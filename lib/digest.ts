// digest：把「本会话人工差评 + 本项目近期教训」交给 LLM 蒸馏成候选规则。
//
// 输入两路（都全量，不截断）：
//   1. 本会话日志里的人工差评（feedback/message-put 的 rating==='negative' 项 +
//      feedback/record 的会话级备注——packages/feedback 刻意不进模型上下文，
//      这里是它的唯一出口，经用户手动命令触发）；
//   2. 本项目近期教训（lessons.jsonl 里同 project 的记录，去重后作背景）。
// LLM 只做一件事：把差评归纳成结构化候选规则（JSON 数组），机器不自动 armed。
//
// llm.stream 契约与 dir-prep-organize 同款（GenerateOptions + 流块 drain）。
//
// 进模型的提示词与失败原因的语言**全部由调用点注入**（`messages` 入参，见 lib/messages.ts）：
// 本文件是纯函数、不读设置。蒸馏出来的规则条目是用户数据，一律原样透传，不改写。
//
// 文本面不住在这里：差评投影在 lib/negative-feedback.ts，system/用户帧拼装与产出解析在
// lib/digest-prompt.ts。本文件只剩"跑一次蒸馏"（取数 → 发流 → 建卡），三段同一条注入纪律。

import { randomUUID } from "node:crypto";
// 事件形状取官方判别联合，不再本地写 `type?: string; data?: Record<string, unknown>`
// ——那等于把整张事件表抹平成一个字典，宿主新增/改名事件位在类型面上完全隐形。
// `feedback/message-put` 与 `feedback/message-delete` 由 @deepseek-ai/dsh-message-feedback、
// `feedback/record` 由 @deepseek-ai/dsh-command-feedback 各自以 `declare module
// '@deepseek-ai/dsh-session/types'` 增强进 SessionEventMap；TS7 不接受 `import type "mod"`
// 这种无绑定形式，故用具名 type-only 导入把三份增强一起带进本模块的 program。
import type { Session, SessionEvent, SessionHeader } from "@deepseek-ai/dsh-session";
// 三条宿主服务面绑官方声明（全部 type-only：运行时服务由 ctx 注入）：
// - `LlmRuntime`：`Context.llm` 的类型（installed @deepseek-ai/dsh-llm/lib/types/index.d.ts:29-31）
// - `AgentDefaultModelConfig`：`Context.agentDefaultModel` 的类型（installed
//   @deepseek-ai/dsh-agent-default-model/lib/types/index.d.ts:6-8, :24）
// - `Session` / `SessionHeader`：installed @deepseek-ai/dsh-session/lib/types/index.d.ts:135 起
//   （`header` :150、`id` :154）与 lib/types/types.d.ts:58-95
import type { AgentDefaultModelConfig } from "@deepseek-ai/dsh-agent-default-model";
// 注入消息的 id 位是官方幻影品牌 `MessageId`，唯一合法构造口是官方 `brandString`（恒等函数；
// 口径：dsh-brand 在 peerDependencies，产物留裸说明符，不再内联）。本文件与 host.ts 共用这
// 同一条口径——两半各自自包含，谁也不 import 谁的运行时。`reasoningEffort` 的品牌同源
// （`Branded` 原语与构造器都住在 dsh-brand，dsh-llm 只交出类型位），故透传它也只引类型。
import { brandString } from "@deepseek-ai/dsh-brand";
import type {
  LlmRuntime,
  MessageId,
  ReasoningEffortId,
  StreamChunk,
  UserMessage,
} from "@deepseek-ai/dsh-llm";
import { errorText } from "@jayyuen66/dsh-plugin-shared/lib/errors";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { deriveProject } from "./lesson-store.ts";
import type { LessonStore } from "./lesson-store.ts";
import { fenceUntrusted, LESSON_SOURCE_KIND } from "./prompt.ts";
import { collectNegativeFeedback } from "./negative-feedback.ts";
import {
  buildDigestPrompt,
  digestSystemPrompt,
  lessonsBackground,
  parseDigestOutput,
} from "./digest-prompt.ts";
import type { DigestParsedRule } from "./digest-prompt.ts";
import { fill } from "./messages.ts";
import type { LessonLoopMessages } from "./messages.ts";

