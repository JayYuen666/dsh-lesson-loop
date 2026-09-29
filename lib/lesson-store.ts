// lesson-store：教训总线的领域核心（纯 TS，宿主依赖只从 RulesRepository 端口进来）。
//
// 职责（五段闭环的"沉淀 + 度量 + 衰减"全部在这里）：
//   沉淀 —— 教训全量落 **官方 cache 目录**的事件流水 JSONL（默认不设上限；可选
//           maxBytes 仅作磁盘保险，不为省 token 截断内容——用户拍板"保持功能强大"）；
//           cache 是 dsh 定位的"可丢弃派生数据"目录，流水正是这一类；
//   蒸馏 —— 同 (project, category, signature) 教训达 promoteThreshold 归并为
//           候选规则卡（statement 由分类模板按当前语言起草、人工可改；模板见
//           lib/messages.ts，已落库的正文是用户数据、永不随语言改写）；
//   升格 —— **只有人工确认**（卡片 arm / reject），与 loop-design-check 的
//           "人保留判断"红线一致，机器永不自动 armed；
//   度量 —— armed 后三个计数器回答三个不同的问题，彼此不可互替：
//           violation   规则场景再被触发且被违反（复发，规则无效的信号）；
//           suppressed  规则场景再被触发且被遵守（pass 信号驱动的"干净命中"，
//                        规则起效的信号——也是复发率唯一合法的"清白"分母项）；
//           samples     规则在场且会话未违规的"暴露"会话数（度量的是曝光，
//                        不是正确性：无关干净会话抬高它，绝不进复发率分母）。
//   衰减 —— 复发率裁决只用真实证据（observed+violation）：violation/(violation+
//           suppressed) ≥ demoteRatio 且 observed+violation 足量才自动降级待人审；
//           样本量 samples 永不进分母（旧设计回避的分母灌水风险继续回避）。
//           armed 超 decayDays 且 violation+suppressed 双零 → 判"不可判定"
//           （既非违规亦无一次干净命中，机器无从裁定），保留 armed 交人工，
//           由 /stats 与卡片显式提示——不再静默归档（人工仍可手动归档）。
//
// 规则库的存放面是设置命名空间（= 本包 profile 条目 id `lesson-loop`）里的 `rules`
// 数组字段（见 lib/rules-namespace.ts）。
// 本文件只依赖 RulesRepository 端口：读 = 拿"这一刻"的数组 + revision，写 = 带
// revision 的 CAS。多进程共库的纪律因此从"读前对齐磁盘指纹"变成"写前重读 + CAS
// 重读重放"（LessonStore.commit），**绝不把基于陈旧读的整数组写回去**。

import { randomUUID } from "node:crypto";
import { deriveProjectKey } from "@jayyuen666/dsh-plugin-shared/lib/project-key";
import type { LessonLoopMessages } from "./messages.ts";
import { fieldOf, isRecord } from "@jayyuen666/dsh-plugin-shared/lib/record";
// 事件流水的落盘面（追加/读取/磁盘保险丝）在 lib/lesson-jsonl.ts：这一层的失败纪律是"只日志、
// 不抛穿热路径"，与本文件的规则库 CAS 回执是两件事，因此分家。
import { appendJsonl, readJsonl } from "./lesson-jsonl.ts";
// 键的算法（签名归一 + 类别级稳定签名 + 归并键）与正文起草各自成层：写入侧、查找侧、迁移侧
// 与 lib/statement-draft.ts 必须算出同一个串，一处漏调就长成"写得进、查不到"的键漂移。
import {
  CATEGORY_SIGNATURES,
  looksLikePathSignature,
  normalizeSignature,
  ruleKey,
  stableSignatureFor,
} from "./rule-signature.ts";
import { draftStatement } from "./statement-draft.ts";
// 衰减裁决只吃计数器与阈值，没有任何存放面读写；store 侧负责把 settings 现读的阈值组装成
// DecayPolicy 递给它。
import { DEFAULT_DECAY, decayVerdict } from "./decay-policy.ts";
import type { DecayPolicy } from "./decay-policy.ts";

// ── 守卫小件（泛型防御纵深，不用断言）──────────────────────────────────

const RULE_STATUSES: ReadonlySet<string> = new Set([
  "candidate",
  "armed",
  "demoted",
  "rejected",
  "archived",
]);

function isRuleStatus(value: unknown): value is RuleStatus {
  return typeof value === "string" && RULE_STATUSES.has(value);
}

/**
 * 内置已知来源（观察端五个生产者）。**开放集**：第三方插件自报的来源名同样合法
 * （见 normalizeLessonSource），本表只用来判定"是不是内置值"（内部调用方与
 * 统计口径用它，不再当白名单用）。
 */
export type KnownLessonSource =
  | "danger-guard"
  | "quality-gate"
  | "session-rescue"
  | "lessons-digest"
  | "manual";

/**
 * `/lessons-digest` 蒸馏生产者的来源名——**同一个串在两处枚举面出现**：既是内置来源
 * `KnownLessonSource` 的一员（`digest.ts` 上报时带它），也是蒸馏建卡的 `RuleOrigin`
 * （`addCandidate` 的默认 source 与 origin）。字面量写四遍就改四处，故收成这一枚。
 */
const LESSONS_DIGEST_SOURCE = "lessons-digest" as const;

const KNOWN_LESSON_SOURCES: readonly KnownLessonSource[] = [
  "danger-guard",
  "quality-gate",
  "session-rescue",
  LESSONS_DIGEST_SOURCE,
  "manual",
];

const KNOWN_SOURCE_SET: ReadonlySet<string> = new Set(KNOWN_LESSON_SOURCES);

/** 内置来源判定（供卡片/统计区分"宿主自带生产者"与第三方上报）。 */
export function isKnownLessonSource(value: unknown): value is KnownLessonSource {
  return typeof value === "string" && KNOWN_SOURCE_SET.has(value);
}

/** 内置五个之外的兜底来源名。 */
const FALLBACK_LESSON_SOURCE: KnownLessonSource = "manual";

/** 来源名长度上限：防把整段错误文本塞进来源字段（枚举面失控、卡片无法归因）。 */
const MAX_LESSON_SOURCE_LENGTH = 64;

/**
 * 来源归一（开放集）：trim 后非空且不过长 → 原样保留（第三方插件得以自报家门，
 * 其教训与内置来源一样可入库、可统计）；空/非字符串/超限 → manual。
 *
 * 为什么退 manual 而不是拒收：manual 是"有人记了这条、但说不出是谁"的最保守归属，
 * 不因此把它当成某个内置生产者的机器上报（内置来源的归因语义不许被稀释）。
 */
function normalizeLessonSource(value: unknown): string {
  if (typeof value !== "string") {
    return FALLBACK_LESSON_SOURCE;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LESSON_SOURCE_LENGTH) {
    return FALLBACK_LESSON_SOURCE;
  }
  return trimmed;
}

/** 归一后落回 manual 的"本来说了别的"情形：必须留日志，否则第三方接入只表现为静默降级。 */
function noteSourceFallback(raw: unknown, source: string): string {
  if (source === FALLBACK_LESSON_SOURCE && typeof raw === "string" && raw.trim().length > 0) {
    console.warn(
      `[lesson-loop] lesson source "${raw.trim().slice(0, MAX_LESSON_SOURCE_LENGTH + 8)}" 不可用（非空但超 ${String(MAX_LESSON_SOURCE_LENGTH)} 字符），按 manual 记账`,
    );
  }
  return source;
}

const RULE_ORIGINS: ReadonlySet<string> = new Set(["threshold", LESSONS_DIGEST_SOURCE, "manual"]);

function isRuleOrigin(value: unknown): value is RuleOrigin {
  return typeof value === "string" && RULE_ORIGINS.has(value);
}

/** origin 归一：字段缺失的存量卡都出自阈值归并（digest 建卡更晚），故退 threshold。 */
function originOf(value: unknown): RuleOrigin {
  return isRuleOrigin(value) ? value : "threshold";
}

/** status 归一：漂移状态退 archived（不注入、不度量的最保守态），人工可 revive。 */
function statusOf(value: unknown): RuleStatus {
  return isRuleStatus(value) ? value : "archived";
}

