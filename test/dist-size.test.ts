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
  // 审查批次给 host 半补了五段行为面：蒸馏墙钟的本地化超时（DigestTimeoutError，按错误类型
  // 而非本地化文案识别）、模型产出解析的多候选切片与取值域白名单、串行落库的单条容错与
  // 无覆盖恢复锁、reasoningEffort 透传、衰减策略的计数合法化，外加双语字典里的对应新条目
  // ——按本机实测，host.js 由 HEAD 的 194,239 B 涨到 200,383 B（净增 6,144 B，约 +6.1 KB），
  // 已顶穿原来的 199,000 B；预算按「当前实测 + 余量」重定为 204,000 B（长期口径仍是上面那条
  // 约 25% 浮动：正常演进不该立刻改预算，只有真正超了才按实测重定）。
  ["host.js", 204_000],
  // 规则读面迁到官方 Typert Remote 后，客户端多了一枚 descriptor/读取器（约 6 KB）。
  // 设置卡迁到 @jayyuen66/dsh-plugin-shared/lib/card-ui 后，卡片样式与组件逻辑随包进
  // client.js（实测增加约 9 KB），预算按迁移后的实量重定。
  ["client.js", 80_000],
];

/**
 * `types/` 整目录的字节预算：`files` 里写的是整目录，声明体积就是下载成本。
 *
 * 实测 21,809 B（`removeComments` 之后；带注释时约 71 KB，其中绝大部分是注释）。
 * 取实测值上浮约 25%，与上面两行 JS 产物同口径——它挡的是"注释或大查表重新混进发布物"。
 */
const DECLARATION_BUDGET_BYTES = 28_000;

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
