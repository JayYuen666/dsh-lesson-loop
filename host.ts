// lesson-loop host 半：教训闭环的总线与规则引擎。
//
// 五段闭环（设计定稿："一切皆插件"，不动 dsh 核心）：
//   观察 —— danger-guard / quality-gate / session-rescue（以及任何第三方插件）经
//           ctx.get('lessonLoop') 上报（可选读：总线缺失只丢报告，绝不拖垮报告方）；
//   写入 —— 规则、教训流水与会话结算台账同住一个 SQLite 库
//           dshPath('data','lesson-loop','lesson-loop.db')（WAL + BEGIN IMMEDIATE +
//           meta.revision CAS，见 lib/lesson-db.ts）。旧介质一次性迁入且不回写：
//           `config.rules` 只在库为空时导入（字段已从 schema 摘除），
//           cache/lesson-loop/events.jsonl 导入后改名 .bak（见 lib/db-migration.ts）；
//   提醒 —— ①常驻 systemPrompt 段（order 1560，闭环存在感；段文本/语言变化时宿主会贴
//           本地化的替换/退役通知，见 registerPromptSection）；②agent/created 按**当前工作
//           目录**所属项目注入 armed 规则全文（agent.inject，不唤醒）。归因折 header.cwd 与
//           每条 workspace-root/change（foldCwd，与宿主 WorkingDirectoryService 同源）；
//           注入幂等（ensureInjection：面上同内容跳过、不同则带"替换"说明追加），并在
//           切目录与 compaction/end 之后重做，压缩折掉的那份因此会补回；
//   升格 —— 候选卡只能人工在卡片上 arm/reject（loop-design-check 红线：人保留判断）；
//   度量 —— armed 后复发 violation++ / 场景被触发且遵守 suppressed++（observed）/
//           在场未违规 samples++（暴露度）；复发率高（真实证据足）自动降级待人审，
//           armed 够久却零复发零遵守 → 判"不可判定"（保留 armed，/stats+卡片提示，
//           人工停用/归档），不再静默归档。
//
// 严禁自定义会话事件（持久化读取白名单会拒绝加载，session-rescue 同教训）——
// 总线只走服务方法 + 插件自己的数据目录写入。
//
// 运行方式：dsh cordis Loader 直接 import 本 .ts（Node ≥22.18 类型剥离）。
// 运行时值导入三枚：schemastery（宿主 fork）、@deepseek-ai/dsh-home-paths、@deepseek-ai/dsh-brand
// （都在 peerDependencies，产物里按包名引用它们；不进 dependencies——见 test/publish-manifest.test.ts）；
// @deepseek-ai/cordis 等宿主服务一律 type-only。

