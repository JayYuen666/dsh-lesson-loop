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
import { deriveProjectKey } from "@jayyuen66/dsh-plugin-shared/lib/project-key";
import type { LessonLoopMessages } from "./messages.ts";
import { fieldOf, isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
// 事件流水的落盘面（追加/读取/磁盘保险丝）在 lib/lesson-jsonl.ts：这一层的失败纪律是"只日志、
// 不抛穿热路径"，与本文件的规则库 CAS 回执是两件事，因此分家。
import { appendJsonl, readJsonl } from "./lesson-jsonl.ts";
// 键的算法（签名归一 + 类别级稳定签名 + 归并键）与正文起草各自成层：写入侧、查找侧、迁移侧
// 与 lib/statement-draft.ts 必须算出同一个串，一处漏调就长成"写得进、查不到"的键漂移。
import {
  CATEGORY_SIGNATURES,
  REJECTED_SUMMARY_SUFFIX,
  isFragmentSignatureOf,
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
 * （见 normalizeLessonSource），本类型只枚举内置值；没有按值判定的生产消费者，
 * 不设运行期白名单表。
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
 * （`addCandidate` 的默认 source 与 origin）。字面量散着写就要逐处同改，故收成这一枚。
 */
const LESSONS_DIGEST_SOURCE = "lessons-digest" as const;

/** 内置五个之外的兜底来源名。 */
const FALLBACK_LESSON_SOURCE: KnownLessonSource = "manual";

/** 来源名长度上限：防把整段错误文本塞进来源字段（枚举面失控、卡片无法归因）。 */
const MAX_LESSON_SOURCE_LENGTH = 64;

/** Unicode 控制字符类（Cc）：来源字段出现即视为不可信。 */
const CONTROL_CHARACTER = /\p{Cc}/u;

/**
 * 来源归一（开放集）：trim 后非空、不过长、不含控制字符 → 原样保留（第三方插件得以
 * 自报家门，其教训与内置来源一样可入库、可统计）；空/非字符串/超限/含控制字符 → manual。
 *
 * 控制字符（含换行）不得进入来源名：它会流进卡片渲染面与 `console.warn` 日志，
 * `x\n[lesson-loop] …` 一类的串能伪造出一条看似别人的日志行。
 *
 * 为什么退 manual 而不是拒收：manual 是"有人记了这条、但说不出是谁"的最保守归属，
 * 不因此把它当成某个内置生产者的机器上报（内置来源的归因语义不许被稀释）。
 */
function normalizeLessonSource(value: unknown): string {
  if (typeof value !== "string") {
    return FALLBACK_LESSON_SOURCE;
  }
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_LESSON_SOURCE_LENGTH ||
    CONTROL_CHARACTER.test(trimmed)
  ) {
    return FALLBACK_LESSON_SOURCE;
  }
  return trimmed;
}

/**
 * 归一后落回 manual 的"本来说了别的"情形的拒因描述：described 是日志里引号内的原文
 * （控制字符已剥），reason 是给人看的拒因；undefined = 上报方什么都没说（缺字段/空串，
 * 不刷日志）或归一本来就会收下它（典型是内置 "manual" 恰好等于兜底名——上报合法来源
 * 不算"本来说了别的"，不打假告警）。拒因判据与 normalizeLessonSource 逐条对应，
 * 两份判据只隔几行，改一处忘另一处会被各自的测试用例当场钉住。
 */
function sourceFallbackReason(raw: unknown): { described: string; reason: string } | undefined {
  let detail: { described: string; reason: string } | undefined;
  if (typeof raw === "string") {
    const described = raw.trim();
    if (described.length > 0) {
      if (CONTROL_CHARACTER.test(described)) {
        detail = { described, reason: "含控制字符" };
      } else if (described.length > MAX_LESSON_SOURCE_LENGTH) {
        detail = { described, reason: `非空但超 ${String(MAX_LESSON_SOURCE_LENGTH)} 字符` };
      }
    }
  } else if (raw !== undefined && raw !== null) {
    // 非字符串载荷取可读形式：JSON 优先（对象/数组进来的原样可读）；toJSON 返回
    // undefined 时 stringify 的运行时值是 undefined（按类型收窄，不用 ??）；循环引用/
    // BigInt 走 catch，退最后的辨认形态。
    try {
      const text: string = JSON.stringify(raw, (_key, value: unknown) =>
        typeof value === "bigint" ? String(value) : value,
      );
      detail = {
        described: typeof text === "string" ? text : Object.prototype.toString.call(raw),
        reason: `类型是 ${typeof raw}`,
      };
    } catch {
      detail = { described: Object.prototype.toString.call(raw), reason: `类型是 ${typeof raw}` };
    }
  }
  return detail;
}

/**
 * 归一后落回 manual 的"本来说了别的"情形：必须留日志，否则第三方接入只表现为静默降级。
 * 每一档拒因（非字符串 / 含控制字符 / 超长）各留一条。上报方什么都没说（缺字段/空串）
 * 不算"说了别的"，不刷日志。
 */
function noteSourceFallback(raw: unknown, source: string): string {
  if (source === FALLBACK_LESSON_SOURCE) {
    const detail = sourceFallbackReason(raw);
    if (detail !== undefined) {
      // 引号里的原文剥掉控制字符再上日志：它进不了来源名，也不该借日志的便回来。
      const clipped = detail.described
        .replaceAll(/\p{Cc}/gu, "")
        .slice(0, MAX_LESSON_SOURCE_LENGTH + 8);
      console.warn(
        `[lesson-loop] lesson source "${clipped}" 不可用（${detail.reason}），按 manual 记账`,
      );
    }
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

/** 数值字段读取：只认 number 与数字字符串两种存量形态；NaN/null/布尔/对象一律视为漂移。
 *  空串/纯空白串也按漂移退兜底：`Number("") === 0` 是有限数，会把"字段被清空"读成
 *  合法的 0——落卡上是"纪元 0"锚点与 0 次计数，比缺字段更难察觉。 */
function numericOf(value: unknown): number | undefined {
  let result: number | undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    result = value;
  } else if (typeof value === "string") {
    // 空串/纯空白串 Number("") === 0：会把漂移读成合法的 0（"纪元 0" 锚点、0 次计数），
    // 必须当漂移退兜底，而不是走 Number 的宽转换。
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) {
        result = parsed;
      }
    }
  }
  return result;
}

