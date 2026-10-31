// 衰减裁决、签名折叠、围栏定界与蒸馏解析的属性面。期望值全部来自各模块头注写明的
// 契约（脏计数不参与裁决、NUL 分隔、行首引用标记、白名单类别），不从实现派生。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import fc from "fast-check";

import { DEFAULT_DECAY, decayVerdict } from "../../lib/decay-policy.ts";
import type { DecayPolicy } from "../../lib/decay-policy.ts";
import {
  CATEGORY_SIGNATURES,
  isFragmentSignatureOf,
  ruleKey,
  stableSignatureFor,
} from "../../lib/rule-signature.ts";
import { fenceUntrusted } from "../../lib/prompt.ts";
import { DIGEST_CATEGORIES, parseDigestOutput } from "../../lib/digest-prompt.ts";
import type { RuleCard } from "../../lib/lesson-store.ts";

/** 衰减裁决只读这几位：其余字段按 RuleCard 形状填合法值。 */
function armedCard(overrides: {
  violation: number;
  suppressed: number;
  armedAt?: number;
  createdAt?: number;
}): RuleCard {
  return {
    id: "card-1",
    project: "proj",
    category: "factgate-deny",
    signature: "sig",
    statement: "statement",
    status: "armed",
    createdAt: overrides.createdAt ?? 1000,
    updatedAt: 1000,
    ...(overrides.armedAt === undefined ? {} : { armedAt: overrides.armedAt }),
    occurrences: 3,
    sources: [],
    violation: overrides.violation,
    suppressed: overrides.suppressed,
    samples: 0,
    recurrences: 0,
    evidence: [],
    origin: "threshold",
  };
}

/** 文案行首引用标记（判据自持：帧结构符只许出现在行首，引用标记是帧自己不用的一位）。 */
const QUOTE_MARK = "│ ";

/** 脏计数的生成域：负数、NaN、小数、Infinity（与 isCleanCount 的四条否定逐条对应）。 */
const dirtyCountArb = fc.oneof(
  fc.integer({ min: -1000, max: -1 }),
  fc.constant(Number.NaN),
  fc.constant(1.5),
  fc.constant(Number.POSITIVE_INFINITY),
);

describe("decayVerdict 的裁决性质", () => {
  it("脏计数（负/NaN/小数/Infinity）恒 keep——不参与任何裁决", () => {
    fc.assert(
      fc.property(dirtyCountArb, fc.integer({ min: 0, max: 50 }), (dirty, clean) => {
        for (const card of [
          armedCard({ violation: dirty, suppressed: clean }),
          armedCard({ violation: clean, suppressed: dirty }),
        ]) {
          assert.equal(decayVerdict(card, DEFAULT_DECAY, 1e12), "keep");
        }
      }),
    );
  });

  it("非 armed 状态恒 keep", () => {
    const card = { ...armedCard({ violation: 99, suppressed: 99 }), status: "candidate" as const };
    assert.equal(decayVerdict(card, DEFAULT_DECAY, 1e12), "keep");
  });

  it("suppressed=0 且（挂满 decayDays 或复发达阈值）⇒ undeterminable，绝不 demote", () => {
    const maturedAt = 1000 + DEFAULT_DECAY.decayDays * 86_400_000;
    assert.equal(
      decayVerdict(
        armedCard({ violation: 0, suppressed: 0, armedAt: 1000 }),
        DEFAULT_DECAY,
        maturedAt,
      ),
      "undeterminable",
    );
    assert.equal(
      decayVerdict(
        armedCard({ violation: DEFAULT_DECAY.demoteThreshold, suppressed: 0, armedAt: 1000 }),
        DEFAULT_DECAY,
        1000,
      ),
      "undeterminable",
    );
    // 未挂满且未达阈值：keep（有分母前不作任何降级判断）。
    assert.equal(
      decayVerdict(armedCard({ violation: 1, suppressed: 0, armedAt: 1000 }), DEFAULT_DECAY, 1000),
      "keep",
    );
  });

  it("demote 四条件同时成立才降级：复发≥阈值、证据≥最小样本、比率≥阈值、分母为正", () => {
    const policy: DecayPolicy = { ...DEFAULT_DECAY };
    const strong = armedCard({ violation: 5, suppressed: 5, armedAt: 1000 });
    assert.equal(decayVerdict(strong, policy, 2000), "demote");
    // 分母不足：证据 < demoteMinSamples。
    const thin = armedCard({ violation: 3, suppressed: 1, armedAt: 1000 });
    assert.notEqual(decayVerdict(thin, policy, 2000), "demote");
  });
});