/** 字符串字段归一：非字符串（缺字段/类型漂移）退兜底，绝不整条丢弃。 */
function strField(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** 数值字段读取：只认 number 与数字字符串两种存量形态；NaN/null/布尔/对象一律视为漂移。 */
function numericOf(value: unknown): number | undefined {
  let result: number | undefined;
  if (typeof value === "number" || typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      result = parsed;
    }
  }
  return result;
}

/** 必填数值字段归一：漂移退兜底（计数与时间戳缺了就没法渲染、排序、衰减）。 */
function numField(value: unknown, fallback: number): number {
  const parsed = numericOf(value);
  return parsed ?? fallback;
}

/** 未知数组：非数组退空表（不经 any 扩散，逐元素仍是 unknown）。 */
export function unknownArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

// ── 类型 ──────────────────────────────────────────────────────────────────

/**
 * 教训来源（生产者插件）：**开放集**——任意非空、不过长的字符串都可入库，第三方
 * 插件经 ctx.get('lessonLoop') 自报名字即可被归因与统计（归一规则见
 * normalizeLessonSource）。内置五个值见 KnownLessonSource。
 */
export type LessonSource = string;

/** 一条教训：一次具体失败的结构化记录（detail 全量，不截断）。 */
export interface LessonRecord {
  ts: number;
  source: LessonSource;
  /** 分类：factgate-deny / dangerous-bash / secret-path / gate-failure /
   *  transient-failure / max-tokens / unfinished-turn / feedback-digest / … */
  category: string;
  /** 项目桶：shared/lib/project-key.ts 的规范派生（尾目录名-<cwd sha256 前 8 位>），
   *  与记忆网关 deriveAgentId 同语义，保证教训与"上次栽的坑"记忆落在同一桶，
   *  跨系统可对照。 */
  project: string;
  cwd?: string;
  sessionId?: string;
  turn?: number;
  /** 去重签名：同类的稳定键（如门禁命令串、目标路径、provider 名）。 */
  signature: string;
  /** 全量细节（拒绝理由 / 门禁输出 / 失败分类），绝不截断。 */
  detail: string;
  evidence?: Record<string, unknown>;
}

export type RuleStatus = "candidate" | "armed" | "demoted" | "rejected" | "archived";

/** 规则来源：阈值归并 / 差评蒸馏 / 人工补录（存量卡缺此字段时按 threshold 归一）。 */
export type RuleOrigin = "threshold" | "lessons-digest" | "manual";

/** 一条原始证据：教训的全量 detail（不截断），按时间序追加。 */
export interface RuleEvidence {
  ts: number;
  source: LessonSource;
  detail: string;
  /** 被类别级稳定签名折叠掉的**原始**签名（路径 / 命令行）。
   *  键负责汇聚、证据负责可追溯：卡片按类别命中一次教训时，"是哪条路径/哪条命令"
   *  只存在这里。未发生折叠（签名即键）时不落此字段，避免同一串存两份。 */
  signature?: string;
}

/** 规则卡：教训的蒸馏形态与度量载体。 */
export interface RuleCard {
  id: string;
  project: string;
  /** 建卡时上报的会话 cwd（migrateProjectKeys 重算 project 的唯一依据）。
   *  存量卡没有这个字段 → 迁移一律不碰它：桶键是跨系统契约，宁可少迁不可猜错。 */
  cwd?: string;
  category: string;
  signature: string;
  /** 规则正文（候选期由模板起草，arm 时可人工改写；注入全文，不设 token 上限）。 */
  statement: string;
  status: RuleStatus;
  createdAt: number;
  updatedAt: number;
  armedAt?: number;
  /** 该签名累计观察到的教训次数（候选期累积，armed 后由 violation 继续计）。 */
  occurrences: number;
  sources: LessonSource[];
  /** armed 后同类教训复发次数（规则无效/未被遵守的信号）。 */
  violation: number;
  /** armed 后「规则场景被触发且被遵守」的会话数（pass 信号驱动，规则起效的信号）。
   *  即设计文档所称的 observed clean hits——字段名沿用 suppressed（存量库与前端契约
   *  稳定），语义就是"测到且被遵守"，与 samples（在场未被违反的暴露数）严格区分：
   *  复发率分母只认 violation+suppressed，samples 永不进分母。 */
  suppressed: number;
  /** armed 后该规则"在场且未被违反"的会话数（暴露度，非正确性度量）：
   *  同项目、armed、会话收尾未违规即 +1，无论是否 pass。用于回答"这条规则到底
   *  被测过没有"，绝不参与降级裁决（否则无关干净会话会灌大分母、稀释复发率）。 */
  samples: number;
  /** rejected 后同签名再次出现的次数（达阈值自动转回候选待重审）。 */
  recurrences: number;
  lastSeenAt?: number;
  lastViolationAt?: number;
  lastSuppressedAt?: number;
  /** 原始证据（教训全量 detail，按时间序追加，不截断）。 */
  evidence: RuleEvidence[];
  origin: RuleOrigin;
}

/** report() 的回执：调用方可据此日志，不改行为。 */
export interface ReportReceipt {
  /** false = 这一次改动没进规则库（两类失败见 PERSIST_FAILED），调用方需提示用户重试。 */
  ok: boolean;
  reason?: string;
  /** 命中的 armed 规则（violation 已 +1）。 */
  violationOf?: RuleCard;
  /** 归并到的候选卡（occurrences 已 +1；ready = 达到升格门槛待人工确认）。 */
  candidate?: RuleCard;
  ready?: boolean;
}

/**
 * 落盘失败回执的 reason（与 not-found 区分：前者是"没存住、可重试"，后者是 id 错了）。
 *
 * 一次写不出两类失败，全部收成这一个值，因为它对调用方只有一层含义：**这一次改动没
 * 有进到规则库**。为什么不再是旧契约那句"内存已改、只是没落盘"——本文件已没有跨调用
 * 存活的内存数组（每笔改动都从端口重读、在"这一刻"的数组上重放，见 LessonStore.commit），
 * "没落盘"因此就等于"没生效"：
 *   (a) 端口明确拒绝（rejected，含 usable:false 的不可写面）：连别人的最新状态都没读到
 *       可信值，这一次改动既不许写出去、也不留在任何地方——留着就是替坏数据背书。
 *   (b) CAS 冲突耗尽（conflict 用满 RULES_CAS_RETRY_LIMIT）：对方确实在推进 revision，
 *       这一次改动同样不外推、不缓存，重试权交回拿着回执的调用方；下一笔仍旧先重读端口，
 *       于是永远不可能拿陈旧内存覆掉别人写好的卡。
 * 两类共用一个回执值：调用方的处置动作（提示重试）完全一致，差别只落在端口回执与
 * commit 的重试行为上（(a) 不重试、(b) 重读到上限）。
 */
export const PERSIST_FAILED = "rules-not-persisted";

/** 人工动作结果：persisted 已落盘；not-found 无此卡；persist-failed 这一次没存住（需重试）。 */
export type RuleActionResult = "persisted" | "not-found" | "persist-failed";

// ── 规则库端口（settings 命名空间的读写面；实现在 lib/rules-namespace.ts）────

/**
 * 一次规则库读取：`cards` 是"这一刻"解析出的卡（逐行归一后的**新对象**，改它不会
 * 渗回端口），`revision` 是这次读取对应的版本号（写回时作 CAS 条件）。
 */
export interface RulesRead {
  readonly revision: number;
  readonly cards: readonly RuleCard[];
  /**
   * false = 该命名空间当前读不出可信值（注册被存量坏数据打回 / provider 缺位 /
   * 注册已被回收）。此时**读面与写面都算空/拒**——把"读不懂"当成"真的没有"再写回去，
   * 等于替坏数据背书并把别人写好的卡覆掉，这是旧实现里最贵的那类错误。端口即便在
   * usable:false 下递来数组（存量假件、provider 半解析结果），本文件也不认：见
   * LessonStore.workingCards 与 commit 的可信读判定。
   */
  readonly usable: boolean;
}

/** 一次规则库写的结果。conflict = revision 已被别处推进（该重读重放）；rejected = 其它失败。 */
export type RulesWriteOutcome = "persisted" | "conflict" | "rejected";

