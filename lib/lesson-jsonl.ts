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

/** 上次读失败（非 ENOENT）的错误摘要（按文件）：错误没变就不重复 warn。 */
const lastReadError = new Map<string, string>();

/** 解析结果缓存：流水是**追加写**的（appendJsonl 每次改 size；唯一的整文件重写是保险丝
 *  裁尾，也必然改 size）。size 位存的是**实际解析那份文本**的字节数，不是读取前的
 *  stat 读数——键即内容：两次调用之间若有并发追加或 fuse 裁尾，缓存键与内容不再对应的
 *  话，下一次 stat 必然不匹配而白读一遍整份流水。mtimeMs 取读取前的 stat 读数（只做
 *  "同字节长度不同内容"这一档的旁证）。上限 8 份：一个进程只有本包这一份流水，
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

/** 文件消失（或从未存在）时清掉按路径留下的全部状态：流水被删后若以同样的大小与
 *  mtime 重新出现（cp -p、快照恢复、同一毫秒内的原地重写），残留的解析缓存与坏行
 *  计数会把已删除/已替换的内容当成当前流水。 */
function forgetFile(file: string): void {
  parseCache.delete(file);
  lastBadCount.delete(file);
  lastReadError.delete(file);
}

/** 非 ENOENT 的读失败：按文件去重后 warn 一次（错误没变不重复刷）。权限不足、目录
 *  被删、EBUSY、磁盘故障若与"确实没有流水"同形（都表现成 0 条），数据可见性事故
 *  会被掩盖——"读不到"与"没有"必须分得开。 */
function warnReadFailure(file: string, error: unknown): void {
  const summary = errorText(error);
  if (lastReadError.get(file) === summary) {
    return;
  }
  lastReadError.set(file, summary);
  console.warn(`[lesson-loop] lesson ledger unreadable (${summary}): ${file}`);
}

/** 整份文本 → 好行数组 + 坏行数（坏行跳过，逐行容错）。 */
function parseLedger(text: string): { rows: Record<string, unknown>[]; bad: number } {
  const rows: Record<string, unknown>[] = [];
  let bad = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      const parsed = parseJsonLine(trimmed);
      if (parsed === null) {
        bad += 1;
      } else {
        rows.push(parsed);
      }
    }
  }
  return { rows, bad };
}

/**
 * 读整个 JSONL（容错；坏行跳过，计数变化时才 warn；未变则复用上一次的解析结果）。
 *
 * 失败纪律：文件不存在（含读取途中被删的 ENOENT）静默返回空表并清掉该路径的缓存状态；
 * 其余 IO 错误 warn 一次（按文件去重）后返回空表。返回的**数组**是本次的新拷贝，可自由
 * 处置；行对象与缓存共享，调用方只读不写——改行会污染缓存，后续所有命中（recentLessons /
 * lessonsCount / 其他调用方）都会读到被改脏的数据（此为公开边界上的约定，非实现细节）。
 */
export function readJsonl(file: string): readonly Readonly<Record<string, unknown>>[] {
  let stats: ReturnType<typeof statSync>;
  let text: string;
  try {
    if (!existsSync(file)) {
      forgetFile(file);
      return [];
    }
    stats = statSync(file);
    const cached = parseCache.get(file);
    if (cached !== undefined && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
      // 数组浅拷贝一份数组：缓存里的那份只许本层改，行对象共享（见函数 JSDoc）。
      return [...cached.rows];
    }
    text = readFileSync(file, "utf8");
  } catch (error) {
    // 读取途中被删（existsSync 之后、readFileSync 之前）与"从未存在"同待遇。
    if (isRecord(error) && error["code"] === "ENOENT") {
      forgetFile(file);
      return [];
    }
    warnReadFailure(file, error);
    return [];
  }
  const { rows, bad } = parseLedger(text);
  // 两个判据各求值一次（写成一条 && 表达式时，"没有坏行"的那次读会让第二个判据整条
  // 短路掉，覆盖门禁 100% 的分支口径下会留一个永远不执行的操作数）。
  const previousBad = lastBadCount.get(file);
  if (bad > 0 && previousBad !== bad) {
    console.warn(`[lesson-loop] ${bad} malformed lesson line(s) skipped in ${file}`);
  }
  lastBadCount.set(file, bad);
  rememberParse(file, Buffer.byteLength(text, "utf8"), stats.mtimeMs, rows);
  return [...rows];
}