import { randomUUID } from "node:crypto";
// 0.2.1-alpha.2 设置面要求宿主 fork：只有 @deepseek-ai/schemastery 的 resolve 会把 volatile
// 字段包成 Volatile 引用（vendor/schemastery/src/index.ts:521-533），公共
// schemastery@3.18.0 既没有 `.volatile()`、解析出来的也仍是普通值（设置卡写进去的值读不到）。
// 本包的 lib/rules-namespace.ts 同步换 fork：它用同一份 Schema 构造旧 `rules` 字段的
// 形状声明（`RulesFieldSchema`），迁移读旧 patch 时靠它判定卡数组；用公共包的话
// `.volatile()` 不存在，设置面会静默失效。
import Schema from "@deepseek-ai/schemastery";
import { dshCachePath, dshPath } from "@deepseek-ai/dsh-home-paths";
import type { Context, Events, Fiber, Volatile } from "@deepseek-ai/cordis";
// 注入消息的 id 位是官方的 `MessageId`（带 `brand` 标记的幻影类型，installed @deepseek-ai/dsh-llm/lib/types/
// brand.d.ts:14），唯一合法构造口是官方 `brandString`（@deepseek-ai/dsh-brand/lib/types/
// index.d.ts:28，恒等函数）。它也是本文件的 @deepseek-ai/* 值导入之一：落在
// peerDependencies、产物里按包名引用（只在 devDependencies 会被 rolldown 内联进 host.js；
// 写进 dependencies 则会在消费方 profile 里物化出第二份宿主实例，两者都不行）
// ——与 danger-guard 的 `brandNumber`、session-rescue 的 `brandString` 同一处、同一理由。
import { brandString } from "@deepseek-ai/dsh-brand";
import type { Agent, AgentRegistry } from "@deepseek-ai/dsh-agent";
import type { CommandRuntime } from "@deepseek-ai/dsh-commands";
import type { MessageId } from "@deepseek-ai/dsh-llm";
import type {
  Session,
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionSurface,
} from "@deepseek-ai/dsh-session";
import type { SettingsForms } from "@deepseek-ai/dsh-settings";
// 会话事件流的官方读取接口（见下面 SessionQueryFace 的用法注记）：type-only，运行时由 ctx 注入。
import type { SessionQueryEngine } from "@deepseek-ai/dsh-session-query";
import type { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import type { TimerService } from "@deepseek-ai/cordis-plugin-timer";
// catch 值转日志文本：直接用 shared 的 errorText。
import { errorText } from "@jayyuen66/dsh-plugin-shared/lib/errors";
import { DEFAULT_MAX_STATEMENT_CHARS, LessonStore, deriveProject } from "./lib/lesson-store.ts";
import type {
  LessonRecord,
  LessonSource,
  ReportReceipt,
  RuleActionResult,
  RuleCard,
  RulesRepository,
} from "./lib/lesson-store.ts";
import { installRulesRemote } from "./lib/rules-remote.ts";
import { LESSON_DB_FILE, LedgerConsumedElsewhereError, LessonDb } from "./lib/lesson-db.ts";
import type { LedgerRow } from "./lib/lesson-db.ts";
import { migrateToDb } from "./lib/db-migration.ts";
import type { RuleActionName } from "./lib/rules-shape.ts";
import { createRulesRepository } from "./lib/rules-namespace.ts";
import type { SettingsCasSurface } from "./lib/rules-namespace.ts";
import { RULES_FIELD } from "./lib/rules-layout.ts";
import {
  SECTION_NAME,
  SECTION_ORDER,
  PLUGIN_NAME,
  LESSON_SOURCE_KIND,
  armedRulesOf,
  renderSectionText,
  renderRulesDigest,
} from "./lib/prompt.ts";
import { runDigest, digestCreatedLine, DEFAULT_DIGEST_TIMEOUT_MS } from "./lib/digest.ts";
import type { LlmService, AgentDefaultModel, SessionLike } from "./lib/digest.ts";
import { MESSAGES, fill } from "./lib/messages.ts";
import type { LessonLoopMessages } from "./lib/messages.ts";
// host 侧文案语言跟官方 locale 插件的偏好同源：读它拥有的 settings 命名空间（未注册即中文）。
// 这条链覆盖 lesson-loop 自己产出的全部文案，**含起草新规则卡时那份 statement 正文**
// （模板在 lib/messages.ts，经 store 的 messages 注入口取用）。已经落库的规则正文不在
// 这条链上——那是本条目设置段 `rules` 里的用户数据，界面语言切换绝不改写已生效的规则。
import {
  DEFAULT_LOCALE,
  LOCALE_SETTINGS_NAMESPACE,
  messagesFor,
  resolveLocalePreference,
} from "@jayyuen66/dsh-plugin-shared/lib/locale";
import { claimInstance } from "@jayyuen66/dsh-plugin-shared/lib/instance-lock";
import { fieldOf, isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

// ── 守卫小件（泛型防御纵深，不用断言；session-rescue/client 同款）──────────

/** 无可回收资源的空清理（consistent-return：effect 各分支统一返回值）。 */
const noDisposer = (): void => {
  void 0;
};

/** 人工动作键（总线宿主服务与规则读取接口共用的取值域；白名单在 lib/rules-remote.ts）。 */
type RuleActionKind = RuleActionName;

/**
 * `commands` 可选服务的运行时判据：值是 record，且 `register` 那一位可调用。
 * 投影（{@link CommandsService}）的 `register` **签名**来自官方类；结构检查与类型投影
 * 分开，替身才满足得了名义类之外的那一层。
 */
function hasCallableRegister(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const { register } = value;
  return typeof register === "function";
}

/**
 * `/lessons-digest` 命令服务投影：官方 `CommandRuntime`（@deepseek-ai/dsh-commands，
 * installed `lib/types/index.d.ts:80` 起是 class，`extends TypertRemoteService` + 四枚
 * private 字段 → 名义比较）的 `register` 方法子集（installed `:94`，官方
 * `Context.commands: CommandRuntime` 见同文件 `:65`）。
 * 改造前那份 descriptor 是照着官方 `CommandDefinition`（installed `:38-55`）抄出来的，有**三处**
 * 不一致（逐条按官方声明行号核对，本包的实际写法恰好都被官方容纳，故绑定后编译不报错）：
 *   1. `recordInput` 抄成**必填**，官方是 `readonly recordInput?: boolean`
 *      （`:52`，注记 "Defaults to true"）——本包传 `false`，语义不变；
 *   2. `input` 抄成 `{ hint: string }`，官方是 `CommandInputDescriptor`
 *      （`@deepseek-ai/dsh-commands/types` installed `lib/types/types.d.ts:20-31`），
 *      除 `hint` 外还有本包不用的可选 `attachments` 旗标；
 *   3. 回显形状抄成**非判别**联合 `{ kind: "success" | "error"; text: string }`，
 *      官方 `CommandResult`（同上 installed `:33-41`）是判别联合，且 success 分支的
 *      `text` 是**可选**（`readonly text?: string`）并多一枚 `sourceEventSeq?: SessionSeq`；
 *      error 分支的 `text` 才是必填。
 * 入参同理：handler 的形参抄成了 `unknown`，官方是 `CommandInvocation`
 * （installed `:19-36`：`commandId`/`agent: Agent`/`rawInput: string`/`attachments`/`signal`）。
 * 形参类型现在由官方给出，但本包**读**它仍走 `fieldOf` + `isRecord` 的 unknown 面——载荷跨
 * 进程边界，官方标必填的成员（`agent`、`rawInput`）运行时未必真在。防御分支一条没删。
 * disposer 按官方 `() => void` 收。
 */
type CommandsService = Pick<CommandRuntime, "register">;
function isCommandsService(value: unknown): value is CommandsService {
  return hasCallableRegister(value);
}

/**
 * systemPrompt 服务投影：官方 `SystemPrompt`（@deepseek-ai/dsh-system-prompt，installed
 * `lib/types/index.d.ts:237` 起是 cordis `Service` 子类 + private `layers`/`toolOrder`
 * → 名义比较）的 `section` 方法子集（installed `:250`）。载荷即官方 `PromptSection`
 * （installed `:47-70`）：`name`/`order` 必填，`text` 允许静态串**或**每次拼装以
 * `AssembleContext`（installed `:37-45`）求值的 provider——改造前把 provider 的入参抄成了
 * `unknown`，那是加宽后的假类型；官方还多两枚本包不用的可选旗标 `interpolate`/`complete`。
 * 返回是官方承诺的 "the exact Cordis effect disposer" `() => void`（installed `:248-250`）。
 */
type SystemPromptService = Pick<SystemPrompt, "section">;
function isSystemPromptService(value: unknown): value is SystemPromptService {
  if (!isRecord(value)) {
    return false;
  }
  const { section } = value;
  return typeof section === "function";
}

/**
 * timer 服务投影：官方 `TimerService`（@deepseek-ai/cordis-plugin-timer，installed
 * `lib/types/index.d.ts:11` 起是 cordis `Service` 子类 + private `_schedule` → 名义比较）
 * 的 `timeout` 方法子集（installed `:18-19`）。官方 `timeout` 是**重载**
 * （`timeout(callback, delay): () => void` / `timeout(delay): Promise<void>`），`Pick<>`
 * 两枚重载都保留，故本包的两参调用拿到的仍是取消函数。本地投影改名 `TimerFace`：官方导出
 * 名 `TimerService` 已被上面的 type import 占用（zvec-grep 同款退避）。
 */
type TimerFace = Pick<TimerService, "timeout">;
function isTimerService(value: unknown): value is TimerFace {
  if (!isRecord(value)) {
    return false;
  }
  const { timeout } = value;
  return typeof timeout === "function";
}

/**
 * 会话事件流的官方读取接口：`ctx.sessionQuery`（installed @deepseek-ai/dsh-session-query/
 * lib/types/index.d.ts:23-27 把它增强进 `Context`）的 `observeSession` 方法子集投影
 * （同文件 :47 —— `observeSession(sessionId: SessionId, options?): Promise<SessionObservation>`）。
 * 本包只取这一位：`SessionObservation.events` 就是"该会话此刻的不可变事件切片"
 * （installed lib/types/observation.d.ts:15-19），替代已被官方标 `@deprecated` 的
 * `Session.snapshotEvents`（@deepseek-ai/dsh-session/lib/types/index.d.ts:218-224，
 * "new calls are prohibited"）。`SessionQueryEngine` 是 cordis `Service` 子类
 * （:35 起 + private 字段 → 名义比较），故只 `Pick`，不取整类。
 */
type SessionQueryFace = Pick<SessionQueryEngine, "observeSession">;

/**
 * agent 注册表的读取口：官方 `ctx.agents`（`AgentRegistry`，packages/core/agent/src/index.ts:
 * 30-34 声明进 `Context`、:271 `super(ctx, 'agents')`）的 `get(id)` 子集——`session/event`
 * 只带 Session，而注入只在 Agent 面上（`Agent["inject"]`）。
 * `get(id)` 的入参是带 brand 的 `SessionId`（同文件 :591-593），故调用点一律经 `brandString`。
 */
type AgentsFace = Pick<AgentRegistry, "get">;
function isAgentRegistry(value: unknown): value is AgentsFace {
  if (!isRecord(value)) {
    return false;
  }
  const { get } = value;
  return typeof get === "function";
}

function isSessionQueryService(value: unknown): value is SessionQueryFace {
  if (!isRecord(value)) {
    return false;
  }
  const { observeSession } = value;
  return typeof observeSession === "function";
}

function isLlmService(value: unknown): value is LlmService {
  if (!isRecord(value)) {
    return false;
  }
  const { stream } = value;
  return typeof stream === "function";
}

function isAgentDefaultModel(value: unknown): value is AgentDefaultModel {
  if (!isRecord(value)) {
    return false;
  }
  const { currentSelection } = value;
  return typeof currentSelection === "function";
}

/** 会话最小投影（/lessons-digest 命令入参的 agent.session）。 */
function isSessionLike(value: unknown): value is SessionLike {
  return isRecord(value);
}

/**
 * 宿主 ctx 结构契约守卫（apply 把 Context 收窄为 HostCtx，不写断言）。
 * 核验的是 0.2.1-alpha.2 的实际调用形态：`effect`/`on` 接线、`inject` + `fiber` 挂页面策略、
 * `settings.describe` 做跨命名空间读与规则库读，以及 `fiber.await()`（装载期迁移必须
 * 等本条目 ACTIVE 才能读到规则库，见 startBootMigrations）。缺任一项一律急停——带着
 * 半截宿主服务在首个回合才崩，会退化成一条 kind:error 的 turn 直接甩给用户。
 */
function isHostCtx(value: unknown): value is HostCtx {
  if (!isRecord(value)) {
    return false;
  }
  const { effect, fiber, inject, on, settings } = value;
  return (
    typeof effect === "function" &&
    typeof on === "function" &&
    typeof inject === "function" &&
    typeof fieldOf(fiber, "await") === "function" &&
    typeof fieldOf(settings, "describe") === "function"
  );
}

// PLUGIN_NAME / LESSON_SOURCE_KIND 的定义收敛到 lib/prompt.ts（lib/digest.ts 也要用
// 同一个 kind，而它 import 不到 host——方向是 host → lib）。见该处的注释。

// ── 结构类型（与宿主交互的类型的运行时形状；避免值导入 @deepseek-ai/*）────────

/**
 * 主 ctx 上本包要用的 settings 面：只剩 `describe()`（跨命名空间读 locale）。
 * 规则库已迁到 SQLite，不再从设置段读 value/user/revision，`update()` 也不用了。
 *
 * `configure` **不在这里**：它只在 `ctx.inject` 给的子上下文里被调用（见 InjectedCtx）。
 */
export type SettingsProvider = Pick<SettingsForms, "describe">;

/**
 * `ctx.inject(deps, callback)` 回调收到的子上下文（本包用到 settings + effect，以及
 * commands / systemPrompt / timer 三个可选服务的就绪回调）。
 * 与 SettingsProvider 分开声明是有意的：子上下文里的 settings 只有页面策略要调，
 * 规则库那条读写链走的是主 ctx 的 service 实例。
 */
interface InjectedCtx {
  /** 只投影页面策略那一位，签名整体取官方成员：自己抄成 `owner?: unknown` 比官方
   *  （`configure(presentation, owner?: Fiber)`，dsh-settings index.d.ts:80-82）更松，
   *  owner 传错东西编译期抓不到。 */
  settings: Pick<SettingsForms, "configure">;
  /** 服务就绪回调里对三个可选服务只做守卫收窄，函数签名上各自另有 isXxx判据。 */
  commands: unknown;
  systemPrompt: unknown;
  timer: unknown;
  effect: (factory: () => (() => void | Promise<void>) | undefined, label?: string) => void;
  /** 子上下文上的事件监听：listener 归**这条 inject 子 fiber** 所有
   *  （vendor/cordis/src/events.ts:296-315 与 `Fiber["on"]` 的 `@returns a disposer`），
   *  随它重建一起撤掉。把它当成"和 svc.on 一样"挂到父 ctx 上，effect 工厂重跑就会留下
   *  一条指向旧闭包的监听（旧 sp / 旧的 disposeSection）。只声明本包用到的那一枚事件；
   *  返回域直接写 `() => void`（官方就是这条），不要用 HostCtx.on 的 `unknown`——
   *  那一位是给故意不读返回值的主 ctx 用的。 */
  on: (event: "settings/document-updated", listener: (ns: unknown) => void) => () => void;
}

/** 逐字段解析后的设置快照（0.1.6 那份 `scope.get()` 的等价物，改从 volatile 引用现读）。 */
interface ResolvedSettings {
  enabled: boolean;
  reportEnabled: boolean;
  injectEnabled: boolean;
  sectionEnabled: boolean;
  promoteThreshold: number;
  demoteThreshold: number;
  demoteMinSamples: number;
  demoteRatio: number;
  decayDays: number;
  reviveThreshold: number;
  maxLessonsBytes: number;
  /** 规则正文写入上限（字符；arm/edit 与继承存量正文时判）。 */
  maxStatementChars: number;
  /** 部署值（非 volatile）：/lessons-digest 一次蒸馏的墙钟（毫秒）。 */
  digestTimeoutMs: number;
  /** 部署值（非 volatile）：周期衰减的武装间隔（毫秒）。 */
  decayIntervalMs: number;
  /** 部署值（非 volatile）：会话开始最多注入几条 armed 规则（0 = 不设上限）。 */
  maxInjectedRules: number;
}

/** 取设置快照的取用入口：每次现读引用当前值（设置卡改完下一个事件/回合即生效）。 */
type SettingsOf = () => ResolvedSettings;

/** timer 的取消句柄：官方 `TimerService.setTimeout` 的返回（installed
 *  `@deepseek-ai/cordis-plugin-timer/lib/types/index.d.ts:14`，单签名
 *  `setTimeout(callback: () => void, delay: number): () => void`）。
 *  ⚠ 为什么从 `setTimeout` 而不是从本包真正调的 `timeout` 上取：`timeout` 是**重载**
 *  （installed `:18-19`），`ReturnType<TimerService["timeout"]>` 只会命中**最后一枚**签名
 *  `timeout(delay): Promise<void>` —— 实测报
 *  `error TS2322: Type '() => void' is not assignable to type 'Promise<void>'`（两处赋值）
 *  加 `error TS2349: This expression is not callable`。改写成
 *  `TimerFace extends (callback, delay) => infer R ? R : never` 也取不到：条件类型对重载
 *  函数只做可分配性判定、不逐签名 infer，实测整个 `TimerDisposer` 收成 `never`
 *  （`TimerDisposer | undefined` 塌成 `undefined`，`last?.()` 报
 *  `Type 'never' has no call signatures`）。两枚成员在官方声明里同签名同返回（`:14` 与
 *  `:18` 的取消函数一致，`:13` 的注记本身就写着 "use `ctx.timeout()` instead"），
 *  故这里取的是同一个官方事实，而不是本地重述 `() => void`。 */
type TimerDisposer = ReturnType<TimerService["setTimeout"]>;

/**
 * 归因读的那两位 = **官方 `Session` 的键名投影**（installed @deepseek-ai/dsh-session/
 * lib/types/index.d.ts：`get id(): SessionId` :154、`readonly header: SessionHeader` :150）。
 * 值域不取整类：`Session` 带 private 字段（:135-139）→ TS 按名义比较，本包的替身会话永远
 * 满足不了；`header` 又只读本包判定"是不是子代理会话"用到的三位
 * （installed @deepseek-ai/dsh-llm 域外、dsh-session/lib/types/types.d.ts:69/:81/:87
 *  的 `cwd`/`origin`/`delegationDepth`，官方三者本来就都可缺）。键名一处都不重述。
 */
interface AgentSessionView {
  readonly id?: Session["id"];
  readonly header?: Partial<Pick<SessionHeader, "cwd" | "delegationDepth" | "origin">>;
  /**
   * 当前模型可见面（官方 `Session.surface`，installed @deepseek-ai/dsh-session/lib/types/
   * surface.d.ts:252-259：`nodes` 是"当前面上按模型可见序排的事件 seq 表"）。
   * 只读 `nodes` 这一串：判断本包上次注入的那条 `user/message` 还在不在面上——压缩会把
   * 一段消息折进摘要（surface 的 `replace` 操作，packages/compaction/compaction-basic/src/
   * region.ts:111-112 与 :351 的保留区只护 surface 头部的 `system/message`），被折掉的
   * seq 因此离开 `nodes`。投影成可选：会话对象跨边界递来时未必带这个 getter。
   */
  readonly surface?: Pick<SessionSurface, "nodes">;
}

/**
 * agent/created 载荷里的 agent = 官方 `Agent` 的本包读取投影。
 * `Agent` 是 interface（installed @deepseek-ai/dsh-agent/lib/types/types.d.ts:11 只声明
 * `id`，成员由 lib/types/runtime-types.d.ts:138-192 的官方增强交出：`session` :143、
 * `inject` :…、`status` :147…），不带私有字段，但整体类型远多于本包所需，故按 `Pick` 只取
 * `inject` 一位——**签名不再本地重述**。改造前写的是 `inject?: (message: unknown) => void`：
 * `unknown` 什么都收，官方给 `UserMessage` 加必填位时本包静默漏填（正是此前迁移在别处
 * 抓到的那类缺陷），现在载荷由官方 `UserMessage` 约束，`id` 走 `brandString<MessageId>`、
 * `source.kind` 走 lib/prompt.ts 里那条 producer 声明。
 * `session` 一位只能投影（见 {@link AgentSessionView} 的理由）：官方 `Agent.session` 是
 * **必选**的 `Session` 类（runtime-types.d.ts:143），跨进程递来的会话是否具备某位只能
 * 运行时判（下面 `if (!isSessionLike(sessionRaw))` 与 header 的 typeof 守卫照旧留着）。
 * `inject` 留可选同样是边界规则而非宿主判决：官方那一位在 `Agent` 面上必选，
 * 但本包拿到的 agent 可能是测试替身或半装配对象（`typeof agent.inject !== "function"`
 * 的守卫在 injectRulesDigest 里）。
 */
interface StartAgent extends Partial<Pick<Agent, "inject">> {
  readonly session?: AgentSessionView;
}

/**
 * `agent/created` 载荷的本包视图：除 `agent` 一位外**全部成员直接索引官方事件表**
 * （installed @deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:227-231 交出
 * `{ agent: Agent; source: SessionStartSource; signal?: AbortSignal }`），于是官方给这枚
 * 载荷加/改成员时本包与下面那条 listener 一起报错，而不是静默漏填。
 * `agent` 位换成 {@link StartAgent} 投影的理由写在那儿（整枚 `Agent` 会把 `session` 的
 * 名义类一路渗进来，本包的三条运行时守卫当场在编译器眼里变成死代码）。
 * 旧 agent/session-start 无派发端（死事件），故只取 agent 字段这一判决不变。
 */
type AgentCreatedPayload = Omit<Parameters<Events["agent/created"]>[0], "agent"> & {
  readonly agent?: StartAgent;
};

/** `session/event` 监听器的签名：官方事件表直接交出（`Session` + 追加的那条事件）。
 *  `@mode emit` 的载荷原样递来，本包不做任何重述。 */
type SessionEventListener = (
  session: Parameters<Events["session/event"]>[0],
  event: Parameters<Events["session/event"]>[1],
) => void;

interface HostCtx {
  settings: SettingsProvider;
  /** 读取服务的类型取官方 `Context["get"]`（installed @deepseek-ai/cordis/lib/types/reflect.d.ts:14
   *  `get<K extends string & keyof this>(name: K, strict?: boolean): undefined | this[K]`）：
   *  本包读的 `commands` / `llm` / `agentDefaultModel` / `systemPrompt` / `sessionQuery` **全部**
   *  是官方声明进 `Context` 的名字（installed @deepseek-ai/dsh-commands/lib/types/index.d.ts:65、
   *  @deepseek-ai/dsh-llm/lib/types/index.d.ts:29-31、
   *  @deepseek-ai/dsh-agent-default-model/lib/types/index.d.ts:6-8、
   *  @deepseek-ai/dsh-system-prompt 同名增强、@deepseek-ai/dsh-session-query 同名增强），
   *  故走泛型分支拿到 `undefined | 官方服务类`，
   *  一条都不落进 `get(name: string): any` 兜底分支（cordis 的 lib/types/reflect.d.ts 里 Context 增强的 get）。
   *  ⚠ 与 danger-guard/host.ts 的 `HostCtx.get` 相反：那一包读的是 `SETTINGS_READER` 与
   *  `lessonLoop`，两者都不在官方 `Context` 上，换官方面只会把 `unknown` 降级成 `any`，
   *  所以它把本地面留着并写明了理由。这里名字全在官方面上，条件成立才换。
   *  返回 `undefined` 是官方语义（"or `undefined` when not (yet) provided"）：精简 profile
   *  确实交不出某些服务，各调用点下面的形状守卫照旧。 */
  get?: Context["get"];
  /** 服务供给的类型取官方 `Context["provide"]`（installed reflect.d.ts:41-43，两枚重载）。
   *  本包 provide 的名字 `lessonLoop` 是本仓 sibling 插件自有的服务名（宿主安装里检索为
   *  0 命中），故它落在官方 `provide(name: string, value?: any): () => void` 那枚兜底分支上——
   *  这是**官方给出的**读不到声明名时的规则，disposer 仍由官方签名交出（:43 `() => void`），
   *  本地不再重述。 */
  provide?: Context["provide"];
  /** 注册口（单实例锁要用）。可选：本包其余部分从不碰它，缺了就是「能力缺席」，
   *  锁按放行处理（见 shared 的 lib/instance-lock 头注释）。取值时**直接交对象本身**，
   *  不要再包一层 `{ provide }` —— 包出来的箭头恒是函数，会让「没有注册口」伪装成
   *  「有注册口但 provide 抛错」，让路判据据此误判而把整份插件关掉。 */
  reflect?:
    | { readonly provide?: ((name: string, value?: unknown) => unknown) | undefined }
    | undefined;
  /** 挂页面策略用：`configure` 的 owner 必须显式传本插件 fiber（见 apply）。 */
  inject: (deps: readonly string[], callback: (child: InjectedCtx) => void) => unknown;
  /** 本插件 fiber：隐式注册后插件侧不再持有 scope，页面策略只认它。类型即官方
   *  `SettingsForms.configure(presentation, owner?: Fiber)`（installed index.d.ts:80）的那位
   *  `Fiber`；旧代码写 `unknown` 是为了把任何东西塞进 owner，官方面交回来后受约束。 */
  fiber: Fiber;
  /** 官方效应面（`Context extends Pick<Fiber, 'effect'>`，installed
   *  @deepseek-ai/cordis/lib/types/fiber.d.ts:8）：本地不再重述工厂签名。⚠ 官方返回域
   *  （`SyncEffect`/`Effect`，:49-51）**不收 `undefined`**——见 NOOP_DISPOSER。 */
  effect: Context["effect"];
  /** 事件接线的类型：两枚事件名与载荷都由官方事件表交出（`Parameters<Events[…]>[0]`），
   *  本地不重述签名。`session/disposed` 的载荷就此是官方 `Session`（installed
   *  @deepseek-ai/dsh-session/lib/types/index.d.ts:50）；本包只读它的 `id`，那道
   *  `stringIdOf`/`isRecord` 守卫照旧（官方类型说的是宿主的承诺，交付由守卫负责）。
   *  ⚠ 不换 `Context["on"]`：那是全仓延后项（泛型 `on<K extends keyof Events>` 会重写每一枚
   *  监听器签名，ctx-observe 的 host.ts 记着同一条理由）。按重载逐枚点名，
   *  新增事件时加一条签名即可，不必把整张事件表拖进来。 */
  on: ((
    event: "session/disposed",
    listener: (session: Parameters<Events["session/disposed"]>[0]) => void,
  ) => unknown) &
    ((
      event: "agent/created",
      listener: (payload: AgentCreatedPayload) => void | Promise<void>,
    ) => unknown) &
    /**
     * 会话日志每条追加事件的派发（`packages/core/session/src/index.ts:85` 声明
     * `(session: Session, event: SessionEvent)`，`@mode emit`）。本包只认两种载荷：
     * `workspace-root/change`（当前工作目录变了，归因桶随之变）与 `compaction/end`
     * （压缩可能把本包注入的摘要折进摘要块，需要补回）。形状照旧由官方事件表交出，
     * 本地不重述签名。
     */
    ((event: "session/event", listener: SessionEventListener) => unknown) &
    ((event: "settings/document-updated", listener: (ns: unknown) => void) => unknown);
}

// ── 配置 ─────────────────────────────────────────────────────────────────

/**
 * 行级配置（组合包层/用户层行的 `config:`），由 cordis 按导出的 `Config` schema 校验并
 * 逐字段填 `.default()` 后传入 apply。0.2.1-alpha.2 里注册是**隐式**的：命名空间 = profile 条目 id
 * （`lesson-loop`，见 cordis.patch.yml），可编辑字段由 schema 上的 `.volatile()` 声明，
 * 插件侧不再有 `settings.register`，也没有它那一层 `base` 底座——原 BUILTIN_BASE 逐字段
 * 落成下面的 `.default(...)`，单一来源。volatile 字段以 Volatile 引用形态交进来，
 * 读当前值一律 `.get()`。
 * 优先级：settings 运行时值（设置卡/规则卡）> 行 config > schema 默认。
 */
export interface Config {
  enabled: Volatile<boolean>;
  /** 教训写到磁盘与归并开关（关掉后 report 只回执不写到磁盘，管理界面照常可用）。 */
  reportEnabled: Volatile<boolean>;
  /** 会话开始注入 armed 规则摘要。 */
  injectEnabled: Volatile<boolean>;
  /** 常驻 systemPrompt 段。 */
  sectionEnabled: Volatile<boolean>;
  /** 同 (project, category, signature) 教训达此次数 → 候选卡标记 ready 待人工确认。 */
  promoteThreshold: Volatile<number>;
  /** armed 后复发达此次数且复发率达标 → 自动降级待人审。 */
  demoteThreshold: Volatile<number>;
  /** 降级所需的最小真实证据样本数（violation+suppressed；暴露 samples 不计入）。 */
  demoteMinSamples: Volatile<number>;
  demoteRatio: Volatile<number>;
  /** armed 超此天数却零复发零遵守（从没被测到）→ 判"不可判定"（保留 armed 交人工）。 */
  decayDays: Volatile<number>;
  /** rejected 规则再次出现到此次数 → 自动转回候选待人工重审（1-20，默认 3）。 */
  reviveThreshold: Volatile<number>;
  /** lessons.jsonl 磁盘保险丝（字节）。0 = 不设上限（默认；内容零截断）。 */
  maxLessonsBytes: Volatile<number>;
  /** 规则正文写入上限（字符）。armed 正文整段注入每次会话的提示词；超出时 arm/edit
   *  被拒（蒸馏建候选不受限，人审改写后再 arm）。 */
  maxStatementChars: Volatile<number>;
  /** 证据时间线每页条数（`ruleDetail` 的服务端页大小）。存设置段，跨 profile 同一偏好；
   *  5–100，默认 20。规则正文与证据仍全量落库，这个数只决定一次下发多少条。 */
  evidencePageSize: Volatile<number>;
  /**
   * 部署值：一次蒸馏的墙钟（毫秒）。到点 abort 那条 llm.stream——评审机/网络慢的
   * 部署要抬，但它不是用户随时翻的开关，故**不标 volatile**、不进设置卡。
   */
  digestTimeoutMs: number;
  /** 部署值：周期衰减的武装间隔（毫秒）。随部署的会话节奏调整。 */
  decayIntervalMs: number;
  /**
   * 部署值：会话开始最多注入几条 armed 规则（0 = 不设上限）。
   *
   * 为什么需要它：armed 只能由人工升格，而"零干净命中"的卡拿不到降级或归档的裁决
   * （见 lib/decay-policy.ts 的不可判定态），条数因此没有任何自动收敛路径——这条上限是
   * 唯一能约束"注入单调增长"的地方。每条规则的正文仍**全文**注入（不截断），
   * 少的是条数不是内容。同 digestTimeoutMs：是部署旋钮而非用户随时翻的开关，故不标 volatile。
   */
  maxInjectedRules: number;
}

/** 设置命名空间与 loader 行 config 共用同一 schema（唯一来源，防漂移）。
 *  值名退避为 configSchema：避免与同名 interface Config 触发 no-redeclare（ctx-observe
 *  同款），外部仍以 `Config` 名导入（export as）——cordis registry 读的就是入口键
 *  `Config`（vendor/cordis/src/registry.ts:104 `Plugin.Base.Config`，装载时
 *  fiber._resolveConfig → resolveConfig 校验；此前本包写成 `ConfigSchema` 键，
 *  registry 取不到，本包的行 config 校验从未真正跑过）。
 *  可编辑字段**全部** `.volatile()`（两枚部署值刻意不标，见下）：没有任何 volatile 字段的条目会被宿主 describe() 整条
 *  跳过（packages/settings/settings/src/index.ts:308-309），写入则抛
 *  `has no volatile fields`（:386）——开关与规则库因此都是"从 schema 反推"的，漏标一项
 *  不会报错，只会让那一项从设置卡上静默消失（test/host.test.ts 拿宿主同一个判据钉住）。 */
/** 周期衰减的默认武装间隔（真值由 entry config `decayIntervalMs` 交进来，
 *  这里只剩 schema `.default()` 的单一来源）。一天一轮：衰减是统计规则的整理活，
 *  比会话节奏慢得多，跑赢 24h 就够；更密的部署在行 config 上收紧。 */
const DEFAULT_DECAY_INTERVAL_MS = 24 * 60 * 60_000;

/** 会话开始注入 armed 规则的条数上限默认值（0 = 不设上限）。
 *  取一个宽松但有限的值：它兜的是"零干净命中的卡永不自动收敛"这条结构性缺口
 *  （见 Config.maxInjectedRules），而不是日常使用；真嫌挤的部署在行 config 上收紧。 */
const DEFAULT_MAX_INJECTED_RULES = 50;

/** 证据时间线的默认页大小（设置卡可改，服务端兜底 clamp 到 5–100）。 */
const DEFAULT_EVIDENCE_PAGE_SIZE = 20;

const configSchema = Schema.object({
  enabled: Schema.boolean().default(true).volatile(),
  reportEnabled: Schema.boolean().default(true).volatile(),
  injectEnabled: Schema.boolean().default(true).volatile(),
  sectionEnabled: Schema.boolean().default(true).volatile(),
  promoteThreshold: Schema.natural().min(1).max(20).default(3).volatile(),
  demoteThreshold: Schema.natural().min(1).max(50).default(3).volatile(),
  demoteMinSamples: Schema.natural().min(1).max(100).default(5).volatile(),
  demoteRatio: Schema.number().min(0.05).max(1).step(0.05).default(0.5).volatile(),
  decayDays: Schema.natural().min(1).max(365).default(30).volatile(),
  reviveThreshold: Schema.natural().min(1).max(20).default(3).volatile(),
  // 0 = 不设上限：用户拍板"不为省 token 截断内容"。保险丝只在用户显式要求时给。
  maxLessonsBytes: Schema.natural()
    .max(1024 * 1024 * 1024)
    .default(0)
    .volatile(),
  // 规则正文的写入上限：armed 正文整段注入提示词，没有这条上限时一次写请求就能把它塞满。
  // 默认与 lib/lesson-store.ts 的 DEFAULT_MAX_STATEMENT_CHARS 同源；硬上界防一个离谱的
  // 配置把上限抬到形同没有。
  maxStatementChars: Schema.natural()
    .min(1)
    .max(100_000)
    .default(DEFAULT_MAX_STATEMENT_CHARS)
    .volatile(),
  // 证据时间线的页大小：服务端只读这个数，客户端只带 cursor。上限 100 防止一次把
  // 整段证据序列化过网关；下限 5 防止每页一条把翻页变成逐条轮询。
  evidencePageSize: Schema.natural().min(5).max(100).default(DEFAULT_EVIDENCE_PAGE_SIZE).volatile(),
  // 三枚部署级调优值（官方 config.md:78-92 的判据是"行 config 能否不改代码改值"，
  // 不是"能不能在页面上改"）。刻意不标 volatile ⇒ 不进设置卡；默认与旧常量同值，
  // 行为冻结由 test/host.test.ts 的字面值钉住。min(1000) 挡掉 0：零墙钟会让蒸馏一帧都
  // 读不到，零间隔会让衰减定时器变成忙循环。maxInjectedRules 的 0 是**有语义的**
  // （不设上限，与 maxLessonsBytes 同义），故它没有 min(1)。
  digestTimeoutMs: Schema.natural().min(1000).default(DEFAULT_DIGEST_TIMEOUT_MS),
  decayIntervalMs: Schema.natural().min(1000).default(DEFAULT_DECAY_INTERVAL_MS),
  maxInjectedRules: Schema.natural().max(1000).default(DEFAULT_MAX_INJECTED_RULES),
});
export { configSchema as Config };

/**
 * 派生数据的写到磁盘位置：官方 cache 目录（`dshCachePath` = `$DSH_HOME/cache`，
 * DSH_HOME 未设时由 home-paths 自己按 `~/.dsh` 解析）。
 *
 * 为什么是 cache：dsh 承认的用户数据目录只有 settings 文档与 sessions/storages/
 * cache/logs，插件自开 `metrics/` 属越界（用户的手工编辑、备份、清理都不在官方面上）。
 * 事件流水正是 cache 定位的"可丢弃派生数据"——丢了能由会话与规则库重建，不该占用
 * 用户唯一那份 settings.yaml。自制 `DSH_HOME → HOME/.dsh → throw` 三态回退一并删掉：
 * 解析规则由官方包唯一来源提供，插件不再第二份实现（也不再有"两个环境变量都没有就炸"
 * 这种热路径抛错）。
 */
export function cacheFile(name: string): string {
  // 官方 cache 助手（@deepseek-ai/dsh-home-paths 0.1.x 起导出）：字符串重载即
  // `dshHomePath("cache", <segment>, …)` 的展开式，路径与 rc.3 时代手写的
  // `dshHomePath("cache", PLUGIN_NAME, name)` 逐字节相同（见 lib/index.js 的
  // dshCachePath 实现），故已写到磁盘的流水不需要迁移。
  return dshCachePath(PLUGIN_NAME, name);
}

/**
 * 旧规则库的**只读导入端口**：规则数组已从 Config schema 摘除，但老 profile 的
 * `config: { rules: [...] }` 还在文档里。cordis 的 `~standard.validate` 对未声明键是
 * 透传的（实测 `Schema.object({a}).validate({a,rules})` 返回 `{a,rules}`），所以 apply
 * 拿到的 config 里仍带着这段原文，迁移只需在这里读一次。
 *
 * 读不懂（非数组）按 unusable 处理：迁移跳过、日志点名，不猜、不清空。
 * `save` 永远 rejected：字段已摘除，清空旧位那一笔写不进去（也不该把用户原文悄悄抹掉）。
 */
function legacyRulesFromConfig(config: Config): RulesRepository {
  const raw = fieldOf(config, RULES_FIELD);
  if (raw === undefined) {
    return createRulesRepository(null);
  }
  const surface: SettingsCasSurface = {
    // 合成一条 describe 投影：value/user 都是文档原文那一层，revision 0 只作占位
    // （迁移不再写回，CAS 条件不会被用到）。规则卡归一化与坏形状判定仍复用
    // lib/rules-namespace.ts 的同一套实现，不另写第二份。
    describe: () => [
      { ns: PLUGIN_NAME, revision: 0, value: { [RULES_FIELD]: raw }, user: { [RULES_FIELD]: raw } },
    ],
    // 迁移只读（load）；字段摘除后没有任何生产路径会写回旧位。
    /* v8 ignore next 1 -- 只读合成面：save() 永不落盘，单测也不驱动这条箭头 */
    update: () => Promise.reject(new Error("legacy rules field is read-only")),
  };
  return createRulesRepository(surface);
}

/** 会话台账容量上限（ctx-observe 同款纪律：防长驻进程无界）。 */
const WATCH_MAX_SESSIONS = 200;

/** 会话台账里**一个项目桶**：同一场会话可能在多个项目里留下记录（进入工作树、
 *  再回到原项目），每个桶各自记账、各自清算。 */
interface SessionBucket {
  violated: Set<string>;
  passed: Set<string>;
}

/** 会话台账的一行：按项目分桶 + 最近一次写入所在桶（无桶时兜底清算读它）。
 *
 *  为什么按桶而不是一个 project 字段：归因口径是"会话**当前**工作目录"（见
 *  {@link foldCwd}），而一场会话可以在中途换目录（宿主 `workspace-root/change`）。
 *  换目录前后注入的是两套规则、上报的是两个项目，收尾时两边都要按各自的 armed 集
 *  记 exposure/suppressed；只留一个 project 字段会让先前的桶在换目录那一刻被覆盖，
 *  那一段的 exposure 与 suppressed 永久丢失。 */
interface SessionWatchEntry {
  buckets: Map<string, SessionBucket>;
  /** 最近一次写入（注入/违规/pass）所在的项目：没有任何桶时用它兜底，见 onDisposedSession。 */
  project: string;
  /** 上一次清算里**已经真写进库**的项目桶（写失败被还原的那条台账据此跳过已落定的桶，
   *  否则重试会把同一场会话的 samples 再计一遍）。 */
  settled?: Set<string>;
}

/** sessionId → 台账行：会话内复发记录，session/disposed 时清算 suppressed。 */
type SessionWatch = Map<string, SessionWatchEntry>;

/** 已清算过的 durable session：`session/disposed` 按 store 条目发，同一会话 resume 一次
 *  就多一条边，清算必须按 durable 身份去重（见 createSessionWatch 的说明）。 */
type SettledSessions = Map<string, true>;

/**
 * 消息表的取用入口：每次现取，用户在「设置 → 常规」改语言偏好后，下一条回显/注入
 * 就是新文案（不重启、也不给本包加一个自己的 locale 设置项）。语言只由设置偏好决定：
 * 旧 HTTP 接口那条 Accept-Language 兜底随请求一起消失，Remote 调用没有浏览器请求头可依。
 */
type MessagesOf = () => LessonLoopMessages;

/** 数组性判据（**不是** type predicate，故不产生收窄；理由见 observeSessionEvents 内注释）。 */
function isArrayDelivery(value: unknown): boolean {
  return Array.isArray(value);
}

/**
 * 取一场会话的事件流：官方 `ctx.sessionQuery.observeSession(sessionId)` 的
 * `observation.events`。
 * 两个用途：蒸馏（`/lessons-digest` 的差评证据）与注入对账（当前工作目录折叠 + 本包
 * 上一份摘要是否还在面上，见 {@link foldCwd} 与 {@link priorDigestOf}）。
 * 三条降级路径一律回**空表**（宁可少背景，不可炸命令，语义与迁移前的 `readSessionEvents`
 * 逐条对齐）：
 *  1. `sessionQuery` 未装配（非该 profile / 精简 bundle）——`get` 交回 undefined，
 *     官方语义即"or `undefined` when not (yet) provided"（installed
 *     @deepseek-ai/cordis/lib/types/reflect.d.ts:12）。
 *  2. 拿不到 `SessionId`：本包的 {@link SessionLike} 只借官方键名、值域按边界收窄
 *     （`id?: Session["id"]`），递来的对象完全可能没有 id 或不是字符串。旧写法不需要这一步
 *     （它直接读对象上的方法），换成按 sessionId 查询后，这道理所应当是一道守卫。
 *  3. `observeSession` 抛错/拒绝（会话已卸载、存储读不出、取消信号命中）。
 *
 * `SessionId` 的 `brand` 标记只能由 {@link brandString} 打上（`brandString<SessionId>` 是唯一
 * 合法构造口：这类类型没有 type-only 的构造方式，`as` 又被 typescript/no-unsafe-type-assertion 禁掉），
 * 见文件头列出的 dsh-brand 值导入。
 */
async function observeSessionEvents(
  svc: HostCtx,
  session: SessionLike,
): Promise<readonly SessionEvent[]> {
  const queryRaw = svc.get?.("sessionQuery");
  if (!isSessionQueryService(queryRaw)) {
    return [];
  }
  const sessionId: string | undefined =
    typeof session.id === "string" && session.id.length > 0 ? session.id : undefined;
  if (sessionId === undefined) {
    return [];
  }
  let observation: Awaited<ReturnType<SessionQueryFace["observeSession"]>> | undefined;
  try {
    // 本包只读 events：`projectionMode: "none"` 避免宿主为整份日志算一遍全部投影。
    observation = await queryRaw.observeSession(brandString<SessionId>(sessionId), {
      projectionMode: "none",
    });
    // 交付判据只当**布尔**用，不经 `Array.isArray` 收窄：那条守卫会把官方
    // `readonly SessionEvent[]`（installed dsh-session-query/lib/types/observation.d.ts:19）
    // 塌成 `any[]`，类型信息当场作废并让返回值变成 unsafe return。数组性由这个不收窄的
    // 判据挡住，返回的仍是官方形状。
    if (!isArrayDelivery(observation.events)) {
      return [];
    }
    return observation.events;
  } catch {
    return [];
  } finally {
    // 冷读的 observation 是一条 pin 住缓存的 lease；不还就会让会话数据一直留在内存里。
    // 旧宿主的观察接口可能没有 Symbol.dispose，释放失败也不改变本次读窗的结论。
    try {
      observation?.[Symbol.dispose]?.();
    } catch {
      // 释放是尽力而为：读窗已经交回，不能因为归还失败把命令变成异常。
    }
  }
}

/**
 * 会话**当前**工作目录：`header.cwd` 只是"原始项目目录"，宿主自己的投影
 * `WorkingDirectoryService` 以它作 init（packages/session/working-directory/src/index.ts:105-110），
 * 此后只认 `workspace-root/change` 的 cwd（同文件 :112 的 `apply` 只认这一条；`working-directory/change`
 * 已无写入方，注释标了 `@deprecated`）。这里按同一顺序折叠一遍，注入/蒸馏/清算因此与
 * 宿主的"当前目录"逐条同源，而不是与"会话在哪个项目里创建"同源。
 *
 * 为什么读的是事件而非服务：`workingDirectory` 与这两条事件类型的声明分别住在
 * `@deepseek-ai/dsh-working-directory`、`@deepseek-ai/dsh-compaction-basic`，两者都不在本包
 * 的依赖面上（`SessionEventType` 因此在编译期看不到这两个名字）。事件名与载荷取自宿主源码
 * （`SessionEventMap` 的 `'workspace-root/change': { cwd: string }`），读取按边界收窄：
 * 只认 `type` 精确相等、且 `data.cwd` 是非空字符串。
 */
const WORKSPACE_ROOT_CHANGE = "workspace-root/change";
/** 压缩收尾事件（声明在 `@deepseek-ai/dsh-compaction-basic`，同一处不装；同上按 type 字符串认）。 */
const COMPACTION_END = "compaction/end";

function foldCwd(headerCwd: unknown, events: readonly SessionEvent[]): string | undefined {
  let cwd = typeof headerCwd === "string" && headerCwd.length > 0 ? headerCwd : undefined;
  for (const event of events) {
    if (fieldOf(event, "type") === WORKSPACE_ROOT_CHANGE) {
      const next = fieldOf(fieldOf(event, "data"), "cwd");
      if (typeof next === "string" && next.length > 0) {
        cwd = next;
      }
    }
  }
  return cwd;
}

/** 本包注入过的那份摘要的对账结果（见 {@link priorDigestOf}）。 */
interface PriorDigest {
  /** 仍在模型可见面上的那份正文（`surface.nodes` 里还含它那条消息的 seq）。 */
  readonly retained?: string;
  /** 日志里是否出现过本包的注入（出现过但不在面上 = 被压缩折进摘要了）。 */
  readonly logged: boolean;
}

/** 一条 `user/message` 是不是本包注入的摘要；是则返回其正文（逐块拼接 text，空块跳过）。
 *  单出口（守卫收进表达式）：本仓 lint 的 consistent-return 把 `return undefined` 读成
 *  "不返回值"，与"返回正文"混在一起就判红。 */
function ownedDigestText(messageRaw: unknown): string | undefined {
  const source = fieldOf(messageRaw, "source");
  const content = fieldOf(messageRaw, "content");
  const blocks = Array.isArray(content) ? content : [];
  const text =
    fieldOf(source, "kind") === LESSON_SOURCE_KIND
      ? blocks
          .map((block) => {
            const type = fieldOf(block, "type");
            const value = fieldOf(block, "text");
            return type === "text" && typeof value === "string" ? value : "";
          })
          .join("")
      : "";
  return text.length > 0 ? text : undefined;
}

/**
 * 对账本包上一次注入：与宿主自己的动态上下文投影同一套读法
 * （packages/core/agent-loop/src/runtime-context.ts:44-56：扫历史找自己那条、拿
 * `session.surface.nodes` 判它还在不在面上）。
 *
 * 两类状态必须分开，否则 resume 与压缩会被混成一件事故：
 *  - **还在面上** → `retained`，调用点拿它的正文与本次帧逐字节比，相同就不重复注入；
 *  - **不在面上、但日志里有** → `logged` 且没有 `retained`。压缩把一段消息折进摘要时
 *    用的是 surface 的 `replace` 操作（seq 因此离开 `nodes`），日志本身不删事件，
 *    所以"日志有、面上没有"精确对应"本包那份被折进摘要了"，这时必须补回一次。
 */
function priorDigestOf(
  session: AgentSessionView | undefined,
  events: readonly SessionEvent[],
): PriorDigest {
  const nodesRaw = session?.surface?.nodes;
  const visible = new Set<string>();
  if (Array.isArray(nodesRaw)) {
    for (const seq of nodesRaw) {
      visible.add(String(seq));
    }
  }
  let retained: string | undefined;
  let logged = false;
  // 顺序扫、后者覆盖前者：取的是"最新一条"。
  for (const event of events) {
    if (fieldOf(event, "type") === "user/message") {
      const text = ownedDigestText(fieldOf(event, "data"));
      if (text !== undefined) {
        logged = true;
        retained = visible.has(String(fieldOf(event, "seq"))) ? text : undefined;
      }
    }
  }
  return retained === undefined ? { logged } : { logged, retained };
}

/**
 * 注册 /lessons-digest 命令（人工触发蒸馏；commands 服务可选读——缺失只 warn 一次）。
 *  与 report 同一条规则：插件关闭期间既不烧 LLM 也不写候选卡。命令回显与进模型的蒸馏
 *  提示都随语言偏好走；蒸馏出来的规则条目是用户数据，原样透传。 */
function registerDigestCommand(
  svc: HostCtx,
  store: LessonStore,
  settingsOf: SettingsOf,
  messagesOf: MessagesOf,
): void {
  // commands 服务晚于本条目到位是常态（兄弟条目装载次序/热插拔）：effect 里 get 一次
  // 只能看见"此刻"，晚到即永久注册不上。inject 让宿主在服务就绪时回调（cordis 注入
  // 语义，applySettingsPagePolicy 同款）。缺席语义随之从"warn 一次"变成"静默等"——
  // "还没来"与"永远不来"在 apply 时刻不可区分，为可能晚到的服务打缺席告警是误报。
  svc.inject(["commands"], (child) => {
    child.effect(() => {
      const commandsRaw = child.commands;
      if (!isCommandsService(commandsRaw)) {
        return noDisposer;
      }
      const commands = commandsRaw;
      const description = messagesOf().digestCommandDescription;
      return commands.register({
        name: "lessons-digest",
        description,
        input: { hint: messagesOf().digestInputHint },
        recordInput: false,
        handler: async (invocationRaw) => {
          const messages = messagesOf();
          const cfg = settingsOf();
          if (!cfg.enabled || !cfg.reportEnabled) {
            return {
              kind: "error" as const,
              text: messages.digestRejectedDisabled,
            };
          }
          const agent = fieldOf(invocationRaw, "agent");
          const sessionRaw = isRecord(agent) ? fieldOf(agent, "session") : undefined;
          if (!isSessionLike(sessionRaw)) {
            return {
              kind: "error" as const,
              text: messages.digestRejectedNoSession,
            };
          }
          const session = sessionRaw;
          const llmRaw = svc.get?.("llm");
          if (!isLlmService(llmRaw)) {
            return { kind: "error" as const, text: messages.digestRejectedNoLlm };
          }
          const llm = llmRaw;
          const modelSvcRaw = svc.get?.("agentDefaultModel");
          const selection = isAgentDefaultModel(modelSvcRaw)
            ? modelSvcRaw.currentSelection()
            : undefined;
          const rawInput = fieldOf(invocationRaw, "rawInput");
          const extra =
            typeof rawInput === "string" && rawInput.trim().length > 0 ? rawInput : undefined;
          // 本会话事件流经**官方** `ctx.sessionQuery.observeSession()` 取（见上面
          // SessionQueryFace 的注记）：旧写法是 `session.snapshotEvents()`，而官方把那条同步读
          // 面标了 `@deprecated` 并禁止新增调用。取不到（服务缺位 / 会话已卸载 / 会话 id 读不出 /
          // 观察抛错）一律退**空背景**——蒸馏照跑，只是少了差评证据；命令绝不能因为读取接口缺失而炸。
          const events = await observeSessionEvents(svc, session);
          // 归因与注入同一口径：会话**当前**工作目录（见 foldCwd）。工作树里蒸馏出的候选
          // 必须落在工作树那个桶里，否则下次进工作树注入不到，而主仓里反而多出一批
          // 本不该用的规则。
          const cwd = foldCwd(session.header?.cwd, events);
          try {
            const result = await runDigest(store, session, llm, selection, {
              messages,
              events,
              ...(cwd === undefined ? {} : { cwd }),
              timeoutMs: settingsOf().digestTimeoutMs,
              ...(extra === undefined ? {} : { extra }),
            });
            if (result.created.length === 0 && result.dropped.length === 0) {
              return {
                kind: "success" as const,
                text: fill(messages.digestNoNewRules, { count: result.feedbackCount }),
              };
            }
            // 没写到磁盘的那批**不能**并进"已蒸馏"：库里没有那些卡，回显成成功会让人去卡片上找
            // 一张不存在的卡（写到磁盘失败与成功因此是两条回显，见 lib/digest.ts 的 acc）。
            if (result.dropped.length > 0) {
              return {
                kind: "error" as const,
                text: fill(messages.digestPartialFailure, {
                  count: result.created.length,
                  failed: result.dropped.length,
                }),
              };
            }
            const lines = result.created.map((rule, index) =>
              digestCreatedLine(rule, index + 1, messages),
            );
            return {
              kind: "success" as const,
              text: fill(messages.digestCreated, {
                count: result.created.length,
                lines: lines.join("\n"),
              }),
            };
          } catch (error) {
            return {
              kind: "error" as const,
              text: fill(messages.digestFailed, { reason: errorText(error) }),
            };
          }
        },
      });
    }, "lesson-loop: /lessons-digest command");
  });
}

/** 启动时的存量碎片迁移：路径型签名的候选/armed 碎片并入类别级
 *  稳定签名卡。幂等——迁移后不再有匹配碎片，重复调用是 no-op。容错。 */
async function runFragmentMigration(store: LessonStore): Promise<void> {
  try {
    const merged = await store.migrateFragmentRules();
    if (merged > 0) {
      console.info(`[lesson-loop] migrated ${merged} fragment rule(s) to stable signatures`);
    }
  } catch (error) {
    console.error(`[lesson-loop] fragment migration failed: ${errorText(error)}`);
  }
}

/** 启动时的 project 键归一迁移：桶键派生收进 shared/lib/project-key.ts（补
 *  path.resolve + realpath）后，按卡片自存的 cwd 重算 project 并归并撞车卡。
 *  幂等；与碎片迁移同一纪律——失败只记日志，装载不许被存量数据炸断。 */
async function runProjectKeyMigration(store: LessonStore): Promise<void> {
  try {
    const { rewrites, merged } = await store.migrateProjectKeys();
    if (rewrites > 0) {
      console.info(
        `[lesson-loop] normalized ${rewrites} rule project key(s)${merged > 0 ? `, merged ${merged} collision(s)` : ""}`,
      );
    }
  } catch (error) {
    console.error(`[lesson-loop] project key migration failed: ${errorText(error)}`);
  }
}

/** 官方 cache 目录下的流水文件名（库不可用时回退介质；迁移也按它找旧文件）。 */
const EVENTS_FILE_NAME = "events.jsonl";
/** cordis `FiberState.ACTIVE` 的现量（const enum 无运行期对象，故按源码取值 2 写死）。 */
const FIBER_ACTIVE = 2;

/** 条目是否已 ACTIVE。入参按 `unknown` 收窄：枚举比较规则不认跨包 const enum 的字面量。 */
function isFiberActive(state: unknown): boolean {
  return state === FIBER_ACTIVE;
}

const SESSION_ENDED_FAILURE_LABEL = "sessionEnded failed";

/**
 * 清算回执的读法：只有明确的 `false` 算"没写进库"；`true` 与缺省的 `undefined`（旧替身）
 * 都按已落定读。入参按边界收窄成 `unknown`：官方签名是 boolean，而"替身回 undefined"
 * 正是要越过的那一层。
 */
function settledOk(persisted: unknown): boolean {
  return persisted !== false;
}

/**
 * 清算一个 session 的**唯一**入口：内存桶与 SQLite 台账先合并成同一份项目视图，
 * 再逐项目串行调用 `store.sessionEnded`。
 *
 * 为什么必须合并：内存桶由 `recordPass` / 注入预种建立，库台账由两处写穿透维护；
 * report 早于 `agent/created`、watch 被容量修剪、插件中途装载时，两边集合会不一致。
 * 以前 `settleBuckets` 只信内存、`settleLedgerRemnants` 只信台账，结果同一场会话被
 * 两套语义各清一次：pass 先按内存计一次 suppressed，再按台账补算一次。这里把"哪个
 * 项目要清"与"这个项目违过/遵守过哪些规则"统一成一份，之后每个项目只清一次。
 *
 * 幂等靠两个标记：
 *   - 内存条目上的 `entry.settled`：同一进程内重试时跳过已真写进库的项目；
 *   - 台账行的 `settled_at`：成功提交后打上，跨进程/重启都认它。
 * 两者都不表示"这次清算已经被调用过"；只有规则写和 `settled_at` 在同一个
 * `saveRules` 事务里提交（见 `onPersisted`），才不存在"规则计数已落、台账仍 pending"
 * 的中间态。
 *
 * @param args.countExposure 首个 dispose 边/卸载清算为 true；resume 重复边与启动补算为 false。
 * @param args.fallbackProject 无内存条目且台账也为空时，用会话 header 的项目做一次空集合清算。
 */
interface SettleSessionArgs {
  store: LessonStore;
  db: LessonDb | null;
  sessionId: string;
  entry?: SessionWatchEntry;
  countExposure: boolean;
  fallbackProject?: string;
}

interface SettleProjectArgs {
  store: LessonStore;
  db: LessonDb | null;
  sessionId: string;
  project: string;
  bucket: SessionBucket;
  /** 该项目的待计台账行（没有则 undefined）。有行时它是本次要计的 id 真相源。 */
  ledger?: LedgerRow;
  countExposure: boolean;
  alreadySettled: boolean;
}

/** 台账行已落定且队列空，且内存桶还有待结算的旧计数 → 这一场已由台账那一侧消费。
 *  只在这种“内存桶非空”的重复边收口；空桶的重复 dispose 仍交给 sessionEnded，
 *  让 store 侧的 exposure 去重与调用次数语义保持原样。 */
function isConsumedLedger(args: {
  db: LessonDb | null;
  sessionId: string;
  project: string;
  bucket: SessionBucket;
}): boolean {
  if (args.db === null || (args.bucket.violated.size === 0 && args.bucket.passed.size === 0)) {
    return false;
  }
  const row = args.db.ledgerRow(args.sessionId, args.project);
  return (
    row !== null && row.settledAt !== null && row.violated.length === 0 && row.passed.length === 0
  );
}

/** 把项目记进内存条目的已清算集合；entry 缺席（启动补算）时没有可落的集合。 */
function markProjectSettled(entry: SessionWatchEntry | undefined, project: string): void {
  if (entry === undefined) {
    return;
  }
  (entry.settled ??= new Set<string>()).add(project);
}

/** 把一个项目桶并进清算视图；同一项目来自内存与台账时取并集（同一规则只算一次）。 */
function mergeBucket(
  buckets: Map<string, SessionBucket>,
  project: string,
  violated: readonly string[],
  passed: readonly string[],
): void {
  const existing = buckets.get(project);
  if (existing === undefined) {
    buckets.set(project, { violated: new Set(violated), passed: new Set(passed) });
    return;
  }
  for (const id of violated) {
    existing.violated.add(id);
  }
  for (const id of passed) {
    existing.passed.add(id);
  }
}

/** 读本会话的 pending 台账；读失败不连累内存桶这一份（pending 留给下次开机）。 */
function pendingLedgerRows(db: LessonDb | null, sessionId: string): readonly LedgerRow[] {
  if (db === null) {
    return [];
  }
  try {
    return db.pendingLedger(sessionId);
  } catch (error) {
    console.error(`[lesson-loop] ledger read failed: ${errorText(error)}`);
    return [];
  }
}

/** 内存与台账都没有项目时才用 header 兜底；台账已有项目时再加空桶会凭空多算 exposure。 */
function addFallbackBucket(buckets: Map<string, SessionBucket>, fallbackProject?: string): void {
  if (buckets.size > 0 || fallbackProject === undefined) {
    return;
  }
  buckets.set(fallbackProject, { violated: new Set(), passed: new Set() });
}

/** 台账队列的一笔取走：`settleLedgerNow` 把 id 从队列里删掉、按需打 settled_at/exposure_at。
 *  写成模块函数而不是内联三处：`settleProject` 的两条路径（同事务回调、事后补打）必须
 *  传**完全相同**的参数，内联两份迟早漂成两份真相。 */
interface ConsumeLedgerArgs {
  db: LessonDb;
  sessionId: string;
  project: string;
  violated: ReadonlySet<string>;
  passed: ReadonlySet<string>;
  countExposure: boolean;
}

function consumeLedger(args: ConsumeLedgerArgs): void {
  args.db.settleLedgerNow(
    args.sessionId,
    args.project,
    { violated: [...args.violated], passed: [...args.passed] },
    args.countExposure,
  );
}

/** 事后补打台账（没有计数要写时 save 提前返回、不会回调钩子，本次只记暴露度）。
 *  队列与 settled_at 仍要落库：否则这条行会一直留在 pending 里，每次开机都被当成本轮
 *  待补算的项目。返回 false 只有"真出错"一种；被别处取走时计数已由它落地，不算失败。 */
function drainLedger(args: ConsumeLedgerArgs): boolean {
  try {
    consumeLedger(args);
    return true;
  } catch (error) {
    // 被另一条连接消费掉：计数已由它落地，这一轮不算失败，也不必重试。
    if (error instanceof LedgerConsumedElsewhereError) {
      return true;
    }
    console.error(`[lesson-loop] ledger settle failed: ${errorText(error)}`);
    return false;
  }
}

/** 清算单个项目。返回 false 表示规则库没落住，调用方保留 pending 重试。 */
async function settleProject(args: SettleProjectArgs): Promise<boolean> {
  const { store, db, sessionId, project, bucket, ledger, countExposure, alreadySettled } = args;
  if (alreadySettled) {
    // 本进程上一次重试已经把这个项目写进库（当时台账队列被同事务取走、settled_at 已打）。
    // 再走一遍只会重算一次 samples；重复的 dispose 边到此为止。
    return true;
  }
  // **计数的 id 真相源是台账队列，不是内存桶**：队列里的 id 才是"还没计过"的那些，
  // 内存桶既可能已经在上一次尝试/另一个进程里被计过（拿它当真相源就会双计），也可能
  // 因为 noteLedger 写失败而根本没进库（此时台账里没有这个项目的行，反而只有内存桶
  // 记着）。两种情况分别取，判据就是"这个项目有没有台账行"。
  const useLedger = db !== null && ledger !== undefined;
  const violated = useLedger ? new Set(ledger.violated) : bucket.violated;
  const passed = useLedger ? new Set(ledger.passed) : bucket.passed;
  // 写成对象而不是裸 `let consumed`：TS 的控制流分析假定"闭包不会被调用"，裸变量在
  // `await` 之后会被窄化成初值 false，`!consumed` 判据当场变成常量（lint 的
  // no-unnecessary-condition 会红，而那恰好是这里最要紧的一位）。
  const consume = { done: false };
  // 同事务取走：规则计数与队列消费在同一个 BEGIN IMMEDIATE 里提交，崩溃只会两个都没发生。
  // 被另一条连接抢先取走时 settleLedgerNow 抛错 → saveRules 回滚 → sessionEnded 回 false，
  // 于是这一轮一个计数也不落（宁可留给下一轮，也不把同一笔计两遍）。
  const onPersisted =
    db === null
      ? undefined
      : (): void => {
          consumeLedger({ db, sessionId, project, violated, passed, countExposure });
          consume.done = true;
        };
  const persisted = await store.sessionEnded(
    project,
    violated,
    passed,
    sessionId,
    countExposure,
    ...(onPersisted === undefined ? [] : [onPersisted]),
  );
  if (!settledOk(persisted)) {
    return false;
  }
  if (db === null || consume.done) {
    return true;
  }
  return drainLedger({ db, sessionId, project, violated, passed, countExposure });
}

async function settleSession(args: SettleSessionArgs): Promise<boolean> {
  const { store, db, sessionId, entry, countExposure } = args;
  const buckets = new Map<string, SessionBucket>();
  if (entry !== undefined) {
    for (const [project, bucket] of entry.buckets) {
      mergeBucket(buckets, project, [...bucket.violated], [...bucket.passed]);
    }
  }
  // 台账行单独按 project 存一份：它才是"还没计过的 id"的真相源，内存桶只用来决定
  // "哪些项目要清"（含写失败时台账里没有行的那些）。
  const ledgerByProject = new Map<string, LedgerRow>();
  for (const row of pendingLedgerRows(db, sessionId)) {
    ledgerByProject.set(row.project, row);
    mergeBucket(buckets, row.project, row.violated, row.passed);
  }
  addFallbackBucket(buckets, args.fallbackProject);

  for (const [project, bucket] of buckets) {
    const alreadySettled = entry?.settled?.has(project) === true;
    const ledger = ledgerByProject.get(project);
    // 队列已经空、且台账行已落定：这一场在另一条连接里结算过。内存桶可能还留有
    // noteLedger 写失败后的旧计数，但那些 id 的计数已经由台账那一侧落地，再写一遍就是
    // 双计；按“已消费即成功”收口，不调用 sessionEnded（也就不会重算 samples）。
    const consumed = !alreadySettled && isConsumedLedger({ db, sessionId, project, bucket });
    if (!consumed) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- 逐项目串行：同一端口上的并发写只会互撞 CAS
      const persisted = await settleProject({
        store,
        db,
        sessionId,
        project,
        bucket,
        ...(ledger === undefined ? {} : { ledger }),
        countExposure,
        alreadySettled,
      });
      if (!persisted) {
        return false;
      }
    }
    markProjectSettled(entry, project);
  }
  return true;
}

async function settleSessionOutcome(
  args: SettleSessionArgs,
): Promise<{ settled: boolean; error?: unknown }> {
  try {
    return { settled: await settleSession(args) };
  } catch (error) {
    return { settled: false, error };
  }
}

/**
 * 启动补算：从库里主动扫描**所有**未落定台账，按 session 逐个清算。
 *
 * 这是原先缺失的读取路径：`pendingLedger(sessionId)` 的调用点都依赖本进程还看得见
 * 这场会话；进程被 kill/崩溃后下一轮开机既没有 sessionWatch、也等不到 session/disposed，
 * pending 行就永远留在库里。启动扫描不看内存，只按库里的账补 suppressed；
 * `countExposure=false` 是有意的——会话已经结束，补 samples 等于凭空造暴露度。
 */
async function recoverPendingLedgers(db: LessonDb | null, store: LessonStore): Promise<void> {
  /* v8 ignore next 3 -- db===null 只在磁盘/权限故障的真实装载里出现；装载期路径已有替身覆盖。 */
  if (db === null) {
    return;
  }
  let sessions: Set<string>;
  try {
    sessions = new Set(db.pendingLedgerAll().map((row) => row.sessionId));
  } catch (error) {
    console.error(`[lesson-loop] ledger recovery scan failed: ${errorText(error)}`);
    return;
  }
  for (const sessionId of sessions) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- 逐会话串行：同一端口上的并发写只会互撞 CAS
    const outcome = await settleSessionOutcome({
      store,
      db,
      sessionId,
      countExposure: false,
    });
    if (!outcome.settled) {
      // 一场坏会话不能中断整轮补算：只记日志，其余 pending 行继续扫。
      const detail = outcome.error === undefined ? "rows left pending" : errorText(outcome.error);
      console.error(`[lesson-loop] ledger recovery incomplete for ${sessionId}: ${detail}`);
    }
  }
}

