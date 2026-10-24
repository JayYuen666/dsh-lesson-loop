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
import { fenceUntrusted } from "./prompt.ts";
import type { NegativeFeedback } from "./negative-feedback.ts";
import { fill } from "./messages.ts";
import type { LessonLoopMessages } from "./messages.ts";
import { fieldOf, isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

/** 近期教训去重压背景：键 = 类别 + 签名（签名可空——存量行只校验了 typeof string，
 *  空签名合法），空签名回退到 detail 本身，避免一组空签名行互相吞掉；同键只留
 *  最新一条 detail，时间戳相同（同毫秒批量写入）时后出现者算"最新"。全量文本。 */
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
    const key = `${row.category}\u0000${sig.length > 0 ? sig : row.detail}`;
    const prev = bySig.get(key);
    if (prev === undefined || row.ts >= prev.ts) {
      bySig.set(key, {
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

/** category 的取值域（输出契约行与解析侧白名单共用同一份，杜绝两侧各自硬编码后漂移）。 */
const DIGEST_CATEGORIES: readonly string[] = [
  "factgate-deny",
  "dangerous-bash",
  "secret-path",
  "gate-failure",
  "transient-failure",
  "max-tokens",
  "unfinished-turn",
  "feedback-digest",
];

/**
 * 蒸馏 system 提示里的输出契约行：JSON 键名与 category 取值域是**机器读的数据**
 * （取值域就是 `lesson-loop` 段 rules 里的归类键，翻译它等于改存储契约），故留在这里；
 * 只有两处 `<>` 里的说明走消息表。取值域由 {@link DIGEST_CATEGORIES} 渲染，解析侧的
 * 白名单与之同源。整行的两语骨架逐字节一致，见 digest.test.ts 的钉。
 */
const DIGEST_OUTPUT_SHAPE = `{"category":"<${DIGEST_CATEGORIES.join("|")}>","signature":"<{signature}>","statement":"<{statement}>"}`;

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
  fencedBackground: string,
  messages: LessonLoopMessages,
  extra?: string,
): string {
  // 差评正文与分类标签都是人工输入（可含换行），逐字段定界后才进编号帧；
  // 形参名把防注入契约钉在签名上：background 必须是已经 fenceUntrusted 定界过的文本
  // （生产路径由 lessonsBackground 交出），本函数不再自行处理。
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
    fencedBackground,
    ...(extra !== undefined && extra.trim().length > 0
      ? ["", messages.digestSectionExtra, fenceUntrusted(extra.trim())]
      : []),
  ].join("\n");
}

/** 解析后的一条候选规则（category 已过取值域白名单）。 */
export interface DigestParsedRule {
  category: string;
  signature: string;
  statement: string;
}

export interface DigestParseResult {
  /** 过滤后的候选（表外类别与空白 statement 的条目被丢弃）。 */
  readonly rules: DigestParsedRule[];
  /** false = 找不到任何能解析成 JSON 数组的切片（模型输出损坏/被截断）；
   *  true 但 rules 为空 = 合法的空数组（模型确实没提出条目）。两者必须可区分，
   *  否则输出损坏会被当成"蒸馏出 0 条"静默成功。 */
  readonly parsed: boolean;
}

/** category 取值域的查询表（解析侧白名单；与上面那条渲染行同源）。 */
const DIGEST_CATEGORY_SET: ReadonlySet<string> = new Set(DIGEST_CATEGORIES);

/** 单条模型输出 → 候选：字段缺失、表外类别、空白 statement 一律拒收（返回 null）。
 *  表外类别丢弃的理由：category 是机器读的存储契约，落一张 `pass()` 永远匹配不到、
 *  也无法与事件类别对齐的卡没有意义。 */
function ruleFromItem(item: unknown): DigestParsedRule | null {
  if (!isRecord(item)) {
    return null;
  }
  const category = fieldOf(item, "category");
  const statement = fieldOf(item, "statement");
  const signature = fieldOf(item, "signature");
  if (
    typeof category !== "string" ||
    !DIGEST_CATEGORY_SET.has(category) ||
    typeof statement !== "string" ||
    statement.trim().length === 0
  ) {
    return null;
  }
  return {
    category,
    signature:
      typeof signature === "string" && signature.trim().length > 0
        ? signature
        : statement.slice(0, 60),
    statement,
  };
}

/** 已解析数组 → 候选数组（逐项过滤，非对象项跳过）。 */
function rulesFromArray(parsed: readonly unknown[]): DigestParsedRule[] {
  const rules: DigestParsedRule[] = [];
  for (const item of parsed) {
    const rule = ruleFromItem(item);
    if (rule !== null) {
      rules.push(rule);
    }
  }
  return rules;
}

/** 切片解析：能 JSON.parse 就交 unknown（不经 any 扩散）；语法坏回 null（null 永远
 *  不会是数组，与合法切片天然可分）。 */
function parseSlice(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return null;
  }
}

/** 数组守卫：Array.isArray 只把值收成 any[]，读原文要 readonly unknown[]。 */
function asArrayOrUndefined(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** 逐档回退扫描：第一个能提出候选的切片赢（正文夹带的方括号、只含噪音的数组都被
 *  跳过）；一个都提不出时回 null。 */
function rulesFromBestSlice(text: string): DigestParsedRule[] | null {
  for (let start = text.indexOf("["); start !== -1; start = text.indexOf("[", start + 1)) {
    for (let end = text.indexOf("]", start + 1); end !== -1; end = text.indexOf("]", end + 1)) {
      // 这一档切不上（JSON 语法坏）就换下一个 `]` 再试（多候选切片）。
      const parsed = asArrayOrUndefined(parseSlice(text.slice(start, end + 1)));
      if (parsed !== undefined) {
        const rules = rulesFromArray(parsed);
        if (rules.length > 0) {
          return rules;
        }
      }
    }
  }
  return null;
}

/** 首个能解析成数组的切片；找不到回 null（全部切片都切不上）。 */
function firstArraySlice(text: string): readonly unknown[] | null {
  for (let start = text.indexOf("["); start !== -1; start = text.indexOf("[", start + 1)) {
    for (let end = text.indexOf("]", start + 1); end !== -1; end = text.indexOf("]", end + 1)) {
      const parsed = asArrayOrUndefined(parseSlice(text.slice(start, end + 1)));
      if (parsed !== undefined) {
        return parsed;
      }
    }
  }
  return null;
}

/**
 * 容错解析：从每个 `[` 位置起、配合其后的每个 `]` 逐档回退尝试。优先交回**第一个能
 * 提出候选**的切片——正文夹带方括号（前言的 `[1]`、尾注的 `]`、模型输出多个数组）时，
 * 一刀切的"首 `[` 到尾 `]`"会整段报废；逐档回退则把混入的方括号剥在外面。全部切片
 * 都提不出候选时，回退到首个能解析成数组的切片（它可能是合法的空数组"[]"，也可能是
 * 纯噪音数组——两者都按 parsed:true 交回空候选）；连一个都找不到才是 parsed:false
 * （输出损坏/被截断）。
 */
export function parseDigestOutput(text: string): DigestParseResult {
  const rules = rulesFromBestSlice(text) ?? [];
  const readable = rules.length > 0 || firstArraySlice(text) !== null;
  return { rules, parsed: readable };
}
