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
// - `Session` / `SessionHeader`：installed @deepseek-ai/dsh-session/lib/types/index.d.ts:118,
//   :122 与 lib/types/types.d.ts:58-90
import type { AgentDefaultModelConfig } from "@deepseek-ai/dsh-agent-default-model";
// 注入消息的 id 位是官方幻影品牌 `MessageId`，唯一合法构造口是官方 `brandString`（恒等函数；
// 口径：dsh-brand 在 dependencies，产物留裸说明符，不再内联）。本文件与 host.ts 共用这
// 同一条口径——两半各自自包含，谁也不 import 谁的运行时。
import { brandString } from "@deepseek-ai/dsh-brand";
import type {
  FinishReason,
  LlmRuntime,
  MessageId,
  StreamChunk,
  UserMessage,
} from "@deepseek-ai/dsh-llm";
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
import { fill } from "./messages.ts";
import type { LessonLoopMessages } from "./messages.ts";

export type { SessionEvent } from "@deepseek-ai/dsh-session";

/**
/**
 * 会话的归因读取面 = **官方 `Session` 的键名投影**（installed
 * @deepseek-ai/dsh-session/lib/types/index.d.ts：`get id(): SessionId` :122、
 * `readonly header: SessionHeader` :118）。
 * 值域两处都收窄：整枚 `Session` 是带 private 字段的类（:105-107 → 名义比较），本包与
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
 * installed @deepseek-ai/dsh-llm/lib/types/types.d.ts:464
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

/** 默认模型选择 = 官方成员返回形状，但**可选性按交付面放宽**：`currentSelection()` 是宿主
 *  服务交回来的值，官方声明里 `provider`/`model` 必选，而本包拿到的是跨边界交付——配置没落、
 *  Volatile 引用未解析时照样可能是缺位的半截对象。守卫留在 runDigest 入口，类型不再替宿主打包票。 */
export type ModelSelection = Partial<ReturnType<AgentDefaultModelConfig["currentSelection"]>>;

// 本插件的消息身份（PLUGIN_NAME / LESSON_SOURCE_KIND）只在 lib/prompt.ts 定义一份：
// 蒸馏请求帧与 host 的 armed 规则摘要注入是同一个生产者，不得有两个身份
// （蒸馏请求本身是 request-only 输入、不落持久消息位，但读回历史行时比的就是这个串）。
// 见 lib/prompt.ts 的注释：0.1.7 的 V4 准入（session-format-v3-to-v4/src/
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
 * drain llm.stream → 全文。流块与终态就此是**官方判别联合**（installed
 * @deepseek-ai/dsh-llm/lib/types/index.d.ts 的 `StreamChunk` 与 `FinishReason`，
 * dir-prep-organize 同批绑定）：`switch/===` 比 `chunk.type` 即收窄载荷，块换名或换字段
 * 在本文件当场编译不过——旧镜像把三块形状手抄成 `{ type?: string; text?: unknown;
 * reason?: {...} }`，那份抄本既不允许编译器认识真实的块集合，也 let 本包把"缺 text"
 * 这种事写成合法形状。
 * 交付侧的宽容保留：`typeof chunk.text === "string"` 与 `typeof failed?.message === "string"`
 * 都不删。`kind` 的兜底走 kindLabel()：官方形状说的是适配器的**契约**，
 * 而 test/digest.test.ts 钉的是**实际吐出来的块**缺字段 / kind 非字符串那几档 ——
 * 声明里有没有，和运行时读不读得懂，是两件事，缺了后者就会把 `{kind}` 印给用户。
 */
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