/** 规则库读写端口：host 侧由 settings provider 实现，测试用同一接口的内存假件。 */
export interface RulesRepository {
  /** 读这一刻的库（同步：provider 的 describe() 就是同步快照）。 */
  readonly load: () => RulesRead;
  /** 带 revision 的 CAS 整片写；回执见 RulesWriteOutcome。 */
  readonly save: (cards: readonly RuleCard[], revision: number) => Promise<RulesWriteOutcome>;
}

/**
 * CAS 冲突后的"重读 + 重放"上限。
 *
 * 3 次足够：冲突只会来自"另一个进程/另一条写队列在我读之后推进了 revision"，
 * 每轮重试都会拿到含对方改动的新数组，重放的是本进程这一次改动。超过上限仍冲突
 * 说明写队列被卡住：按 PERSIST_FAILED 注释里的 (b) 类回执，不外抛，也不把这一次改动
 * 缓存下来等下一笔顺手写走。
 * ⚠ 上限值只在 commit() 用；测试侧要钉的是"读 N 次、写 N 次"这个数本身，故那边写死字面量
 * （引常量就成了自证），这里不再开 export 面。
 */
const RULES_CAS_RETRY_LIMIT = 3;

export interface StoreOptions {
  /** 事件流水 JSONL（官方 cache 目录下；单写者追加）。 */
  lessonsFile: string;
  /** 规则库端口（设置命名空间 `lesson-loop` 的 `rules` 数组）。 */
  rules: RulesRepository;
  /**
   * 起草新候选卡正文用的消息表（中英双语，见 lib/messages.ts 的 statement* 段）。
   *
   * 注入的是**取用口**而不是表本身：host 侧每次现取（用户在「设置 → 常规」换语言后，
   * 下一条起草出来的规则正文就是新语言，不需要重启）。本文件仍不读 settings——
   * 语言判定留在 host，这里只吃注入物（同 `rules` 端口的分法）。
   */
  messages: () => LessonLoopMessages;
  /** lessons JSONL 磁盘保险丝（字节）。0 = 不设上限（默认，内容零截断）。 */
  maxLessonsBytes?: number;
  promoteThreshold?: number;
  demoteThreshold?: number;
  demoteMinSamples?: number;
  demoteRatio?: number;
  decayDays?: number;
  /** rejected 规则再次出现到此次数 → 自动转回候选待人工重审（默认 3，1-20）。 */
  reviveThreshold?: number;
  now?: () => number;
}

// ── 写入侧的键与证据组装（签名算法见 lib/rule-signature.ts）──────────────

/** cwd → 项目桶。派生本体在 shared/lib/project-key.ts（与 quality-gate 的
 *  deriveAgentId 同源）；此处只留本包的既有导出名，别再长第二份实现。 */
export function deriveProject(cwd: unknown): string {
  return deriveProjectKey(cwd);
}

/** 可选字符串字段：非空字符串才认（缺失/空串/类型漂移一律视为"没有这个字段"，
 *  读写两侧都不写 undefined 键——exactOptionalPropertyTypes 下键存在与否有语义）。 */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** 一次教训在写入侧的全部要素：键用的签名（已折叠）、证据用的原始签名、可重算桶键
 *  的 cwd。report() 的两条支路共用同一份，键计算因此只有一处。 */
interface Observation {
  rec: LessonRecord;
  now: number;
  rawSignature: string;
  signature: string;
  cwd?: string;
}

function observeLesson(rec: LessonRecord, now: number): Observation {
  const rawSignature = normalizeSignature(rec.signature);
  const cwd = nonEmptyString(rec.cwd);
  return {
    rec,
    now,
    rawSignature,
    signature: stableSignatureFor(rec.category, rawSignature),
    ...(cwd === undefined ? {} : { cwd }),
  };
}

/** 证据行组装：发生折叠时把原始签名（路径/命令行）随证据落下，键只管汇聚。 */
function evidenceRow(
  ts: number,
  source: LessonSource,
  detail: string,
  raw: string,
  folded: string,
): RuleEvidence {
  return { ts, source, detail, ...(raw === folded ? {} : { signature: raw }) };
}

/** 状态权威序（同键撞卡时谁当主卡）：人工决定 > 机器状态，与 migrateFragmentRules
 *  "人工升格/拒绝不被机器改写"的同一条红线；同级再看观察次数。 */
const STATUS_AUTHORITY: Record<RuleStatus, number> = {
  candidate: 0,
  demoted: 0,
  archived: 1,
  rejected: 2,
  armed: 3,
};

/**
 * 挑主卡：返回 [主卡, 被并卡]。人工状态优先（armed > rejected > archived > 候选/
 * 降级），同级取 occurrences 多者（保持入参顺序优先，结果与卡片在列表里的位置无关）。
 * 因为 armed 一定胜出，被丢掉的那张不可能带着未迁移的 violation/suppressed ——
 * 不需要 migrateProjectFragments 里那步 inheritArmed。
 */
function pickMergePair(left: RuleCard, right: RuleCard): [RuleCard, RuleCard] {
  const leftAuthority = STATUS_AUTHORITY[left.status];
  const rightAuthority = STATUS_AUTHORITY[right.status];
  if (leftAuthority > rightAuthority) {
    return [left, right];
  }
  if (rightAuthority > leftAuthority) {
    return [right, left];
  }
  return left.occurrences >= right.occurrences ? [left, right] : [right, left];
}

/** 证据行归一：逐字段补默认（非对象的证据元素在 unknownArray 之后仍可能为 null）。 */
function normalizeEvidenceRow(value: unknown): RuleEvidence {
  const row: RuleEvidence = {
    ts: numField(fieldOf(value, "ts"), 0),
    source: normalizeLessonSource(fieldOf(value, "source")),
    detail: strField(fieldOf(value, "detail"), ""),
  };
  // 折叠进键的原始签名：非字符串（缺字段/漂移）就当没发生折叠，不写 undefined 键。
  const original = nonEmptyString(fieldOf(value, "signature"));
  if (original !== undefined) {
    row.signature = original;
  }
  return row;
}

/**
 * 规则卡逐字段归一（存量文件漂移容错）。
 *
 * 旧实现只查 id/category/status 就断言整张 RuleCard，缺 evidence/sources 的存量卡
 * 会在 report() 的 rule.evidence.push 处 TypeError——一条坏记录让总线**永久**抛错，
 * 而总线在守卫热路径上（danger-guard 每次拒绝都调它），等于整个自进化环瘫掉。
 * 现在只有 id 是硬要求（人工动作与度量都按 id 定位，缺 id 的记录无处安放），
 * 其余字段一律补默认值；status 漂移退 archived（不注入、不度量），见 statusOf。
 */
export function normalizeRuleCardRow(value: unknown): RuleCard | null {
  const id = fieldOf(value, "id");
  if (typeof id !== "string" || id === "") {
    return null;
  }
  const armedAt = numericOf(fieldOf(value, "armedAt"));
  const lastSeenAt = numericOf(fieldOf(value, "lastSeenAt"));
  const lastViolationAt = numericOf(fieldOf(value, "lastViolationAt"));
  const lastSuppressedAt = numericOf(fieldOf(value, "lastSuppressedAt"));
  const cardCwd = nonEmptyString(fieldOf(value, "cwd"));
  const row: RuleCard = {
    id,
    project: strField(fieldOf(value, "project"), "default"),
    category: strField(fieldOf(value, "category"), "unknown"),
    signature: normalizeSignature(fieldOf(value, "signature")),
    statement: strField(fieldOf(value, "statement"), ""),
    status: statusOf(fieldOf(value, "status")),
    createdAt: numField(fieldOf(value, "createdAt"), 0),
    updatedAt: numField(fieldOf(value, "updatedAt"), 0),
    occurrences: numField(fieldOf(value, "occurrences"), 0),
    sources: unknownArray(fieldOf(value, "sources")).map((entry) => normalizeLessonSource(entry)),
    violation: numField(fieldOf(value, "violation"), 0),
    suppressed: numField(fieldOf(value, "suppressed"), 0),
    // 存量库无 samples（新增暴露计数）：默认 0，不猜值、不改写既有计数。
    samples: numField(fieldOf(value, "samples"), 0),
    recurrences: numField(fieldOf(value, "recurrences"), 0),
    evidence: unknownArray(fieldOf(value, "evidence"))
      .filter((entry): entry is Record<string, unknown> => isRecord(entry))
      .map((entry) => normalizeEvidenceRow(entry)),
    origin: originOf(fieldOf(value, "origin")),
  };
  if (armedAt !== undefined) {
    row.armedAt = armedAt;
  }
  if (cardCwd !== undefined) {
    row.cwd = cardCwd;
  }
  if (lastSeenAt !== undefined) {
    row.lastSeenAt = lastSeenAt;
  }
  if (lastViolationAt !== undefined) {
    row.lastViolationAt = lastViolationAt;
  }
  if (lastSuppressedAt !== undefined) {
    row.lastSuppressedAt = lastSuppressedAt;
  }
  return row;
}