export type { SessionEvent } from "@deepseek-ai/dsh-session";

/**
 * 会话的归因读取面 = **官方 `Session` 的键名投影**（installed
 * @deepseek-ai/dsh-session/lib/types/index.d.ts：`get id(): SessionId` :154、
 * `readonly header: SessionHeader` :150）。
 * 值域两处都收窄：整枚 `Session` 是带 private 字段的类（:135-139 → 名义比较），本包与
 * 测试的替身永远满足不了；`header` 只读 `cwd`（官方即 `readonly cwd?: string`，
 * lib/types/types.d.ts:69），因为 `deriveProject` 只要根目录。可缺失是本包对**跨进程
 * 边界**的口径（命令 handler 递来的 agent.session 是否具备某位只能运行时判，
 * 见 host.ts 的 `isSessionLike`），不是替宿主重定必选性。
 * ⚠ 这里**不再有** `snapshotEvents`：官方把同步事件读面标成 `@deprecated`（"new calls are
 * prohibited"，:186-187），本包的读法已改到 `ctx.sessionQuery.observeSession()` 上（事件由
 * 调用方取好后经 {@link DigestRunOptions.events} 注入，见 host.ts 的 registerDigestCommand）。
 */
export interface SessionLike {
  readonly id?: Session["id"];
  readonly header?: Partial<Pick<SessionHeader, "cwd">>;
}

/**
 * 蒸馏请求帧的形状 = 官方 `GenerateOptions.messages` 受理的那一档。
 * installed @deepseek-ai/dsh-llm/lib/types/types.d.ts:492
 * `RequestMessage = Message | RequestUserInput`——**两档都受理**：本包的帧带稳定 `id` 与
 * producer 归属（`source.form` 声明"这段上下文是要读的指令"，见 lib/prompt.ts），故走完整的
 * 官方 `UserMessage`（`id` 是品牌 `MessageId`，installed lib/types/brand.d.ts:14，构造口只有
 * 官方 `brandString`；`source.kind` 由 lib/prompt.ts 那条 producer 声明 merge 进
 * `MessageSourceMap`）。dir-prep-organize 的整理帧走的是另一档（`RequestUserInput`，
 * 官方在那里把 `id`/`source` 记成 `?: never`），因为它从不声明归属——两包形状不同是**语义
 * 不同**，不是抄本漂移。旧镜像把这一帧手抄成 `{ id: string; role: "user"; content: {...}[];
 * source?: {...} }`：`id` 降级成裸 string（品牌信息丢）、`content` 只承认 text 块（官方是
 * `readonly ContentBlock[]`），且整块不受官方约束。
 */
type DigestRequestMessage = UserMessage;

/**
 * `ctx.llm` 的本包面 = 官方 `LlmRuntime` 的 `stream` 方法面投影，签名一个字都不重述
 * （installed @deepseek-ai/dsh-llm/lib/types/index.d.ts:29-31 交出 `Context.llm`）。
 * 旧镜像把入参整块手抄（provider/model/messages/system/signal 逐个自己判可选性），把返回
 * 也手抄成 `{ type?: string; text?: unknown; reason?: {...} }`——于是流块换名
 * （`text-delta`/`finish` 是官方判别联合的 kind）、或 `reason.failure` 换形状，本包都静默
 * 读不到。现在载荷类型全部由官方成员交出，而**交付侧**的宽容（chunk 缺字段、reason 非对象）
 * 仍由 drainStreamText 里的 `typeof` 守卫承担：官方说的是适配器的承诺，跨实现交付要自己判。
 */
export type LlmService = Pick<LlmRuntime, "stream">;

/** `ctx.agentDefaultModel` 的本包面：只 `currentSelection()`（installed 同文件 :41）。 */
export type AgentDefaultModel = Pick<AgentDefaultModelConfig, "currentSelection">;