async function drainStreamToText(
  stream: AsyncIterable<StreamChunk>,
  messages: LessonLoopMessages,
): Promise<string> {
  let text = "";
  let finish: FinishReason | undefined;
  for await (const chunk of stream) {
    if (chunk.type === "text-delta" && typeof chunk.text === "string") {
      text += chunk.text;
    } else if (chunk.type === "finish") {
      finish = chunk.reason;
    }
  }
  if (finish === undefined) {
    throw new Error(messages.errMissingFinishChunk);
  }
  if (finish.kind !== "stop") {
    // 官方 `FinishReason` 只在 `aborted` / `error` 两档带 `failure`（installed
    // @deepseek-ai/dsh-llm/lib/types/types.d.ts:132-150），`tool-calls`/`max-tokens` 没有这一位。
    // 旧镜像写成"任何非 stop 都可能带 failure"，那是比契约更宽的声明：宽出来的一档
    // 在渲染分支里长出测不到的路径。现在按官方判别联合收窄后再读，`typeof === "string"`
    // 那道交付判据保留（适配器交来的 failure 形状不由本包决定）。
    const failed =
      finish.kind === "aborted" || finish.kind === "error" ? finish.failure : undefined;
    const detail = typeof failed?.message === "string" ? `: ${failed.message}` : "";
    throw new Error(
      fill(messages.errIncompleteFinish, {
        kind: kindLabel(finish),
        failure: detail,
      }),
    );
  }
  return text.trim();
}

export interface DigestResult {
  project: string;
  feedbackCount: number;
  created: { category: string; signature: string; statement: string }[];
  raw: string;
}

/**
 * runDigest 的收尾入参：消息表（语言由调用点决定）+ 用户附加说明 + **本会话事件流**。
 * `events` 由调用方取好交进来（host 走官方 `ctx.sessionQuery.observeSession()`），本文件
 * 不再自己读会话日志：官方把同步事件读面 `Session.snapshotEvents` 标成 `@deprecated`
 * （installed @deepseek-ai/dsh-session/lib/types/index.d.ts:186-187 "new calls are
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
  const { messages, extra, events } = options;
  if (selection?.provider === undefined || selection.model === undefined) {
    throw new Error(messages.errNoModelSelection);
  }
  const feedbacks = collectNegativeFeedback(unknownArray(events));
  const project = deriveProject(session.header?.cwd);
  const background = lessonsBackground(store, project, messages);
  const prompt = buildDigestPrompt(feedbacks, background, messages, extra);

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs);
  try {
    const stream = llm.stream({
      provider: selection.provider,
      model: selection.model,
      // 帧就此是官方 `GenerateOptions.messages` 受理的 **request-only 输入**
      // （`RequestUserInput`，installed @deepseek-ai/dsh-llm/lib/types/types.d.ts:457-462：
      // `id`/`source` 两位都是 `?: never`）。旧镜像给这一帧写了 `id` + `source.kind`，
      // 官方形状说不该有：**这帧从不落任何持久消息位**（runDigest 只把 prompt 送进适配器、
      // 结果经 store 写进设置段，消息本身不回投给会话），所以它既不需要稳定身份也不需要
      // producer 归属；带 `source` 反而暗示"这是一条会被读回的消息"。dir-prep-organize 的
      // 整理帧同一条理由、同一处形状。
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
    const raw = await drainStreamToText(stream, messages);
    if (raw.length === 0) {
      throw new Error(messages.errEmptyDigest);
    }
    const parsed = parseDigestOutput(raw);
    // 建卡是 provider 写（异步）：一条条**串行**跑，避免同一命名空间上 N 条并发 CAS
    // 互相撞车。写成递归而不是 for + await：循环里的 await 会被 lint 判成"该并发"，
    // 这里恰恰并发不了（并发只会撞 revision，见 lib/lesson-store.ts 的 commit 注释）。
    const addInOrder = async (index: number): Promise<DigestResult["created"]> => {
      const entry = parsed[index];
      if (entry === undefined) {
        return [];
      }
      const card = await store.addCandidate({
        project,
        category: entry.category,
        signature: entry.signature,
        statement: entry.statement,
        detail: prompt,
        source: "lessons-digest",
      });
      const rest = await addInOrder(index + 1);
      return [
        { category: card.category, signature: card.signature, statement: card.statement },
        ...rest,
      ];
    };
    const created = await addInOrder(0);
    return { project, feedbackCount: feedbacks.length, created, raw };
  } finally {
    clearTimeout(timer);
  }
}
