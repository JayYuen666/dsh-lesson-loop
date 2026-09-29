// jsonl-fuse：JSONL 的**磁盘保险丝**——文件超过 maxBytes 就按行裁尾，只保最新那一段。
//
// 为什么与 lib/lesson-jsonl.ts 分家：那一份管"流水怎么写进去、怎么读回来"，这一份管"磁盘
// 快撑不住时砍掉多少"。两件事的判据来源不同——裁尾算法本体在 shared/lib/jsonl.ts（与
// ctx-observe 同源、穷举 413 组磁盘内容分歧 0），而**触发策略**（只在 maxBytes > 0 时收缩，
// 出厂默认 0 = 永不截断，那是写进本包 README 的承诺）与**错误出口**（内部 catch 并打日志，
// 绝不把异常抛给守卫热路径）是本包自己的事，统一进 shared 就等于改行为。
// 分家之后这枚裁尾入口有了真实生产消费者（appendJsonl 每次追加前问它一次），不再只是测试面。

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { shrinkJsonlTail } from "@jayyuen666/dsh-plugin-shared/lib/jsonl";

/** 超限时按行对半收缩（判据在 shared/lib/jsonl.ts，与 ctx-observe 同源；单行超限保末行兜底）。
 *  错误出口留在这里吞掉：本包的承诺是"落库失败只日志、不抛穿宿主热路径"。 */
export function trimJsonl(file: string, maxBytes: number): void {
  try {
    if (statSync(file).size <= maxBytes) {
      return;
    }
    const text = readFileSync(file, "utf8");
    const shrunk = shrinkJsonlTail(text, maxBytes);
    if (shrunk !== text) {
      writeFileSync(file, shrunk);
    }
  } catch {
    /* 截断尽力而为 */
  }
}
