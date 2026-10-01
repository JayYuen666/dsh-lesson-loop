// decay-policy：armed 规则的**衰减裁决口径**（阈值形状 + 一条复发率判定）。
//
// 为什么从 lib/lesson-store.ts 拆出来：这一层只回答"这张 armed 卡该降级、该判不可判定、
// 还是该留着"，输入是计数器与阈值，没有任何存放面读写；store 侧负责把 settings 现读的阈值
// 组装成 DecayPolicy（policy()）并在三个落点上调用裁决（report 的复发即判、/stats 的派生态、
// 周期衰减）。裁决住在 store 里时，这三枚 export 的消费者只剩单测，`fallow --production`
// 因此判成「只被测试养着的导出」。
//
// 复发率裁决只用真实证据（violation + suppressed）：样本量 samples 永不进分母（旧设计回避的
// 分母灌水风险继续回避）。armed 超 decayDays 且 violation+suppressed 双零 → 判"不可判定"
// （既非违规亦无一次干净命中，机器无从裁定），保留 armed 交人工，由 /stats 与卡片显式提示
// ——不再静默归档（人工仍可手动归档）。

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

/** 单条 armed 规则的衰减裁决：'demote'（有真实证据的高复发率）| 'undeterminable'
 *  （armed 够久却既无复发也无一次干净命中，机器无从裁定）| 'keep'。 */
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
  const evidence = rule.violation + rule.suppressed;
  const anchor = rule.lastViolationAt ?? rule.lastSuppressedAt ?? rule.armedAt ?? rule.createdAt;
  const matured = now - anchor > policy.decayDays * 86_400_000;
  // **分母必须含至少一次干净命中**：suppressed 为 0 时复发率结构上恒为 1.0（分母只剩
  // 违规自己），宿主不发 pass 的类别（典型是 transient-failure）会被自己的分子判有罪。
  // 无分母即不可判定：既不降级也不归档，保留 armed 交人工——满 decayDays 或违规已达
  // 门槛时点出来（后者说明"一直在犯、但从没验证过规则被遵守过"，同样无从判定）。
  if (rule.suppressed === 0 && (matured || rule.violation >= policy.demoteThreshold)) {
    return "undeterminable";
  }
  // 复发率裁决：armed 后复发 ≥ demoteThreshold、真实证据样本 ≥ demoteMinSamples、
  // 复发率 ≥ demoteRatio，且确有干净命中可比照 → 规则本身有问题（写错了/没被遵守/
  // 无效），降级待人审。
  if (
    rule.suppressed > 0 &&
    rule.violation >= policy.demoteThreshold &&
    evidence >= policy.demoteMinSamples &&
    rule.violation / evidence >= policy.demoteRatio
  ) {
    return "demote";
  }
  return "keep";
}