/**
 * 教训行逐字段归一（JSONL 存量漂移容错）。与规则卡同一取向：category/signature
 * 之外的字段漂移不再整行丢弃，否则一次版本升级就把历史教训从管理面与蒸馏背景
 * 里抹掉（丢掉的正是要拿去归纳规则的材料）。
 */
function normalizeLessonRow(value: unknown): LessonRecord | null {
  const category = fieldOf(value, "category");
  const signature = fieldOf(value, "signature");
  if (typeof category !== "string" || typeof signature !== "string") {
    return null;
  }
  const cwd = fieldOf(value, "cwd");
  const sessionId = fieldOf(value, "sessionId");
  const turn = numericOf(fieldOf(value, "turn"));
  const evidence = fieldOf(value, "evidence");
  const row: LessonRecord = {
    ts: numField(fieldOf(value, "ts"), 0),
    source: normalizeLessonSource(fieldOf(value, "source")),
    category,
    project: strField(fieldOf(value, "project"), "default"),
    signature,
    detail: strField(fieldOf(value, "detail"), ""),
  };
  if (typeof cwd === "string") {
    row.cwd = cwd;
  }
  if (typeof sessionId === "string") {
    row.sessionId = sessionId;
  }
  if (turn !== undefined) {
    row.turn = turn;
  }
  if (isRecord(evidence)) {
    row.evidence = evidence;
  }
  return row;
}

// ── LessonStore ──────────────────────────────────────────────────────────

/** 数字阈值归一：非法/越界用默认值（供 policy() 共用，无父级捕获）。 */
function num(value: unknown, fallback: number, min = 0): number {
  return Number.isFinite(Number(value)) && Number(value) >= min ? Number(value) : fallback;
}

/** commit 的改动计划返回值：write=false = 没有要落盘的改动（不写盘，也不算失败）。 */
interface Planned<Value> {
  readonly value: Value;
  readonly write: boolean;
}

/**
 * commit 的回执。
 * - ok=false：这一次改动没进规则库（两类失败见 PERSIST_FAILED），调用方据此提示重试。
 * - trustworthy=false：这一刻端口读不出可信值（usable:false）。此时"库里没有这张卡"
 *   根本无从判断，查找未命中的一律按 persist-failed 回执，绝不回 not-found——把读不
 *   懂说成"没这条规则"会让调用方去改 id，而真正要修的是那段读不懂的设置。
 */
interface Committed<Value> {
  readonly ok: boolean;
  readonly value: Value;
  readonly trustworthy: boolean;
}

/** report() 一次改动的种类：决定回执挂 violationOf 还是 candidate/ready。 */
type ReportPlanKind = "created" | "candidate" | "violation" | "settled";

/** report() 的改动材料（commit 结束后按它组装回执）。 */
interface ReportPlan {
  readonly kind: ReportPlanKind;
  readonly card: RuleCard;
}

/** 新卡构造参数：阈值归并（report 首报）与蒸馏补录（addCandidate）共用。 */
interface NewCardArgs {
  readonly project: string;
  readonly category: string;
  readonly signature: string;
  readonly statement: string;
  readonly origin: RuleOrigin;
  readonly source: string;
  readonly evidence: RuleEvidence;
  readonly lastSeenAt: number;
  readonly now: number;
  readonly cwd?: string;
}

/**
 * 规则卡骨架：两条建卡路径必须长出同一形状的卡（状态一律 candidate、计数一律从 1/0
 * 起步），否则其中一条路会造出"缺字段靠读取侧补默认"的卡——度量语义就漂了。
 */
function newRuleCard(args: NewCardArgs): RuleCard {
  const { project, category, signature, statement, origin, source, evidence, lastSeenAt, now } =
    args;
  const card: RuleCard = {
    id: `rule-${randomUUID()}`,
    project,
    category,
    signature,
    statement,
    status: "candidate",
    createdAt: now,
    updatedAt: now,
    occurrences: 1,
    sources: [source],
    violation: 0,
    suppressed: 0,
    samples: 0,
    recurrences: 0,
    lastSeenAt,
    evidence: [evidence],
    origin,
    ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
  };
  return card;
}

/** 人工改写的正文：非空 trim 才认（空/缺省 = 保留卡片原文）。 */
function trimmedStatement(statement: string | undefined): string | undefined {
  const trimmed = typeof statement === "string" ? statement.trim() : "";
  return trimmed === "" ? undefined : trimmed;
}

/**
 * 人工动作落地。arm 会清零历史度量：复发/干净/暴露三项计数属于**那一次升格**的
 * 生命周期，带着旧值进新一轮会让降级裁决读到混合证据。
 */
function applyRuleAction(
  rule: RuleCard,
  action: "arm" | "reject" | "demote" | "archive" | "edit" | "revive",
  statement: string | undefined,
  now: number,
): void {
  const nextStatement = trimmedStatement(statement);
  switch (action) {
    case "arm": {
      if (nextStatement !== undefined) {
        rule.statement = nextStatement;
      }
      rule.status = "armed";
      rule.armedAt = now;
      rule.violation = 0;
      rule.suppressed = 0;
      rule.samples = 0;
      rule.recurrences = 0;
      delete rule.lastViolationAt;
      delete rule.lastSuppressedAt;
      break;
    }
    case "reject": {
      rule.status = "rejected";
      rule.recurrences = 0;
      break;
    }
    case "demote": {
      rule.status = "demoted";
      break;
    }
    case "archive": {
      rule.status = "archived";
      break;
    }
    case "revive": {
      // 归档/拒绝/降级 → 候选（重新走人工确认；证据保留）。
      rule.status = "candidate";
      rule.recurrences = 0;
      break;
    }
    case "edit": {
      if (nextStatement !== undefined) {
        rule.statement = nextStatement;
      }
      // action 是六个字面量的联合类型，宿主侧 isRuleAction 先把门外值挡掉，故不写兜底分支。
      // no default
      break;
    }
  }
  rule.updatedAt = now;
}

/** 就地剔出一批卡（commit 的工作数组是本次读取的副本，剔除只影响这份待写内容）。 */
function dropCards(cards: RuleCard[], doomed: ReadonlySet<string>): void {
  for (let cursor = cards.length - 1; cursor >= 0; cursor -= 1) {
    const row = cards[cursor];
    if (row !== undefined && doomed.has(row.id)) {
      cards.splice(cursor, 1);
    }
  }
}

/** 同 (project, category, signature) 键命中。 */
function findByKey(cards: readonly RuleCard[], key: string): RuleCard | undefined {
  return cards.find((row) => ruleKey(row.project, row.category, row.signature) === key);
}

/** 归并目标卡挑选用的排序：观察次数多者在前（toSorted 不改入参，工作数组要保序）。 */
function byOccurrences(left: RuleCard, right: RuleCard): number {
  return right.occurrences - left.occurrences;
}

/**
 * 一轮碎片归并的产出。
 *
 * 为什么 merged 之外还要 dirty：**并入张数为 0 不等于没改动**。单张碎片自己当
 * primary 时（"单条 rejected 碎片"、"跨项目各自归并"两型）没有卡片被剔掉，但它
 * 的签名/正文就地改写成了稳定签名——这笔改写若因 `write: merged > 0` 被跳过，
 * 端口里仍是旧碎片，下一次装载再判一遍再跳过：迁移永不收敛，而调用方拿到的回执
 * 一切正常（commit 的 ok=true）。这正是"改了没存"最隐蔽的一型，故写面只认 dirty。
 */