/** 默认模型选择 = 官方 `ModelSelection` 的三位形状，但**可选性按交付面放宽**：`currentSelection()`
 *  是宿主服务交回来的值，官方声明里 `provider`/`model` 必选，而本包拿到的是跨边界交付——配置
 *  没落、Volatile 引用未解析时照样可能是缺位的半截对象。守卫留在 runDigest 入口，类型不再替
 *  宿主打包票。`reasoningEffort` 是官方选择保留的第三位，runDigest 会把它**原样透传**给
 *  `llm.stream`（官方 `GenerateOptions` 受理该位）——类型面留着它却不用它，等于把用户选定
 *  的推理强度静默丢给适配器默认档。
 *
 *  为什么不直接 import 官方类型：那会在 `types/lib/digest.d.ts` 里留下裸说明符
 *  `@deepseek-ai/dsh-agent`，而本包只把它当 devDependency——消费方按 manifest 装依赖，
 *  声明里没这个名字就是 TS2307。扩 peer 是发布契约变更，归用户裁决；此前用结构等价类型。 */
export interface ModelSelection {
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
}

// 本插件的消息身份（PLUGIN_NAME / LESSON_SOURCE_KIND）只在 lib/prompt.ts 定义一份：
// 蒸馏请求帧与 host 的 armed 规则摘要注入是同一个生产者，不得有两个身份
// （蒸馏请求本身是 request-only 输入、不落持久消息位，但读回历史行时比的就是这个串）。
// 见 lib/prompt.ts 的注释：0.2.1-alpha.2 的 V4 准入（session-format-v3-to-v4/src/
// message-sources.ts）在**每个**声明的持久消息位上拒收退役包装
// `{ kind: 'plugin', plugin }`，迁移表又给未知插件名统一加 `plugin:` 前缀
// （sources.ts producerKind），故 `plugin:lesson-loop` 既是注入身份也是读回身份。

/** 未知数组：非数组退空表（不经 any 扩散，逐元素仍是 unknown）。 */
function unknownArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * /lessons-digest 回执里的单条候选规则行：category 与 statement 都是模型产出
 * （不可信），逐字段定界后才进给人看的编号行。
 */
export function digestCreatedLine(
  rule: { category: string; statement: string },
  index: number,
  messages: LessonLoopMessages,
): string {
  return fill(messages.digestCreatedLine, {
    index,
    category: fenceUntrusted(rule.category),
    statement: fenceUntrusted(rule.statement),
  });
}

// ── 蒸馏入口 ─────────────────────────────────────────────────────────────

/** 蒸馏墙钟的**默认值**（真值由 host 的 entry config `digestTimeoutMs` 交进来，
 *  这里只剩 schema `.default()` 的单一来源）。 */
export const DEFAULT_DIGEST_TIMEOUT_MS = 120_000;

/**
 * 从终态块里取"结束原因"的**可打印标签**。
 *
 * 参数刻意是 `unknown` 而不是 `FinishReason`：官方判别联合声明每档必带 `kind`，
 * 那说的是适配器**承诺**的形状；跨界载荷实际会漂移（test/digest.test.ts 的 weirdReason
 * 就钉"连 kind 都缺"这一档）。若照声明类型把这里的兜底当成死代码删掉，
 * `{kind}` 会原样留在用户看得见的文案里 —— 此前就是这么改红过一条断言。
 * 按 `unknown` 建模，守卫与类型面才是同一件事，类型感知规则也不会反过来把守卫判成冗余。
 */
function kindLabel(reason: unknown): string {
  // 不做类型断言（`as {kind?: unknown}` 会被 no-unsafe-type-assertion 判掉，而且它
  // 本身就是对"漂移载荷"谎报形状）：先按 object 收窄，再用 Reflect 取属性，返回值直接落 unknown。
  const kind: unknown =
    typeof reason === "object" && reason !== null ? Reflect.get(reason, "kind") : undefined;
  return typeof kind === "string" && kind !== "" ? kind : "unknown";
}