/** 必填数值字段归一：漂移退兜底（计数与时间戳缺了就没法渲染、排序、衰减）。 */
function numField(value: unknown, fallback: number): number {
  const parsed = numericOf(value);
  return parsed ?? fallback;
}

/** 计数器字段归一：非负整数（occurrences / violation / suppressed / samples / recurrences）。
 *  负数会把复发率分母（violation+suppressed）压小甚至归零、小数让"达到阈值"的次数比较
 *  失真——计数语义上这些位只能是 0、1、2…，漂移值按截断收敛而不是原样放行。 */
function countField(value: unknown, fallback: number): number {
  const parsed = numericOf(value);
  if (parsed === undefined || parsed < 0) {
    return fallback;
  }
  return Math.trunc(parsed);
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
  /** 规则正文（候选期由模板起草，arm 时可人工改写；注入全文，不按 token 截断——
   *  写入侧另有 maxStatementChars 的体量闸门，超限的 arm/edit 被拒）。 */
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
  /** 归并到的候选卡（occurrences 已 +1）。`ready` 是"已到升格门槛"的**电平**，
   *  `justReady` 是"这一次刚推过门槛"的**边沿**——提示用边沿，否则每条上报都重复。 */
  candidate?: RuleCard;
  ready?: boolean;
  justReady?: boolean;
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

/**
 * 人工动作结果：persisted 已落盘；not-found 无此卡；persist-failed 这一次没存住（需重试）；
 * invalid-statement 动作被拒（arm/edit 带空正文，库未动）；statement-too-long 生效正文
 * 超过 maxStatementChars（库同样没动）；unchanged 请求的终态本就成立（edit 与现文相同），
 * 未落盘也不算失败。
 */
export type RuleActionResult =
  | "persisted"
  | "not-found"
  | "persist-failed"
  | "invalid-statement"
  | "statement-too-long"
  | "unchanged";

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

/** 蒸馏补录（addCandidate）的回执：卡（计划态）+ **它是否真的落库**。
 *  落库失败时卡仍带着本次改动返回（并回已有卡时也一样），但库里那一行原样不动——
 *  调用方必须按 `persisted` 决定回显，不许把"计划"当"已生效"报：/lessons-digest 曾因此
 *  回显"已蒸馏 N 条候选规则"，而卡片列表里一张都没有。 */
export interface CandidateReceipt {
  readonly card: RuleCard;
  readonly persisted: boolean;
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

/** 规则正文的默认写入上限（字符）。设置项 maxStatementChars 的 schema 默认也从这里取，
 *  两侧不留第二份数字。armed 正文整段注入每次会话的提示词，没有上限时一次写请求就能
 *  把任意长文本塞进之后每个会话；蒸馏产出的候选不受这条闸门约束（人审时才经过 arm）。 */
export const DEFAULT_MAX_STATEMENT_CHARS = 4000;
/** 写入上限的硬上界（与 settings schema 的 max 同值）：防一个离谱的配置把闸门变成空门。 */
const MAX_STATEMENT_CHARS_CAP = 100_000;

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
  /** 规则正文的写入上限（字符；arm/edit 与继承存量正文时判）。缺省 4000。 */
  maxStatementChars?: number;
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

/**
 * 一条教训在流水里的身份键：用于「规则面写失败 → 调用方重试」这一条窄路上的去重。
 *
 * 取 report 入参里能判别"这是同一次发生"的全部字段：同一会话同一轮的同一条签名
 * 就是同一件事；detail 一起进键是为了不把"同一签名、不同细节"的两次真实发生
 * 折叠掉。ts 刻意不进键——重试时调用方递的 ts 就是新的。
 */
function lessonLedgerKey(rec: LessonRecord): string {
  return JSON.stringify([
    rec.project,
    rec.category,
    rec.signature,
    rec.sessionId ?? "",
    rec.turn ?? "",
    rec.detail,
  ]);
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

/**
 * 这条上报是不是「判据看不见、要人拍板」，而不是「已确认违规」。
 *
 * 只认上报方在 evidence 里显式打的布尔 `true`：缺这个键就是普通上报，其余取值
 * （字符串 "true"、数字 1）一律不认。放宽成 truthy 会把"字段类型写错"读成"无需确认"，
 * 而这条分支的全部作用就是让这类上报不进复发率——判据宁可漏认，不可误认。
 */
function needsUserConfirmationOf(rec: LessonRecord): boolean {
  const { evidence } = rec;
  return isRecord(evidence) && evidence["needsUserConfirmation"] === true;
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

/** 归并时不能被机器复活的状态：人工否决（rejected / archived）与机器降级（demoted）。
 *  三者的共同点是"这条规则已经不该注入"，要它重新注入只有一条合法路径 —— 人工
 *  `ruleAction(id, "arm")`。与 `STATUS_AUTHORITY` 里这三档排在 armed 之下同源。 */
const NON_REVIVABLE_STATUSES: ReadonlySet<RuleStatus> = new Set([
  "rejected",
  "archived",
  "demoted",
]);

/**
 * 挑主卡：返回 [主卡, 被并卡]。人工状态优先（armed > rejected > archived > 候选/
 * 降级），同级取 occurrences 多者（保持入参顺序优先，结果与卡片在列表里的位置无关）。
 * ⚠ 只有**状态不同级**时"被并的那张不可能带 live 计数"才成立；两张 armed 撞键时按
 * occurrences 取舍，被并的那张正是 armed 且带着自己的 violation/suppressed/samples，
 * 故 mergeProjectKeyCollisions 必须在合并前把它们累加进主卡（foldMetrics）。
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

/** 两个可选时间戳取较晚者（撞键合并后的锚点：不能因为并卡把衰减锚点拉早）。 */
function laterOf(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return Math.max(left, right);
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
    occurrences: countField(fieldOf(value, "occurrences"), 0),
    sources: unknownArray(fieldOf(value, "sources")).map((entry) => normalizeLessonSource(entry)),
    violation: countField(fieldOf(value, "violation"), 0),
    suppressed: countField(fieldOf(value, "suppressed"), 0),
    // 存量库无 samples（新增暴露计数）：默认 0，不猜值、不改写既有计数。
    samples: countField(fieldOf(value, "samples"), 0),
    recurrences: countField(fieldOf(value, "recurrences"), 0),
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
  const cwd = nonEmptyString(fieldOf(value, "cwd"));
  const sessionId = nonEmptyString(fieldOf(value, "sessionId"));
  const turn = numericOf(fieldOf(value, "turn"));
  const evidence = fieldOf(value, "evidence");
  const row: LessonRecord = {
    ts: numField(fieldOf(value, "ts"), 0),
    source: normalizeLessonSource(fieldOf(value, "source")),
    // 空白 category 会把所有漂移行折进蒸馏去重的同一个桶（键 = category+signature），
    // 与卡片归一（normalizeRuleCardRow 对 category 退 "unknown"）取同款兜底；保留行、
    // 不让一条坏 category 把整条教训从读面抹掉。
    category: category.trim().length > 0 ? category : "unknown",
    project: strField(fieldOf(value, "project"), "default"),
    signature,
    detail: strField(fieldOf(value, "detail"), ""),
  };
  if (cwd !== undefined) {
    row.cwd = cwd;
  }
  if (sessionId !== undefined) {
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

/** 数字阈值归一：非法/越界用默认值（供 policy() 共用，无父级捕获）。
 *  只认 number 类型：`Number(null/"")` 都是 0，会把漂移交出来的 null/空串当成
 *  "合法的 0"放行——与"非法用默认值"的承诺相反。 */
function num(value: unknown, fallback: number, min = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    return fallback;
  }
  return value;
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
  /** 本次改动前的累计观察数。`justReady` 的边沿判据要拿它比门槛，不能只看改完后的值：
   *  一次上报可能把 occurrences 跳过多个格（rejected 转回候选时把复发段整段并进来），
   *  等值比较会整段漏掉；而门槛本身是设置项，下调之后 occurrences 已经大于门槛，
   *  等值比较永远不再成立。 */
  readonly previousOccurrences?: number;
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
 * 人工动作落地。返回动作有没有真的改了卡：
 * - "changed"：状态/正文/计数有实际变化，updatedAt 推进到 now，写盘。
 * - "no-statement"：arm/edit 需要非空正文而拿不到（缺省、空白）。空正文的规则一旦
 *   armed 会整段注入常驻注入面（prompt 侧不设 token 上限），一条没有内容的"规则"
 *   只挤占上下文；edit 空正文则是"什么都没改"。两种都不动卡，调用方回 400。
 * - "too-long"：生效正文超过 maxStatementChars。armed 正文整段注入每次会话的提示词，
 *   写入侧不设限时一次请求就能把它塞满；arm 继承存量正文时同样要判（旧数据不受写入
 *   上限约束，但不许借一次 arm 直接进注入面）。
 * - "no-change"：edit 的正文与现文逐字相同。不碰正文也不推进 updatedAt——那会把
 *   "最后一次人工动作时间"污染成一个没有动作的时刻，还触发一轮整片 CAS 覆写。
 *
 * arm 会清零历史度量：复发/干净/暴露三项计数属于**那一次升格**的生命周期，带着旧值
 * 进新一轮会让降级裁决读到混合证据。
 */
/** 人工动作的"缺正文"信号（字面量在返回类型与两处 return 之间共用，不散写）。 */
const ACTION_NO_STATEMENT = "no-statement" as const;
/** 人工动作的"正文超长"信号（同上）。 */
const ACTION_TOO_LONG = "too-long" as const;

function applyRuleAction(
  rule: RuleCard,
  action: "arm" | "reject" | "demote" | "archive" | "edit" | "revive",
  statement: string | undefined,
  now: number,
  maxStatementChars: number,
): "changed" | typeof ACTION_NO_STATEMENT | typeof ACTION_TOO_LONG | "no-change" {
  const nextStatement = trimmedStatement(statement);
  switch (action) {
    case "arm": {
      const effective = nextStatement ?? rule.statement;
      if (effective.trim().length === 0) {
        return ACTION_NO_STATEMENT;
      }
      if (effective.length > maxStatementChars) {
        return ACTION_TOO_LONG;
      }
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
      if (nextStatement === undefined) {
        return ACTION_NO_STATEMENT;
      }
      if (nextStatement.length > maxStatementChars) {
        return ACTION_TOO_LONG;
      }
      if (nextStatement === rule.statement) {
        return "no-change";
      }
      rule.statement = nextStatement;
      break;
    }
    // action 是六个字面量的联合类型，宿主侧 isRuleAction 先把门外值挡掉，故不写兜底分支。
    // no default
  }
  rule.updatedAt = now;
  return "changed";
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
  /** 上一次 report 的「流水已写、规则面没写成」记号（见 report 的注释）。
   *  只活到下一次 report 成功或换了一条教训为止：它是**一次失败重试**的去重面，
   *  不是跨会话的幂等表——持久化幂等需要事件 id 与读侧重放，那是另一套东西。 */
  private pendingLedgerKey: string | null = null;

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
        | "maxStatementChars"
        | "reviveThreshold"
      >
    >,
  ): void {
    for (const [key, val] of Object.entries(partial)) {
      if (typeof val === "number" && Number.isFinite(val)) {
        // 写入侧按读取侧（threshold()/policy()/reviveThreshold()）接受的合法区间收敛后
        // 再赋值：负数/越界值直写 opts 只会在读取侧被静默换成默认值，设置界面上的值与
        // 实际生效值从此对不上，排查时无从判断"设置到底有没有生效"。各键的区间与读取
        // 侧一一对应（policy() 不取整，故这两枚不 floor；threshold()/reviveThreshold()
        // 读取侧 floor，写入侧同样收成整数）。
        switch (key) {
          case "promoteThreshold": {
            this.opts.promoteThreshold = Math.max(1, Math.floor(val));
            break;
          }
          case "demoteThreshold": {
            this.opts.demoteThreshold = Math.max(1, val);
            break;
          }
          case "demoteMinSamples": {
            this.opts.demoteMinSamples = Math.max(1, val);
            break;
          }
          case "demoteRatio": {
            this.opts.demoteRatio = Math.max(0.01, val);
            break;
          }
          case "decayDays": {
            this.opts.decayDays = Math.max(1, val);
            break;
          }
          case "maxLessonsBytes": {
            // 走归一口而不是再写一次字段：保险丝"非法退 0"的判据只该有一处。
            this.setMaxLessonsBytes(val);
            break;
          }
          case "maxStatementChars": {
            this.opts.maxStatementChars = Math.min(
              MAX_STATEMENT_CHARS_CAP,
              Math.max(1, Math.floor(val)),
            );
            break;
          }
          case "reviveThreshold": {
            this.opts.reviveThreshold = Math.min(20, Math.max(1, Math.floor(val)));
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
      // 数组浅拷贝：卡对象本身的隔离由端口契约保证（RulesRead 的 JSDoc：每次 load 交出
      // 归一后的**新对象**，plan 就地改写不会渗回端口）。端口实现若缓存复用卡对象，
      // CAS 重放会把同一批对象二次累加——那是违反契约，不是这里的缺陷。
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
    //
    // 两笔之间没有事务，所以"重试"必须在这里收口：上一次已经写过流水、只是规则面
    // 没写成时，调用方重试同一条教训**不再追加第二行**——否则一次 CAS 冲突就在流水
    // 里留下两条"这条教训发生过"，而规则卡只加了一次，两个计数从此对不上。
    // 反过来（流水没写成）不做补偿：流水是 cache，少一行只影响展示，补写反而要在
    // 规则面已经生效之后再造一次写失败面。
    const ledgerKey = lessonLedgerKey(rec);
    const alreadyAppended = ledgerKey === this.pendingLedgerKey;
    if (!alreadyAppended) {
      appendJsonl(this.opts.lessonsFile, rec, this.opts.maxLessonsBytes ?? 0);
    }
    const obs = observeLesson(rec, now);
    const key = ruleKey(rec.project, rec.category, obs.signature);
    const outcome = await this.commit((cards) => this.planReport(cards, obs, key));
    this.pendingLedgerKey = outcome.ok ? null : ledgerKey;
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
    // 改完之后的 occurrences 可能跳过好几格（rejected 转回候选时把复发段整段并进来），
    // 边沿判据要拿改动前的这一位与门槛比。
    const previousOccurrences = rule.occurrences;
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
      // 「需用户拍板」不是「已确认违规」：上报方把 `needsUserConfirmation: true` 打在
      // evidence 里，表示它**判据看不见**这段内容（nestedShellUnconfirmed 一类），
      // 既没确认危险也没有一次干净命中。把它计进复发率会让一条从不产生违规的规则
      // 凭"问过几次"累积到降级门槛，且分母（suppressed）永远是 0，卡只会停在不可判定。
      // 这类上报只补证据，不动任何度量位。
      if (needsUserConfirmationOf(rec)) {
        return { value: { kind: "settled", card: rule }, write: true };
      }
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
      return { value: { kind: "candidate", card: rule, previousOccurrences }, write: true };
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
      return { value: { kind: "candidate", card: rule, previousOccurrences }, write: true };
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
    // 累计观察数只增不减：rejected 期的复发同样是"这条教训又出现了"的观测，转回候选时
    // 并进 occurrences（旧实现写 `occurrences = recurrences`，把此前的累计数直接覆盖成
    // 复发段的那几个数——卡片上的"观察 N 次"会凭空变小）。
    rule.occurrences += rule.recurrences;
    rule.recurrences = 0;
    rule.updatedAt = now;
    return true;
  }

  /** 组装 report() 回执：ready 只在确实落盘后才报（磁盘没存住就催人工审 = 点空）。 */
  private receiptFor(outcome: Committed<ReportPlan>): ReportReceipt {
    const { ok, value } = outcome;
    const { kind, card, previousOccurrences } = value;
    const threshold = this.threshold();
    // ready 必须同时看落盘：磁盘没存住就催人工审，人点下去是一张不存在的卡。
    const ready = ok && (kind === "created" ? threshold <= 1 : card.occurrences >= threshold);
    // 刚越过门槛的那一次：这是**边沿**，与 ready 的**电平**不是一回事。
    // 调用方拿 ready 打日志会在越过门槛之后每一条上报各打一次（上游持续复发时就是刷屏），
    // 而"该来审这张卡了"这件事在每个门槛上只发生一次。门槛为 1 时建卡即越线。
    // 判据是「改动前没过门槛、改动后过了」，不是「改动后恰好等于门槛」：一次上报可能把
    // occurrences 跳过好几格（rejected 转回候选时把复发段整段并进来），等值比较会整段漏掉；
    // 门槛又是设置项，下调之后 occurrences 已大于门槛，等值比较永远不再成立。
    const justReady =
      ready &&
      (kind === "created"
        ? true
        : (previousOccurrences ?? 0) < threshold && card.occurrences >= threshold);
    return {
      ok,
      ...(ok ? {} : { reason: PERSIST_FAILED }),
      ...(kind === "violation" ? { violationOf: card } : {}),
      ...(kind === "created" || kind === "candidate" ? { candidate: card, ready, justReady } : {}),
    };
  }

  /** revival 阈值（StoreOptions.reviveThreshold，归一 1-20，默认 3）。 */
  private reviveThreshold(): number {
    const value = Number(this.opts.reviveThreshold);
    return Number.isFinite(value) && value >= 1 ? Math.min(20, Math.floor(value)) : 3;
  }

  /** 规则正文写入上限（StoreOptions.maxStatementChars，归一 1-100000，默认 4000）。
   *  按 UTF-16 码元计：这条闸门护的是"注入面的体量"，不是排版宽度。 */
  private maxStatementChars(): number {
    const value = Number(this.opts.maxStatementChars);
    return Number.isFinite(value) && value >= 1
      ? Math.min(MAX_STATEMENT_CHARS_CAP, Math.floor(value))
      : DEFAULT_MAX_STATEMENT_CHARS;
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
   *
   * @returns 是否落定：true = 要么真写进了库、要么本来就没有要写的东西；false = 这次
   * 清算没到达磁盘（CAS 耗尽 / 端口拒写 / 读不可信），暴露账目在盘上一格未动——调用方
   * 据此保留重试边（ lesson-store 的宿主接线靠它决定要不要还原清算标记与台账条目）。
   *
   * @param countExposure 首个 dispose 边计暴露；resume 出来的重复边只结算 suppressed。
   */
  public async sessionEnded(
    project: string,
    violatedRuleIds: ReadonlySet<string>,
    passedRuleIds: ReadonlySet<string>,
    sessionId?: string,
    countExposure = true,
  ): Promise<boolean> {
    const now = this.now();
    const outcome = await this.commit((cards): Planned<boolean> => {
      let dirty = false;
      for (const rule of cards) {
        const counts = rule.status === "armed" && rule.project === project;
        const passed = counts && passedRuleIds.has(rule.id);
        // 两个计数器都不动就是没东西可写：重复的 dispose 边既不涨 samples（countExposure
        // 为假）又没有新一轮的干净命中，写一笔只改 updatedAt 会把"这次上报了什么"变成
        // "最后一次清算发生在何时"，而且每次 resume 都触发一轮 CAS 整片写。
        const writes = counts && (countExposure || passed) && !violatedRuleIds.has(rule.id);
        if (writes) {
          if (countExposure) {
            rule.samples += 1;
          }
          rule.updatedAt = now;
          dirty = true;
          if (passed) {
            rule.suppressed += 1;
            rule.lastSuppressedAt = now;
          }
        }
      }
      return { value: dirty, write: dirty };
    });
    // 汇报"已清算"只在**真的写进库**之后：没存住（CAS 耗尽/端口拒写/读不懂）时
    // samples/suppressed 在盘上一格没动，回执 false 让调用方保留重试边。
    if (outcome.value && !outcome.ok) {
      console.error(
        `[lesson-loop] ${sessionId ?? "unknown session"}: session settle for project ${project} was NOT persisted (retry on the next session end)`,
      );
      return false;
    }
    // 读不可信（usable:false）时计划折叠成空转：一笔 samples/suppressed 都没记、也没进
    // 库，outcome 却是 ok:true + value:false——回执 false，别让这次暴露的丢失在日志里
    // 完全无迹可查（规则库侧的 corrupt 告警说的是"读不懂"，这条说的是"因此少记了账"）。
    if (!outcome.trustworthy) {
      console.error(
        `[lesson-loop] ${sessionId ?? "unknown session"}: session settle for project ${project} was skipped (rule library unreadable, exposure not recorded)`,
      );
      return false;
    }
    if (outcome.value && sessionId !== undefined) {
      console.info(
        `[lesson-loop] ${sessionId}: session settled for project ${project} (${String(passedRuleIds.size)} passed rule(s))`,
      );
    }
    return true;
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
   *  没存住（含端口读不懂的那种），调用方提示重试，绝不当成"规则不存在"；
   *  invalid-statement = 动作被正文判据拒绝（库未动）；statement-too-long = 生效正文
   *  超过 maxStatementChars（库同样没动）；unchanged = 请求的终态本就成立。 */
  public async ruleAction(
    id: string,
    action: "arm" | "reject" | "demote" | "archive" | "edit" | "revive",
    statement?: string,
  ): Promise<RuleActionResult> {
    const outcome = await this.commit(
      (cards): Planned<"changed" | "missing" | "no-statement" | "too-long" | "no-change"> => {
        const rule = cards.find((row) => row.id === id);
        if (rule === undefined) {
          return { value: "missing", write: false };
        }
        const applied = applyRuleAction(
          rule,
          action,
          statement,
          this.now(),
          this.maxStatementChars(),
        );
        // 两个 no-* 都不写盘：no-statement 是动作被拒（调用方回 400），no-change 是
        // 请求的终态（正文 = 这段文字）本就成立——落一盘只改 updatedAt 的 CAS 覆写
        // 没有语义。
        return applied === "changed"
          ? { value: "changed", write: true }
          : { value: applied, write: false };
      },
    );
    if (outcome.value === "missing") {
      return outcome.trustworthy ? "not-found" : "persist-failed";
    }
    if (outcome.value === "no-statement") {
      return "invalid-statement";
    }
    if (outcome.value === "too-long") {
      return "statement-too-long";
    }
    if (outcome.value === "no-change") {
      return "unchanged";
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
  }): Promise<CandidateReceipt> {
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
        // 只有候选卡消费蒸馏产出（计 occurrences + 追加证据）；rejected/armed/archived/
        // demoted 的状态与证据都由人拍板，蒸馏一概不改。证据这一面尤其不能松：落盘时
        // capEvidence 只留最近几条（见 lib/rules-layout.ts），而蒸馏正文是模型产出——
        // 模型连报几条同键条目就能把人工卡此前的真实证据整批挤出，且状态与计数一格不动，
        // 任何日志都不会发现。想留下这一笔，就在人审时自己写进卡片正文。
        if (existing.status === "candidate") {
          existing.evidence.push(evidenceRow(now, source, input.detail, rawSignature, signature));
          existing.occurrences += 1;
          existing.updatedAt = now;
          existing.lastSeenAt = now;
          return { value: existing, write: true };
        }
        // 非候选命中一格未动：写一笔只改 updatedAt 的整片 CAS 覆盖，会把"最后一次
        // 人工动作时间"污染成一次蒸馏摸过的时刻，还触发无意义的全库写。
        return { value: existing, write: false };
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
    // 回执带 `persisted`：没存住时库里的那一行原样不动（outcome.ok=false），调用方据此
    // 决定回显，不许把计划态当已生效报——见 CandidateReceipt 的注释。
    return { card: outcome.value, persisted: outcome.ok };
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
    // 与 runDecay 同一口径：计划值不等于落盘值。commit 在 CAS 耗尽/端口拒写时一次都
    // 没写，盘上一张卡未动——把并掉的张数照原样返回，调用方的 "migrated N fragment
    // rule(s)" 日志就把未落盘的归并当成了事实。
    if (!outcome.ok && outcome.value > 0) {
      console.error(
        `[lesson-loop] fragment migration: ${String(outcome.value)} merge(s) were NOT persisted`,
      );
      return 0;
    }
    return outcome.value;
  }

  /** 在待写数组上跑一遍全类别的碎片归并（数组就地收敛；产出见 MergePass）。 */
  private mergeFragmentsIn(cards: RuleCard[]): MergePass {
    let merged = 0;
    let dirty = false;
    for (const [category, stableSig] of Object.entries(CATEGORY_SIGNATURES)) {
      // 快照全部潜在碎片（候选/armed/rejected 且**按类别**算碎片签名），再按 project
      // 分组处理——跨项目绝不合并（规则卡按 project 隔离，混并会污染桶内度量与注入）。
      const candidates = cards.filter(
        (card) =>
          card.category === category &&
          card.signature !== stableSig &&
          (card.status === "candidate" || card.status === "armed" || card.status === "rejected") &&
          isFragmentSignatureOf(category, card.signature),
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
    const summarySig = `${stableSig}${REJECTED_SUMMARY_SUFFIX}`;
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
      // 容器正文原则上由本包模板起草，但 busiest 碎片可能被人改写过（edit 对任何状态
      // 的卡都生效）——无条件覆盖会把人写下的拒绝理由换成模板文案。机器起草的判定：
      // 正文与该签名按当前语言起草出的模板逐字相同才覆盖；语言切换后的存量卡比不中
      // 模板，按"人工写过的"保守保留。已是汇总签名的那张卡走不到这里，它的正文永不被改写。
      const draftedAsFragment = draftStatement(category, primary.signature, this.messages());
      const machineDrafted = primary.statement === draftedAsFragment;
      primary.signature = summarySig;
      if (machineDrafted) {
        primary.statement = draftStatement(category, summarySig, this.messages());
      }
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
    const armedSources: RuleCard[] = [];
    const doomed = new Set<string>();
    for (const card of fragments) {
      if (card.id !== primary.id) {
        if (card.status === "armed") {
          armedSources.push(card);
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
    LessonStore.absorbArmedSources(primary, armedSources);
    if (merged > 0 || rewritten) {
      primary.updatedAt = this.now();
    }
    dropCards(cards, doomed);
    return { merged, dirty: merged > 0 || rewritten };
  }

  /**
   * 把若干 armed 碎片的决定与度量折进主卡。
   *
   * 人工"已升格"的决定优先于卡面状态：碎片里有 armed 而主卡只是候选时，归并后必须
   * 仍是 armed（否则升格过的规则静默退回候选，注入随之停止）。
   *
   * 度量要**逐张累加**：arm 期计数属于各自那次升格，而这里可能不止一张 armed 碎片
   * （旧版按路径分片就会这样）。只搬第一张等于把其余几张真实被测到的证据抹掉——
   * 复发率分母随之变小，一条本该校降级的规则会永远留在 armed 继续注入。
   *
   * @param primary - 归并后的主卡
   * @param armedSources - 被并掉的 armed 碎片（不含主卡自身）
   */
  private static absorbArmedSources(primary: RuleCard, armedSources: readonly RuleCard[]): void {
    if (armedSources.length === 0) {
      return;
    }
    if (primary.status === "armed") {
      // 主卡自己就是 armed：它的度量已在卡上，只折叠被并的那几张。
      for (const source of armedSources) {
        LessonStore.foldMetrics(primary, source);
      }
      return;
    }
    if (NON_REVIVABLE_STATUSES.has(primary.status)) {
      // 主卡已被人工否决（rejected / archived）或被降级（demoted）：只并入度量，不改状态。
      // 归并是**机器**动作，它不能替人撤销一次决定 —— 与 accumulate() 那条「机器永不把
      // rejected 写成 armed」是同一条红线，`STATUS_AUTHORITY` 也把这三档排在 armed 之后。
      // 旧实现只看主卡「当前是不是 armed」，于是 existing 命中即当主卡、随后 inheritArmed
      // 无条件写 armed，把一次人工否决整个翻掉，规则重新进入注入面。
      for (const source of armedSources) {
        LessonStore.foldMetrics(primary, source);
      }
      return;
    }
    // 主卡不是 armed：第一张整片继承（含 armedAt 与三个时间戳的缺键语义），
    // 其余几张按度量累加，免得继承与累加把第一张算两遍。
    for (const [index, source] of armedSources.entries()) {
      if (index === 0) {
        LessonStore.inheritArmed(primary, source);
      } else {
        LessonStore.foldMetrics(primary, source);
      }
    }
  }

  /** 把 armed 碎片的生命周期度量搬到主卡（arm 期计数属于那次升格，不能留空）。
   *  三个时间戳按静态键逐个处理：源卡缺值时必须真的删键（留 undefined 与删键在
   *  JSON 往返后语义不同，decayVerdict 的锚点回退链会被 undefined 干扰）。
   *  **源卡有值时取更晚的一个，不是整片取代**：主卡自己可能已经带着一个更晚的
   *  armedAt——candidate 卡从 armed 降级/拒绝/归档再复活时 armedAt 是保留的
   *  （见 demote/reject/archive 分支），于是「主卡未武装」不等于「主卡没有锚点」。
   *  整片取代会把锚点拉早，decayVerdict 的 `now - anchor >= decayDays` 提前成立，
   *  一张刚升格的卡会被立刻判降级。lastViolationAt/lastSuppressedAt 同属"最近一次"
   *  语义，同样不能被更早的碎片覆盖回去。
   *  源卡缺这个键时仍按原语义**删键**（不是留着主卡旧值）：那一路的口径是"这次升格
   *  没有时间戳可承"，留一个陈旧锚点会被 decayVerdict 当成真的升格时刻。 */
  private static inheritArmed(primary: RuleCard, armedSource: RuleCard): void {
    primary.status = "armed";
    primary.violation = armedSource.violation;
    primary.suppressed = armedSource.suppressed;
    primary.samples = armedSource.samples;
    const inherited =
      armedSource.armedAt === undefined ? undefined : laterOf(primary.armedAt, armedSource.armedAt);
    if (inherited === undefined) {
      delete primary.armedAt;
    } else {
      primary.armedAt = inherited;
    }
    const lastViolation =
      armedSource.lastViolationAt === undefined
        ? undefined
        : laterOf(primary.lastViolationAt, armedSource.lastViolationAt);
    if (lastViolation === undefined) {
      delete primary.lastViolationAt;
    } else {
      primary.lastViolationAt = lastViolation;
    }
    const lastSuppressed =
      armedSource.lastSuppressedAt === undefined
        ? undefined
        : laterOf(primary.lastSuppressedAt, armedSource.lastSuppressedAt);
    if (lastSuppressed === undefined) {
      delete primary.lastSuppressedAt;
    } else {
      primary.lastSuppressedAt = lastSuppressed;
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
    // 与 runDecay / migrateFragmentRules 同一口径：CAS 耗尽 / 端口拒写时一次都没落盘，
    // "rewrote N / merged M" 的调用方日志不许把计划当事实报。
    // 两个计划值合并成一个判据（而不是 `a > 0 || b > 0`）：写只可能在 rewrites > 0 时发生，
    // 短路会让 `merged > 0` 成为一条永远不求值的分支，覆盖率门禁把它当未覆盖。
    const plannedChanges = outcome.value.rewrites + outcome.value.merged;
    if (!outcome.ok && plannedChanges > 0) {
      console.error(
        `[lesson-loop] project key migration: ${String(outcome.value.rewrites)} rewrite(s) / ${String(outcome.value.merged)} merge(s) were NOT persisted`,
      );
      return { rewrites: 0, merged: 0 };
    }
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
        LessonStore.foldMetrics(primary, extra);
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

  /** 撞键合并前把被并卡的**生命周期度量**累加进主卡：两张 armed 撞同键时被并的那张
   *  带着自己的 violation/suppressed/samples，而 mergeFragment 只折叠观察类字段
   *  （occurrences/evidence/sources/lastSeenAt/statement/armedAt）——不累加就等于把
   *  一条规则真实被测到的证据抹掉，复发率分母随之变小。三个时间戳取较晚者（锚点不拉早，
   *  免得刚并完就判"不可判定"）；源卡缺值时才删键（undefined 与删键在 JSON 往返后语义
   *  不同，decayVerdict 的锚点回退链会被 undefined 干扰，同 inheritArmed 的口径）。 */
  private static foldMetrics(primary: RuleCard, extra: RuleCard): void {
    primary.violation += extra.violation;
    primary.suppressed += extra.suppressed;
    primary.samples += extra.samples;
    const armedAt = laterOf(primary.armedAt, extra.armedAt);
    const lastViolationAt = laterOf(primary.lastViolationAt, extra.lastViolationAt);
    const lastSuppressedAt = laterOf(primary.lastSuppressedAt, extra.lastSuppressedAt);
    for (const [key, value] of [
      ["armedAt", armedAt],
      ["lastViolationAt", lastViolationAt],
      ["lastSuppressedAt", lastSuppressedAt],
    ] as const) {
      if (value === undefined) {
        Reflect.deleteProperty(primary, key);
      } else {
        primary[key] = value;
      }
    }
  }

  /** 该规则当前是否"不可判定"（armed 够久却 violation+suppressed 双零）。派生态，
   *  每次按当前 policy/now 现算，不落库——规则重新被触发（violation 或 pass 计数）
   *  即自然退出该态。计数由调用方在**已经读到的那份**规则数组上算
   *  （/stats 每条轮询：一次读取既是投影也是计数，见 host.ts 的 statsSnapshot）。 */
  public isUndeterminable(rule: RuleCard): boolean {
    return decayVerdict(rule, this.policy(), this.now()) === "undeterminable";
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
    const { undeterminable } = outcome.value;
    // demoted 只在**真的写进库**之后才作数：写失败时库里的状态还是 armed，
    // 报出 demoted 会让调用点以为降级已生效（/stats 与「N demoted」日志同一条口径）。
    const demoted = outcome.ok ? outcome.value.demoted : 0;
    if (outcome.value.demoted > 0 && !outcome.ok) {
      console.error(
        `[lesson-loop] decay: ${String(outcome.value.demoted)} demote(s) were NOT persisted — rules stay armed`,
      );
    }
    if (demoted + undeterminable > 0) {
      console.info(`[lesson-loop] decay: ${demoted} demoted, ${undeterminable} undeterminable`);
    }
    return { demoted, undeterminable };
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

  /** 有效教训数：与 recentLessons 同一归一口径（normalizeLessonRow 过滤后的条数），
   *  而不是 JSONL 原始行数——原始行数把"可解析但 category 漂移"之类读侧会兜底/丢弃的
   *  行也计进去，界面的"计数"会大于"列表全量长度"，两个数字对不上。 */
  public lessonsCount(): number {
    let count = 0;
    for (const row of readJsonl(this.opts.lessonsFile)) {
      if (normalizeLessonRow(row) !== null) {
        count += 1;
      }
    }
    return count;
  }
}