interface MergePass {
  readonly merged: number;
  readonly dirty: boolean;
}

/** 零归并（该 project 这一组无卡可并）。 */
const CLEAN_PASS: MergePass = { merged: 0, dirty: false };

export class LessonStore {
  private readonly opts: StoreOptions & Required<Pick<StoreOptions, "lessonsFile" | "rules">>;
  private readonly repo: RulesRepository;
  private readonly now: () => number;

  public constructor(opts: StoreOptions) {
    this.opts = opts;
    this.repo = opts.rules;
    this.now = opts.now ?? Date.now;
  }

  /** 磁盘保险丝（settings 运行时可调；0 = 不设上限）。**这个字段唯一的写入归一口**：
   *  非有限值与负数一律落 0——appendJsonl 判的是 `maxBytes > 0`，退 0 与留着负数是同
   *  一件事，但只有归一过一次，读侧才不必再猜"库里那个数是不是半截的"。 */
  public setMaxLessonsBytes(bytes: number): void {
    this.opts.maxLessonsBytes = Number.isFinite(bytes) && bytes >= 0 ? bytes : 0;
  }

  /** settings 拉模型：宿主每次 report/decay 前把运行时阈值同步进来（pull，无需订阅）。 */
  public configure(
    partial: Partial<
      Pick<
        StoreOptions,
        | "promoteThreshold"
        | "demoteThreshold"
        | "demoteMinSamples"
        | "demoteRatio"
        | "decayDays"
        | "maxLessonsBytes"
        | "reviveThreshold"
      >
    >,
  ): void {
    for (const [key, val] of Object.entries(partial)) {
      if (typeof val === "number" && Number.isFinite(val)) {
        // 动态键直写 opts 会撞索引签名断言；已知数值键白名单走 switch 显式字段赋值。
        switch (key) {
          case "promoteThreshold": {
            this.opts.promoteThreshold = val;
            break;
          }
          case "demoteThreshold": {
            this.opts.demoteThreshold = val;
            break;
          }
          case "demoteMinSamples": {
            this.opts.demoteMinSamples = val;
            break;
          }
          case "demoteRatio": {
            this.opts.demoteRatio = val;
            break;
          }
          case "decayDays": {
            this.opts.decayDays = val;
            break;
          }
          case "maxLessonsBytes": {
            // 走归一口而不是再写一次字段：保险丝"非法退 0"的判据只该有一处（configure 的
            // 循环只滤掉非有限值，负数仍会漏进来）。
            this.setMaxLessonsBytes(val);
            break;
          }
          case "reviveThreshold": {
            this.opts.reviveThreshold = val;
            break;
          }
          default: {
            break;
          }
        }
      }
    }
  }

  /**
   * 一次规则库改动：读 → 在**这一刻读到的数组**上重放改动 → 带 revision 的 CAS 写。
   *
   * 为什么必须"写前重读 + 带 revision"：本进程不是规则库的唯一作者——常驻 web 实例
   * 与一次性 headless 进程交替写同一段设置，而 provider 对 `rules` 这个数组键是
   * **整片覆盖**（mergeLayers 不合并数组）。写回的数组若来自陈旧读，就会把别的进程
   * 刚写进来的卡整片抹掉（此前实测到的丢卡缺陷）。revision 被别处推进过时 provider
   * 抛 SettingsConflictError：重读合并后的值、在新数组上重放本次改动再写，最多
   * RULES_CAS_RETRY_LIMIT 次；仍失败按 persist-failed 语义回执，绝不外抛——总线挂在
   * 守卫热路径上（danger-guard 每次拒绝都调它），抛穿等于整个自进化环瘫掉。
   *
   * 失败分两类收手（同一回执 PERSIST_FAILED，理由见 PERSIST_FAILED 的注释）：
   *   (a) 不可信读 / 端口明确拒绝 → **一次都不写、也不重放**：usable:false 时连"别人
   *       此刻有什么"都读不懂，写回去就是替坏数据背书；rejected 是端口自身写不进去，
   *       重放只会重复撞同一堵墙。本文件不留任何跨调用存活的数组，所以"不落内存"这条
   *       在结构上是自动成立的——计划改的是本次读取的副本，副本随本函数返回即丢弃。
   *   (b) CAS 冲突（对方在推进 revision）→ 值得重放：每轮都拿含对方改动的新数组，
   *       重放的是本进程这一次改动；用满上限仍冲突说明写队列被卡住，就此收手回执
   *       失败，改动留在调用方手里的回执对象上（不缓存、不回滚端口）。
   * 两类的共同底线：任何一次写都只可能带上"重读后那一刻"的他人卡，绝不整体回滚成
   * 陈旧内存覆掉别人写好的卡。
   */
  private async commit<Value>(
    plan: (cards: RuleCard[]) => Planned<Value>,
  ): Promise<Committed<Value>> {
    // 递归而非 for + await：CAS 重放本质是"一次写一等"，循环里的 await 会被 lint 判为
    // 该并发（并发不了：同一端口上两笔整片覆写只会互相撞 revision）。
    const attempt = async (retryLeft: number): Promise<Committed<Value>> => {
      const current = this.repo.load();
      const trustworthy = current.usable;
      const cards = trustworthy ? [...current.cards] : [];
      const planned = plan(cards);
      if (!planned.write) {
        return { ok: true, value: planned.value, trustworthy };
      }
      if (!trustworthy) {
        // (a) 命名空间读不出可信值：写一律拒绝（哪怕端口递来了数组）。把"读不懂"当成
        // "库里真没有"再覆写上去，等于替坏数据背书——坏内容保持原样等人修，读面已如实报空。
        return { ok: false, value: planned.value, trustworthy };
      }
      const outcome = await this.repo.save(cards, current.revision);
      if (outcome === "persisted") {
        return { ok: true, value: planned.value, trustworthy };
      }
      if (outcome === "rejected" || retryLeft <= 0) {
        // (a) rejected 不重放；(b) conflict 用满上限后收手。
        return { ok: false, value: planned.value, trustworthy };
      }
      return attempt(retryLeft - 1);
    };
    // 等的是 attempt 自己那条 CAS 重放链（`return await` 会被 return-await 判违规，故先落变量）。
    const committed = await attempt(RULES_CAS_RETRY_LIMIT);
    return committed;
  }

  private threshold(): number {
    const value = Number(this.opts.promoteThreshold);
    return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 3;
  }

  /** 起草用的消息表：每次现取（见 StoreOptions.messages），本文件不读 settings。 */
  private messages(): LessonLoopMessages {
    return this.opts.messages();
  }

  private policy(): DecayPolicy {
    const { opts } = this;
    return {
      demoteThreshold: num(opts.demoteThreshold, DEFAULT_DECAY.demoteThreshold, 1),
      demoteMinSamples: num(opts.demoteMinSamples, DEFAULT_DECAY.demoteMinSamples, 1),
      demoteRatio: num(opts.demoteRatio, DEFAULT_DECAY.demoteRatio, 0.01),
      decayDays: num(opts.decayDays, DEFAULT_DECAY.decayDays, 1),
    };
  }

  /**
   * 记一条教训：全量落事件流水 → 归并规则卡（armed 命中计复发；候选累积）。
   *
   * 键里的签名走 stableSignatureFor()：登记表内的类别一律汇聚到类别级稳定签名，
   * 原始路径/命令行改落 evidence.signature。碎片因此**不再产生**（旧数据由
   * migrateFragmentRules 一次性收拢）。
   */
  public async report(record: LessonRecord): Promise<ReportReceipt> {
    const now = this.now();
    const source = noteSourceFallback(record.source, normalizeLessonSource(record.source));
    const rec: LessonRecord = {
      ...record,
      source,
      ts: Number.isFinite(record.ts) ? record.ts : now,
    };
    // 流水（cache，单写者追加）与规则面（settings，CAS）分两笔：流水失败不挡规则
    // 归并，规则面失败也不回滚流水——回执如实报 ok:false，调用方自己决定重试。
    appendJsonl(this.opts.lessonsFile, rec, this.opts.maxLessonsBytes ?? 0);
    const obs = observeLesson(rec, now);
    const key = ruleKey(rec.project, rec.category, obs.signature);
    const outcome = await this.commit((cards) => this.planReport(cards, obs, key));
    return this.receiptFor(outcome);
  }