/**
 * drain llm.stream → 全文。流块与终态就此是**官方判别联合**（installed
 * @deepseek-ai/dsh-llm/lib/types/index.d.ts 的 `StreamChunk` 与 `FinishReason`，
 * dir-prep-organize 同批绑定）：`switch/===` 比 `chunk.type` 即收窄载荷，块换名或换字段
 * 在本文件当场编译不过——旧镜像把三块形状手抄成 `{ type?: string; text?: unknown;
 * reason?: {...} }`，那份抄本既不允许编译器认识真实的块集合，也 let 本包把"缺 text"
 * 这种事写成合法形状。
 * 交付侧的宽容保留，且"finish 块有没有"与"reason 读不读得懂"分开记：`reason` 按官方
 * 声明必在，但跨边界交付会漂移——把它直接塞进 `FinishReason` 变量，缺位时会被误判成
 * "缺 finish 块"（errMissingFinishChunk 说的是另一件事），非对象时 `.kind` 会绕过全部
 * 注入文案直接 TypeError。所以 `reason` 落 unknown，读侧经 isRecord/Reflect 收窄；
 * `typeof chunk.text === "string"` 与 `typeof failed.message === "string"` 两道交付判据
 * 同理保留。`kind` 的兜底走 kindLabel()：官方形状说的是适配器的**契约**，而
 * test/digest.test.ts 钉的是**实际吐出来的块**缺字段 / kind 非字符串那几档——声明里
 * 有没有，和运行时读不读得懂，是两件事，缺了后者就会把 `{kind}` 印给用户。
 */
async function drainStreamToText(
  stream: AsyncIterable<StreamChunk>,
  messages: LessonLoopMessages,
): Promise<string> {
  let text = "";
  let finishSeen = false;
  let finishReason: unknown;
  for await (const chunk of stream) {
    if (chunk.type === "text-delta" && typeof chunk.text === "string") {
      text += chunk.text;
    } else if (chunk.type === "finish") {
      finishSeen = true;
      finishReason = chunk.reason;
    }
  }
  if (!finishSeen) {
    throw new Error(messages.errMissingFinishChunk);
  }
  if (!isRecord(finishReason) || finishReason["kind"] !== "stop") {
    // 官方 `FinishReason` 只在 `aborted` / `error` 两档带 `failure`（installed
    // @deepseek-ai/dsh-llm/lib/types/types.d.ts:132-150），`tool-calls`/`max-tokens` 没有这一位。
    // 旧镜像写成"任何非 stop 都可能带 failure"，那是比契约更宽的声明：宽出来的一档
    // 在渲染分支里长出测不到的路径。现在按官方判别联合收窄后再读，交付判据
    // （failure 是否对象、message 是否字符串）保留——适配器交来的形状不由本包决定。
    const failed =
      isRecord(finishReason) &&
      (finishReason["kind"] === "aborted" || finishReason["kind"] === "error")
        ? Reflect.get(finishReason, "failure")
        : undefined;
    const detail =
      isRecord(failed) && typeof failed["message"] === "string" ? `: ${failed["message"]}` : "";
    throw new Error(
      fill(messages.errIncompleteFinish, {
        kind: kindLabel(finishReason),
        failure: detail,
      }),
    );
  }
  return text.trim();
}

/** 蒸馏产出的一条候选（命令回显逐条列出；created 与 dropped 同一形状）。 */
export interface DigestCreatedRule {
  category: string;
  signature: string;
  statement: string;
}

export interface DigestResult {
  project: string;
  feedbackCount: number;
  /** 真的落进规则库的候选。 */
  created: DigestCreatedRule[];
  /** 模型提出了、但这一次没写进规则库的候选（规则库拒写 / CAS 重放耗尽 / 落库中途
   *  抛错）。命令回显必须把它与 created 分开讲：库里的那张卡并不存在。 */
  dropped: DigestCreatedRule[];
  raw: string;
}

