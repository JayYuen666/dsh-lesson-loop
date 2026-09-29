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

import { CATEGORY_SIGNATURES } from "./rule-signature.ts";
import { fill } from "./messages.ts";
import type { LessonLoopMessages } from "./messages.ts";

/**
 * 候选规则 statement 模板：按分类起草，signature 原文嵌入（可读性优先）。
 * @param category - 教训分类（决定模板选型）。
 * @param signature - 归一后的签名（嵌进模板，或作为 feedback-digest 的正文）。
 * @param messages - 当前语言的消息表。
 * @returns 起草出的规则正文。
 */
export function draftStatement(
  category: string,
  signature: string,
  messages: LessonLoopMessages,
): string {
  switch (category) {
    case "factgate-deny": {
      // 稳定签名 → 通用正文：不再把具体路径嵌进规则（碎片化修复的一部分）。
      if (signature === CATEGORY_SIGNATURES["factgate-deny"]) {
        return messages.statementFactgateStable;
      }
      // rejected 汇总签名（${stable}:rejected）→ 归档容器文案，不嵌占位。
      if (signature.endsWith(":rejected")) {
        return fill(messages.statementFactgateRejected, { signature });
      }
      return fill(messages.statementFactgatePath, { signature });
    }
    case "dangerous-bash": {
      return fill(messages.statementDangerousBash, { signature });
    }
    case "secret-path": {
      // 稳定签名 → 通用正文：具体是哪个凭据文件在 evidence.signature 里，正文不嵌占位。
      if (signature === CATEGORY_SIGNATURES["secret-path"]) {
        return messages.statementSecretPathStable;
      }
      return fill(messages.statementSecretPathTarget, { signature });
    }
    case "gate-failure": {
      return fill(messages.statementGateFailure, { signature });
    }
    case "transient-failure": {
      return fill(messages.statementTransientFailure, { signature });
    }
    case "max-tokens": {
      return messages.statementMaxTokens;
    }
    case "unfinished-turn": {
      return messages.statementUnfinishedTurn;
    }
    case "feedback-digest": {
      return signature;
    }
    default: {
      return fill(messages.statementGeneric, { signature });
    }
  }
}
