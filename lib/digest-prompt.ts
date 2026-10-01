// digest-prompt：蒸馏帧的**文本面**——背景条目、system 提示、用户帧拼装，以及模型产出的容错解析。
//
// 为什么从 lib/digest.ts 拆出来：digest.ts 剩下的部分是"跑一次蒸馏"（取差评 → 发流 → 建卡），
// 本模块只回答"送进模型的那段文字长什么样、模型吐回来的怎么读"。四枚导出都被 runDigest
// 逐段消费（背景 → system → 用户帧 → 解析），拆出来之后它们的 export 有了真实生产消费者；
// 此前消费者只有单测，`fallow --production` 把整层判成「只被测试养着的导出」。
//
// 与 lib/digest.ts 同一条纪律：进模型的提示词全部由调用点注入（`messages` 入参，见
// lib/messages.ts），本文件是纯函数、不读设置；蒸馏出来的规则条目是用户数据，原样透传。

import type { LessonStore } from "./lesson-store.ts";
import { unknownArray } from "./lesson-store.ts";
import { fenceUntrusted } from "./prompt.ts";
import type { NegativeFeedback } from "./negative-feedback.ts";
import { fill } from "./messages.ts";
import type { LessonLoopMessages } from "./messages.ts";
import { fieldOf, isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

/** 近期教训去重压背景（同 signature 只留最新一条 detail；全量文本）。 */
export function lessonsBackground(
  store: LessonStore,
  project: string,
  messages: LessonLoopMessages,
  limit = 40,
): string {
  const rows = store.recentLessons(project, limit);
  if (rows.length === 0) {
    return messages.lessonsNoHistory;
  }
  const bySig = new Map<
    string,
    { category: string; signature: string; detail: string; ts: number; source: string }
  >();
  for (const row of rows) {
    const sig = row.signature;
    const prev = bySig.get(sig);
    if (prev === undefined || row.ts > prev.ts) {
      bySig.set(sig, {
        category: row.category,
        signature: sig,
        detail: row.detail,
        ts: row.ts,
        source: row.source,
      });
    }
  }
  const lines = [...bySig.values()]
    .toSorted((left, right) => right.ts - left.ts)
    .map(
      (row) =>
        // 四个字段全来自上报方（工具错误原文/模型输出），逐个定界后再拼背景条目行。
        `- [${fenceUntrusted(row.source)}/${fenceUntrusted(row.category)}] ${fenceUntrusted(row.signature)}\n  ${fenceUntrusted(row.detail)}`,
    );
  return lines.join("\n");
}

/**
 * 蒸馏 system 提示里的输出契约行：JSON 键名与 category 取值域是**机器读的数据**
 * （取值域就是 `lesson-loop` 段 rules 里的归类键，翻译它等于改存储契约），故留在这里；
 * 只有两处 `<>` 里的说明走消息表。整行的两语骨架逐字节一致，见 digest.test.ts 的钉。
 */
const DIGEST_OUTPUT_SHAPE =
  '{"category":"<factgate-deny|dangerous-bash|secret-path|gate-failure|transient-failure|max-tokens|unfinished-turn|feedback-digest>","signature":"<{signature}>","statement":"<{statement}>"}';

/** 输出契约行（数据骨架 + 消息表的两段说明）。 */
function digestOutputShape(messages: LessonLoopMessages): string {
  return fill(DIGEST_OUTPUT_SHAPE, {
    signature: messages.digestSystemShapeSignature,
    statement: messages.digestSystemShapeStatement,
  });
}

/** 蒸馏 system 提示全文（三段来自消息表 → 输出契约行 → 一段来自消息表）。 */
export function digestSystemPrompt(messages: LessonLoopMessages): string {
  return [
    messages.digestSystemRole,
    messages.digestSystemShape,
    digestOutputShape(messages),
    messages.digestSystemRules,
  ].join("\n");
}

export function buildDigestPrompt(
  feedbacks: readonly NegativeFeedback[],
  background: string,
  messages: LessonLoopMessages,
  extra?: string,
): string {
  // 差评正文与分类标签都是人工输入（可含换行），逐字段定界后才进编号帧；
  // background 已由 lessonsBackground 定界，这里只拼自己的 `##` 分节标题。
  const fb = feedbacks
    .map((entry, index) => {
      const cat =
        entry.category === undefined
          ? ""
          : fill(messages.digestCategorySuffix, { category: fenceUntrusted(entry.category) });
      const scope =
        entry.kind === "session" ? messages.digestScopeSession : messages.digestScopeMessage;
      return `${index + 1}. ${scope}${cat} ${fenceUntrusted(entry.note)}`;
    })
    .join("\n");
  return [
    messages.digestSectionFeedback,
    fb.length > 0 ? fb : messages.digestNoFeedback,
    "",
    messages.digestSectionBackground,
    background,
    ...(extra !== undefined && extra.trim().length > 0
      ? ["", messages.digestSectionExtra, fenceUntrusted(extra.trim())]
      : []),
  ].join("\n");
}

/** 容错解析：取首个 JSON 数组块，逐项校验字段。 */
export function parseDigestOutput(
  text: string,
): { category: string; signature: string; statement: string }[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const out: { category: string; signature: string; statement: string }[] = [];
  // 切片以 `[` 开头且能 JSON.parse → 必为数组；非数组只可能是解析漂移，
  // 经 unknownArray 归空表（不再开一条不可达的显式分支）。
  for (const item of unknownArray(parsed)) {
    if (isRecord(item)) {
      const category = fieldOf(item, "category");
      const statement = fieldOf(item, "statement");
      const signature = fieldOf(item, "signature");
      if (typeof category === "string" && typeof statement === "string") {
        out.push({
          category,
          signature:
            typeof signature === "string" && signature.trim().length > 0
              ? signature
              : statement.slice(0, 60),
          statement,
        });
      }
    }
  }
  return out;
}