/**
 * runDigest 的收尾入参：消息表（语言由调用点决定）+ 用户附加说明 + **本会话事件流**。
 * `events` 由调用方取好交进来（host 走官方 `ctx.sessionQuery.observeSession()`），本文件
 * 不再自己读会话日志：官方把同步事件读面 `Session.snapshotEvents` 标成 `@deprecated`
 * （installed @deepseek-ai/dsh-session/lib/types/index.d.ts:218-224 "new calls are
 * prohibited"），而本文件是纯函数、拿不到 ctx——把取数留在唯一真正持有 ctx 的那一侧。
 * 值域是官方判别联合（`SessionEvent`，shared/本包都按它分支），非数组交付一律退空表
 * 那条 `unknownArray` 判据仍然生效。
 */
export interface DigestRunOptions {
  messages: LessonLoopMessages;
  extra?: string;
  events: readonly SessionEvent[];
  /** 蒸馏墙钟（毫秒）：由 entry config 的 `digestTimeoutMs` 交进来，
   *  本模块不再自带那个数（DEFAULT_DIGEST_TIMEOUT_MS 只剩 schema 默认这一处用途）。 */
  timeoutMs: number;
}

/** 守卫后的模型选择：provider / model 已在 runDigest 入口判过（必有、非空白）。 */
interface ResolvedModelSelection {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

/**
 * 发一次模型流并收取全文。墙钟只约束这一段（LLM 阶段）：串行落库不可中止，不该顶着
 * 已无意义的定时器跑。超时与其他失败分开讲：适配器对 abort 的收场形态不一（AbortError、
 * 流提前结束、finish kind=aborted），直接透出就是一句未本地化的底层错误文本，甚至会被
 * 误报成"缺 finish 块"。到点必返回由竞速门兜底（见实现内注释）：abort 之后、门触发
 * 之前自己恢复并交出合法 finish 的流照常算成功；门已触发才到的 finish 等于超时，
 * 一律按 errDigestTimeout 收场。
 */
/**
 * 等一条已被竞速放弃的流落定：落定值无人消费，这里只防 unhandledRejection。
 * **这里不打日志**：没超时时的失败本来就是竞速赢家、由外层 catch 原样透出；超时后的
 * 落定由超时文案统一收场，底层错误经 cause 可查。以前那条 "settled after the command
 * already failed" 的条件写反了——它只在"未超时"时打，正好是重复且误导的那一档。
 */
async function settleAbandonedStream(stream: Promise<string>): Promise<void> {
  try {
    await stream;
  } catch {
    // 落定值无人消费：接住它只防 unhandledRejection。
  }
}

/** 超时门的哨兵：门以 resolve 交出它（不 reject），竞速里它一出现即按超时收场。 */
const TIMEOUT_MARK = Symbol("lesson-loop-digest-timeout");

/** 超时收场的专用错误类型：识别"已经是本地化超时错误"必须靠类型，不能靠人读文案——
 *  文案由消息表注入（中/英两语各不相同），按子串匹配在英文界面下必然失效，同一条超时
 *  错误会被再包一层 cause；反过来底层错误只要恰好含那几个字也会被误认成"已本地化"。 */
class DigestTimeoutError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DigestTimeoutError";
  }
}

/** Node 定时器的延时上限（2^31-1 毫秒）：超出会溢出成立即触发，等于零墙钟。 */
const MAX_TIMER_MS = 2_147_483_647;

/** 墙钟到点后的**收尾宽限**（毫秒）：到点先 abort，给协作式适配器一小段时间自行收场
 *  ——abort 后立刻恢复并交出合法 finish 的流不算失败（test/digest.test.ts 钉着这条）；
 *  宽限期内还没落定的（不监听 signal 的实现）按超时收场，/lessons-digest 不许被一条
 *  永不结束的流无限挂住。宽限只影响"报错的最晚时刻"，不影响 abort 的时机。 */
const DIGEST_ABORT_GRACE_MS = 250;

