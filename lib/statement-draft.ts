// statement-draft：候选规则**正文**的起草（按分类选模板，signature 原文嵌入）。
//
// 为什么从 lib/lesson-store.ts 拆出来：起草是"产出一段要注入给模型的文案"，与 store 的
// 沉淀/度量/落盘纪律无关；它只依赖两样东西——消息表的两语模板（lib/messages.ts 的
// `statement*` 段）与类别级稳定签名（lib/rule-signature.ts，决定走通用正文还是嵌占位）。
// 留在 store 里时它的 export 只因单测逐条模板取用，`fallow --production` 判成
// 「只被测试养着的导出」。
//
// 语言由调用点经消息表入参递进来：本函数是纯函数，不读 settings（与 lib/digest.ts 同一条
// 纪律）。已落库的规则正文不经这里，因此切换界面语言不会改写已生效的规则，只影响**新起草**
// 的那一张（那正文随即回注给模型，属"注入给模型的文案"）。
// signature 与 category 是**数据**、不翻译：feedback-digest 分类的 signature 就是
// 模型产出的正文本身，原样透传，不经字典。
//
// 防注入契约：正文里的 signature 以原文嵌入，**定界发生在渲染那一刻**——注入模型的
// 调用点（lib/prompt.ts 的 renderRulesDigest 等）对整条 statement 过 fenceUntrusted；
// 本函数不自行加框，落库的正文保持原文。
//
// 分类 → 模板的对应收成一张表（不再用 switch 逐类枚举）：lib/digest-prompt.ts 的类别白名单、
// lib/rule-signature.ts 的登记表与本表是三份各自演化的数据，新增登记分类时漏改这里
// 会落到通用兜底、把稳定签名原文当具体路径嵌进正文。两条门禁在 test/digest.test.ts：
// 「类别清单与 CATEGORY_STATEMENTS 同域」管键集，「每个登记分类都真的起草出分类专属正文」
// 管选型（键集对上但模板 key 指错的形态只有后者抓得住）。

import { isRejectedSummarySignature, isStableSignature } from "./rule-signature.ts";
import { fill } from "./messages.ts";
import type { LessonLoopMessages } from "./messages.ts";

/** 消息表里 statement* 模板的键名（编译期钉住：写错键名 tsc 当场红）。 */
type StatementTemplateKey = {
  [Key in keyof LessonLoopMessages]: Key extends `statement${string}` ? Key : never;
}[keyof LessonLoopMessages];

/**
 * 单个登记分类的正文选型：
 * - stable-or-drafted：该类有"稳定签名 → 通用正文 / 其余签名 → 嵌占位正文"两档
 *   （碎片化修复的三个类别）；
 * - fixed：无论签名是什么，正文都是这一条模板（签名嵌占位或不嵌，随模板本身）；
 * - passthrough：signature 就是模型产出的正文本身，原样透传（feedback-digest）。
 */
/** 选型种类（字面量只此一份，表与分支都从它取）。 */
const KIND_TWO_TIER = "stable-or-drafted";
const KIND_FIXED = "fixed";
const KIND_PASSTHROUGH = "passthrough";

type StatementEntry =
  | {
      readonly kind: typeof KIND_TWO_TIER;
      readonly stable: StatementTemplateKey;
      readonly drafted: StatementTemplateKey;
    }
  | { readonly kind: typeof KIND_FIXED; readonly template: StatementTemplateKey }
  | { readonly kind: typeof KIND_PASSTHROUGH };

/** 登记分类 → 正文选型。键集与 lib/digest-prompt.ts 的类别白名单（DIGEST_CATEGORIES）
 *  同域，一致性由 test/digest.test.ts 的两条逐类探针钉住——两边漂移的后果是静默降级，
 *  不是崩溃，故必须有门禁。 */
