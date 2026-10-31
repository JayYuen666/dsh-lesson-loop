// decay-policy 单元测试：衰减裁决的**输入合法性收口**。
//
// 这一层是导出面（LessonStore 之外的调用方也能直接调），阈值与计数都可能绕开
// store / settings schema 的钳位传进来。判据独立写死期望值：每条用例都同时给出
// "若非法值被当真"与"回落默认档"两种走向，只让后者成立——实现把收口删掉时用例会红。
//
// 为什么单独立一份：store 侧的用例只喂经过钳位的 policy，收口本身（decayDays <= 0、
// NaN、ratio 越界、脏计数、NaN now）没有判据，删掉它不会有任何门变红。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { DEFAULT_DECAY, decayVerdict } from "../lib/decay-policy.ts";
import type { DecayPolicy } from "../lib/decay-policy.ts";
import type { RuleCard } from "../lib/lesson-store.ts";

const t0 = 1_700_000_000_000;
const DAY = 86_400_000;

/** 一张 armed 规则卡（只覆盖差异项；字段与 RuleCard 一一对应）。 */
function card(over: Partial<RuleCard> = {}): RuleCard {
  return {
    id: "r1",
    project: "p",
    category: "gate-failure",
    signature: "sig",
    statement: "陈述",
    status: "armed",
    createdAt: t0,
    updatedAt: t0,
    armedAt: t0,
    occurrences: 1,
    sources: [],
    violation: 0,
    suppressed: 0,
    samples: 0,
    recurrences: 0,
    evidence: [],
    origin: "threshold",
    ...over,
  };
}

describe("decayVerdict 的计数合法性", () => {
  it("负数/小数/非有限计数一律 keep：脏计数不参与任何一档裁决", () => {
    for (const over of [
      { violation: -1 },
      { suppressed: -2 },
      { violation: 1.5 },
      { suppressed: 0.5 },
      { violation: Number.NaN },
      { suppressed: Number.POSITIVE_INFINITY },
    ]) {
      assert.equal(
        // 挂满一年 + 复发 99 次：按"当真"读会判 demote/undeterminable，脏计数必须 keep。
        decayVerdict(card({ violation: 99, ...over }), DEFAULT_DECAY, t0 + 365 * DAY),
        "keep",
        `${JSON.stringify(over)} 是脏计数，不许判成任何一档`,
      );
    }
  });
});

describe("decayVerdict 的阈值收口（policyOf）", () => {
  it("decayDays 为 0/负数/非有限时回落 DEFAULT_DECAY（0 会让刚升格的卡立刻判挂满）", () => {
    for (const decayDays of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const policy: DecayPolicy = { ...DEFAULT_DECAY, decayDays };
      assert.equal(
        // armed 后只过了一天：按 0 天窗口会判 undeterminable，回落 30 天才是 keep。
        decayVerdict(card(), policy, t0 + DAY),
        "keep",
        `${String(decayDays)} 必须回落默认档`,
      );
    }
    // 反向一侧：合法值照旧生效——恰好挂满 30 天判不可判定。
    assert.equal(decayVerdict(card(), DEFAULT_DECAY, t0 + 30 * DAY), "undeterminable");
  });

  it("demoteThreshold 为 0/负数/非有限时回落默认档（0 会让零复发也够门槛）", () => {
    for (const demoteThreshold of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const policy: DecayPolicy = { ...DEFAULT_DECAY, demoteThreshold };
      assert.equal(
        // 零复发、零干净命中、只挂了一天：门槛 0 会判 undeterminable，回落 3 才是 keep。
        decayVerdict(card(), policy, t0 + DAY),
        "keep",
        `${String(demoteThreshold)} 必须回落默认档`,
      );
    }
    // 反向一侧：合法门槛 1 仍照用——零分母时复发 1 次即到门槛。
    assert.equal(
      decayVerdict(card({ violation: 1 }), { ...DEFAULT_DECAY, demoteThreshold: 1 }, t0 + DAY),
      "undeterminable",
    );
  });

  it("demoteMinSamples 为 0/负数/非有限时回落默认档（0 会让一次复发就够样本量）", () => {
    const policy: DecayPolicy = { ...DEFAULT_DECAY, demoteThreshold: 1 };
    for (const demoteMinSamples of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(
        // violation 1 / suppressed 1：分母 2 条证据。样本量按 0 算会 demote，回落 5 才是 keep。
        decayVerdict(
          card({ violation: 1, suppressed: 1 }),
          { ...policy, demoteMinSamples },
          t0 + DAY,
        ),
        "keep",
        `${String(demoteMinSamples)} 必须回落默认档`,
      );
    }
    // 反向一侧：合法的 2 条样本门槛照用，同一张卡就 demote。
    assert.equal(
      decayVerdict(
        card({ violation: 1, suppressed: 1 }),
        { ...policy, demoteMinSamples: 2 },
        t0 + DAY,
      ),
      "demote",
    );
  });

  it("demoteRatio 越出 (0, 1] 时回落默认 0.5（2 让降级永不发生、0 让降级恒发生）", () => {
    const hot = card({ violation: 3, suppressed: 3 });
    for (const demoteRatio of [2, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(
        // 复发率 3/6 = 0.5：按 2 读永不够、按 0 读恒够，回落 0.5 才恰好 demote。
        decayVerdict(hot, { ...DEFAULT_DECAY, demoteRatio }, t0 + DAY),
        "demote",
        `${String(demoteRatio)} 必须回落默认档`,
      );
    }
    // 反向一侧：合法的 0.6 门槛照用，同为 0.5 的复发率不够，判 keep。
    assert.equal(decayVerdict(hot, { ...DEFAULT_DECAY, demoteRatio: 0.6 }, t0 + DAY), "keep");
  });

  it("now 非有限时按 Date.now() 裁决（NaN/Infinity 会让挂满窗口整条失效）", () => {
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(
        // armedAt 在 2023 年：按 NaN 读"挂满"恒假 → keep；回落到当前时刻才判不可判定。
        decayVerdict(card(), DEFAULT_DECAY, now),
        "undeterminable",
        `${String(now)} 必须回落到当前时刻`,
      );
    }
  });

  it("armedAt 缺位时锚点回退 createdAt；两处都坏时锚点落回 now", () => {
    const noArmedAt = card();
    delete (noArmedAt as { armedAt?: number }).armedAt;
    // armedAt 缺位、createdAt 是一年前：窗口按 createdAt 算 → 不可判定。
    assert.equal(decayVerdict(noArmedAt, DEFAULT_DECAY, t0 + 365 * DAY), "undeterminable");
    // 两处都是 NaN：锚点落回 now → 窗口为 0，刚升格一样 keep（不许判"早已挂满"）。
    assert.equal(
      decayVerdict(
        card({ armedAt: Number.NaN, createdAt: Number.NaN }),
        DEFAULT_DECAY,
        t0 + 365 * DAY,
      ),
      "keep",
    );
  });
});