async function streamDigestText(
  llm: LlmService,
  selection: ResolvedModelSelection,
  prompt: string,
  messages: LessonLoopMessages,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  // 用对象持窄化逃不掉的"跨回调改写"标记：裸 let 的字面量初始化会被流程分析钉成
  // 恒 false（回调里的赋值不进它的图），对象属性不参与那个窄化。
  const timeoutState = { fired: false };
  // 超时以两级钟收场，不只靠 abort：适配器若不监听 signal（或第三方 provider 实现不
  // 协作），for await 永远拿不到下一块也不结束，单靠 abort 兜不住"到点必收场"。
  // 主钟到点 → abort；宽限钟到点（流仍未落定）→ 门以哨兵 resolve，竞速按超时收场。
  // 门的哨兵形态让"竞速落定后门才落定"不再产生没人等的 rejection。
  // 门用**resolve 哨兵**而不是 reject：竞速已按正常路径落定之后才到点的定时器会
  // 落定一只没人等的门，reject 形态会冒 unhandledRejection（测试的假定时器路径会
  // 走到），resolve 形态无人消费则无害。
  const { promise: timeoutGate, resolve: timeoutResolve } =
    Promise.withResolvers<typeof TIMEOUT_MARK>();
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timeoutState.fired = true;
    controller.abort();
    graceTimer = setTimeout(() => {
      timeoutResolve(TIMEOUT_MARK);
    }, DIGEST_ABORT_GRACE_MS);
  }, timeoutMs);
  try {
    const stream = llm.stream({
      provider: selection.provider,
      model: selection.model,
      // 官方选择里的第三位原样透传（GenerateOptions 受理 `reasoningEffort`）：品牌构造
      // 走 dsh-brand 的 brandString（恒等函数），不为此引 dsh-llm 的运行时。
      ...(selection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: brandString<ReasoningEffortId>(selection.reasoningEffort) }),
      // 帧走 `DigestRequestMessage`（官方 `RequestMessage` 的 `Message` 那一臂，见文件顶部）：
      // 稳定 `id` 与 producer 归属都是这一臂的形状要求。这帧从不落任何持久消息位（runDigest
      // 只把 prompt 送进适配器、结果经 store 写进设置段），但形状仍按 `Message` 交，
      // 不降级成 `RequestUserInput`——那会把品牌 id 与 `source` 归属一起丢掉。
      messages: [
        {
          id: brandString<MessageId>(`lesson-loop-digest-${randomUUID()}`),
          role: "user",
          content: [{ type: "text", text: prompt }],
          // form 声明这段上下文是"要读的指令"（官方 ContextForm）：其中的差评/教训正文
          // 已经 fenceUntrusted 定界，帧结构符只可能由本插件产生。
          source: { kind: LESSON_SOURCE_KIND, form: "instructions" },
        } satisfies DigestRequestMessage,
      ],
      system: digestSystemPrompt(messages),
      signal: controller.signal,
    });
    const drained = drainStreamToText(stream, messages);
    // 门赢了（超时收场）之后流才会落定：abort 引发的失败已按超时呈报，这一次落定
    // 无人等待——接住它只是防 unhandledRejection，不是吞掉正常路径的错误（竞速
    // 赢家若是流自己的错误，走的是下面 catch 的原样透出）。
    void settleAbandonedStream(drained);
    try {
      const settled = await Promise.race([drained, timeoutGate]);
      if (settled === TIMEOUT_MARK) {
        throw new DigestTimeoutError(fill(messages.errDigestTimeout, { ms: timeoutMs }));
      }
      return settled;
    } catch (error) {
      if (timeoutState.fired && !(error instanceof DigestTimeoutError)) {
        // 超时的一档把底层错误拴在 cause 上（排障可见），给人看的是本地化文案。
        throw new DigestTimeoutError(fill(messages.errDigestTimeout, { ms: timeoutMs }), {
          cause: error,
        });
      }
      throw error;
    } finally {
      // 墙钟只约束 LLM 阶段：落库在定时器清掉之后才跑；宽限钟一并清（正常收场时不留）。
      clearTimeout(timer);
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
      }
    }
  } finally {
    // stream 构造即同步抛错的那条路走这里兜底；已清过的定时器再清一次是幂等的。
    clearTimeout(timer);
  }
}

/** 单次蒸馏的候选条数上限：落库是"读全库 + CAS 整片写"的串行链（每条一次），模型
 *  输出不受我们控制——被注入或异常放大的输出可以拖住命令并让 profile 文档反复整写。
 *  超出部分按"没写进去"回执（与拒写同一档），并留一条日志点名真实原因。 */
