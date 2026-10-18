// test/dist-size.test.ts —— 产物体积闸门。
//
// `npm run check` 里 build 在 test 之前，所以这道门读到的是当轮刚产出的产物。它挡两类不会让
// 任何行为用例变红的回退：切面里塞进大查表/字面量，以及外部化清单漏掉一枚包导致整包内联
// （`test/build-host.test.ts` 那两条断言判的是说明符字符串还在，翻倍本身不触发它们）。
//
// 预算取当前实测值上浮约 25%：正常演进不该立刻改预算，翻倍一定顶穿。
//
// 不开 minify：压缩后 `from "@jayyuen66/dsh-plugin-shared/lib/record"` 这类说明符字符串会从
// 产物里消失，外部化断言随之恒绿。省体积不值得废两道门。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const pkgDir = path.resolve(import.meta.dirname, "..");

/** 产物文件名与预算的对照。 */
const BUDGETS: readonly (readonly [string, number])[] = [
  ["host.js", 153_000],
  // 规则读面迁到官方 Typert Remote 后，客户端多了一枚 descriptor/读取器（约 6 KB）。
  ["client.js", 55_000],
];

/** `types/` 整目录的字节预算：`files` 里写的是整目录，声明体积就是下载成本。 */
const DECLARATION_BUDGET_BYTES = 72_000;

/**
 * 目录（递归）下 `.d.ts` 的字节合计。
 *
 * @param dir - 目录绝对路径
 * @returns 字节合计
 */
function declarationBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += declarationBytes(full);
    } else if (entry.name.endsWith(".d.ts")) {
      total += readFileSync(full).byteLength;
    }
  }
  return total;
}

describe("产物体积", () => {
  it.each(BUDGETS)("%s 不超过 %s 字节预算", (file, budget) => {
    const bytes = readFileSync(path.join(pkgDir, file)).byteLength;
    assert.ok(
      bytes <= budget,
      `${file} 实测 ${bytes.toLocaleString("en-US")} B，超出预算 ` +
        `${budget.toLocaleString("en-US")} B：多半是某个切面塞进了大查表/字面量，` +
        `或外部化清单漏了一枚包导致整包内联。确属正常演进就改这里的预算常量，并写明理由。`,
    );
  });

  it("types/ 声明总量不超出预算", () => {
    const bytes = declarationBytes(path.join(pkgDir, "types"));
    assert.ok(
      bytes <= DECLARATION_BUDGET_BYTES,
      `types/ 实测 ${bytes.toLocaleString("en-US")} B，超出预算 ` +
        `${DECLARATION_BUDGET_BYTES.toLocaleString("en-US")} B。`,
    );
  });
});
