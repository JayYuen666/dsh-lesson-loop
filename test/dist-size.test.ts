// test/dist-size.test.ts —— 产物体积上限检查。
//
// `npm run check` 里 build 在 test 之前，所以这道门读到的是当轮刚产出的产物。它挡两类不会让
// 任何行为用例变红的回退：切面里塞进大查表/字面量，以及外部化清单漏掉一枚包导致整包内联
// （`test/build-host.test.ts` 那两条断言判的是说明符字符串还在，翻倍本身不触发它们）。
//
// 预算取当前实测值上加约 25%：正常演进不该立刻改预算，翻倍一定顶穿。
//
// 不开 minify：压缩后 `from "@jayyuen66/dsh-plugin-shared/lib/record"` 这类说明符字符串会从
// 产物里消失，外部化断言随之永远通过。省体积不值得废两道门。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const pkgDir = path.resolve(import.meta.dirname, "..");

/** 产物文件名与预算的对照。 */
const BUDGETS: readonly (readonly [string, number])[] = [
  // 审查批次给 host 半补了五段行为测试：蒸馏墙钟的本地化超时（DigestTimeoutError，按错误类型
  // 而非本地化文案识别）、模型产出解析的多候选切片与取值域白名单、串行落库的单条容错与
  // 无覆盖恢复锁、reasoningEffort 透传、衰减策略的计数合法化，外加双语字典里的对应新条目
  // ——按本机实测，host.js 由 HEAD 的 194,239 B 涨到 200,383 B（净增 6,144 B，约 +6.1 KB），
  // 已顶穿原来的 199,000 B；预算按「当前实测 + 余量」重定为 204,000 B（长期规则仍是上面那条
  // 约 25% 浮动：正常演进不该立刻改预算，只有真正超了才按实测重定）。
  //
  // 本轮根因修复（归因统一 + 注入对账 + 段通知本地化；0.1.16 工作区面）再涨到实测 214,101 B：新增的是
  // 事件折叠/历史对账/分桶台账三段逻辑与它们的中文注释（不开 minify 时注释也进产物），
  // 没有新增外部化清单漏项（build-host.test 那两条说明符断言仍绿）。预算按实测 + 约 10%
  // 重定为 232,000 B。
  //
  // 本轮存储层重构（SQLite 规则库 + 教训流水 + 结算台账 + 迁移）再涨到实测 234,145 B：
  // 新增的是建表/读写/迁移三段与它们的中文注释，没有新增外部化清单漏项。预算按实测
  // + 约 2.5% 重定为 240,000 B。
  //
  // 七条缺陷根因修复（统一清算入口/启动补算/迁移原子性/字节口径/共享 NumberField）再涨
  // 到实测 241,600 B：新增的是 pending 台账全表扫描、事务内落定标记、整批迁移与字节裁剪
  // 四段逻辑及其中文注释（不开 minify 时注释也进产物），没有新增外部化漏项。预算按
  // 实测 + 约 1% 重定为 244,000 B；这是行为修复的正常演进，不是放宽闸门。
  // 评审问题的根因修复再涨到实测 256,554 B：新增的是台账队列语义（settleLedgerNow 的
  // 取走/回滚判据）、schema v2 就地迁移、revision 自愈、分批导入与 `close()` 释放，以及
  // ruleDetail 的可信位与字节上限（不开 minify 时中文注释一并进产物）。没有新增外部化
  // 清单漏项（build-host.test 那两条说明符断言仍绿）。预算按实测 + 约 1% 重定为 259,000 B。
  //
  // 读链根因修复（ruleDetail 的 400/404/500 分流、证据单条与整页字节上限、命名空间守卫
  // 数据表化、候选卡补 cwd）再涨到实测 264,025 B：新增的是 capChars/projectEvidencePage
  // 两段投影逻辑与规则读取接口的类型注解（不开 minify 时中文注释一并进产物），没有新增
  // 外部化清单漏项。预算按实测 + 约 1% 重定为 266,000 B。
  //
  // 低危项收尾（node:sqlite 静态导入的 engines 依据、两条冗余索引为何保留、isLedgerRow
  // 属发布面而非读路径、ruleDetail 的 cursor 是偏移量因而翻页可能漂）再涨到实测
  // 266,180 B：这一轮**只加注释、不动逻辑**，增量全是四段说明（不开 minify 时中文注释
  // 一并进产物）。预算按实测 + 约 1% 重定为 269,000 B。
  //
  // 数据库专项修复（lesson_stats 单行计数器与插入/删除触发器、按主键小批裁剪、迁移前
  // 一次读 payload 集合做批间去重、裁剪失败后的缓存水位顺序）再涨到实测 273,254 B：
  // 新增的是计数器/批量删除/去重集合三段逻辑与建表触发器，没有新增外部化清单漏项
  // （build-host.test 的说明符断言仍绿）。预算按实测 + 约 0.3% 重定为 274,000 B。
  ["host.js", 274_000],
  // 规则读取接口迁到官方 Typert Remote 后，客户端多了一枚 descriptor/读取器（约 6 KB）。
  // shared 客户端行改为 external 并开启 minify 后实测 26,664 B；shared card-ui 的字节
  // 不再计入本产物，按实测 × 1.25 取整重定。
  ["client.js", 34_000],
];

/**
 * `types/` 整目录的字节预算：`files` 里写的是整目录，声明体积就是下载成本。
 *
 * 实测 29,034 B（`removeComments` 之后；带注释时约 71 KB，其中绝大部分是注释）。
 * 取实测值上加约 25%，与上面两行 JS 产物同一种做法——它挡的是"注释或大查表重新混进发布物"。
 * 本轮涨的是 `LedgerRow` / `LedgerConsumedElsewhereError` / `settleLedgerNow` /
 * `hasLessons` / `close` / `RuleDetailReplyOrFailure` / `RuleRemoteActionName` 七处新导出面
 * （各带一段声明注释）。
 */
const DECLARATION_BUDGET_BYTES = 37_000;

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