const MAX_DIGEST_CANDIDATES = 20;

/** 蒸馏候选的 detail 落库上限（字符）：同一批候选每条都会带一份 detail，整段 prompt
 *  （含全部差评原文与项目教训）逐条存就是 N 份全文；写侧 capEvidence 还会再截一次，
 *  而且它保的是开头——截剩的往往是分节标题，不是本条规则对应的证据。上报前先收敛。 */
const MAX_CANDIDATE_DETAIL_CHARS = 400;

/** 单条候选的落库回执：null = 落库抛 I/O 异常（已记日志），调用方记 dropped。 */
type CandidateAttempt = Awaited<ReturnType<LessonStore["addCandidate"]>> | null;

/** 单条落库（异常折成 null）：单条失败不拖垮整次蒸馏，否则"前面已落库的候选"
 *  会随整体失败一起从回执里消失——用户以为一条都没写，库里却留下了无处对账的卡。 */
async function attemptCandidate(
  store: LessonStore,
  project: string,
  entry: DigestParsedRule,
  prompt: string,
): Promise<CandidateAttempt> {
  try {
    return await store.addCandidate({
      project,
      category: entry.category,
      signature: entry.signature,
      statement: entry.statement,
      detail: prompt.slice(0, MAX_CANDIDATE_DETAIL_CHARS),
      source: "lessons-digest",
    });
  } catch (error) {
    console.error(`[lesson-loop] digest persist failed: ${errorText(error)}`);
    return null;
  }
}

/** 候选规则串行落库：一条条跑，避免同一命名空间上 N 条并发 CAS 互相撞车。写成递归
 *  而不是 for + await：循环里的 await 会被 lint 判成"该并发"，这里恰恰并发不了
 *  （并发只会撞 revision，见 lib/lesson-store.ts 的 commit 注释）。落库失败
 *  （CAS 耗尽 / 端口拒写 / 抛错）**不计进 created**：卡片列表里没有的规则不能回显成
 *  "已蒸馏"，那是让人去卡片上找一张不存在的卡（见 CandidateReceipt 的注释）。 */
async function persistCandidates(
  store: LessonStore,
  project: string,
  parsed: readonly DigestParsedRule[],
  prompt: string,
): Promise<{ created: DigestCreatedRule[]; dropped: DigestCreatedRule[] }> {
  const acc: { created: DigestCreatedRule[]; dropped: DigestCreatedRule[] } = {
    created: [],
    dropped: [],
  };
  // 条数上限在解析结果上收口：超出部分按"没写进去"处理（与拒写同一档），回执里
  // 它们就在 dropped 里，用户重试也无济于事——所以超额必须留一条日志点名真实原因。
  const overflow = Math.max(0, parsed.length - MAX_DIGEST_CANDIDATES);
  if (overflow > 0) {
    console.warn(
      `[lesson-loop] digest output: ${String(overflow)} candidate(s) beyond the per-run limit of ${String(MAX_DIGEST_CANDIDATES)} were not persisted`,
    );
  }
  const accepted = parsed.slice(0, MAX_DIGEST_CANDIDATES);
  // 超出上限的条目按"模型提出了、但没写进规则库"回执（与拒写同一档 dropped），
  // 回显口径一致：那些卡同样不在库里。
  for (const entry of parsed.slice(MAX_DIGEST_CANDIDATES)) {
    acc.dropped.push({
      category: entry.category,
      signature: entry.signature,
      statement: entry.statement,
    });
  }
  const addInOrder = async (index: number): Promise<void> => {
    const entry = accepted[index];
    if (entry === undefined) {
      return;
    }
    const receipt = await attemptCandidate(store, project, entry, prompt);
    if (receipt === null) {
      // 这一档没有 card，回执带上报原文。
      acc.dropped.push({
        category: entry.category,
        signature: entry.signature,
        statement: entry.statement,
      });
    } else {
      // 回显用卡片上真实存下的字段（签名可能已被折叠成类别级稳定键），不是上报原文。
      acc[receipt.persisted ? "created" : "dropped"].push({
        category: receipt.card.category,
        signature: receipt.card.signature,
        statement: receipt.card.statement,
      });
    }
    await addInOrder(index + 1);
  };
  await addInOrder(0);
  return acc;
}

