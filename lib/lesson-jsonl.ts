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

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { errorText } from "@jayyuen66/dsh-plugin-shared/lib/errors";
import { trimJsonl } from "./jsonl-fuse.ts";

/** JSONL 单行容错解析：坏行/非对象 → null（供 readJsonl 计 bad）。 */
function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** JSONL 追加（容错：路径/建目录/截断/追加任一失败只日志不抛——热路径不许炸宿主）。 */
export function appendJsonl(file: string, row: object, maxBytes: number): void {
  try {
    const dir = path.dirname(file);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    if (maxBytes > 0) {
      trimJsonl(file, maxBytes);
    }
    appendFileSync(file, `${JSON.stringify(row)}\n`);
  } catch (error) {
    console.error(`[lesson-loop] lesson append failed: ${errorText(error)}`);
  }
}

/** 读整个 JSONL（容错；坏行跳过并 warn 一次计数）。 */
export function readJsonl(file: string): Record<string, unknown>[] {
  try {
    if (!existsSync(file)) {
      return [];
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
    if (bad > 0) {
      console.warn(`[lesson-loop] ${bad} malformed lesson line(s) skipped in ${file}`);
    }
    return out;
  } catch {
    return [];
  }
}
