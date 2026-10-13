// lesson-jsonl：教训**事件流水**的落盘面（cache 里那一条 JSONL 的追加与读取）。
//
// 为什么从 lib/lesson-store.ts 拆出来：流水与规则库是两块存放面、两套失败纪律——流水是
// dsh 定位的"可丢弃派生数据"（单写者追加，任何一步失败只日志，绝不让守卫热路径抛穿），
// 规则库是设置命名空间里的 CAS 写（失败要回 PERSIST_FAILED 回执）。两件事住在一个文件里时，
// 落盘这层的出口只因"同文件另有一半人用"而挂着 export，`fallow --production` 因此把它们
// 判成「只被测试养着的导出」；拆开之后每枚都有真实生产消费者（lesson-store 的 report /
// recentLessons / lessonsCount），测试也按这层边界直接取用。
//
// 内容零截断是这层的承诺：`maxBytes` 只是磁盘保险丝（0 = 不设上限），裁尾那一步在
// lib/jsonl-fuse.ts，判据本体在 shared/lib/jsonl.ts，与 ctx-observe 同源。
//
// 写入不再是裸 append：走 jsonl-fuse 的 `appendUnderFuse`——「先裁后写」在同一把跨进程
// 锁里（裁剪的读改写与别的进程的追加曾互相覆盖，见该文件头），本层只负责行边界与失败日志。

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { errorText } from "@jayyuen66/dsh-plugin-shared/lib/errors";
import { appendUnderFuse } from "./jsonl-fuse.ts";

/** JSONL 单行容错解析：坏行/非对象 → null（供 readJsonl 计 bad）。 */
function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** JSONL 追加（容错：路径/建目录/裁剪/追加任一失败只日志不抛——热路径不许炸宿主）。
 *
 *  落盘那一笔交给 `appendUnderFuse`：同一个临界区里先裁后写（跨进程串行，见 jsonl-fuse.ts）。
 *
 *  每条记录**前**补一个换行：文件尾已是换行时它落成一个空行（读侧按 trim 忽略），是半行
 *  （崩溃、ENOSPC 半写、外部编辑留下的残行）时正好把残行封口——新记录因此永远自成一行，
 *  不会与残行拼成一条坏行被整条丢掉。不先读文件尾部那个字节，是因为那需要 openSync +
 *  readSync（fd 读），而本仓 no-sync 的同步读白名单只列到 readFileSync/readSync 那一组，
 *  openSync/closeSync 不在其中；多一个字节换掉一次同步打开，这笔账划算。 */
export function appendJsonl(file: string, row: object, maxBytes: number): void {
  try {
    const dir = path.dirname(file);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendUnderFuse(file, `\n${JSON.stringify(row)}\n`, maxBytes);
  } catch (error) {
    console.error(`[lesson-loop] lesson append failed: ${errorText(error)}`);
  }
}

/** 上次读到的坏行数（按文件）：坏行数没变就不再重复 warn。
 *  没有这一层，一张永久坏掉的行会跟着 /stats 轮询每次全量读都刷一条——
 *  那是把"这里出过事"变成日志噪声，读的人反而找不到真正变化的那一次。 */
const lastBadCount = new Map<string, number>();

/** 解析结果缓存：按 (size, mtimeMs) 判"这份文件自上次读以来没变"。
 *  流水是**追加写**的（appendJsonl 每次改 size；唯一的整文件重写是保险丝裁尾，也必然
 *  改 size），故 size+mtime 这对判据对追加语义足够灵敏。没有这一层，卡片轮询 /stats
 *  每轮都要把整份流水重新 readFileSync + 逐行 JSON.parse（recentLessons 与 lessonsCount
 *  各一次），而流水按用户口径不设上限。上限 8 份：一个进程只有本包这一份流水，
 *  多出来的是测试里的临时文件，不随工程数增长。 */
const parseCache = new Map<
  string,
  { size: number; mtimeMs: number; rows: Record<string, unknown>[] }
>();
const PARSE_CACHE_MAX = 8;

/** 记一份解析结果（超上限按插入序淘汰最旧的）。 */
function rememberParse(
  file: string,
  size: number,
  mtimeMs: number,
  rows: Record<string, unknown>[],
): void {
  if (parseCache.size >= PARSE_CACHE_MAX) {
    // 腾一格：Map 保持插入序，首个键就是最旧的。默认值兜住"空表"这一格（那时删的就是
    // 正要写入的这个键，等于把它挪到队尾），因此不需要一条判空分支。
    const [oldest = file] = parseCache.keys();
    parseCache.delete(oldest);
  }
  parseCache.set(file, { size, mtimeMs, rows });
}

/** 读整个 JSONL（容错；坏行跳过，计数变化时才 warn；未变则复用上一次的解析结果）。 */
export function readJsonl(file: string): Record<string, unknown>[] {
  try {
    if (!existsSync(file)) {
      return [];
    }
    const stats = statSync(file);
    const cached = parseCache.get(file);
    if (cached !== undefined && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
      // 浅拷贝一份数组：缓存里的那份只许本层改，调用方拿到的是可自由处理的视图。
      return [...cached.rows];
    }
    const text = readFileSync(file, "utf8");
    const out: Record<string, unknown>[] = [];
    let bad = 0;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        const parsed = parseJsonLine(trimmed);
        if (parsed === null) {
          bad += 1;
        } else {
          out.push(parsed);
        }
      }
    }
    // 两个判据各求值一次（写成一条 && 表达式时，"没有坏行"的那次读会让第二个判据整条
    // 短路掉，覆盖门禁 100% 的分支口径下会留一个永远不执行的操作数）。
    const previousBad = lastBadCount.get(file);
    if (bad > 0 && previousBad !== bad) {
      console.warn(`[lesson-loop] ${bad} malformed lesson line(s) skipped in ${file}`);
    }
    lastBadCount.set(file, bad);
    rememberParse(file, stats.size, stats.mtimeMs, out);
    return [...out];
  } catch {
    return [];
  }
}