/**
 * 卸载时清算仍未收到 session/disposed 的会话。
 *
 * 为什么需要：headless/CLI 进程只跑一个任务就退出，Cordis 拆树时插件 fiber 先于会话
 * 事件销毁——只挂在 session/disposed 上的收尾清算在这些进程里**永远不执行**，
 * samples/observed 因此恒为 0，armed 规则结构性落入"不可判定"，度量层等于没做。
 * 开关判断与容错规则与事件版一致（关闭期间不清算、单条失败不拖垮其余），但**交回可 await 的
 * 异步 disposer**：官方声明异步 disposer 由 cordis 在销毁 fiber 时 await（cordis 的 `Fiber["dispose"]`），
 * 旧的 fire-and-forget 写法会让在飞的 provider 写被截断，
 * 违反 defensive-patterns.md 里「Dispose must reach quiescence」那一条。
 */
function settleOpenSessionsOnDispose(args: {
  store: LessonStore;
  sessionWatch: SessionWatch;
  settingsOf: SettingsOf;
  markSettled: (sessionId: string) => boolean;
  db: LessonDb | null;
}): () => Promise<void> {
  const { store, sessionWatch, settingsOf, markSettled, db } = args;
  return async (): Promise<void> => {
    if (!settingsOf().enabled) {
      return;
    }
    // 只删不增：Map 迭代器对"删除当前项"是安全的（规范保证），无需先复制一份。
    // **串行**清算，不再 Promise.all：同一条连接上的并发整片写只会互撞 revision，
    // 多个项目桶叠加时很容易把 RULES_CAS_RETRY_LIMIT 用完；以前这里正是退出路径绕开
    // 逐桶串行约束的那一处。
    for (const [sid, entry] of sessionWatch) {
      sessionWatch.delete(sid);
      // 与 session/disposed 那条路共用同一套 exposure 去重：两个入口各判一次就会让
      // 同一条会话被两边各计一次 samples。`firstSettle` 先落成变量，不为省一行嵌套。
      const firstSettle = markSettled(sid);
      // oxlint-disable-next-line eslint/no-await-in-loop -- 见上：逐会话串行是 CAS 正确性要求
      const outcome = await settleSessionOutcome({
        store,
        db,
        sessionId: sid,
        entry,
        countExposure: firstSettle,
      });
      if (!outcome.settled) {
        // 单条清算失败只记日志：退出 disposer 必须继续把其余会话写完，不能因为
        // 一条坏会话把整棵 fiber 的卸载带炸（cordis 会 await 这个 disposer）。
        const detail =
          outcome.error === undefined ? "still has unsaved settlement" : errorText(outcome.error);
        console.error(`[lesson-loop] ${SESSION_ENDED_FAILURE_LABEL}: ${sid} ${detail}`);
      }
    }
    // 内存条目之外还可能有被容量修剪/上一条失败留下的台账行；卸载时用库侧扫描补齐。
    // 这里用零 exposure（同启动补算）：会话已经离开本进程，补 samples 会造暴露度。
    await recoverPendingLedgers(db, store);
  };
}

