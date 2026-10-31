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
import { z } from "zod";

/** 背景去重的**事件扫描窗**（条数）：先取更宽的窗口再按 category+signature 去重——
 *  只扫 limit 条事件时，热点签名（每拒绝一次就写一条的 dangerous-bash 一类）能把
 *  窗口吃满，去重后只剩一行，其它更早但互不相同的教训全被挤掉；背景的多样性反而
 *  被热点吃掉。扫描窗按解析缓存的承受力取，去重排序后的**行数**仍由 limit 收口。 */
const DEDUP_SCAN_EVENTS = 400;

/** 近期教训去重压背景：键 = 类别 + 签名（签名可空——存量行只校验了 typeof string，
 *  空签名合法），空签名回退到 detail 本身，避免一组空签名行互相吞掉；同键只留
 *  最新一条 detail，时间戳相同（同毫秒批量写入）时后出现者算"最新"。全量文本，
 *  行数至多 limit（最近 N 条**不同**教训，不是最近 N 条事件内的去重）。 */
export function lessonsBackground(
  store: LessonStore,
  project: string,
  messages: LessonLoopMessages,
  limit = 40,
): string {
  const rows = store.recentLessons(project, DEDUP_SCAN_EVENTS);
  if (rows.length === 0) {
    return messages.lessonsNoHistory;
  }
  const bySig = new Map<
    string,
    { category: string; signature: string; detail: string; ts: number; source: string }
  >();
  for (const row of rows) {
    const sig = row.signature;
    // 键用 JSON 序列化拼装而不是分隔符连接：category 与 detail 都是上报方可控文本，
    // 含 `\u0000` 时分隔符拼法会让两条不同的教训折进同一个键。
    const key = JSON.stringify([row.category, sig.length > 0 ? sig : row.detail]);
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
    .slice(0, limit)
    .map(
      (row) =>
        // 四个字段全来自上报方（工具错误原文/模型输出），逐个定界后再拼背景条目行。
        `- [${fenceUntrusted(row.source)}/${fenceUntrusted(row.category)}] ${fenceUntrusted(row.signature)}\n  ${fenceUntrusted(row.detail)}`,
    );
  return lines.join("\n");
}

/** category 的取值域（输出契约行与解析侧白名单共用同一份，杜绝两侧各自硬编码后漂移）。
 *  export 出来的唯一消费者是 test/digest.test.ts 的逐类探针：它拿这张清单去撞
 *  lib/statement-draft.ts 的 CATEGORY_STATEMENTS，新增分类却漏登记模板会当场红
 *  （漏登记会落到通用兜底，把稳定签名原文当具体路径嵌进正文）。 */
export const DIGEST_CATEGORIES: readonly string[] = [
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
  /** 被白名单/校验拒收的条目数（取自"赢下"的那个切片）：0 条结果既可能是"模型
   *  没提出"，也可能是"提了但全被拒收"——后者长期隐形会让类别白名单的漂移没人看见。 */
  readonly rejected: number;
}

/** category 取值域的查询表（解析侧白名单；与上面那条渲染行同源）。 */
const DIGEST_CATEGORY_SET: ReadonlySet<string> = new Set(DIGEST_CATEGORIES);

/** 模型输出的一条候选：类别在表内、正文非空白；签名缺省或空白时由调用点兜底。 */
const DIGEST_RULE_SCHEMA = z.object({
  category: z
    .string()
    .refine((value) => DIGEST_CATEGORY_SET.has(value), { error: "category 不在白名单内" }),
  statement: z.string().refine((value) => value.trim().length > 0, { error: "statement 不能为空" }),
  signature: z.preprocess(
    (value) => (typeof value === "string" && value.trim().length > 0 ? value : undefined),
    z.string().optional(),
  ),
});

/** 空签名时的兜底长度：从正文截一段当签名（按码点截，避免把代理对劈成孤立代理项）。 */
const SIGNATURE_FALLBACK_MAX = 60;

/** 按码点截断：字符串展开（[...text]）会被 no-misused-spread / prefer-spread 两条
 *  规则各打一板，for..of 按码点迭代两边都不犯。 */
function truncateCodePoints(text: string, max: number): string {
  let out = "";
  let counted = 0;
  for (const char of text) {
    if (counted >= max) {
      return out;
    }
    out += char;
    counted += 1;
  }
  return out;
}

/** 单条模型输出 → 候选：字段缺失、表外类别、空白 statement 一律拒收（返回 null）。
 *  表外类别丢弃的理由：category 是机器读的存储契约，落一张 `pass()` 永远匹配不到、
 *  也无法与事件类别对齐的卡没有意义。 */
function ruleFromItem(item: unknown): DigestParsedRule | null {
  const parsed = DIGEST_RULE_SCHEMA.safeParse(item);
  if (!parsed.success) {
    return null;
  }
  const { category, statement, signature } = parsed.data;
  return {
    category,
    signature: signature ?? truncateCodePoints(statement.trim(), SIGNATURE_FALLBACK_MAX),
    statement,
  };
}

/** 已解析数组 → 候选数组（逐项过滤，非对象项跳过），连同被拒收的条数。 */
function rulesFromArray(parsed: readonly unknown[]): {
  rules: DigestParsedRule[];
  rejected: number;
} {
  const rules: DigestParsedRule[] = [];
  let rejected = 0;
  for (const item of parsed) {
    const rule = ruleFromItem(item);
    if (rule === null) {
      rejected += 1;
    } else {
      rules.push(rule);
    }
  }
  return { rules, rejected };
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

/** 解析尝试上限：输入是模型输出原文（长度不受限），双指针逐切片 JSON.parse 的最坏
 *  成本随方括号数量平方增长，而墙钟在解析前已经清掉——超限直接判不可解析（输出
 *  本来就不正常），把主线程被卡住的代价挡在常数内。 */
const MAX_PARSE_SLICES = 500;
/** 单个切片的长度上限：合法的候选数组只有几 KB；超长切片只可能是把大半个输出
 *  包进方括号的病态形态，跳过它比解析它便宜，也让上面那条尝试上限真正封顶。 */
const MAX_SLICE_CHARS = 65_536;

/** 逐档候选切片：每个 `[` 配其后的每个 `]`，按位置序交出（正文夹带的方括号被逐档
 *  剥在外面）；超长切片不产出。 */
function* candidateSlices(text: string): Generator<string> {
  for (let start = text.indexOf("["); start !== -1; start = text.indexOf("[", start + 1)) {
    for (let end = text.indexOf("]", start + 1); end !== -1; end = text.indexOf("]", end + 1)) {
      // `end` 随内层循环单调递增：第一个超长候选出现时，这个 `[` 之后的所有候选都超长，
      // 直接换下一个 `[`——否则内层仍要把尾部每个 `]` 走完，上面那条尝试上限承诺的
      // "常数封顶"不成立（输出长度不受限，O(方括号数²) 的比较照旧发生）。
      if (end + 1 - start > MAX_SLICE_CHARS) {
        break;
      }
      yield text.slice(start, end + 1);
    }
  }
}

/** 逐档回退扫描：第一个能提出候选的切片赢（正文夹带的方括号、只含噪音的数组都被
 *  跳过）；一个都提不出时回 null。 */
function rulesFromBestSlice(text: string): { rules: DigestParsedRule[]; rejected: number } | null {
  let attempts = 0;
  // "解析成了合法数组但条目全被过滤"的那一档：后续切片都提不出候选时，它就是
  // 最佳结果——rejected 计数要能带到日志（全拒收与"模型什么都没提"必须可区分）。
  let parsedButEmpty: { rules: DigestParsedRule[]; rejected: number } | undefined;
  for (const slice of candidateSlices(text)) {
    attempts += 1;
    if (attempts > MAX_PARSE_SLICES) {
      // 超限也要交回已经拿到的确定结论：`parsedButEmpty` 里可能是"解析成数组但条目全被
      // 白名单拒收"的那一档，它的 rejected 计数是 digest 侧"模型提了条目却全被拒"告警的
      // 唯一来源，丢掉它就等于把输出损坏与"什么都没提"混成一档。
      return parsedButEmpty ?? null;
    }
    // 这一档切不上（JSON 语法坏）就换下一个 `]` 再试（多候选切片）。
    const parsed = asArrayOrUndefined(parseSlice(slice));
    if (parsed !== undefined) {
      const counted = rulesFromArray(parsed);
      if (counted.rules.length > 0) {
        return counted;
      }
      // 只留第一个空数组会丢信息：前言的 `[]`（rejected=0）会顶掉后面"全被拒收"的那一档，
      // rejected 归零、全拒收告警静默消失。按 rejected 取大者。
      if (parsedButEmpty === undefined || counted.rejected > parsedButEmpty.rejected) {
        parsedButEmpty = { rules: [], rejected: counted.rejected };
      }
    }
  }
  return parsedButEmpty ?? null;
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
  const best = rulesFromBestSlice(text);
  const rules = best?.rules ?? [];
  // `best !== null` 即"至少有一个切片解析成了数组"（含 `[]` 与全被拒收的那一档）：
  // rulesFromBestSlice 的回退结论与复扫 firstArraySlice 的结论逐档一致，不必再扫一遍。
  const readable = best !== null;
  return { rules, parsed: readable, rejected: best?.rejected ?? 0 };
}