  /** 未命中任何键 → 按类别级稳定签名开一张新候选卡；命中 → 补证据 + 按状态计度量。 */
  private planReport(cards: RuleCard[], obs: Observation, key: string): Planned<ReportPlan> {
    const rule = findByKey(cards, key);
    return rule === undefined
      ? {
          value: {
            kind: "created",
            card: LessonStore.openCandidate(cards, obs, this.messages()),
          },
          write: true,
        }
      : this.accumulate(rule, obs);
  }

  /** 首报：开一张新候选卡并放进待写数组（静态：只吃 obs 与递来的消息表，不读实例状态）。 */
  private static openCandidate(
    cards: RuleCard[],
    obs: Observation,
    messages: LessonLoopMessages,
  ): RuleCard {
    const { rec, now, rawSignature, signature } = obs;
    const card = newRuleCard({
      project: rec.project,
      category: rec.category,
      signature,
      statement: draftStatement(rec.category, signature, messages),
      origin: "threshold",
      source: rec.source,
      lastSeenAt: rec.ts,
      evidence: evidenceRow(rec.ts, rec.source, rec.detail, rawSignature, signature),
      now,
      ...(obs.cwd === undefined ? {} : { cwd: obs.cwd }),
    });
    cards.push(card);
    return card;
  }

  /** 命中已有卡：补证据 + 按状态计复发/累积/复活。 */
  private accumulate(rule: RuleCard, obs: Observation): Planned<ReportPlan> {
    const { rec, now, rawSignature, signature } = obs;
    rule.lastSeenAt = rec.ts;
    rule.updatedAt = now;
    rule.evidence.push(evidenceRow(rec.ts, rec.source, rec.detail, rawSignature, signature));
    if (!rule.sources.includes(rec.source)) {
      rule.sources.push(rec.source);
    }
    // 存量卡补 cwd（只补不猜）：这条教训与卡片同 (project, category, signature) 键，
    // 说明该 cwd 确实属于这个桶，migrateProjectKeys 此后才有可重算的依据。
    if (rule.cwd === undefined && obs.cwd !== undefined) {
      rule.cwd = obs.cwd;
    }

    if (rule.status === "armed") {
      rule.violation += 1;
      rule.lastViolationAt = rec.ts;
      // 复发即裁决（不攒批）：达到复发率红线立即降级，规则失效要尽早停止注入。
      // 与本次复发一起一次写回——两笔写只会被 CAS 排成两次整片覆写，反而更危险。
      if (decayVerdict(rule, this.policy(), now) === "demote") {
        rule.status = "demoted";
        rule.updatedAt = now;
      }
      return { value: { kind: "violation", card: rule }, write: true };
    }
    if (rule.status === "candidate") {
      rule.occurrences += 1;
      return { value: { kind: "candidate", card: rule }, write: true };
    }
    // rejected：计数 recurrences；达阈值自动转回候选待人工重审（原人工决定不覆盖——
    // 阈值到了 -> 说明拒绝后同类问题仍反复出现，需要重新审视，交还给人拍板）。
    // archived/demoted：只补证据不复活（复活是人工动作，卡片上点）。
    // 三条路各自的边界（红线：**机器永不把 rejected 写成 armed**）：
    //   - 未到 reviveThreshold：仍 rejected，只多一条证据 + 一次 recurrences；
    //   - 到达阈值：转 candidate 待人工重审（转回的是"候选"，注入面仍然不认候选卡）；
    //   - 人工 arm：只有 ruleAction(id,"arm") 能把 rejected 直接变 armed。
    // 本方法的任何计数都只改本次读取的副本：写失败（两类失败皆然）时端口里那行原样
    // 不动，于是"被人工拒掉的规则"不可能因为一次没存住的上报就活过来。
    if (rule.status === "rejected" && this.noteRecurrence(rule, now)) {
      return { value: { kind: "candidate", card: rule }, write: true };
    }
    return { value: { kind: "settled", card: rule }, write: true };
  }

  /** rejected 卡的复发计数：达阈值则转回候选（返回是否转回）。
   *  转回的落点是 candidate（待人重审），不是 armed，也不清证据——机器不替人升格。 */
  private noteRecurrence(rule: RuleCard, now: number): boolean {
    rule.recurrences += 1;
    if (rule.recurrences < this.reviveThreshold()) {
      return false;
    }
    rule.status = "candidate";
    rule.occurrences = rule.recurrences;
    rule.recurrences = 0;
    rule.updatedAt = now;
    return true;
  }

  /** 组装 report() 回执：ready 只在确实落盘后才报（磁盘没存住就催人工审 = 点空）。 */
  private receiptFor(outcome: Committed<ReportPlan>): ReportReceipt {
    const { ok, value } = outcome;
    const { kind, card } = value;
    const threshold = this.threshold();
    // ready 必须同时看落盘：磁盘没存住就催人工审，人点下去是一张不存在的卡。
    const ready = ok && (kind === "created" ? threshold <= 1 : card.occurrences >= threshold);
    return {
      ok,
      ...(ok ? {} : { reason: PERSIST_FAILED }),
      ...(kind === "violation" ? { violationOf: card } : {}),
      ...(kind === "created" || kind === "candidate" ? { candidate: card, ready } : {}),
    };
  }

  /** revival 阈值（StoreOptions.reviveThreshold，归一 1-20，默认 3）。 */
  private reviveThreshold(): number {
    const value = Number(this.opts.reviveThreshold);
    return Number.isFinite(value) && value >= 1 ? Math.min(20, Math.floor(value)) : 3;
  }

  /** pass 信号：规则场景被触发且被遵守。会话收尾清算时只有被
   *  pass 过的 armed 规则才计 suppressed——无关会话不再灌水。
   *  键与 report() 同源（stableSignatureFor），调用方继续传自己那条细签名。 */
  public pass(project: string, category: string, signature: string): RuleCard | undefined {
    const key = ruleKey(project, category, stableSignatureFor(category, signature));
    // 仅 armed 规则可被 pass 计数（候选/拒绝不消费 pass 信号）。
    return this.workingCards().find(
      (row) => ruleKey(row.project, row.category, row.signature) === key && row.status === "armed",
    );
  }

  /**
   * 会话收尾清算：对本项目内每条「armed 且本会话未违规」的规则记一次暴露 samples
   * （测没测过这条规则的判据，与 pass 无关）；其中被 pass 过的（规则场景触发且被
   * 遵守）再计一次 suppressed=observed。被本会话违反的规则既不记 samples 也不记
   * observed（violation 已由 report() 计）。samples 只增暴露度，绝不进复发率分母。
   */
  public async sessionEnded(
    project: string,
    violatedRuleIds: ReadonlySet<string>,
    passedRuleIds: ReadonlySet<string>,
    sessionId?: string,
  ): Promise<void> {
    const now = this.now();
    const outcome = await this.commit((cards): Planned<boolean> => {
      let dirty = false;
      for (const rule of cards) {
        if (rule.status === "armed" && rule.project === project && !violatedRuleIds.has(rule.id)) {
          rule.samples += 1;
          rule.updatedAt = now;
          dirty = true;
          if (passedRuleIds.has(rule.id)) {
            rule.suppressed += 1;
            rule.lastSuppressedAt = now;
          }
        }
      }
      return { value: dirty, write: dirty };
    });
    if (outcome.value && sessionId !== undefined) {
      console.info(
        `[lesson-loop] ${sessionId}: session settled for project ${project} (${String(passedRuleIds.size)} passed rule(s))`,
      );
    }
  }

  /** 读这一刻的规则数组（每次都是新对象：改动只作用于本次的待写副本）。
   *  usable:false 时一律读空——"读不懂"不许当成"真的没有"，也不许当成"还有这些卡"
   *  拿去注入/评审（那是把坏数据洗成界面事实）。 */
  private workingCards(): RuleCard[] {
    const current = this.repo.load();
    return current.usable ? [...current.cards] : [];
  }

  public rules(): RuleCard[] {
    return this.workingCards();
  }