/**
 * 会话台账的一个项目桶（取或建）。已清算的会话不再建桶：那场会话的下一 dispose 边
 * countExposure 已是 false、pass 也进不来（recordPass 的 hasSettled 判据），新建只会把
 * 注定不会被清算的死条目塞回容量台账。
 *
 * 同一项目在会话内被再次进入时复用同一个桶（幂等），并把 `entry.project` 摆到它上面——
 * 没有桶时兜底清算读的正是"最近一次写入所在桶"。
 */
/** 在**已存在**的台账行里取/建一个项目桶。
 *  不建行：没有行说明这场会话从没被登记过（注入关掉时也只在非注入路径上预种），
 *  与 `noteViolationForSettle` 改造前"只记进已有条目、不为一条标记新建条目"的判据一致。 */
function bucketInEntry(entry: SessionWatchEntry, project: string): SessionBucket {
  entry.project = project;
  const existing = entry.buckets.get(project);
  if (existing !== undefined) {
    return existing;
  }
  const created: SessionBucket = { violated: new Set(), passed: new Set() };
  entry.buckets.set(project, created);
  return created;
}

function bucketOf(
  runtime: ApplyRuntime,
  sessionId: string | undefined,
  project: string,
): SessionBucket | null {
  if (sessionId === undefined) {
    return null;
  }
  const { sessionWatch, pruneWatch, hasSettled } = runtime;
  const entry = sessionWatch.get(sessionId);
  if (entry === undefined) {
    if (hasSettled(sessionId)) {
      return null;
    }
    const bucket: SessionBucket = { violated: new Set(), passed: new Set() };
    sessionWatch.set(sessionId, { buckets: new Map([[project, bucket]]), project });
    pruneWatch();
    return bucket;
  }
  return bucketInEntry(entry, project);
}