describe("ruleKey 与 stableSignatureFor 的折叠性质", () => {
  it(String.raw`NUL 注入不串键：project/category/signature 里夹 NUL 不与相邻字段拼出同键`, () => {
    assert.notEqual(ruleKey("a\u0000b", "c", "s"), ruleKey("a", "b\u0000c", "s"));
    assert.notEqual(ruleKey("a", "c\u0000s", "x"), ruleKey("a", "c", "s\u0000x"));
  });

  it("首尾空白不进键：project/category 只差空白时同键（armed 规则静默失效的防线）", () => {
    assert.equal(ruleKey("repo ", "cat", "sig"), ruleKey("repo", "cat ", "sig"));
  });

  it("登记类别的稳定签名幂等；rejected 归档签名原样返回", () => {
    for (const category of Object.keys(CATEGORY_SIGNATURES)) {
      const stable = stableSignatureFor(category, "whatever detail");
      assert.equal(stableSignatureFor(category, stable), stable);
      const summary = `${stable}:rejected`;
      assert.equal(stableSignatureFor(category, summary), summary);
      // 稳定签名不是碎片签名（归并识别器的对偶面）。
      assert.equal(isFragmentSignatureOf(category, stable), false);
    }
  });

  it("未登记类别原样返回归一签名", () => {
    assert.equal(stableSignatureFor("unknown-category", "  a  b  "), "a b");
  });
});

describe("fenceUntrusted 的定界性质", () => {
  /** 不含行终止符、不含行首结构符的干净正文（此域内 defuse 是恒等，oracle 可逐字比较）。 */
  const structuralLead =
    /^[│\s]*(?:\d{1,9}[.)、]|-{3,}|\*{3,}|_{3,}|={3,}|#{1,6}|\[lesson-loop\]|[-*+>](?=[ \t]))/iu;
  const cleanLineArb = fc
    .stringMatching(/^[a-z][a-z0-9 ,.;:]{0,30}$/u)
    .filter((line) => !structuralLead.test(line));
  /** 行终止符全集（与模块头注写明的一致：LF/CRLF/裸 CR/LS/PS/NEL/VT/FF；十六进制转义按
   *  lint 基线用大写）。 */
  const terminatorArb = fc.constantFrom(
    "\n",
    "\r\n",
    "\r",
    "\u2028",
    "\u2029",
    "\u0085",
    "\u000B",
    "\u000C",
  );

  it("任意行终止符都切行：每行都拿到引用标记，正文逐字保留", () => {
    fc.assert(
      fc.property(cleanLineArb, terminatorArb, cleanLineArb, (left, terminator, right) => {
        const output = fenceUntrusted(`${left}${terminator}${right}`);
        assert.equal(output, `${QUOTE_MARK}${left}\n${QUOTE_MARK}${right}`);
      }),
    );
  });

  it("单行干净正文 = 引用标记 + 原文（零截断）", () => {
    fc.assert(
      fc.property(cleanLineArb, (line) => {
        assert.equal(fenceUntrusted(line), `${QUOTE_MARK}${line}`);
      }),
    );
  });

  it("行首结构符本体被【】包住（探针实测：包的是匹配段，不是整行）", () => {
    assert.equal(fenceUntrusted("1. 危险命令"), `${QUOTE_MARK}【1.】 危险命令`);
    assert.equal(fenceUntrusted("## 标题"), `${QUOTE_MARK}【##】 标题`);
    assert.equal(fenceUntrusted("---"), `${QUOTE_MARK}【---】`);
  });
});

describe("parseDigestOutput 的容错性质", () => {
  /** 任意文本（含方括号、截断、噪声）。 */
  const anyTextArb = fc.string({ maxLength: 200 });

  it("任意输入不抛；产出的候选类别全部在白名单内", () => {
    fc.assert(
      fc.property(anyTextArb, (text) => {
        const result = parseDigestOutput(text);
        assert.equal(typeof result.parsed, "boolean");
        assert.ok(result.rejected >= 0);
        for (const rule of result.rules) {
          assert.ok(
            DIGEST_CATEGORIES.includes(rule.category),
            `白名单外类别混入：${rule.category}`,
          );
        }
      }),
    );
  });

  it("白名单外的候选只进 rejected 不进 rules；合法候选全收", () => {
    const mixed = JSON.stringify([
      { category: "dangerous-bash", statement: "合法" },
      { category: "not-in-list", statement: "越权" },
    ]);
    const result = parseDigestOutput(mixed);
    assert.equal(result.parsed, true);
    assert.equal(result.rules.length, 1);
    assert.equal(result.rules[0]?.category, "dangerous-bash");
    assert.equal(result.rejected, 1);
  });

  it("没有任何方括号切片才 parsed:false；前缀 [1] 是噪音数组（parsed:true 空候选），不吞后面的真候选", () => {
    assert.equal(parseDigestOutput("没有任何方括号的普通文本").parsed, false);
    const prefixOnly = parseDigestOutput("前言 [1] 说明");
    assert.equal(prefixOnly.parsed, true);
    assert.equal(prefixOnly.rules.length, 0);
    const prefixed = parseDigestOutput('前言 [1]\n[{"category":"max-tokens","statement":"续写"}]');
    assert.equal(prefixed.parsed, true);
    assert.equal(prefixed.rules.length, 1);
  });
});