  /** 人工动作：arm（可携改写后的 statement）/ reject / demote / archive / edit / revive。
   *  返回 not-found = 可信读面上确实无此卡（id 错了，重试也没用）；persist-failed = 这一次
   *  没存住（含端口读不懂的那种），调用方提示重试，绝不当成"规则不存在"。 */
  public async ruleAction(
    id: string,
    action: "arm" | "reject" | "demote" | "archive" | "edit" | "revive",
    statement?: string,
  ): Promise<RuleActionResult> {
    const outcome = await this.commit((cards): Planned<boolean> => {
      const rule = cards.find((row) => row.id === id);
      if (rule === undefined) {
        return { value: false, write: false };
      }
      applyRuleAction(rule, action, statement, this.now());
      return { value: true, write: true };
    });
    if (!outcome.value) {
      return outcome.trustworthy ? "not-found" : "persist-failed";
    }
    return outcome.ok ? "persisted" : "persist-failed";
  }

  /** /lessons-digest 与卡片手工补录直接建候选（origin 标记来源）。
   *  键与 report() 同源：蒸馏出来的路径型签名同样折叠，否则机器建卡又会开一批碎片。 */
  public async addCandidate(input: {
    project: string;
    category: string;
    signature: string;
    statement: string;
    detail: string;
    source?: string;
  }): Promise<RuleCard> {
    const now = this.now();
    const rawSignature = normalizeSignature(input.signature);
    const signature = stableSignatureFor(input.category, rawSignature);
    const raw = input.source ?? LESSONS_DIGEST_SOURCE;
    const source = noteSourceFallback(raw, normalizeLessonSource(raw));
    const key = ruleKey(input.project, input.category, signature);
    const outcome = await this.commit((cards) => {
      const existing = findByKey(cards, key);
      if (existing !== undefined) {
        // 同 (project,category,signature) 只允许一张卡：ruleKey 是 report()/pass() 的
        // 查找键，第二张同键卡永远查不到（新观测堆在没人看的卡上），人工决定也会被
        // 蒸馏路径绕过重开一张。故一律并回已有卡。
        existing.updatedAt = now;
        existing.evidence.push(evidenceRow(now, source, input.detail, rawSignature, signature));
        // 只有候选卡计 occurrences；rejected/armed/archived 的状态由人拍板，蒸馏不改。
        if (existing.status === "candidate") {
          existing.occurrences += 1;
        }
        return { value: existing, write: true };
      }
      const card = newRuleCard({
        project: input.project,
        category: input.category,
        signature,
        statement: input.statement,
        origin: LESSONS_DIGEST_SOURCE,
        source,
        lastSeenAt: now,
        evidence: evidenceRow(now, source, input.detail, rawSignature, signature),
        now,
      });
      cards.push(card);
      return { value: card, write: true };
    });
    // 回执只有卡片本身（与旧签名一致）：没存住由 ok 通道外的日志/下一次读取暴露。
    return outcome.value;
  }

  /** 把 source 碎片并入 primary（occurrences/evidence/sources/lastSeenAt 累加；
   *  更晚 armed 的碎片覆盖 primary 的 statement 与生效时间）。 */
  private static mergeFragment(primary: RuleCard, source: RuleCard): void {
    if (
      source.status === "armed" &&
      typeof source.armedAt === "number" &&
      source.armedAt > (primary.armedAt ?? 0)
    ) {
      // 另一张并行武装的碎片更新——继承其人工 statement。violation/suppressed
      // 属于各自生命周期（arm 时清零），不合并。
      primary.statement = source.statement;
      primary.armedAt = source.armedAt;
    }
    primary.occurrences += source.occurrences;
    primary.evidence.push(...source.evidence);
    primary.sources = [...new Set([...primary.sources, ...source.sources])];
    if (
      source.lastSeenAt !== undefined &&
      (primary.lastSeenAt === undefined || source.lastSeenAt > primary.lastSeenAt)
    ) {
      primary.lastSeenAt = source.lastSeenAt;
    }
  }

  /**
   * 存量碎片迁移（碎片化修复）：把 category 对应类别级稳定签名出现
   * 之前的「路径型签名」候选/armed/rejected 规则归并。合并规则：
   *   - 候选/armed 碎片并入稳定签名卡（若已存在直接并入；否则取最权威一张——
   *     armed 优先、其次 occurrences 最多——改写为稳定签名，statement 保留人工
   *     改写，其余并入并移除）；
   *   - rejected 碎片并入 `${stableSig}:rejected` 汇总卡（人工拒绝语义保留：
   *     状态 rejected、不复活、不注入；碎片卡从规则列表收敛，避免 20 条同内容
   *     重复占据列表）；
   *   - archived/demoted 碎片不参与（一律人工动作决定）。
   * 按 project 分组，跨项目绝不合并。
   * 返回并入的碎片数。
   */
  public async migrateFragmentRules(): Promise<number> {
    const outcome = await this.commit((cards) => {
      const pass = this.mergeFragmentsIn(cards);
      return { value: pass.merged, write: pass.dirty };
    });
    return outcome.value;
  }

  /** 在待写数组上跑一遍全类别的碎片归并（数组就地收敛；产出见 MergePass）。 */
  private mergeFragmentsIn(cards: RuleCard[]): MergePass {
    let merged = 0;
    let dirty = false;
    for (const [category, stableSig] of Object.entries(CATEGORY_SIGNATURES)) {
      // 快照全部潜在碎片（候选/armed/rejected 且路径型签名），再按 project 分组处理——
      // 跨项目绝不合并（规则卡按 project 隔离，混并会污染桶内度量与注入）。
      const candidates = cards.filter(
        (card) =>
          card.category === category &&
          card.signature !== stableSig &&
          (card.status === "candidate" || card.status === "armed" || card.status === "rejected") &&
          looksLikePathSignature(card.signature),
      );
      const projects = [...new Set(candidates.map((card) => card.project))];
      for (const project of projects) {
        const live = candidates.filter(
          (card) => card.project === project && card.status !== "rejected",
        );
        const rejected = candidates.filter(
          (card) => card.project === project && card.status === "rejected",
        );
        const livePass = this.migrateProjectFragments(cards, live, category, stableSig, project);
        const rejectedPass = this.migrateRejectedFragments(
          cards,
          rejected,
          category,
          stableSig,
          project,
        );
        merged += livePass.merged + rejectedPass.merged;
        dirty ||= livePass.dirty || rejectedPass.dirty;
      }
    }
    return { merged, dirty };
  }

  /** rejected 路径碎片的归并汇总：并入该 project 一条签名 `${stableSig}:rejected`
   *  的汇总卡（人工拒绝语义保留：状态 rejected、不复活、不注入），避免碎片卡
   *  占据规则列表。与 armed/candidate 稳定卡不冲突（签名不同）。 */
  private migrateRejectedFragments(
    cards: RuleCard[],
    fragments: RuleCard[],
    category: string,
    stableSig: string,
    project: string,
  ): MergePass {
    const summarySig = `${stableSig}:rejected`;
    const summary = cards.find(
      (card) =>
        card.category === category && card.signature === summarySig && card.project === project,
    );
    // 主卡挑选：已有汇总卡优先（它可能已被人工 revive 成候选，见下方签名判定）；
    // 否则取观察次数最多的碎片。两组都空时 primary 缺省 → 无卡可归并。
    const [busiest] = fragments.toSorted(byOccurrences);
    const primary = summary ?? busiest;
    if (primary === undefined) {
      return CLEAN_PASS;
    }
    let merged = 0;
    const doomed = new Set<string>();
    for (const card of fragments) {
      if (card.id !== primary.id) {
        LessonStore.mergeFragment(primary, card);
        doomed.add(card.id);
        merged += 1;
      }
    }
    let rewritten = false;
    if (primary.signature !== summarySig) {
      primary.signature = summarySig;
      // 容器正文由本包模板起草（不是人工写下的规则），故随当前语言走；已是汇总
      // 签名的那张卡走不到这里，它的正文永不被改写。
      primary.statement = draftStatement(category, summarySig, this.messages());
      // 新建汇总卡才钉 rejected；已存在的汇总卡可能是人工 revive 过的候选，
      // 无条件覆写会把人的决定退回。
      primary.status = "rejected";
      rewritten = true;
    }
    if (merged > 0 || rewritten) {
      primary.updatedAt = this.now();
    }
    dropCards(cards, doomed);
    return { merged, dirty: merged > 0 || rewritten };
  }

