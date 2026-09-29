// rules-layout：规则库在**设置文档里的坐标**——命名空间名、`rules` 字段名，以及把解析值
// 折成规则卡数组的那一步投影。
//
// 为什么从 lib/rules-namespace.ts 拆出来：坐标与投影是"库住在哪儿、读回来长什么样"，
// 端口实现是"怎么读（describe 取 value/user/revision）、怎么写（update 带 revision 的 CAS）"。
// 三枚坐标在 rules-namespace.ts 内部全都在用（load 拿它读卡、save 拿它写字段、describe 拿它
// 挑本条目那一行），export 面却只有测试与假件在取 ⇒ `fallow --production` 判成「只被测试
// 养着的导出」。拆出来之后端口与端口实现各自只依赖这份坐标，定义仍只有一份。
//
// 段名与本插件条目 id 同源（lib/prompt.ts 的 PLUGIN_NAME），防"卡片绑的段 / 端点前缀 /
// 这里读的段"三处字面量漂移。

import { normalizeRuleCardRow, unknownArray } from "./lesson-store.ts";
import type { RuleCard } from "./lesson-store.ts";
import { PLUGIN_NAME } from "./prompt.ts";
import { fieldOf } from "@jayyuen666/dsh-plugin-shared/lib/record";

/**
 * 规则库存身的设置命名空间 = 本包 profile **条目 id**（`lesson-loop`，见 cordis.patch.yml
 * 的裸 `- id:`）。0.1.7 的注册是隐式的：宿主按条目导出的 `Config` 反推命名空间与可编辑
 * 字段，插件侧不再登记任何段。与 lib/prompt.ts 的 PLUGIN_NAME 同源，防"卡片绑的段 /
 * 端点前缀 / 这里读的段"三处字面量漂移。
 * 类型标注不是装饰：它把"段名就是插件名那一枚字面量"钉成类型，PLUGIN_NAME 若从
 * `"lesson-loop"` 变成 `string`，这里当场编译不过（段名散成宽类型正是漂移的开始）。
 */
export const SETTINGS_NAMESPACE: typeof PLUGIN_NAME = PLUGIN_NAME;

/** 规则数组在 `Config` 里的字段名（读写 `describe()` 的 value/user 都以它为键）。 */
export const RULES_FIELD = "rules";

/** 解析后的命名空间值 → 规则卡数组（逐行归一；非数组一律空库）。 */
export function cardsOfValue(value: unknown): RuleCard[] {
  const out: RuleCard[] = [];
  for (const row of unknownArray(fieldOf(value, RULES_FIELD))) {
    const card = normalizeRuleCardRow(row);
    if (card !== null) {
      out.push(card);
    }
  }
  return out;
}