/**
 * 注入对账与落笔：幂等、可重入，并在会话换目录、压缩之后重做。
 *
 * **为什么不再是一次性 append**：`agent.inject` 没有任何"已提交状态"，而同一场会话会被
 * 重新进入，模型可见面也会被改写。旧写法在这三处各自出错：
 *  1. resume 时 `agent/created` 照发（source='resume'），已提交的注入作为 `user/message`
 *     留在日志里，于是同一段摘要被注入第二遍；
 *  2. 压缩把那条 `user/message` 折进摘要（compaction 的保留区只护 surface 头部的
 *     `system/message`，packages/compaction/compaction-basic/src/region.ts:111-112 与 :351），
 *     而本包没有压缩后的补回路径，规则从上下文里消失；
 *  3. 进工作树后 `header.cwd` 仍是原始项目，注入的仍是原项目的规则桶。
 *
 * 解法照宿主自己的动态上下文投影（packages/core/agent-loop/src/runtime-context.ts:44-56）：
 * 扫历史找自己那条、拿 `session.surface.nodes` 判它还在不在面上、内容相同就不再发。
 * 三个触发点（`agent/created`、`workspace-root/change`、`compaction/end`）走同一个函数，
 * 因此彼此幂等。
 */
async function ensureInjection(runtime: ApplyRuntime, agent: StartAgent): Promise<void> {
  const { svc, store, settingsOf, localeMessages } = runtime;
  try {
    const cfg = settingsOf();
    if (!cfg.enabled) {
      return;
    }
    const { session } = agent;
    if (session === undefined) {
      return;
    }
    const sid = typeof session.id === "string" ? session.id : undefined;
    const { header } = session;
    if (!cfg.injectEnabled) {
      // 只预种台账，不读事件流：注入关掉时"当前目录"无从得知，按 header 的原始项目记账
      // 与改造前同口径；收尾清算照旧按项目计 exposure。
      bucketOf(runtime, sid, deriveProject(header?.cwd));
      return;
    }
    // 根会话判定（ctx-observe isRootSession 同款：delegationDepth>0 或 origin==='subagent' 非根）。
    if (
      header &&
      ((typeof header.delegationDepth === "number" && header.delegationDepth > 0) ||
        header.origin === "subagent")
    ) {
      return;
    }
    // 事件流一次读、两处用：折当前目录（归因）与找本包上一份摘要（对账）。
    const events = await observeSessionEvents(svc, session);
    const project = deriveProject(foldCwd(header?.cwd, events));
    // 台账按桶记：本次归因的项目在场过，收尾清算就该按它计 exposure/suppressed。
    // **这一笔先于下面的 inject 面守卫**：没有 inject 的 agent（半装配替身/别的宿主形态）
    // 也照样有一场会话在这个项目里在场过，漏记就等于少一次 exposure。
    bucketOf(runtime, sid, project);
    if (typeof agent.inject !== "function") {
      return;
    }
    const messages = localeMessages();
    // 规则库只读一次：帧与日志都要这份选取，两次 store.rules() 会各跑一遍 provider
    // describe + 逐行归一。
    const allRules = store.rules();
    const armedCount = armedRulesOf(allRules, project).length;
    const digest = renderRulesDigest(allRules, project, messages, cfg.maxInjectedRules);
    if (digest === null) {
      // 本项目没有 armed 规则：零噪音，不注入空块。上一份（别的项目桶的）摘要留在面上
      // 不动——它描述的是本会话真实发生过的注入，而"换成什么都没有"的新块只会多一段噪音。
      return;
    }
    const prior = priorDigestOf(session, events);
    // 三种状态各自对应一份"本次该写的正文"，判重必须把两种历史形态都认掉：
    //  · 首次注入：日志里没有本包的块 → 裸 digest；
    //  · 再次触发（换项目/规则变了）：旧块还在面上或已折进摘要 → 带前缀，说明"这份替换
    //    先前那份"；
    //  · 什么都没变：面上那份**就是**本次要写的东西 → 跳过。
    //
    // 第三种的判据要同时接受两种正文：嵌入日志的既可能是裸 digest（首次写的那份），也
    // 可能是带前缀的版本（后来替换过的）。只比其中一种，另一种就会被判成"变了"，于是
    // 每个触发点（agent/created、workspace-root/change、compaction/end）都追加一份新副本。
    const replacement = `${messages.digestReplacesEarlier}\n\n${digest}`;
    if (prior.retained === digest || prior.retained === replacement) {
      console.info(
        `[lesson-loop] armed rules for project ${project} unchanged — skipping duplicate injection`,
      );
      return;
    }
    const text = prior.logged ? replacement : digest;
    // inject 属于 Agent 面（core/agent runtime-types：排入最近一个 pre-step 的
    // 模型侧上下文，不唤醒 driver）；Session 没有这个方法。
    // form:'instructions'（packages/llm/llm/src/message.ts 的 ContextForm）显式声明
    // 这段上下文的语义是"模型要遵守的指令"；其中不可信的规则正文已在
    // renderRulesDigest 内逐行定界，帧结构符只可能由本插件产生。
    agent.inject({
      // 载荷就此受官方 `UserMessage` 约束（`Agent["inject"](message: UserMessage)`，
      // installed @deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts）：`id` 是带 `brand` 标记的
      // `MessageId`，只能由官方 `brandString` 送出；`source.kind` 由 lib/prompt.ts 那条
      // producer 声明进 `MessageSourceMap`，`form` 是本包自有的上下文语义位。
      id: brandString<MessageId>(`${PLUGIN_NAME}-${randomUUID()}`),
      role: "user",
      content: [{ type: "text", text }],
      source: { kind: LESSON_SOURCE_KIND, form: "instructions" },
    });
    // 计数取自 armedRulesOf 的同一次选取，不从帧的行数推：帧尾可能多一行"另有更早的未列出"。
    const shown =
      cfg.maxInjectedRules > 0 ? Math.min(armedCount, cfg.maxInjectedRules) : armedCount;
    console.info(
      `[lesson-loop] injected ${shown} of ${armedCount} armed rule(s) for project ${project}${prior.logged ? " (replaces earlier digest)" : ""}`,
    );
  } catch (error) {
    console.error(`[lesson-loop] rule injection failed: ${errorText(error)}`);
  }
}