  /** 单个 project 的候选/armed 碎片归并（产出见 MergePass）。 */
  private migrateProjectFragments(
    cards: RuleCard[],
    fragments: RuleCard[],
    category: string,
    stableSig: string,
    project: string,
  ): MergePass {
    const existing = cards.find(
      (card) =>
        card.category === category && card.signature === stableSig && card.project === project,
    );
    // 主卡挑选（人工决定优先）：已有稳定签名卡 > 首个 armed 碎片 > 观察次数最多。
    const armedFirst = fragments.find((card) => card.status === "armed");
    const [busiest] = fragments.toSorted(byOccurrences);
    const primary = existing ?? armedFirst ?? busiest;
    if (primary === undefined) {
      // 该 project 只剩 rejected 碎片（live 组为空）：无活卡可归并。
      return CLEAN_PASS;
    }
    let merged = 0;
    let armedSource: RuleCard | undefined;
    const doomed = new Set<string>();
    for (const card of fragments) {
      if (card.id !== primary.id) {
        if (card.status === "armed" && armedSource === undefined) {
          armedSource = card;
        }
        LessonStore.mergeFragment(primary, card);
        doomed.add(card.id);
        merged += 1;
      }
    }
    let rewritten = false;
    if (primary.signature !== stableSig) {
      primary.signature = stableSig;
      rewritten = true;
    }
    // 人工"已升格"决定优先于卡面状态：碎片里有 armed 而主卡只是候选时，
    // 归并后必须仍是 armed（否则升格过的规则静默退回候选，注入随之停止）。
    if (primary.status !== "armed" && armedSource !== undefined) {
      LessonStore.inheritArmed(primary, armedSource);
    }
    if (merged > 0 || rewritten) {
      primary.updatedAt = this.now();
    }
    dropCards(cards, doomed);
    return { merged, dirty: merged > 0 || rewritten };
  }

  /** 把 armed 碎片的生命周期度量搬到主卡（arm 期计数属于那次升格，不能留空）。
   *  三个时间戳按静态键逐个处理：源卡缺值时必须真的删键（留 undefined 与删键在
   *  JSON 往返后语义不同，decayVerdict 的锚点回退链会被 undefined 干扰）。 */
  private static inheritArmed(primary: RuleCard, armedSource: RuleCard): void {
    primary.status = "armed";
    primary.violation = armedSource.violation;
    primary.suppressed = armedSource.suppressed;
    primary.samples = armedSource.samples;
    if (armedSource.armedAt === undefined) {
      delete primary.armedAt;
    } else {
      primary.armedAt = armedSource.armedAt;
    }
    if (armedSource.lastViolationAt === undefined) {
      delete primary.lastViolationAt;
    } else {
      primary.lastViolationAt = armedSource.lastViolationAt;
    }
    if (armedSource.lastSuppressedAt === undefined) {
      delete primary.lastSuppressedAt;
    } else {
      primary.lastSuppressedAt = armedSource.lastSuppressedAt;
    }
  }

  /**
   * 一次性 project 键归一迁移：桶键派生已收敛到 shared/lib/project-key.ts（补
   * path.resolve + realpath）。旧键是"纯字符串归一"的产物——cwd 写成相对路径、含
   * `..` 冗余段、或经过软链（macOS /tmp ↔ /private/tmp）时，同一个项目会被切成
   * 两个桶：教训与 armed 规则注入各看到一半。
   *
   * 迁移只按卡片**自己存的 cwd** 重算：
   *   - 没存 cwd 的存量卡原样留下。project 是跨系统（记忆网关 agent_id）的桶名，
   *     猜错一次就把别的项目的规则注进当前会话，宁可不迁；
   *   - 重算后与别的卡撞同 (project, category, signature) 键 → 归并，主卡由人工
   *     状态决定（见 pickMergePair），证据/观察次数按 mergeFragment 折叠；
   *   - 幂等：第二次跑每张卡的 project 都已等于 deriveProjectKey(cwd) → 零改动、
   *     零落盘（不会与 migrateFragmentRules 互相回退）。
   * 已规范绝对路径的输入产出的键与旧实现逐字节相同，所以"正常机器"上这里是 no-op。
   */
  public async migrateProjectKeys(): Promise<{ rewrites: number; merged: number }> {
    const outcome = await this.commit((cards) => {
      let rewrites = 0;
      for (const card of cards) {
        const cwd = nonEmptyString(card.cwd);
        if (cwd !== undefined) {
          const target = deriveProjectKey(cwd);
          if (target !== card.project) {
            card.project = target;
            rewrites += 1;
          }
        }
      }
      if (rewrites === 0) {
        return { value: { rewrites: 0, merged: 0 }, write: false };
      }
      return { value: { rewrites, merged: this.mergeProjectKeyCollisions(cards) }, write: true };
    });
    return outcome.value;
  }

  /** project 重算后按 (project, category, signature) 键归并撞车的卡，返回被并掉的张数。
   *  顺带守住"一键一卡"不变式：report()/addCandidate() 都按这个键查找，库里同键留两张
   *  等于第二张永远查不到（观测堆在没人看的卡上）。 */
  private mergeProjectKeyCollisions(cards: RuleCard[]): number {
    const survivors = new Map<string, RuleCard>();
    const doomed = new Set<string>();
    const now = this.now();
    let merged = 0;
    for (const card of cards) {
      const key = ruleKey(card.project, card.category, card.signature);
      const kept = survivors.get(key);
      if (kept === undefined) {
        survivors.set(key, card);
      } else {
        const [primary, extra]: [RuleCard, RuleCard] = pickMergePair(kept, card);
        LessonStore.mergeFragment(primary, extra);
        primary.updatedAt = now;
        survivors.set(key, primary);
        doomed.add(primary === kept ? extra.id : kept.id);
        merged += 1;
      }
    }
    dropCards(cards, doomed);
    return merged;
  }

  /** 该规则当前是否"不可判定"（armed 够久却 violation+suppressed 双零）。派生态，
   *  每次按当前 policy/now 现算，不落库——规则重新被触发（violation 或 pass 计数）
   *  即自然退出该态。 */
  public isUndeterminable(rule: RuleCard): boolean {
    return decayVerdict(rule, this.policy(), this.now()) === "undeterminable";
  }

  /** 全部"不可判定"的 armed 规则（供 /stats 汇总与卡片提示；人工可停用/归档）。 */
  public undeterminableRules(): RuleCard[] {
    return this.rules().filter((rule) => this.isUndeterminable(rule));
  }

  /** 周期衰减：对全部 armed 规则执行裁决。降级会改状态并落盘；"不可判定"只是派生
   *  提示态（状态仍 armed，等人处理），不改盘。auto-archive 已被不可判定取代。 */
  public async runDecay(): Promise<{ demoted: number; undeterminable: number }> {
    const now = this.now();
    const policy = this.policy();
    const outcome = await this.commit((cards) => {
      let demoted = 0;
      let undeterminable = 0;
      for (const rule of cards) {
        const verdict = decayVerdict(rule, policy, now);
        if (verdict === "demote") {
          rule.status = "demoted";
          rule.updatedAt = now;
          demoted += 1;
        } else if (verdict === "undeterminable") {
          undeterminable += 1;
        }
      }
      return { value: { demoted, undeterminable }, write: demoted > 0 };
    });
    const { demoted, undeterminable } = outcome.value;
    if (demoted + undeterminable > 0) {
      console.info(`[lesson-loop] decay: ${demoted} demoted, ${undeterminable} undeterminable`);
    }
    return outcome.value;
  }

  /** 近期教训（project 过滤可选；limit ≤ 0 = 全量——内容零截断）。 */
  public recentLessons(project?: string, limit = 0): LessonRecord[] {
    const out: LessonRecord[] = [];
    for (const row of readJsonl(this.opts.lessonsFile)) {
      const lesson = normalizeLessonRow(row);
      if (lesson !== null && (project === undefined || lesson.project === project)) {
        out.push(lesson);
      }
    }
    return limit > 0 ? out.slice(-limit) : out;
  }

  public lessonsCount(): number {
    return readJsonl(this.opts.lessonsFile).length;
  }
}