/**
 * 执行一次蒸馏：差评收集 → LLM 归纳 → 建候选规则（origin 'lessons-digest'）。
 * 任何一步失败都抛错由调用方呈现（命令 handler / 端点）。
 */
export async function runDigest(
  store: LessonStore,
  session: SessionLike,
  llm: LlmService,
  selection: ModelSelection | undefined,
  options: DigestRunOptions,
): Promise<DigestResult> {
  const { messages, extra, events, timeoutMs } = options;
  // 选择是宿主 currentSelection() 的跨边界交付（可能是缺位的半截对象）：类型面说的
  // 是宿主的承诺，守卫只认 string。统一取 trim 后的值——既挡住 `{ provider: null,
  // model: 5 }` 一类的穿透（它们会在 .trim() 处 TypeError，把一句未本地化的底层错误
  // 甩给用户），也让 " p " 这种带空白的取值不再原样进 llm.stream。
  const providerRaw = selection?.provider;
  const modelRaw = selection?.model;
  const effortRaw = selection?.reasoningEffort;
  const provider = typeof providerRaw === "string" ? providerRaw.trim() : "";
  const model = typeof modelRaw === "string" ? modelRaw.trim() : "";
  const reasoningEffort =
    typeof effortRaw === "string" && effortRaw.trim().length > 0 ? effortRaw.trim() : undefined;
  if (provider.length === 0 || model.length === 0) {
    throw new Error(messages.errNoModelSelection);
  }
  // 墙钟口径只在三处出现：configSchema 的 min(1000) 是**配置面**约束（设置卡/文档），
  // 本守卫只管"能不能拿去 setTimeout"——有限正数且不超过 Node 的 2^31-1 毫秒上限
  // （超出会溢出成立即触发，等于零墙钟）。文案因此只说本守卫自己的口径，不重复
  // schema 的 1000 下限：单测要用几十毫秒的墙钟驱动超时分支。
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS) {
    throw new Error(messages.errDigestTimeoutInvalid);
  }
  // 交付面守卫：events 非数组（host 取数失败交回了别的形状）退空表继续跑，但必须留下
  // 一条诊断——"零证据蒸馏"与"真的没有差评"在回执上同形（feedbackCount: 0），没有这条
  // 日志，取数侧的集成故障会长期隐形。
  if (!Array.isArray(events)) {
    console.warn(
      `[lesson-loop] digest events payload is not an array (${typeof events}); digesting without feedback`,
    );
  }
  const feedbacks = collectNegativeFeedback(unknownArray(events));
  const project = deriveProject(session.header?.cwd);
  const background = lessonsBackground(store, project, messages);
  const prompt = buildDigestPrompt(feedbacks, background, messages, extra);

  const resolved: ResolvedModelSelection = {
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  };
  const raw = await streamDigestText(llm, resolved, prompt, messages, timeoutMs);
  if (raw.length === 0) {
    throw new Error(messages.errEmptyDigest);
  }
  const { rules: parsed, parsed: readable, rejected } = parseDigestOutput(raw);
  if (!readable) {
    // 模型给了读不懂的输出：不能走成"蒸馏出 0 条"的正常路径，那会让人以为模型
    // 确实没提出任何条目。
    throw new Error(messages.errUnreadableDigest);
  }
  // 模型提了条目、但全被类别白名单/正文校验拒收：回执与"真的没提出"同形（都是
  // 0 条），没有这条日志，白名单漂移会长期隐形。
  if (parsed.length === 0 && rejected > 0) {
    console.warn(
      `[lesson-loop] digest output: ${String(rejected)} candidate(s) proposed by the model were all rejected by category/statement validation`,
    );
  }
  const { created, dropped } = await persistCandidates(store, project, parsed, prompt);
  return {
    project,
    feedbackCount: feedbacks.length,
    created,
    dropped,
    raw,
  };
}