/**
 * 把一次注入排进该会话的串行链。
 *
 * 为什么需要串行：三个触发点可能在同一 tick 相遇（换目录与压缩都发生在回合内），
 * 而对账读的是**已提交**日志——两条并发链会各自判定"还没注入"而各注一遍。同会话的上一次
 * 注入没跑完之前，后一次排队等它（它跑完后日志里已经有那条 `user/message`，后一次据此
 * 判重）。
 *
 * 交回 Promise：`agent/created` 的监听器返回它，宿主是 `await ctx.serial(...)` 派发
 * （packages/core/agent/src/index.ts:562-582），因此注入仍发生在首个回合之前。
 */
async function queueInjection(
  runtime: ApplyRuntime,
  sessionId: string | undefined,
  agent: StartAgent,
): Promise<void> {
  if (sessionId === undefined) {
    // 没有 id 就没有对账所需的日志读口，直接走一次性路径（ensureInjection 自己吞错）。
    await ensureInjection(runtime, agent);
    return;
  }
  const { injectionChains } = runtime;
  const previous = injectionChains.get(sessionId) ?? Promise.resolve();
  const holder: { tail?: Promise<void> } = {};
  const next = (async (): Promise<void> => {
    await previous;
    await ensureInjection(runtime, agent);
    if (injectionChains.get(sessionId) === holder.tail) {
      injectionChains.delete(sessionId);
    }
  })();
  holder.tail = next;
  injectionChains.set(sessionId, next);
  await next;
}

// ── apply 的模块级受控 helper ─────────────────────────────────────────────
// apply 是 cordis 插件的装配入口：把它切成"一段职责一个函数"之后，各段仍在 apply 里
// **按原次序**串起来——效应注册次序就是宿主观测到的注册次序（见 test/host.test.ts 里
// 按 `effects.at(-2)/at(-1)` 认 decay 与路由 disposer 的那两条断言），拆并不得改变它。

/** lessonLoop 服务的上报入参（报告方经 `ctx.get('lessonLoop').report()` 递来的原样）。 */
interface LessonReportInput {
  source: LessonSource;
  category: string;
  cwd?: unknown;
  sessionId?: string;
  turn?: number;
  signature: string;
  detail: string;
  evidence?: Record<string, unknown>;
}

/** lessonLoop 服务的 pass 入参：只到"场景被触发且遵守"这一格，不带正文。 */
interface LessonPassInput {
  category: string;
  cwd?: unknown;
  sessionId?: string;
  signature: string;
}

/**
 * 对外宿主服务（danger-guard / quality-gate / session-rescue 经 ctx.get 消费）。
 * 名字与成员逐个照旧：这份类型是 sibling 插件的调用契约，改一位就等于改它们的运行时。
 */
interface LessonLoopService {
  /** 记一条教训。全同步、容错：总线任何故障不外抛（报告方多在守卫热路径上）。 */
  report: (input: LessonReportInput) => Promise<ReportReceipt>;
  /** pass 信号：规则场景被触发且被遵守（如 danger-guard fact-gate
   *  通过）。登记到会话台账，session/disposed 清算时该规则才计 suppressed——
   *  无关会话不再灌水。仅 armed 规则消费。 */
  pass: (input: LessonPassInput) => { ok: boolean };
  rules: () => RuleCard[];
  ruleAction: (id: string, action: RuleActionKind, statement?: string) => Promise<RuleActionResult>;
  recentLessons: (project?: string, limit?: number) => LessonRecord[];
  stats: () => Record<string, unknown>;
}

/**
 * apply 各段共用的运行期：一次装载构造一份，按引用传下去。
 * `sessionWatch` 是 Map（原地增删）、`store` 是实例，故装箱不需要 `{ value }` 那一层——
 * 各处读写的一直是同一份。
 */
interface ApplyRuntime {
  svc: HostCtx;
  store: LessonStore;
  /** SQLite 端口（打开失败时为 null：规则库回退设置端口、流水回退 JSONL、台账不落库）。 */
  db: LessonDb | null;
  settingsOf: SettingsOf;
  localeMessages: MessagesOf;
  sessionWatch: SessionWatch;
  pruneWatch: () => void;
  /** 登记一次清算，重复会话返回 false（见 createSessionWatch）。 */
  markSettled: (sessionId: string) => boolean;
  /** 撤销清算标记：清算没写到磁盘时回滚，让 resume 出来的下一边带着全量台账重试
   *  （见 onDisposedSession）。 */
  unsettle: (sessionId: string) => void;
  /** 这条会话是否已清算；两处记录下来入口共用它决定要不要重建条目。 */
  hasSettled: (sessionId: string) => boolean;
  syncStore: () => ResolvedSettings;
  /** 每场会话的注入串行链（见 queueInjection）：上一次没跑完时后一次排队，防同一 tick
   *  的两个触发点各读一遍"未注入"的旧日志而各注一遍。 */
  injectionChains: Map<string, Promise<void>>;
}

/** 页面策略声明：本包自带卡片，别让宿主再生成一份自动表单页。
 *  0.2.1-alpha.2 里注册是**隐式**的（命名空间 = profile 条目 id，见 cordis.patch.yml），可编辑
 *  字段由 schema 的 `.volatile()` 交出，插件侧不再有 `settings.register`；只剩这一位要
 *  声明。owner 必须显式传本插件 fiber（缺省是 settings 服务自己的 fiber，传错等于给别人的
 *  页面定策略），且经 child.effect 挂载以便随注入子上下文回收——宿主 dsh-client-locale
 *  与已迁移三包同款写法。 */
function applySettingsPagePolicy(svc: HostCtx): void {
  svc.inject(["settings"], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, svc.fiber));
  });
}

/** 现读一份解析后的设置（旧 `scope.get()` 的等价物）：每次都重新取引用的当前值，所以
 *  设置卡改完下一个事件/回合即生效，不必重挂载插件。 */
function settingsSnapshot(config: Config): ResolvedSettings {
  return {
    enabled: config.enabled.get(),
    reportEnabled: config.reportEnabled.get(),
    injectEnabled: config.injectEnabled.get(),
    sectionEnabled: config.sectionEnabled.get(),
    promoteThreshold: config.promoteThreshold.get(),
    demoteThreshold: config.demoteThreshold.get(),
    demoteMinSamples: config.demoteMinSamples.get(),
    demoteRatio: config.demoteRatio.get(),
    decayDays: config.decayDays.get(),
    reviveThreshold: config.reviveThreshold.get(),
    maxLessonsBytes: config.maxLessonsBytes.get(),
    maxStatementChars: config.maxStatementChars.get(),
    // 三枚是**非 volatile** 的部署值：cordis 交进来的是值而不是引用（改值随重启生效）
    // ——带 .get() 会读到一个函数。
    digestTimeoutMs: config.digestTimeoutMs,
    decayIntervalMs: config.decayIntervalMs,
    maxInjectedRules: config.maxInjectedRules,
  };
}

/**
 * 规则库端口的"首次读即迁移"外壳：第一次 `load()` 把旧介质（patch 里的 rules 与
 * events.jsonl）搬进库，之后只是直通。迁移是同步的，故读回来的这一次就已包含存量。
 */
function migrateOnFirstLoad(
  db: LessonDb,
  legacy: RulesRepository | null,
  eventsFile: string,
  isActive: () => boolean,
): RulesRepository {
  let migrated = false;
  return {
    load: () => {
      // 只在条目 ACTIVE 之后才碰旧设置端口：真实宿主在 apply 期间 describe() 投不出本行，
      // 那一刻读只会多一次 PENDING 采样（装载时序用例钉着"非 ACTIVE 不读"）。
      if (!migrated && isActive()) {
        migrated = true;
        migrateToDb({ db, legacy, eventsFile });
      }
      return db.rules.load();
    },
    // 第三参必须转发：`onPersisted` 是"规则计数与台账落定同事务提交"的唯一通道，
    // 在这里丢掉它，会话清算就退回"先提交规则、再单独打台账"的两段式，中间崩溃会让
    // 同一笔 suppressed 在下次开机被补算一遍。
    save: (cards, revision, onPersisted) => db.rules.save(cards, revision, onPersisted),
  };
}

/** 建总线与规则引擎：装载期一次性取阈值给构造器，之后每次 report/decay 前都会 syncStore
 *  现读，改动不必重启。 */
function buildLessonStore(
  svc: HostCtx,
  settingsOf: SettingsOf,
  localeMessages: MessagesOf,
  legacy: RulesRepository,
): { store: LessonStore; db: LessonDb | null; legacy: RulesRepository } {
  const boot = settingsOf();
  // 规则库与流水的**主介质**：`$DSH_HOME/data/lesson-loop/lesson-loop.db`。data 而不是
  // cache：规则是用户工作（丢了就丢判断），流水是派生物但同一库更好备份。
  const db = LessonDb.open({ path: dshPath("data", PLUGIN_NAME, LESSON_DB_FILE) });
  // 旧规则数组只作迁移来源：schema 已摘除该字段，运行期不再从设置段读规则。
  // 库侧迁移**懒触发**：第一次读规则库时同步搬（`legacy.load()` 是同步快照、SQLite 写
  // 也是同步的）。不在 apply 里搬：真实宿主此刻条目还没 ACTIVE，describe() 看不到本行，
  // 搬了也是空跑，还平白多一次 PENDING 读（装载时序用例钉的正是那一格）。
  const rulesRepo =
    db === null
      ? null
      : migrateOnFirstLoad(db, legacy, cacheFile(EVENTS_FILE_NAME), () =>
          isFiberActive(svc.fiber.state),
        );
  const store = new LessonStore({
    // 事件流水：库可用时走 SQLite；否则退回官方 cache 目录的 JSONL。
    lessonsFile: cacheFile(EVENTS_FILE_NAME),
    ...(db === null ? {} : { lessons: db.lessons }),
    // 规则库：只走 SQLite。库打不开时规则读空写拒（设置卡开关照常工作），
    // 不再回退设置段——那条路正是这次要退役的。
    rules: rulesRepo ?? createRulesRepository(null),
    // 起草规则卡正文用的模板表：给取用入口而非当下那份，换语言即刻生效（不重启）。
    messages: localeMessages,
    maxLessonsBytes: boot.maxLessonsBytes,
    maxStatementChars: boot.maxStatementChars,
    promoteThreshold: boot.promoteThreshold,
    demoteThreshold: boot.demoteThreshold,
    demoteMinSamples: boot.demoteMinSamples,
    demoteRatio: boot.demoteRatio,
    decayDays: boot.decayDays,
    reviveThreshold: boot.reviveThreshold,
  });
  return { store, db, legacy };
}

/** 装载期一次性迁移：provider 写是异步的，apply 是同步契约 → 起一条链按旧顺序跑
 *  （先收签名碎片、再重算 project 键），两个 helper 各自 catch，故链上不会 reject。
 *
 *  ⚠ 必须先 `fiber.await()` 等本条目 settle 再读规则库：真实 `settings.describe()` 只投影
 *  `entry.fiber.state === ACTIVE` 的条目（packages/settings/settings/src/index.ts:305-306），
 *  而 apply 跑在自己那条 fiber 变 ACTIVE **之前**（vendor/cordis/src/fiber.ts 的状态机：`_execute`
 *  结算后才 `_updateState`）。在 apply 里同步读的后果不是报错而是**静默地什么也没做**：describe()
 *  投不出本条目 → 端口判 unusable（lib/rules-namespace.ts 的 load）→ commit 不写
 *  （lib/lesson-store.ts 的 commit）→ 存量碎片永不归并、project 键永不归一，而日志一声不响。
 *  `fiber.await()` 等的正是这条边界（vendor/cordis/src/fiber.ts:698-710，装载错误会在这
 *  里重抛，故失败装载直接收手——那种情况下本条目根本没有规则库可迁）。 */
function startBootMigrations(
  svc: HostCtx,
  store: LessonStore,
  db: LessonDb | null,
  legacy: RulesRepository | null,
  settingsOf: SettingsOf,
): void {
  void (async (): Promise<void> => {
    try {
      await svc.fiber.await();
    } catch {
      // 装载失败（config 校验错/启动错）：本条目不会 ACTIVE，也没有规则库可迁。
      // 错误本身已由 cordis 记进日志，这里只收手，不重复报一遍。
      return;
    }
    // 先搬旧介质（patch 里的 rules 与 events.jsonl），再做签名/project 归并——
    // 那两条归并都经 store 的端口，端口此时已经指向库里那份数据。
    if (db !== null) {
      migrateToDb({ db, legacy, eventsFile: cacheFile(EVENTS_FILE_NAME) });
    }
    await runFragmentMigration(store);
    await runProjectKeyMigration(store);
    // 最后补算旧会话：迁移/归并可能改写规则卡，先让规则库稳定，再按台账补 suppressed。
    // 插件关闭时不清算（与事件路径同一约束），pending 留给下次开机。
    if (settingsOf().enabled) {
      await recoverPendingLedgers(db, store);
    }
  })();
}

/** 会话台账 + 它的容量修剪。
 *  sessionId → {buckets, project}：会话内复发/遵守记录下来，session/disposed 时每个项目桶
 *  各自清算 suppressed 与 exposure。容量纪律同 ctx-observe（超 200 丢最旧，防长驻进程无界）。 */
function createSessionWatch(): {
  sessionWatch: SessionWatch;
  pruneWatch: () => void;
  hasSettled: (sessionId: string) => boolean;
  markSettled: (sessionId: string) => boolean;
  unsettle: (sessionId: string) => void;
  injectionChains: Map<string, Promise<void>>;
} {
  const sessionWatch: SessionWatch = new Map();
  /** 注入串行链（见 queueInjection）：跑完即删，上限自然跟着台账的会话数。 */
  const injectionChains = new Map<string, Promise<void>>();
  /**
   * 每次插入后调用：超出上限时按插入序把多出的几条丢掉。
   *
   * 不用「取最旧一条 + 跳过本会话」的写法：Map.set 对已存在的键保持原位，而每次
   * 插入后都会立刻回到 ≤ 上限，故能走到这里的调用一定是"新键排在末位"——按插入序
   * 丢的就是别的会话，永远丢不到刚被触碰的这条。留着那个 keepId 判断只会是一块
   * 不可达、测不到的死分支（同下面不写 while 的理由）。
   */
  const pruneWatch = (): void => {
    const overflow = sessionWatch.size - WATCH_MAX_SESSIONS;
    if (overflow <= 0) {
      return;
    }
    for (const key of [...sessionWatch.keys()].slice(0, overflow)) {
      sessionWatch.delete(key);
    }
  };
  /**
   * 已经清算过的 durable session。
   *
   * 为什么需要：`session/disposed` 是**每次 store 条目生命周期**各发一次，不是每个 durable
   * 会话一次——`dsh-session` 的 detach 实现按 entry 发（`enter` → `announce` → `detach`
   * 一轮一条），而同一 durable 会话每被 resume 一次就重走一轮。只按 disposed 边数清算，
   * samples 数出来的是"重开过几次"，而它的语义是"这条规则在场几场会话"。
   *
   * 容量与台账同一种做法：超上限丢最旧，防长驻进程无界。一个可观测的后果是：被丢出集合的
   * 已清算会话若再次 dispose，会被当成"首个边"重新计一次 exposure——这是有界内存换来的
   * 已知取舍（test/host.test.ts 钉着同一句话），不是无界正确性的缺陷。
   */
  const settledSessions: SettledSessions = new Map();
  return {
    sessionWatch,
    pruneWatch,
    injectionChains,
    /**
     * 这条会话是否已经清算过。两个写入处（违规记录下来与 pass 记录下来）都要先问它：
     * 会话已清算时任何一侧单独重建条目，那个条目都要留到进程退出才清算，等于把一场
     * 已结束的会话再算一次。
     */
    hasSettled: (sessionId: string): boolean => settledSessions.has(sessionId),
    /** 撤销清算标记（清算没写到磁盘时的回滚，见 onDisposedSession）：下一 dispose 边
     *  重新按"首个边"清算。 */
    unsettle: (sessionId: string): void => {
      settledSessions.delete(sessionId);
    },
    /**
     * 登记一次清算；首次返回 `true`（该清算），重复返回 `false`（跳过）。
     */
    markSettled: (sessionId: string): boolean => {
      if (settledSessions.has(sessionId)) {
        return false;
      }
      settledSessions.set(sessionId, true);
      const overflow = settledSessions.size - WATCH_MAX_SESSIONS;
      if (overflow > 0) {
        for (const key of [...settledSessions.keys()].slice(0, overflow)) {
          settledSessions.delete(key);
        }
      }
      return true;
    },
  };
}

