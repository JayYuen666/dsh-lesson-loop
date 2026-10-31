// decay-policy：armed 规则的**衰减裁决口径**（阈值形状 + 一条复发率判定）。
//
// 为什么从 lib/lesson-store.ts 拆出来：这一层只回答"这张 armed 卡该降级、该判不可判定、
// 还是该留着"，输入是计数器与阈值，没有任何存放面读写；store 侧负责把 settings 现读的阈值
// 组装成 DecayPolicy（policy()）并在三个落点上调用裁决（report 的复发即判、/stats 的派生态、
// 周期衰减）。裁决住在 store 里时，这三枚 export 的消费者只剩单测，`fallow --production`
// 因此判成「只被测试养着的导出」。
//
// 复发率裁决只用真实证据（violation + suppressed）：样本量 samples 永不进分母（旧设计回避的
// 分母灌水风险继续回避）。不可判定的两条触发路径（都以「从没有过一次干净命中」为前提）：
//   1. armed 已挂满 decayDays（锚点是 armedAt，回退 createdAt——复发不改写这个锚点，
//      否则每次复发都会重置窗口，"挂满多久"就永远量不出来）；
//   2. armed 期复发已达 demoteThreshold（一直在犯、却从没被遵守过，同样无从判定）。
// 命中即判"不可判定"，保留 armed 交人工，由 /stats 与卡片显式提示——不再静默归档
// （人工仍可手动归档）。

import type { RuleCard } from "./lesson-store.ts";

export interface DecayPolicy {
  demoteThreshold: number;
  demoteMinSamples: number;
  demoteRatio: number;
  decayDays: number;
}

export const DEFAULT_DECAY: DecayPolicy = {
  demoteThreshold: 3,
  demoteMinSamples: 5,
  demoteRatio: 0.5,
  decayDays: 30,
};

/** 一天的毫秒数（挂满 decayDays 的窗口换算）。 */
const MS_PER_DAY = 86_400_000;

/** 计数是否可信：非有限、负数、小数都算脏（读取侧 countField 已归一，但 decayVerdict
 *  是导出面，调用方可以不经 store 归一）。脏计数**不参与任何裁决**——单侧为负会让
 *  evidence 变小、复发率被放大而误判降级；NaN 会让 evidence > 0 与 suppressed === 0
 *  同时失效、卡片静默永久 keep。两种都不是"这条规则表现如何"的结论，所以直接 keep
 *  留给人修，不写进 demote / undeterminable 任何一档。 */
function isCleanCount(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

/** 阈值归一：store 侧与 settings schema 都做了钳位，但本函数是导出面，调用方可以不经
 *  它们传策略。非法值按默认档收口——decayDays <= 0 会让"挂满"对任何 armed 卡恒真、
 *  NaN 会让它恒假；demoteRatio 越出 (0, 1] 会让降级永不发生或恒发生。 */
function policyOf(policy: DecayPolicy): DecayPolicy {
  const days =
    Number.isFinite(policy.decayDays) && policy.decayDays > 0
      ? policy.decayDays
      : DEFAULT_DECAY.decayDays;
  const threshold =
    Number.isFinite(policy.demoteThreshold) && policy.demoteThreshold >= 1
      ? Math.floor(policy.demoteThreshold)
      : DEFAULT_DECAY.demoteThreshold;
  const minSamples =
    Number.isFinite(policy.demoteMinSamples) && policy.demoteMinSamples >= 1
      ? Math.floor(policy.demoteMinSamples)
      : DEFAULT_DECAY.demoteMinSamples;
  const ratio =
    Number.isFinite(policy.demoteRatio) && policy.demoteRatio > 0 && policy.demoteRatio <= 1
      ? policy.demoteRatio
      : DEFAULT_DECAY.demoteRatio;
  return {
    demoteThreshold: threshold,
    demoteMinSamples: minSamples,
    demoteRatio: ratio,
    decayDays: days,
  };
}

/** 单条 armed 规则的衰减裁决：'demote'（有真实证据的高复发率）| 'undeterminable'
 *  （armed 后从没有被遵守过，且要么已挂满 decayDays、要么复发已达门槛，机器无从
 *  裁定）| 'keep'。 */
export function decayVerdict(
  rule: RuleCard,
  policy: DecayPolicy,
  now: number,
): "demote" | "undeterminable" | "keep" {
  if (rule.status !== "armed") {
    return "keep";
  }
  // 复发率分母只用真实证据（violation + suppressed/observed）。samples（暴露度）
  // 刻意不进来——它把"项目里什么都没发生"的无关会话也数进去，进分母只会稀释复发率、
  // 让一条其实没被测过的规则显得"表现良好"。
  if (!isCleanCount(rule.violation) || !isCleanCount(rule.suppressed)) {
    return "keep";
  }
  const { violation, suppressed } = rule;
  const evidence = violation + suppressed;
  const activePolicy = policyOf(policy);
  // 不可判定的"挂满"锚定在升格那一刻：lastViolationAt 一类的最近证据时间戳一旦进来，
  // 每次复发都会重置窗口——一条零星复发、又从未被遵守的规则就永远到不了"挂满"，
  // 既降不了级也判不成不可判定，只能一直 keep。锚点还必须落回"现在"当它缺位或被
  // 漂移写坏（0 / 负数 / NaN）：锚 0 会让一张刚升格的卡立刻判"早已挂满"，NaN 会让
  // "挂满"这条路径无声失效。
  // `now` 也必须是有限数：NaN/Infinity 会让 `now - anchor` 变 NaN，挂满窗口与后续所有
  // >= 比较一起退化，"挂满 decayDays"这条不可判定路径静默失效（与锚点同一个事故面）。
  const clock = Number.isFinite(now) ? now : Date.now();
  const candidateAnchor = rule.armedAt ?? rule.createdAt;
  const anchor = Number.isFinite(candidateAnchor) && candidateAnchor > 0 ? candidateAnchor : clock;
  // 恰好挂满 decayDays 也算"挂满"（与注释的语义一致；`>` 会把判定推迟一整轮）。
  const matured = clock - anchor >= activePolicy.decayDays * MS_PER_DAY;
  // **分母必须含至少一次干净命中**：suppressed 为 0 时复发率结构上恒为 1.0（分母只剩
  // 违规自己），宿主不发 pass 的类别（典型是 transient-failure）会被自己的分子判有罪。
  // 无分母即不可判定：既不降级也不归档，保留 armed 交人工——挂满 decayDays 或违规已达
  // 门槛时点出来（后者说明"一直在犯、但从没验证过规则被遵守过"，同样无从判定）。
  if (suppressed === 0 && (matured || violation >= activePolicy.demoteThreshold)) {
    return "undeterminable";
  }
  // 复发率裁决：armed 后复发 ≥ demoteThreshold、真实证据样本 ≥ demoteMinSamples、
  // 复发率 ≥ demoteRatio，且确有干净命中可比照 → 规则本身有问题（写错了/没被遵守/
  // 无效），降级待人审。走到这里 suppressed 必然 !== 0（为零的情形已被上面的守卫
  // 接走），但存量脏数据仍可能交来负数（violation=3, suppressed=-3 → 分母 0）——
  // 除法前显式要求分母为正，别让 Infinity 替一张脏卡做降级决定。
  if (
    evidence > 0 &&
    violation >= activePolicy.demoteThreshold &&
    evidence >= activePolicy.demoteMinSamples &&
    violation / evidence >= activePolicy.demoteRatio
  ) {
    return "demote";
  }
  return "keep";
}