export const CATEGORY_STATEMENTS: Readonly<Record<string, StatementEntry>> = Object.freeze({
  "factgate-deny": {
    kind: KIND_TWO_TIER,
    stable: "statementFactgateStable",
    drafted: "statementFactgatePath",
  },
  "dangerous-bash": {
    kind: KIND_TWO_TIER,
    stable: "statementDangerousBashStable",
    drafted: "statementDangerousBash",
  },
  "secret-path": {
    kind: KIND_TWO_TIER,
    stable: "statementSecretPathStable",
    drafted: "statementSecretPathTarget",
  },
  "gate-failure": { kind: KIND_FIXED, template: "statementGateFailure" },
  "transient-failure": { kind: KIND_FIXED, template: "statementTransientFailure" },
  "max-tokens": { kind: KIND_FIXED, template: "statementMaxTokens" },
  "unfinished-turn": { kind: KIND_FIXED, template: "statementUnfinishedTurn" },
  "feedback-digest": { kind: KIND_PASSTHROUGH },
});

/**
 * 候选规则 statement 模板：按分类起草，signature 原文嵌入（可读性优先）。
 * @param category - 教训分类（决定模板选型；开放集——第三方上报的分类走 default 模板）。
 * @param signature - 归一后的签名（嵌进模板，或作为 feedback-digest 的正文）。
 * @param messages - 当前语言的消息表。
 * @returns 起草出的规则正文。
 */
export function draftStatement(
  category: string,
  signature: string,
  messages: LessonLoopMessages,
): string {
  // rejected 归档汇总（`${稳定签名}:rejected`）先于分类模板判定：lesson-store 的
  // migrateRejectedFragments 对每个登记分类都会生成汇总卡，这批正文必须走分类无关的
  // 归档容器文案——埋进单个分类里，其余分类会把汇总签名当成路径/命令嵌进正文。
  // 精确比对（而非后缀探测）保证模型的普通正文不会被误判成汇总卡。
  if (isRejectedSummarySignature(category, signature)) {
    return fill(messages.statementRejectedSummary, { signature });
  }
  if (signature.trim().length === 0) {
    // 空签名（首尾空白折叠后为空）在旧分支会起草出坏正文：feedback-digest 直接
    // 透传成空 statement（arm 后注入面只剩一行空话），default 分支嵌出"详见证据"
    // 却无指向的半句。统一退到一条明说缺签名的占位正文，人审时看得见问题。
    return messages.statementMissingSignature;
  }
  // 普通对象索引会走原型链：category 是模型/第三方给的数据，\`toString\` / \`constructor\`
  // 这类键取到的是函数（entry.kind 为 undefined），于是落到文件末尾的原样透传——一条
  // 本应走通用兜底的正文把函数对象塞进注入面。用 Object.hasOwn 收口，键集之外一律
  // 走 statementGeneric（先 trim：登记分类是精确键，前后空白同样是漂移）。
  const categoryKey = category.trim();
  const entry = Object.hasOwn(CATEGORY_STATEMENTS, categoryKey)
    ? CATEGORY_STATEMENTS[categoryKey]
    : undefined;
  if (entry === undefined) {
    // 未登记分类（第三方上报）：通用兜底正文。
    return fill(messages.statementGeneric, { signature });
  }
  // 下面两支按 entry.kind 收口。末尾**故意**保留 return signature 而不是写成第三条
  // 判断：三档各自 return 会让 TS 把函数末尾判成不可达，而运行期再补一条 default /
  // throw 纯属不可达代码，只会白送一行未覆盖（共享覆盖率基线是四项 100%）。代价是
  // 「将来新增 kind 却忘了在这里跟」不会在编译期报错，而是静默落进原样透传——这条
  // 已知缺口登记在 REPORT 的未完成项，不在这里用不可达分支遮住。
  if (entry.kind === KIND_TWO_TIER) {
    // 稳定签名 → 通用正文：不再把具体路径/命令嵌进规则（碎片化修复的一部分）。
    if (isStableSignature(category, signature)) {
      return messages[entry.stable];
    }
    return fill(messages[entry.drafted], { signature });
  }
  if (entry.kind === KIND_FIXED) {
    return fill(messages[entry.template], { signature });
  }
  // 只剩 passthrough 一档（feedback-digest）：signature 本身即正文，原样返回。
  return signature;
}