/** settings → store 的阈值同步（pull：每次 report/decay 前执行）。 */
function syncStoreFrom(store: LessonStore, settingsOf: SettingsOf): ResolvedSettings {
  const cfg = settingsOf();
  store.configure({
    promoteThreshold: cfg.promoteThreshold,
    demoteThreshold: cfg.demoteThreshold,
    demoteMinSamples: cfg.demoteMinSamples,
    demoteRatio: cfg.demoteRatio,
    decayDays: cfg.decayDays,
    reviveThreshold: cfg.reviveThreshold,
    maxLessonsBytes: cfg.maxLessonsBytes,
    maxStatementChars: cfg.maxStatementChars,
  });
  return cfg;
}

/**
 * 把这次命中的 armed 规则记进会内台账，供收尾清算判"本会话违规过"。
 *
 * 条目已被清算时**不重建**（与 recordPass 的 hasSettled 判据同源）：那说明会话在 report
 * 的 await 期间结束了。重建出来的条目要等到进程退出才清算，等于把一场已结束的会话又算
 * 一次 exposure。违规计数本身已在 `store.report` 里落定，这里丢掉的只是"本会话违规过"
 * 这条标记（它在收尾清算里只作排除用，不另计任何数）。
 */
function noteViolationForSettle(
  runtime: ApplyRuntime,
  sessionId: string | undefined,
  project: string,
  ruleId: string | undefined,
): void {
  if (sessionId === undefined || ruleId === undefined) {
    return;
  }
  if (runtime.hasSettled(sessionId)) {
    return;
  }
  const entry = runtime.sessionWatch.get(sessionId);
  if (entry !== undefined) {
    // 上报的归因是**上报方给的 cwd**（当前工作目录，见 reportLesson），与注入同一口径：
    // 工作树里命中规则就该记进工作树那个桶，收尾时两边的 violated 才与各自的 armed 集对得上。
    bucketInEntry(entry, project).violated.add(ruleId);
  }
  // 写穿透：台账也进库（崩溃/重启后 `pendingLedger` 能把这笔补算回来）。内存条目可能
  // 因容量修剪缺席，库是唯一不漏记的地方。
  runtime.db?.noteLedger(sessionId, project, "violated", ruleId);
}

/** 记一条教训。全同步、容错：总线任何故障不外抛（报告方多在守卫热路径上）。 */
async function reportLesson(
  runtime: ApplyRuntime,
  input: LessonReportInput,
): Promise<ReportReceipt> {
  const { store, syncStore } = runtime;
  try {
    const cfg = syncStore();
    if (!cfg.enabled || !cfg.reportEnabled) {
      return { ok: false, reason: "disabled" };
    }
    const project = deriveProject(input.cwd);
    const receipt = await store.report({
      ts: Date.now(),
      source: input.source,
      category: input.category,
      project,
      ...(input.cwd !== undefined && typeof input.cwd === "string" ? { cwd: input.cwd } : {}),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.turn === undefined ? {} : { turn: input.turn }),
      signature: input.signature,
      detail: input.detail,
      ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
    });
    noteViolationForSettle(runtime, input.sessionId, project, receipt.violationOf?.id);
    if (receipt.violationOf !== undefined) {
      // 日志要能分辨"哪一条命令、哪一类命中"。规则正文是**同一张卡共用**的长文案，
      // 截断后每条都一模一样，读日志的人分不出这是 74 次里的哪一次；真正区分它们的是
      // 这一条上报的原始签名（卡片上的签名是折叠后的稳定键，同键的每条都一样）。
      // 原始签名可能内嵌路径/命令参数，日志里截到 64 字符——完整原文本就按设计落在
      // 事件流水与证据里，日志只留辨认所需的头部。
      const rawText =
        input.signature.length > 64 ? `${input.signature.slice(0, 64)}…` : input.signature;
      const rawSignature =
        input.signature === receipt.violationOf.signature ? "" : ` raw=${rawText}`;
      console.warn(
        `[lesson-loop] armed rule violated: ${receipt.violationOf.category} / ${receipt.violationOf.signature}（violation=${receipt.violationOf.violation}${rawSignature}）`,
      );
    } else if (receipt.candidate !== undefined && receipt.justReady === true) {
      // 边沿而不是电平：越过阈值之后的上报不再重复说同一句话。
      console.info(
        `[lesson-loop] candidate ready for review: ${receipt.candidate.category} / ${receipt.candidate.signature}（occurrences=${receipt.candidate.occurrences}）`,
      );
    }
    return receipt;
  } catch (error) {
    console.error(`[lesson-loop] report failed: ${errorText(error)}`);
    return { ok: false, reason: "error" };
  }
}

/** pass 信号：规则场景被触发且被遵守（如 danger-guard fact-gate
 *  通过）。登记到会话台账，session/disposed 清算时该规则才计 suppressed——
 *  无关会话不再灌水。仅 armed 规则消费。 */
function recordPass(runtime: ApplyRuntime, input: LessonPassInput): { ok: boolean } {
  const { store, syncStore } = runtime;
  try {
    const cfg = syncStore();
    if (!cfg.enabled) {
      return { ok: false };
    }
    const project = deriveProject(input.cwd);
    const rule = store.pass(project, input.category, input.signature);
    if (rule === undefined) {
      return { ok: true };
    }
    if (input.sessionId !== undefined) {
      // 已清算的会话不重建条目：那说明会话在 store.pass 之前就结束了。重建出来的条目要
      // 等到进程退出才清算，那一轮 countExposure 为 false 而 passed 非空，会给一条
      // 实际违反过的规则记一次 suppressed——分母多一个，与本次去重的目的相反。
      // 与 noteViolationForSettle 共用同一个判据（hasSettled），避免两条写入口各行其是。
      // 取舍明说：resume 出来的同一 durable 会话在宿主侧没有"复活"信号可依，它的 pass
      // 一律不计 suppressed——宁少记，不给已结束的会话补账。
      if (runtime.hasSettled(input.sessionId)) {
        return { ok: true };
      }
      // 与上报同一归因口径（pass 入参的 cwd 就是当前工作目录），按项目分桶记账：
      // 换过目录的会话在两边的桶里各记各的，收尾时不会互相覆盖。
      bucketOf(runtime, input.sessionId, project)?.passed.add(rule.id);
      runtime.db?.noteLedger(input.sessionId, project, "passed", rule.id);
    }
    return { ok: true };
  } catch (error) {
    console.error(`[lesson-loop] pass failed: ${errorText(error)}`);
    return { ok: false };
  }
}

/** 管理界面快照（/stats 的原样载荷 + 卡片副标题用的计数）。
 *  `rules` 可由调用方交进来复用：/stats 既要投影规则卡、又要这份计数，一次读取
 *  （provider describe + 逐行归一）在这条轮询路径上不该做两遍。 */
function statsSnapshot(
  runtime: ApplyRuntime,
  rules: RuleCard[] = runtime.store.rules(),
): Record<string, unknown> {
  const { store, settingsOf } = runtime;
  const cfg = settingsOf();
  return {
    rules,
    lessonsCount: store.lessonsCount(),
    undeterminableCount: rules.filter((rule) => store.isUndeterminable(rule)).length,
    config: {
      enabled: cfg.enabled,
      reportEnabled: cfg.reportEnabled,
      injectEnabled: cfg.injectEnabled,
      sectionEnabled: cfg.sectionEnabled,
      promoteThreshold: cfg.promoteThreshold,
      demoteThreshold: cfg.demoteThreshold,
      decayDays: cfg.decayDays,
      maxLessonsBytes: cfg.maxLessonsBytes,
      maxStatementChars: cfg.maxStatementChars,
      // 注入条数上限与它兜的那条缺口一起暴露：卡片读得到才知道"还有更老的规则没被注入"。
      maxInjectedRules: cfg.maxInjectedRules,
    },
  };
}

/** 装配对外宿主服务：六位里四位是 store 的直通，report/pass/stats 各走自己的 helper。 */
function createLessonLoopService(runtime: ApplyRuntime): LessonLoopService {
  const { store } = runtime;
  return {
    report: (input) => reportLesson(runtime, input),
    pass: (input) => recordPass(runtime, input),
    rules(): RuleCard[] {
      return store.rules();
    },
    async ruleAction(
      id: string,
      action: RuleActionKind,
      statement?: string,
    ): Promise<RuleActionResult> {
      // 规则库落库是异步的（CAS 写），宿主服务对外声明也是 Promise：等它真的写完再回执。
      const outcome = await store.ruleAction(id, action, statement);
      return outcome;
    },
    recentLessons(project?: string, limit?: number): LessonRecord[] {
      return store.recentLessons(project, limit ?? 0);
    },
    stats: () => statsSnapshot(runtime),
  };
}

/** 服务供给：inspector 同款（provide 返回 disposer 交 effect 托管）。
 *  provide 缺失 = 总线不可见，报告方全部静默丢报告 → 一条 error 日志点破。 */
function provideLessonLoopService(svc: HostCtx, service: LessonLoopService): void {
  svc.effect(() => {
    if (typeof svc.provide !== "function") {
      console.error(
        "[lesson-loop] ctx.provide unavailable — lessonLoop service invisible to reporters",
      );
      return noDisposer;
    }
    return svc.provide("lessonLoop", service);
  }, "lesson-loop: provide lessonLoop service");
}

/** 会话开始：预种会话台账 + 注入 armed 规则摘要（见 onSessionStart）。
 *  事件接线修正：agent/session-start 无官方派发端，
 *  预种与 armed 规则注入从未执行过 → 改用官方 agent/created（载荷 {agent,source,signal}）。 */
async function onAgentCreated(
  runtime: ApplyRuntime,
  payloadRaw: AgentCreatedPayload,
): Promise<void> {
  const { agent } = payloadRaw;
  if (agent === undefined) {
    return;
  }
  // 注入与预种台账是同一步（见 ensureInjection）。宿主是 `await ctx.serial(...)` 派发
  // `agent/created`（packages/core/agent/src/index.ts:562-582），监听器交回的 Promise 会被等，
  // 因此注入仍发生在首回合之前。
  await queueInjection(
    runtime,
    typeof agent.session?.id === "string" ? agent.session.id : undefined,
    agent,
  );
}

/** 会话收尾清算：只对本会话 pass 过且未违规的 armed 规则计 suppressed（pass 信号
 *  驱动）。与上报一样受 enabled 约束：插件关闭期间不清算。
 *
 *  按 durable session 身份去重：`session/disposed` 每条 store 条目生命周期各发一次，
 *  同一个会话每被 resume 一次就多一条边；不去重则 samples 数的是"重开过几次"。 */
function onDisposedSession(runtime: ApplyRuntime, sessionRaw: unknown): void {
  const { store, db, settingsOf, sessionWatch, pruneWatch, markSettled, unsettle } = runtime;
  if (!settingsOf().enabled) {
    return;
  }
  const idVal = fieldOf(sessionRaw, "id");
  const sid = typeof idVal === "string" ? idVal : undefined;
  if (sid === undefined) {
    return;
  }
  const firstSettle = markSettled(sid);
  const watchEntry = sessionWatch.get(sid);
  sessionWatch.delete(sid);
  // 清算回执落到"真写进了库"之后：写失败（CAS 耗尽/端口拒写/读不可信）时把清算标记
  // 与台账条目一并还原——只回滚标记不还原条目的话，resume 出来的下一边读到的是空表，
  // samples 照样永久丢失（"retry on the next session end" 的承诺只有在数据还在时才
  // 成立）。旧替身若回传 undefined（按"已落定"读），不触发回滚。
  const restoreOnFailure = (persisted: boolean | undefined): void => {
    if (persisted !== false) {
      return;
    }
    unsettle(sid);
    if (watchEntry !== undefined) {
      sessionWatch.set(sid, watchEntry);
      pruneWatch();
    }
  };
  // 事件处理器保持同步；落库的等待与失败回滚收进一只自执行的异步体（账本的
  // prefer-await-to-then 不认 then/catch 链），错误规则同 settleSession。
  void (async (): Promise<void> => {
    try {
      // 无 watch 时从 header 回填兜底项目；有 watch 时连同库台账一起合并清算。
      // 两条路都走同一个 settleSession，不再出现"watch 路径只清内存、无 watch 路径
      // 先给空集合计 exposure、再补台账"的两套语义。
      const header = fieldOf(sessionRaw, "header");
      const headerCwd = isRecord(header) ? fieldOf(header, "cwd") : undefined;
      const persisted = await settleSession({
        store,
        db,
        sessionId: sid,
        ...(watchEntry === undefined ? {} : { entry: watchEntry }),
        countExposure: firstSettle,
        fallbackProject: deriveProject(headerCwd),
      });
      restoreOnFailure(persisted);
    } catch (error) {
      // `sessionEnded` 不外抛（内部吞错）；这一层兜"将来改出抛错"的意外，并把清算标记
      // 与台账条目还原——否则异常路径和写失败路径的恢复语义会分成两套。
      restoreOnFailure(false);
      console.error(`[lesson-loop] ${SESSION_ENDED_FAILURE_LABEL}: ${errorText(error)}`);
    }
  })();
}

/**
 * 会话日志追加事件里的两处"归因/可见面变了"：
 *  - `workspace-root/change`：当前工作目录变了（宿主 `WorkingDirectoryService.set` 写的
 *    就是这条，packages/session/working-directory/src/index.ts:112），归因桶随之变，
 *    要按新桶重新注入；
 *  - `compaction/end`：压缩可能把本包注入的 `user/message` 折进摘要（保留区只护 surface
 *    头部的 `system/message`，packages/compaction/compaction-basic/src/region.ts:111-112
 *    与 :351），补回一份。
 *  Agent 面从官方 `ctx.agents`（`AgentRegistry.get(id)`，packages/core/agent/src/index.ts:
 *  591-593）取活的那个：事件载荷只给 Session，而 `inject` 只在 Agent 上。
 */
function onSessionEvent(runtime: ApplyRuntime, sessionRaw: unknown, eventRaw: unknown): void {
  const type = fieldOf(eventRaw, "type");
  if (type !== WORKSPACE_ROOT_CHANGE && type !== COMPACTION_END) {
    return;
  }
  const idVal = fieldOf(sessionRaw, "id");
  if (typeof idVal !== "string" || idVal.length === 0) {
    return;
  }
  const agentsRaw = runtime.svc.get?.("agents");
  if (!isAgentRegistry(agentsRaw)) {
    return;
  }
  const agent = agentsRaw.get(brandString<SessionId>(idVal));
  if (agent === undefined) {
    return;
  }
  // 事件处理器保持同步：起链、错误在链内吞（ensureInjection 自己 catch）。
  void queueInjection(runtime, idVal, agent);
}

/** 两枚会话事件的接线（顺序即注册顺序，与拆出前一致）。 */
function wireSessionEvents(runtime: ApplyRuntime): void {
  const { svc } = runtime;
  // 返回 Promise 由宿主 await（`agent/created` 的派发是 `await ctx.serial(...)`），
  // 注入因此仍在首回合之前落定。
  svc.on("agent/created", (payloadRaw) => onAgentCreated(runtime, payloadRaw));
  svc.on("session/disposed", (sessionRaw) => {
    onDisposedSession(runtime, sessionRaw);
  });
  svc.on("session/event", (sessionRaw, eventRaw) => {
    onSessionEvent(runtime, sessionRaw, eventRaw);
  });
}

/** 常驻 systemPrompt 段（项目无关；timer/commands 皆可选读）。
 *  开关用动态 text 而不是「注册时读一次」：section 注册在 effect 里只跑一次，
 *  读一次的写法要让设置卡改动生效必须重启。**空 text 的段不会进提示词**（`renderPrompt`
 *  仍按 `text.length > 0` 过滤，packages/core/system-prompt/src/index.ts:341-357），所以
 *  关闭时返回空串即完全不参与拼装。旧注释把出处写成 `:283` 与"被 core 丢掉"，行号与
 *  语义都已过时，这次一并改正。
 *
 *  `replacement` / `retirement` 两枚**必须由本包给**：0.2.2-rc.5 起的增量装配在段文本
 *  变化（含变空、含语言切换）时向会话追加一条 `system/message` 说明，缺省文案是写死节名的
 *  英文句（packages/core/system-prompt/src/index.ts:93-104 与 :734-745、
 *  admission.ts:117-148）。界面语言是中文时这条通知会以英文出现，故两枚都从消息表取，
 *  并在语言偏好变化时**重新注册**（只有注册时读到的两枚会随注册一起被会话捕获）。 */
function registerPromptSection(runtime: ApplyRuntime): void {
  const { svc, settingsOf, localeMessages } = runtime;
  svc.inject(["systemPrompt"], (child) => {
    child.effect(() => {
      const spRaw = child.systemPrompt;
      if (!isSystemPromptService(spRaw)) {
        return noDisposer;
      }
      const sp = spRaw;
      let disposeSection: () => void = noDisposer;
      /** 撤下当前注册、再按当前语言注册一次。同一 tick 内完成：宿主在**装配**时才比较
       *  有效文本与退役，因此文本没变的重注册不会多出一条通知。 */
      const mount = (): void => {
        disposeSection();
        const messages = localeMessages();
        disposeSection = sp.section({
          name: SECTION_NAME,
          order: SECTION_ORDER,
          replacement: messages.sectionReplacement,
          retirement: messages.sectionRetirement,
          // 总开关优先：README 承诺 enabled=false 时常驻段一并停用，故两位都要看。
          text: () => {
            const cfg = settingsOf();
            return cfg.enabled && cfg.sectionEnabled ? renderSectionText(localeMessages()) : "";
          },
        });
      };
      mount();
      // 语言偏好变了：两枚通知文案随注册被捕获，改文案只能重注册一次（text 本身每趟现取，
      // 不受影响）。这条监听与上面 localeMessages 的缓存失效是两条独立接线，注册顺序上
      // 缓存失效在前，故这里读到的已是新语言。
      //
      // 挂在 `child` 上而不是 `svc` 上，并把 disposer 一并交回 effect：`ctx.on` 的
      // listener 归**注册它的那个 fiber** 所有（vendor/cordis/src/events.ts:296-315），
      // 挂在父 svc 上时它只随整棵插件树销毁才消失——而 effect 工厂在这条 inject 子 fiber
      // 重建时会再跑一遍，旧闭包持有旧的 `sp` 与旧的 `disposeSection`，于是同一个事件
      // 被 N 份旧监听处理（每份都对着已撤下的段重注册）。
      const off = child.on("settings/document-updated", (ns: unknown) => {
        if (ns === LOCALE_SETTINGS_NAMESPACE) {
          mount();
        }
      });
      return () => {
        off();
        disposeSection();
      };
    }, "lesson-loop: systemPrompt section");
  });
}

/** 衰减一轮：阈值现读 + 跑 decay；失败只记日志（一轮炸了不许带走后面的轮次）。
 *  总关闭期间跳过：关闭状态下不该产生"自动降级并写库"这类持久化副作用（定时器
 *  照排、跑空一轮，重新打开后下一轮恢复裁决）。 */
async function decayOnce(runtime: ApplyRuntime): Promise<void> {
  const { store, syncStore } = runtime;
  try {
    const cfg = syncStore();
    if (!cfg.enabled) {
      return;
    }
    await store.runDecay();
  } catch (error) {
    console.error(`[lesson-loop] decay failed: ${errorText(error)}`);
  }
}

/** 周期衰减：apply 时立即跑一次，此后每 `decayIntervalMs`（部署值，默认 24h）一轮
 *  （timer 可选读；服务晚于本条目到位是常态——兄弟条目装载次序/热插拔——effect 里
 *  get 一次只能看见"此刻"，故走 inject 让宿主在服务就绪时回调，与
 *  applySettingsPagePolicy 同款）。 */
function registerDecayTimer(runtime: ApplyRuntime): void {
  const { svc, settingsOf } = runtime;
  svc.inject(["timer"], (child) => {
    child.effect(() => {
      const timerRaw = child.timer;
      if (!isTimerService(timerRaw)) {
        return noDisposer;
      }
      const timer = timerRaw;
      // 非 volatile 的部署值：装载期读一次即可（改值随重启生效），故不进 tick 现读。
      const intervalMs = settingsOf().decayIntervalMs;
      let stopped = false;
      let last: TimerDisposer | undefined;
      // 在飞的那轮衰减：disposer 要等它落定（见下方 disposer 注释）。
      let inflight: Promise<void> | undefined;
      // 退出位只经这个读口读：直接读 `stopped` 时，类型检查把它收窄成字面量 `false`
      // （赋值发生在另一个闭包里，tsc 看不见），`if (stopped)` 会被判成永远不成立的分支；
      // 经函数返回的 `boolean` 不再收窄，判据才真的是运行期的值。
      const isStopped = (): boolean => stopped;
      // 排下一轮而不是在起点就排：`runDecay` 要跨 provider 写到磁盘，耗时可能超过间隔。
      // 固定间隔重排会让两轮衰减重叠（两笔整片写互相撞 revision），改成上一轮结算后
      // 再武装。自引用只在**调度那一刻**发生：`arm` 先跑完这一轮，再判退出位并武装下一轮。
      // 这样"上一轮结算后才排下一轮"写在同一个函数里，读的人不必跨两处拼次序。
      const arm = async (): Promise<void> => {
        // 入口也读一次退出位：timer 回调已入队、disposer 先置位时，这一轮不该再起——
        // 它会跨 provider 整片写盘，与退出清算的 CAS 写并发，输方按失败上报。
        if (isStopped()) {
          return;
        }
        const round = decayOnce(runtime);
        inflight = round;
        await round;
        // 这轮衰减等待期间 disposer 可能已置位。
        if (isStopped()) {
          return;
        }
        last = timer.timeout(() => {
          void arm();
        }, intervalMs);
      };
      // 装载期那一轮也走 arm：它与后续每一轮共用同一条"结算后再排"的次序。
      void arm();
      // Dispose must reach quiescence（本文件 settleOpenSessionsOnDispose 同一纪律）：
      // 卸载不等同步 disposer 里的异步任务，在飞的 runDecay（跨 provider 整片 CAS 写）
      // 必须在这里等完——否则卸载完成后幽灵写才落地（降级在卸载后才生效），或与卸载
      // 清算的写互撞 revision。decayOnce 内部自捕错误，await 不会 reject。
      return async () => {
        stopped = true;
        last?.();
        await inflight;
      };
    }, "lesson-loop: decay timer");
  });
}

export function apply(ctx: Context, config: Config): void {
  // 契约守卫收窄（不写断言）：宿主 ctx 必满足 HostCtx 结构，否则属集成错误急停。
  if (!isHostCtx(ctx)) {
    throw new Error("[lesson-loop] host context contract violated");
  }
  const svc: HostCtx = ctx;

  // 0. 单实例锁：market 的热挂子树（`mkt-*`，走 `file://…/host.js`）与 profile 的 bundle 层
  //    解析到同一份模块，却各起一个 fiber、各跑一次 apply。第二份若照常装配，prompt 段落、
  //    Remote 服务、事件监听与衰减定时器都会各挂一份——判定与写库都会跑两遍，且这种重复
  //    **不抛错**。让路的那一份不提供任何东西，功能由先到的那一份承担。
  if (
    !claimInstance(
      { get: (name: string): unknown => svc.get?.(name), reflect: svc.reflect },
      "@jayyuen66/dsh-lesson-loop/instance",
    )
  ) {
    console.warn(
      "[lesson-loop] 检测到本插件已在同一作用域内装载：本次装配让路，规则库与注入由在册的那一份提供。",
    );
    return;
  }

  // 命名空间与可编辑字段都是隐式的（宿主从条目 Config 反推，见 cordis.patch.yml），
  // apply 只声明页面策略那一位。
  applySettingsPagePolicy(svc);

  // 每次现读引用当前值：设置卡改完下一个事件/回合即生效，不必重挂载插件。
  const settingsOf: SettingsOf = () => settingsSnapshot(config);

  // host 侧一切文案随官方 locale 偏好走：用户在「设置 → 常规」改语言后，下一条回显/注入
  // 就是新语言（不重启、不另开本包自己的 locale 设置项）。起草新规则卡的 statement 正文
  // 也在这条链上；条目 `rules` 里**已落库**的正文是用户数据，永不因语言切换被改写。
  // 跨命名空间读在 0.2.1-alpha.2 只有 describe() 一条路（未装 client-locale / 那条没有 volatile
  // 字段 → 宿主不投影它 → undefined → 中文默认）。返回值域按 `readonly unknown[]` 收，
  // 故字段一律经 `fieldOf` 从 unknown 读——与规则库那条链同一种做法：「读到了东西」不等于
  // 「读得懂」，读不懂就退中文默认，绝不按声明猜。
  //
  // 偏好读一次即缓存：describe() 对每个活跃条目都要 schema.toJSON() + JSON.stringify 算
  // revision 再投影三份，而 systemPrompt section 的 text 每次提示词装配都求值——那是本包
  // 频度最高的读点。失效靠宿主推送：写配置 → app-boot/config-reload → SettingsForms
  // invalidate() → 微任务里 describe() → 对 raw 变化的条目 emit('settings/document-updated')。
  let cachedPreference: unknown;
  let hasCachedPreference = false;
  svc.on("settings/document-updated", (ns: unknown) => {
    if (ns === LOCALE_SETTINGS_NAMESPACE) {
      hasCachedPreference = false;
    }
  });
  const localeMessages: MessagesOf = () => {
    // **缺席与读取失败都不缓存**：locale 条目可能晚于本条目才到位，缓存一次缺席/失败
    // 就把语言跟随永久钉死（test 钉着"条目迟到时每趟都重读"这条保证）。代价明说：
    // 缺席的 profile——最常见的默认情形——每趟都付一次 describe()；那是有意的取舍，
    // 不用三态缓存换（宿主对静默新增条目是否 emit 失效事件没有本仓判据）。
    // describe() 抛错（provider 半装配、文档解析失败）按"这趟没读到"处理，退中文默认——
    // 可选读一律降级，不许把最坏情况炸进提示词装配/命令注册（rules-namespace 的 load 同款）。
    if (!hasCachedPreference) {
      try {
        const row = svc.settings
          .describe()
          .find((item) => fieldOf(item, "ns") === LOCALE_SETTINGS_NAMESPACE);
        if (row !== undefined) {
          cachedPreference = fieldOf(row, "value");
          hasCachedPreference = true;
        }
      } catch {
        // 这趟没读到：下次再试（不缓存失败态）。
      }
    }
    // 偏好已注册（装且投影出了 client-locale 那条）→ 设置优先。
    if (hasCachedPreference) {
      return messagesFor(MESSAGES, resolveLocalePreference(cachedPreference));
    }
    // 偏好未注册 → 中文默认。卡片改走 Remote 之后没有浏览器请求头可依，旧 HTTP 接口那条
    // Accept-Language 协商不再有调用点。
    return messagesFor(MESSAGES, DEFAULT_LOCALE);
  };

  const { store, db, legacy } = buildLessonStore(
    svc,
    settingsOf,
    localeMessages,
    legacyRulesFromConfig(config),
  );

  startBootMigrations(svc, store, db, legacy, settingsOf);

  // sessionId → 台账：会话内复发记录，session/disposed 时清算 suppressed。
  const { sessionWatch, pruneWatch, markSettled, unsettle, hasSettled, injectionChains } =
    createSessionWatch();

  // settings → store 的阈值同步（pull：每次 report/decay 前执行）。
  const syncStore = (): ResolvedSettings => syncStoreFrom(store, settingsOf);

  // 各段共用的运行期：一次装载构造一份，按引用往下传（Map/store 原地读写，不必再装箱）。
  const runtime: ApplyRuntime = {
    svc,
    store,
    db,
    settingsOf,
    localeMessages,
    sessionWatch,
    pruneWatch,
    markSettled,
    unsettle,
    injectionChains,
    hasSettled,
    syncStore,
  };

  /** 对外宿主服务（danger-guard / quality-gate / session-rescue 经 ctx.get 消费）。 */
  const service = createLessonLoopService(runtime);

  provideLessonLoopService(svc, service);

  // 会话事件接线：agent/created → 预种台账 + armed 规则注入；session/disposed → 收尾清算。
  wireSessionEvents(runtime);

  // 退出/热卸载兜底清算：headless 与 CLI 进程里 session/disposed 往往来不及送达，
  // 只挂事件的收尾在这些进程恒不执行（度量因此恒 0、规则永远不可判定）。
  //
  // **连接关闭并进这一条释放器，而不是另挂一条 effect**：`DatabaseSync` 持有文件句柄与
  // WAL 的 -shm 映射，插件热重载/卸载不关掉就一直留在库里（旧连接的读快照拖住新实例的写，
  // 卸载后句柄也漏）。但关连接必须发生在清算**之后**——反过来的话最后一次清算会对着已关闭
  // 的库写，每笔都被 `rules write refused: database is closed` 拒掉，度量直接丢。
  // 两条独立 effect 的先后要靠 cordis 的逆序 dispose 保证（vendor/cordis/src/fiber.ts:459），
  // 那是真的，可它只在 fiber 卸载那一条路径上成立：任何直接调用释放器的地方（测试、
  // 手工拆纤）都拿不到这个保证。放进同一条释放器里用 `finally` 收尾，顺序就与调用方无关。
  svc.effect(() => {
    const settle = settleOpenSessionsOnDispose({
      store,
      sessionWatch,
      settingsOf,
      markSettled,
      db,
    });
    return async () => {
      try {
        await settle();
      } finally {
        db?.close();
      }
    };
  }, "lesson-loop: 退出清算");

  // 常驻 systemPrompt 段（项目无关；timer/commands 皆可选读）。
  registerPromptSection(runtime);

  // /lessons-digest 命令（人工触发蒸馏；commands 服务可选读——缺失只 warn 一次）。
  registerDigestCommand(svc, store, settingsOf, localeMessages);

  // 周期衰减：apply 时立即跑一次，此后每 `decayIntervalMs`（部署值，默认 24h）一轮
  // （timer 可选读；缺失退化为主管人工）。
  registerDecayTimer(runtime);

  // 设置卡的规则读取接口（官方 Typert Remote）：构造即注册到本插件 fiber 上，四个方法由
  // 官方网关暴露给本 profile 的客户端。它不依赖任何可选宿主服务（store 与快照取用入口都在
  // 这里），故无条件上线——旧 HTTP 接口那个等 webServer 到位的子 fiber 不再存在。
  installRulesRemote(ctx, {
    store,
    stats: (rules) => statsSnapshot(runtime, rules),
    messagesOf: localeMessages,
    pageSize: () => config.evidencePageSize.get(),
  });
}

export default {
  inject: ["settings"],
  // 入口键必须是 `Config`（cordis registry 只认这个键；写成 ConfigSchema 时校验静默失效）。
  Config: configSchema,
  apply,
};
