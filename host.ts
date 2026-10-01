// lesson-loop host 半：自进化闭环的总线与规则引擎。
//
// 五段闭环（设计定稿："一切皆插件"，不动 dsh 核心）：
//   观察 —— danger-guard / quality-gate / session-rescue（以及任何第三方插件）经
//           ctx.get('lessonLoop') 上报（可选读：总线缺失只丢报告，绝不拖垮报告方）；
//   沉淀 —— 事件流水落 **官方 cache 目录** dshCachePath('lesson-loop','events.jsonl')
//           （单写者追加）；规则卡库存本条目设置命名空间 `lesson-loop` 的 `rules`
//           数组字段（provider 写锁 + 逐 namespace 合并 + revision CAS，见 lib/rules-namespace.ts）；
//   提醒 —— ①常驻 systemPrompt 段（order 1560，闭环存在感）；②agent/created
//           按项目注入 armed 规则全文（agent.inject，不唤醒）；
//   升格 —— 候选卡只能人工在卡片上 arm/reject（loop-design-check 红线：人保留判断）；
//   度量 —— armed 后复发 violation++ / 场景被触发且遵守 suppressed++（observed）/
//           在场未违规 samples++（暴露度）；复发率高（真实证据足）自动降级待人审，
//           armed 够久却零复发零遵守 → 判"不可判定"（保留 armed，/stats+卡片提示，
//           人工停用/归档），不再静默归档。
//
// 严禁自定义会话事件（持久化读取白名单会拒绝加载，session-rescue 同教训）——
// 总线只走服务方法 + 官方设置面/cache 落盘。
//
// 运行方式：dsh cordis Loader 直接 import 本 .ts（Node ≥22.18 类型剥离）。
// 运行时值导入三枚：schemastery（宿主 fork）、@deepseek-ai/dsh-home-paths、@deepseek-ai/dsh-brand
// （都在 dependencies，产物留裸说明符）；@deepseek-ai/cordis 等服务面一律 type-only。

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
// 0.1.7 设置面要求宿主 fork：只有 @deepseek-ai/schemastery 的 resolve 会把 volatile
// 字段包成 Volatile 引用（vendor/schemastery/src/index.ts:521-533），公共
// schemastery@3.18.0 既没有 `.volatile()`、解析出来的也仍是普通值（设置卡写进去的值读不到）。
// 本包的 lib/rules-namespace.ts 同步换 fork：规则库那枚数组字段是在那里构造、在这里并入
// Config 的，用公共包的话它连 `.volatile()` 这个方法都没有，整个规则面会静默失效。
import Schema from "@deepseek-ai/schemastery";
import { dshCachePath } from "@deepseek-ai/dsh-home-paths";
import type { Context, Events, Fiber, Volatile } from "@deepseek-ai/cordis";
// 注入消息的 id 位是官方幻影品牌 `MessageId`（installed @deepseek-ai/dsh-llm/lib/types/
// brand.d.ts:14），唯一合法构造口是官方 `brandString`（@deepseek-ai/dsh-brand/lib/types/
// index.d.ts:28，恒等函数）。它也是本文件的 @deepseek-ai/* 值导入之一：落在
// dependencies、产物留裸说明符（放 devDependencies 会被 rolldown 内联进 host.js）
// ——与 danger-guard 的 `brandNumber`、session-rescue 的 `brandString` 同一处、同一理由。
import { brandString } from "@deepseek-ai/dsh-brand";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { CommandRuntime } from "@deepseek-ai/dsh-commands";
import type { WebServer } from "@deepseek-ai/dsh-host-webserver";
import type { MessageId } from "@deepseek-ai/dsh-llm";
import type { Session, SessionEvent, SessionHeader, SessionId } from "@deepseek-ai/dsh-session";
import type { SettingsForms } from "@deepseek-ai/dsh-settings";
// 会话事件流的官方读面（见下面 SessionQueryFace 的用法注记）：type-only，运行时由 ctx 注入。
import type { SessionQueryEngine } from "@deepseek-ai/dsh-session-query";
import type { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import type { TimerService } from "@deepseek-ai/cordis-plugin-timer";
// 共享 webServer 样板：sendJson/queryParam/guardBody（跨域 + CSRF + body 上限）
// 与 session-rescue/zvec-grep/ocr-review 的同名实现收敛到 shared，避免双份维护。
import { sendJson, queryParam, guardBody } from "@jayyuen66/dsh-plugin-shared/lib/http";
// 信任闸门：四条路由的 handler 第一条语句都走它（Host 权威 → sec-fetch-site → Origin）。
import { guardTrust } from "@jayyuen66/dsh-plugin-shared/lib/trust";
// catch 值转日志文本：直接用 shared 的 errorText（本包曾经由 lesson-store 的
// describeError 转发同一份逻辑）。
import { errorText } from "@jayyuen66/dsh-plugin-shared/lib/errors";
import { LessonStore, deriveProject, PERSIST_FAILED } from "./lib/lesson-store.ts";
import type {
  LessonRecord,
  LessonSource,
  ReportReceipt,
  RuleActionResult,
  RuleCard,
  RulesRepository,
} from "./lib/lesson-store.ts";
import { RulesFieldSchema, createRulesRepository } from "./lib/rules-namespace.ts";
import type { SettingsCasSurface } from "./lib/rules-namespace.ts";
import {
  SECTION_NAME,
  SECTION_ORDER,
  PLUGIN_NAME,
  LESSON_SOURCE_KIND,
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
  LOCALE_SETTINGS_NAMESPACE,
  messagesFor,
  resolveLocalePreference,
} from "@jayyuen66/dsh-plugin-shared/lib/locale";
import { fieldOf, isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

// ── 守卫小件（泛型防御纵深，不用断言；session-rescue/client 同款）──────────

/** 无可回收资源的空清理（consistent-return：effect 各分支统一返回值）。 */
const noDisposer = (): void => {
  void 0;
};

/** 人工动作键（rule-action 端点入参白名单）。 */
type RuleActionKind = "arm" | "reject" | "demote" | "archive" | "edit" | "revive";
const ALLOWED_ACTIONS: ReadonlySet<string> = new Set([
  "arm",
  "reject",
  "demote",
  "archive",
  "edit",
  "revive",
]);
function isRuleAction(value: unknown): value is RuleActionKind {
  return typeof value === "string" && ALLOWED_ACTIONS.has(value);
}

/**
 * `webServer` 与 `commands` 两枚可选服务**共用**的运行时判据：值是 record，且 `register`
 * 那一位可调用。两枚投影（{@link WebServerService} / {@link CommandsService}）的
 * `register` **签名**来自两份不同的官方类（`WebRoute` vs `CommandDefinition`），`Pick<>`
 * 出来是两台名义类型，收窄只能各留一枚；但结构检查只有一份，故收敛到这个函数，
 * 由两枚守卫各自一行委托（此前是两份逐字相同的六行抄本）。
 */
function hasCallableRegister(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const { register } = value;
  return typeof register === "function";
}

/**
 * webServer 可选服务投影：官方 `WebServer`（@deepseek-ai/dsh-host-webserver，installed
 * `lib/types/index.d.ts:67` 起是 cordis `Service` 子类 + `exact`/`prefixes`/`upgrades`/
 * `fallback`/`server` 等一堆 private 字段 → TS 对类按名义比，测试替身满足不了整类型）的
 * 方法面 `Pick`，本包只 `register()`（installed `:90`）。
 * 旧镜像在这里手抄过一枚 route：`kind: string`（一处**静默加宽**——官方 `WebRouteKind`
 * 是 `'exact' | 'prefix'` 字面量联合，installed `:31`/`:34`。kind 拼错在运行时**不会**报错：
 * 官方 register 走 `route.kind === "exact" ? this.exact : this.prefixes`（installed
 * `lib/index.js:178`），任何非 `"exact"` 的串都被塞进**前缀**表，于是本应精确命中的端点会
 * 连子路径一起吃掉）、`path`、以及 handler 的 `(IncomingMessage, ServerResponse)` 形参与
 * `void | Promise<void>` 返回（installed `:33-39`）。现在全部来自官方 `WebRoute`，
 * 拼错的 kind 在编译期就红，disposer 亦按官方 `() => void` 收。别名取名 `WebServerService`：
 * 官方导出名 `WebServer` 已被上面的 type import 占用，同名会互相顶掉
 * （ctx-observe / zvec-grep / ocr-review 同款）。
 */
type WebServerService = Pick<WebServer, "register" | "host">;
function isWebServer(value: unknown): value is WebServerService {
  return hasCallableRegister(value);
}

/**
 * `/lessons-digest` 命令服务投影：官方 `CommandRuntime`（@deepseek-ai/dsh-commands，
 * installed `lib/types/index.d.ts:80` 起是 class，`extends TypertRemoteService` + 四枚
 * private 字段 → 名义比较）的 `register` 方法面（installed `:94`，官方
 * `Context.commands: CommandRuntime` 见同文件 `:65`）。
 * 旧镜像手抄的那份 descriptor 与官方 `CommandDefinition`（installed `:38-55`）有**三处**
 * 不一致（逐条按官方声明行号核对，本包的实际写法恰好都被官方容纳，故绑定后编译不报错）：
 *   1. `recordInput` 镜像写的是**必填**，官方是 `readonly recordInput?: boolean`
 *      （`:52`，注记 "Defaults to true"）——本包传 `false`，语义不变；
 *   2. `input` 镜像是 `{ hint: string }`，官方是 `CommandInputDescriptor`
 *      （`@deepseek-ai/dsh-commands/types` installed `lib/types/types.d.ts:20-31`），
 *      除 `hint` 外还有本包不用的可选 `attachments` 旗标；
 *   3. 回显形状镜像写的是**非判别**联合 `{ kind: "success" | "error"; text: string }`，
 *      官方 `CommandResult`（同上 installed `:33-41`）是判别联合，且 success 分支的
 *      `text` 是**可选**（`readonly text?: string`）并多一枚 `sourceEventSeq?: SessionSeq`；
 *      error 分支的 `text` 才是必填。
 * 入参同理：镜像把 handler 的形参写成了 `unknown`，官方是 `CommandInvocation`
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
 * `lib/types/index.d.ts:226` 起是 cordis `Service` 子类 + private `layers`/`toolOrder`
 * → 名义比较）的 `section` 方法面（installed `:239`）。载荷即官方 `PromptSection`
 * （installed `:47-70`）：`name`/`order` 必填，`text` 允许静态串**或**每次拼装以
 * `AssembleContext`（installed `:37-45`）求值的 provider——旧镜像把 provider 的入参抄成了
 * `unknown`，那是加宽后的假面；官方还多两枚本包不用的可选旗标 `interpolate`/`complete`。
 * 返回是官方承诺的 "the exact Cordis effect disposer" `() => void`（installed `:237-239`）。
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
 * 的 `timeout` 方法面（installed `:18-19`）。官方 `timeout` 是**重载**
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
 * 会话事件流的官方读面：`ctx.sessionQuery`（installed @deepseek-ai/dsh-session-query/
 * lib/types/index.d.ts:23-27 把它增强进 `Context`）的 `observeSession` 方法面投影
 * （同文件 :47 —— `observeSession(sessionId: SessionId, options?): Promise<SessionObservation>`）。
 * 本包只取这一位：`SessionObservation.events` 就是"该会话此刻的不可变事件切片"
 * （installed lib/types/observation.d.ts:15-19），替代已被官方标 `@deprecated` 的
 * `Session.snapshotEvents`（@deepseek-ai/dsh-session/lib/types/index.d.ts:186-192，
 * "new calls are prohibited"）。`SessionQueryEngine` 是 cordis `Service` 子类
 * （:35 起 + private 字段 → 名义比较），故只 `Pick`，不取整类。
 */
type SessionQueryFace = Pick<SessionQueryEngine, "observeSession">;
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
 * 核验的是 0.1.7 的实际调用面：`effect`/`on` 接线、`inject` + `fiber` 挂页面策略、
 * `settings.describe` 做跨命名空间读与规则库读。缺任一项一律急停——带着半截服务面
 * 在首个回合才崩，会被折叠成 turn kind:error 直接甩给用户。
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
    fiber !== undefined &&
    typeof fieldOf(settings, "describe") === "function"
  );
}

// PLUGIN_NAME / LESSON_SOURCE_KIND 的定义收敛到 lib/prompt.ts（lib/digest.ts 也要用
// 同一个 kind，而它 import 不到 host——方向是 host → lib）。见该处的注释。
/** stats/rules/lessons GET 端点（下发 csrf）。 */
const STATS_PATH = "/_dsh/lesson-loop/stats";
const RULES_PATH = "/_dsh/lesson-loop/rules";
const LESSONS_PATH = "/_dsh/lesson-loop/lessons";
/** 写端点（POST，csrf + 同源校验）。 */
const RULE_ACTION_PATH = "/_dsh/lesson-loop/rule-action";

// ── 结构类型（与宿主交互面的运行时形状；避免值导入 @deepseek-ai/*）────────

/**
 * settings 服务面对本包剩下的三件事（`register`/`get`/`installSection` 已被 0.1.7 移除）：
 *   - `describe()`：唯一的读口——跨命名空间读 locale 走它，规则库读 value/user/revision 也走它
 *     （返回官方 `SettingsDescriptor`，`user`/`revision` 即规则库判"读不懂 vs 真的没有"的两位）；
 *   - `update(ns, patch, expectedRevision)`：规则库的 CAS 写，ns 现在必须是本包的条目 id；
 *   - `configure(presentation, owner)`：页面策略（本包自带卡片，别让宿主再生成一份自动表单页），
 *     只在 `ctx.inject` 给的子上下文里拿到，故不算进 isSettingsProvider 的判定。
 * = 官方 `SettingsForms` 的三位方法面投影（CAS 那两位与 `lib/rules-namespace.ts` 的
 * `SettingsCasSurface` 同一来源；`configure` 见 installed index.d.ts:80）。旧镜像自己写了
 * 一枚 `describe: () => SettingsDescriptor[]`（丢掉官方可选的 `SettingsDescribeOptions` 入参）
 * 并 extends 一枚手抄的 CAS 面，现在三位一律由官方成员交出。
 */
export type SettingsProvider = SettingsCasSurface & Pick<SettingsForms, "configure">;

/**
 * `ctx.inject(deps, callback)` 回调收到的子上下文（本包只用到 settings + effect）。
 * 与 SettingsProvider 分开声明是有意的：子上下文里的 settings 只有页面策略要调，
 * 规则库那条读写链走的是主 ctx 的 service 实例。
 */
interface InjectedCtx {
  /** 只投影页面策略那一位，签名整体取官方成员：手抄成 `owner?: unknown` 比官方
   *  （`configure(presentation, owner?: Fiber)`，dsh-settings index.d.ts:80-82）更松，
   *  owner 传错东西编译期抓不到。 */
  settings: Pick<SettingsForms, "configure">;
  effect: (factory: () => (() => void) | undefined, label?: string) => void;
}

/**
 * provider 是否具备规则库需要的 CAS 面（describe + update）；缺位即规则面不可用。
 * ⚠ 不能再探 `register`：0.1.7 已把它连同 get/installSection 一起移除，拿它当硬前置会让
 * 每一条真宿主都判成"没有 CAS 面"，规则库于是结构性失效。
 * 导出仅供单测：非记录对象这条分支在 apply 里到不了（更早就用了 svc.settings.describe），
 * 但守卫本身要对它负责，故直验而不是伪造一条走不到的装载路径。
 */
export function isSettingsProvider(value: unknown): value is SettingsProvider {
  if (!isRecord(value)) {
    return false;
  }
  const { describe, update } = value;
  return typeof describe === "function" && typeof update === "function";
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
  /** 部署值（非 volatile）：/lessons-digest 一次蒸馏的墙钟（毫秒）。 */
  digestTimeoutMs: number;
  /** 部署值（非 volatile）：周期衰减的武装间隔（毫秒）。 */
  decayIntervalMs: number;
}

/** 取设置快照的取用口：每次现读引用当前值（设置卡改完下一个事件/回合即生效）。 */
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
 * lib/types/index.d.ts：`get id(): SessionId` :122、`readonly header: SessionHeader` :118）。
 * 值域不取整类：`Session` 带 private 字段（:105-107）→ TS 按名义比较，本包的替身会话永远
 * 满足不了；`header` 又只读本包判定"是不是子代理会话"用到的三位
 * （installed @deepseek-ai/dsh-llm 域外、dsh-session/lib/types/types.d.ts:69/:81/:87
 *  的 `cwd`/`origin`/`delegationDepth`，官方三者本来就都可缺）。键名一处都不重述。
 */
interface AgentSessionView {
  readonly id?: Session["id"];
  readonly header?: Partial<Pick<SessionHeader, "cwd" | "delegationDepth" | "origin">>;
}

/**
 * agent/created 载荷里的 agent = 官方 `Agent` 的本包读取投影。
 * `Agent` 是 interface（installed @deepseek-ai/dsh-agent/lib/types/types.d.ts:11 只声明
 * `id`，成员由 lib/types/runtime-types.d.ts:138-192 的官方增强交出：`session` :143、
 * `inject` :…、`status` :147…），不带私有字段，但整面远多于本包所需，故按 `Pick` 只取
 * `inject` 一位——**签名不再本地重述**。旧镜像写的是 `inject?: (message: unknown) => void`：
 * `unknown` 什么都收，官方给 `UserMessage` 加必填位时本包静默漏填（正是此前迁移在别处
 * 抓到的那类缺陷），现在载荷由官方 `UserMessage` 约束，`id` 走 `brandString<MessageId>`、
 * `source.kind` 走 lib/prompt.ts 里那条 producer 声明。
 * `session` 一位只能投影（见 {@link AgentSessionView} 的理由）：官方 `Agent.session` 是
 * **必选**的 `Session` 类（runtime-types.d.ts:143），跨进程递来的会话是否具备某位只能
 * 运行时判（下面 `if (!isSessionLike(sessionRaw))` 与 header 的 typeof 守卫照旧留着）。
 * `inject` 留可选同样是边界口径而非宿主判决：官方那一位在 `Agent` 面上必选，
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

interface HostCtx {
  settings: SettingsProvider;
  /** 服务读取面取官方 `Context["get"]`（installed @deepseek-ai/cordis/lib/types/reflect.d.ts:14
   *  `get<K extends string & keyof this>(name: K, strict?: boolean): undefined | this[K]`）：
   *  本包读的 `webServer` / `commands` / `llm` / `agentDefaultModel` / `systemPrompt` **全部**
   *  是官方声明进 `Context` 的名字（installed @deepseek-ai/dsh-host-webserver/lib/types/
   *  index.d.ts:15-18、@deepseek-ai/dsh-commands/lib/types/index.d.ts:65、
   *  @deepseek-ai/dsh-llm/lib/types/index.d.ts:29-31、
   *  @deepseek-ai/dsh-agent-default-model/lib/types/index.d.ts:6-8、
   *  @deepseek-ai/dsh-system-prompt 同名增强），故走泛型臂拿到 `undefined | 官方服务类`，
   *  一条都不落进 `get(name: string): any` 兜底臂（:16）。
   *  ⚠ 与 danger-guard/host.ts 的 `HostCtx.get` 相反：那一包读的是 `SETTINGS_READER` 与
   *  `lessonLoop`，两者都不在官方 `Context` 上，换官方面只会把 `unknown` 降级成 `any`，
   *  所以它把本地面留着并写明了理由。这里名字全在官方面上，条件成立才换。
   *  返回 `undefined` 是官方语义（"or `undefined` when not (yet) provided"）：精简 profile
   *  确实交不出某些服务，各调用点下面的形状守卫照旧。 */
  get?: Context["get"];
  /** 服务供给面取官方 `Context["provide"]`（installed reflect.d.ts:41-43，两枚重载）。
   *  本包 provide 的名字 `lessonLoop` 是本仓 sibling 插件自有的服务名（宿主安装里检索为
   *  0 命中），故它落在官方 `provide(name: string, value?: any): () => void` 那枚兜底臂上——
   *  这是**官方给出的**读不到声明名时的口径，disposer 仍由官方签名交出（:43 `() => void`），
   *  本地不再重述。 */
  provide?: Context["provide"];
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
  /** 事件接线面：两枚事件名与载荷都由官方事件表交出（`Parameters<Events[…]>[0]`），
   *  本地不重述签名。`session/disposed` 的载荷就此是官方 `Session`（installed
   *  @deepseek-ai/dsh-session/lib/types/index.d.ts:51）；本包只读它的 `id`，那道
   *  `stringIdOf`/`isRecord` 守卫照旧（官方类型说的是宿主的承诺，交付由守卫负责）。
   *  ⚠ 不换 `Context["on"]`：那是全仓延后项（泛型 `on<K extends keyof Events>` 会重写每一枚
   *  监听器签名，ctx-observe/host.ts:328-336 记着同一条理由）。按重载逐枚点名，
   *  新增事件时加一条签名即可，不必把整张事件表拖进来。 */
  on: ((
    event: "session/disposed",
    listener: (session: Parameters<Events["session/disposed"]>[0]) => void,
  ) => unknown) &
    ((event: "agent/created", listener: (payload: AgentCreatedPayload) => void) => unknown) &
    ((event: "settings/document-updated", listener: (ns: unknown) => void) => unknown);
}

// ── 配置 ─────────────────────────────────────────────────────────────────

/**
 * 行级配置（组合包层/用户层行的 `config:`），由 cordis 按导出的 `Config` schema 校验并
 * 逐字段填 `.default()` 后传入 apply。0.1.7 起注册是**隐式**的：命名空间 = profile 条目 id
 * （`lesson-loop`，见 cordis.patch.yml），可编辑字段由 schema 上的 `.volatile()` 声明，
 * 插件侧不再有 `settings.register`，也没有它那一层 `base` 底座——原 BUILTIN_BASE 逐字段
 * 落成下面的 `.default(...)`，单一来源。volatile 字段以 Volatile 引用形态交进来，
 * 读当前值一律 `.get()`。
 * 优先级：settings 运行时值（设置卡/规则卡）> 行 config > schema 默认。
 */
export interface Config {
  enabled: Volatile<boolean>;
  /** 教训落盘与归并开关（关掉后 report 只回执不落盘，管理面照常可用）。 */
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
  /**
   * 规则卡库（人工升格的用户数据）。本包**不从这里读**：读要走 `describe()` 才能同时拿到
   * revision（CAS 条件），见 lib/rules-namespace.ts 的 createRulesRepository；这里列出来是
   * 为了让 Config 与 schema 保持单源同形——少一个字段就是少一处能被宿主投影的面。
   * 元素形状不在这里收窄（normalizeRuleCardRow 才是判定处），故投成 unknown[]。
   */
  rules: Volatile<readonly unknown[]>;
  /**
   * 部署值：一次蒸馏的墙钟（毫秒）。到点 abort 那条 llm.stream——评审机/网络慢的
   * 部署要抬，但它不是用户随时翻的开关，故**不标 volatile**、不进设置卡。
   */
  digestTimeoutMs: number;
  /** 部署值：周期衰减的武装间隔（毫秒）。随部署的会话节奏调整。 */
  decayIntervalMs: number;
}

/** 设置命名空间与 loader 行 config 共用同一 schema（单源，防漂移）。
 *  值名退避为 configSchema：避免与同名 interface Config 触发 no-redeclare（ctx-observe
 *  同款），外部仍以 `Config` 名导入（export as）——cordis registry 读的就是入口键
 *  `Config`（vendor/cordis/src/registry.ts:104 `Plugin.Base.Config`，装载时
 *  fiber._resolveConfig → resolveConfig 校验；此前本包写成 `ConfigSchema` 键，
 *  registry 取不到，本包的行 config 校验从未真正跑过）。
 *  十二个字段**全部** `.volatile()`：没有任何 volatile 字段的条目会被宿主 describe() 整条
 *  跳过（packages/settings/settings/src/index.ts:308-309），写入则抛
 *  `has no volatile fields`（:386）——开关与规则库因此都是"从 schema 反推"的，漏标一项
 *  不会报错，只会让那一项从设置卡上静默消失（test/host.test.ts 拿宿主同一个判据钉住）。 */
/** 周期衰减的默认武装间隔（真值由 entry config `decayIntervalMs` 交进来，
 *  这里只剩 schema `.default()` 的单一来源）。一天一轮：衰减是统计口径的整理活，
 *  比会话节奏慢得多，跑赢 24h 就够；更密的部署在行 config 上收紧。 */
const DEFAULT_DECAY_INTERVAL_MS = 24 * 60 * 60_000;

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
  // 0.1.7 只有"一个条目一份 Config"，规则库因此与开关同段（旧的第二段 `lesson-loop-rules`
  // 无处安放）。`.loose()` / `.default([])` / 读侧"user 层坏形状即不可用"三段闸门各自的
  // 理由见 lib/rules-namespace.ts 的 RulesFieldSchema——同段最贵的那件事（坏存量打死整条
  // 总线）就是靠它们补回来的。
  rules: RulesFieldSchema,
  // 两枚部署级调优值（官方 config.md:78-92 的判据是"行 config 能否不改代码改值"，
  // 不是"能不能在页面上改"）。刻意不标 volatile ⇒ 不进设置卡；默认与旧常量同值，
  // 行为冻结由 test/host.test.ts 的字面值钉住。min(1000) 挡掉 0：零墙钟会让蒸馏一帧都
  // 读不到，零间隔会让衰减定时器变成忙循环。
  digestTimeoutMs: Schema.natural().min(1000).default(DEFAULT_DIGEST_TIMEOUT_MS),
  decayIntervalMs: Schema.natural().min(1000).default(DEFAULT_DECAY_INTERVAL_MS),
});
export { configSchema as Config };

/**
 * 派生数据的落盘位置：官方 cache 目录（`dshCachePath` = `$DSH_HOME/cache`，
 * DSH_HOME 未设时由 home-paths 自己按 `~/.dsh` 解析）。
 *
 * 为什么是 cache：dsh 承认的用户数据目录只有 settings 文档与 sessions/storages/
 * cache/logs，插件自开 `metrics/` 属越界（用户的手工编辑、备份、清理都不在官方面上）。
 * 事件流水正是 cache 定位的"可丢弃派生数据"——丢了能由会话与规则库重建，不该占用
 * 用户唯一那份 settings.yaml。自制 `DSH_HOME → HOME/.dsh → throw` 三态回退一并删掉：
 * 解析规则由官方包单源提供，插件不再第二份实现（也不再有"两个环境变量都没有就炸"
 * 这种热路径抛错）。
 */
export function cacheFile(name: string): string {
  // 官方 cache 助手（@deepseek-ai/dsh-home-paths 0.1.x 起导出）：字符串重载即
  // `dshHomePath("cache", <segment>, …)` 的展开式，路径与 rc.3 时代手写的
  // `dshHomePath("cache", PLUGIN_NAME, name)` 逐字节相同（见 lib/index.js 的
  // dshCachePath 实现），故已落盘的流水不需要迁移。
  return dshCachePath(PLUGIN_NAME, name);
}

/**
 * 建规则库端口（交给 LessonStore）。0.1.7 起这里**不注册任何东西**：命名空间与 `rules`
 * 字段都是宿主从条目导出的 Config 反推的（`settings.register` 已移除）。
 *
 * 两条降级路径：
 *   - provider 没有 CAS 面（describe/update 缺位）→ 这里当场点破并让规则面读空写拒，
 *     设置卡开关照改照生效；这条判据与装载次序无关，所以留在装载期。
 *   - 那一段读不出可信值（用户把 `rules` 手改成非数组）→ 由端口自己在**第一次真读到那一行
 *     时**报（`lib/rules-namespace.ts` 的 load）。装载期报不了：apply 跑在自己那条 fiber
 *     变 ACTIVE 之前，那一刻 describe() 里没有本条目的行（真实宿主隔离实测），在这一点上
 *     判"坏"是错的、判"还没到"则每次正常开机都多一条噪声。
 *     旧实现靠 try/catch 接住"register 被打回"，现在没有可 catch 的注册：同段之后，坏
 *     `rules` 若走到类型判定就会让整条条目不加载（cordis resolveConfig 抛 → 插件根本不
 *     执行，开关与服务一起没）。所以那一步由 schema 上的 `.loose()` 在解析期吸收，坏形状
 *     只在读写侧点名——不点名就会被当成"库里真的没有卡"。
 */
function createRulesFacet(settings: unknown): RulesRepository {
  if (!isSettingsProvider(settings)) {
    console.error(
      "[lesson-loop] settings provider has no CAS surface — rule library unavailable (switches still work)",
    );
    return createRulesRepository(null);
  }
  return createRulesRepository(settings);
}

// ── webServer 工具（样板由 shared 提供，本文件只留常量）────────────────────

/** CSRF header 名（各插件历史上不同名，收敛时保持各自语义）。 */
const LESSON_CSRF_HEADER = "x-lesson-csrf";

/** rule-action 请求体上限（UTF-8 字节）：合法载荷只有 id/action/statement 三个短串。 */
const RULE_ACTION_BODY_MAX_BYTES = 1024 * 1024;

/** 会话台账容量上限（ctx-observe 同款纪律：防长驻进程无界）。 */
const WATCH_MAX_SESSIONS = 200;

/** 会话台账的一行：收尾清算要用的项目归因 + 两个记账集合。 */
interface SessionWatchEntry {
  project: string;
  violated: Set<string>;
  passed: Set<string>;
}

/** sessionId → 台账行：会话内复发记账，session/disposed 时清算 suppressed。 */
type SessionWatch = Map<string, SessionWatchEntry>;

/** 规则卡的 HTTP 投影类型：去证据 + 派生的"不可判定"态（armed 够久却无复发无干净命中）。 */
type RuleView = Omit<RuleCard, "evidence"> & { undeterminable: boolean };

/** 规则卡的 HTTP 投影：去掉 evidence[]，并补上派生态 undeterminable。
 *  证据是全文（一条教训的 detail 可含整段工具输出），而卡片只渲染状态与计数——
 *  原样序列化等于每次轮询把整份证据库传给浏览器再丢掉。不可判定是"该不该由人处理"
 *  的判据（既不自动降级也不自动归档），必须在投影里带出去让人看到。
 */
function ruleViewOf(store: LessonStore, rule: RuleCard): RuleView {
  const { evidence: _evidence, ...rest } = rule;
  return { ...rest, undeterminable: store.isUndeterminable(rule) };
}

// ── webServer 端点（卡片读写的四条路由）────────────────────────────────────

/**
 * 消息表的取用口：每次现取，用户在「设置 → 常规」改语言偏好后，下一条回显/注入
 * 就是新文案（不重启、也不给本包加一个自己的 locale 设置项）。
 */
type MessagesOf = () => LessonLoopMessages;

/**
 * 四条端点在**同一次装载**里共享的依赖：`csrf` 与非回环判据随 effect 实例走（依赖换实例
 *  即重生成，与旧闭包同寿命），store/stats/取文案口由 registerRoutes 交进来。收成一只盒子
 *  而不是四枚形参，是为了让 handler 保持官方 `WebRoute` 的 `(req, res)` 形状。
 */
interface RouteRuntime {
  store: LessonStore;
  stats: () => Record<string, unknown>;
  messagesOf: MessagesOf;
  csrf: string;
  servingNonLoopback: boolean;
}

/** GET stats：全量规则投影 + csrf（卡片轮询的入口，也是 csrf 的唯一来源）。 */
function handleStatsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  { csrf, servingNonLoopback, stats, store }: RouteRuntime,
): void {
  // 信任闸门（shared/lib/trust）：必须是 handler 体的第一条语句——先验权威再谈方法/参数。
  if (!guardTrust(req, res, { servingNonLoopback })) {
    return;
  }
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    sendJson(res, 405, { ok: false, error: "GET only" });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    csrf,
    ...stats(),
    rules: store.rules().map((rule) => ruleViewOf(store, rule)),
  });
}

/** GET rules：project 缺省给全量，给定即按卡片自存的 project 过滤。 */
function handleRulesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  { csrf, servingNonLoopback, store }: RouteRuntime,
): void {
  // 信任闸门（shared/lib/trust）：必须是 handler 体的第一条语句——先验权威再谈方法/参数。
  if (!guardTrust(req, res, { servingNonLoopback })) {
    return;
  }
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    sendJson(res, 405, { ok: false, error: "GET only" });
    return;
  }
  const project = queryParam(req, "project");
  const all = store.rules();
  const rules = (project === null ? all : all.filter((rule) => rule.project === project)).map(
    (rule) => ruleViewOf(store, rule),
  );
  sendJson(res, 200, { ok: true, csrf, rules });
}

/** GET lessons：事件流水只读投影，零写面。 */
function handleLessonsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  { servingNonLoopback, store }: RouteRuntime,
): void {
  // 信任闸门（shared/lib/trust）：必须是 handler 体的第一条语句——先验权威再谈方法/参数。
  if (!guardTrust(req, res, { servingNonLoopback })) {
    return;
  }
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    sendJson(res, 405, { ok: false, error: "GET only" });
    return;
  }
  // limit ≤ 0 / 缺省 = 全量（不截断）；project 可选过滤。
  const project = queryParam(req, "project");
  const limitRaw = Number(queryParam(req, "limit") ?? "0");
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 0;
  const lessons = store.recentLessons(project ?? undefined, limit);
  sendJson(res, 200, { ok: true, count: lessons.length, lessons });
}

/** POST rule-action 的体：csrf 令牌校验 → 入参白名单 → 落库并按结果定状态码。 */
async function applyRuleAction(
  req: IncomingMessage,
  res: ServerResponse,
  { csrf, messagesOf, store }: RouteRuntime,
): Promise<void> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    sendJson(res, 405, { ok: false, error: "POST only" });
    return;
  }
  const raw = await guardBody(req, res, {
    maxBytes: RULE_ACTION_BODY_MAX_BYTES,
    csrf: { token: csrf, headerName: LESSON_CSRF_HEADER },
  });
  if (raw === null) {
    return;
  }
  // 语言在每次请求现取：改偏好不必重启、也不影响已经在盘上的规则数据。
  const messages = messagesOf();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { ok: false, error: messages.errInvalidJsonBody });
    return;
  }
  const idVal = fieldOf(parsed, "id");
  const id = typeof idVal === "string" ? idVal : "";
  const actionVal = fieldOf(parsed, "action");
  const action = typeof actionVal === "string" ? actionVal : "";
  const statementVal = fieldOf(parsed, "statement");
  const statement = typeof statementVal === "string" ? statementVal : undefined;
  if (id === "" || action === "") {
    sendJson(res, 400, { ok: false, error: messages.errIdAndActionRequired });
    return;
  }
  if (!isRuleAction(action)) {
    sendJson(res, 400, {
      ok: false,
      error: fill(messages.errUnknownAction, { action }),
    });
    return;
  }
  const outcome = await store.ruleAction(id, action, statement);
  if (outcome === "not-found") {
    sendJson(res, 404, { ok: false, error: messages.errRuleNotFound });
    return;
  }
  if (outcome === "persist-failed") {
    // 这一次改动没进规则库（端口拒写或 CAS 冲突耗尽）：库里还是旧状态，必须报 500
    // 让人重试，而不是回 200 假装升格已生效。PERSIST_FAILED 是回执码不是文案——
    // 它与 report() 的 receipt.reason 同一个值，翻译它会让调用方的判等作用失效。
    sendJson(res, 500, { ok: false, error: PERSIST_FAILED });
    return;
  }
  sendJson(res, 200, { ok: true, id, action });
}

/** POST rule-action 的壳：闸门 + 兜底 catch（体本身失败一律 500，不许漏成 unhandled rejection）。 */
async function handleRuleActionRoute(
  req: IncomingMessage,
  res: ServerResponse,
  routes: RouteRuntime,
): Promise<void> {
  // 信任闸门（shared/lib/trust）：必须是 handler 体的第一条语句——先验权威再谈方法/参数。
  if (!guardTrust(req, res, { servingNonLoopback: routes.servingNonLoopback })) {
    return;
  }
  try {
    await applyRuleAction(req, res, routes);
  } catch (error) {
    console.error(`[lesson-loop] rule-action handler failed: ${errorText(error)}`);
    sendJson(res, 500, { ok: false, error: routes.messagesOf().errRuleActionFailed });
  }
}

/** 端点装载体：读服务 → 取权威信号与 csrf → 四条路由逐个注册 → 交回合并 disposer。
 *  服务缺席（TUI 宿主没有 webServer）时只交回空清理，装载不许中断。 */
function installLessonRoutes(
  svc: HostCtx,
  store: LessonStore,
  stats: () => Record<string, unknown>,
  messagesOf: MessagesOf,
): () => void {
  const webServerRaw = svc.get?.("webServer");
  if (!isWebServer(webServerRaw)) {
    return noDisposer;
  }
  const webServer = webServerRaw;
  // 非回环服务面唯一的可读信号（installed dsh-host-webserver d.ts `:50`/`:83`）：
  // 绑 0.0.0.0 时本机网卡持有的地址才算可信权威，回环档不必用它。
  const servingNonLoopback = webServer.host === "0.0.0.0";
  const csrf = randomUUID();
  const routes: RouteRuntime = { store, stats, messagesOf, csrf, servingNonLoopback };
  const disposeStats = webServer.register({
    kind: "exact",
    path: STATS_PATH,
    handler: (req, res) => {
      handleStatsRoute(req, res, routes);
    },
  });
  const disposeRules = webServer.register({
    kind: "exact",
    path: RULES_PATH,
    handler: (req, res) => {
      handleRulesRoute(req, res, routes);
    },
  });
  const disposeLessons = webServer.register({
    kind: "exact",
    path: LESSONS_PATH,
    handler: (req, res) => {
      handleLessonsRoute(req, res, routes);
    },
  });
  const disposeAction = webServer.register({
    kind: "exact",
    path: RULE_ACTION_PATH,
    // 任何一处抛错若不被接住 = unhandled rejection（Node 默认退出进程），且响应
    // 永远不结算，客户端挂在那里 → 整段 await 包在 try 内，失败一律回 500。
    handler: (req, res) => handleRuleActionRoute(req, res, routes),
  });
  return () => {
    disposeStats();
    disposeRules();
    disposeLessons();
    disposeAction();
  };
}

/** 注册 webServer 端点：GET stats/rules/lessons（下发 csrf）+ POST rule-action（csrf 校验）。
 *  端点回显给卡片的 error 文案随语言偏好走（卡片把它们直接显示进 .llc-err）。
 *  ⚠ `owner` 必须是 apply 末尾那个 `svc.inject(["webServer"], …)` 交回的子上下文：效应挂在
 *  子 fiber 上才跟着依赖"后到即注册、换实例先卸后装"。挂在父 ctx 上会变成"父 fiber 卸载时
 *  才清"，依赖每次变化都多留一组路由。
 *  类型取本包对子上下文的投影（`InjectedCtx` 的 effect 位），不取官方 `Context["effect"]`：
 *  本包那份是比官方宽一格的本地镜像（官方两条重载的返回域是 Disposable/AsyncDisposable），
 *  混用会当场对不上——收窄到"这里只用到 effect"这一位即可。 */
function registerRoutes(
  svc: HostCtx,
  owner: Pick<InjectedCtx, "effect">,
  store: LessonStore,
  stats: () => Record<string, unknown>,
  messagesOf: MessagesOf,
): void {
  owner.effect(
    () => installLessonRoutes(svc, store, stats, messagesOf),
    "lesson-loop: webServer routes",
  );
}

/** commands 服务缺失只 warn 一次（模块级：一次进程内多次装载不刷屏）。
 *  位装在 const 盒子里而不是裸 `let`：模块级可变声明正是"谁都能改"的那种面，
 *  盒子只暴露这一位，改的对象仍是同一份进程内状态。 */
const commandsWarnState: { warned: boolean } = { warned: false };

/** 数组性判据（**不是** type predicate，故不产生收窄；理由见 digestEvents 内注释）。 */
function isArrayDelivery(value: unknown): boolean {
  return Array.isArray(value);
}

/**
 * 取一次蒸馏要用的会话事件流：官方 `ctx.sessionQuery.observeSession(sessionId)` 的
 * `observation.events`。
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
 * `brandString<SessionId>` 是官方品牌的唯一合法构造口（幻影品牌无 type-only 构造方式，
 * `as` 又被 typescript/no-unsafe-type-assertion 禁掉），见文件头列出的 dsh-brand 值导入。
 */
async function digestEvents(svc: HostCtx, session: SessionLike): Promise<readonly SessionEvent[]> {
  const queryRaw = svc.get?.("sessionQuery");
  if (!isSessionQueryService(queryRaw)) {
    return [];
  }
  const sessionId: string | undefined =
    typeof session.id === "string" && session.id.length > 0 ? session.id : undefined;
  if (sessionId === undefined) {
    return [];
  }
  try {
    const observation = await queryRaw.observeSession(brandString<SessionId>(sessionId));
    // 交付判据只当**布尔**用，不经 `Array.isArray` 收窄：那条守卫会把官方
    // `readonly SessionEvent[]`（installed dsh-session-query/lib/types/observation.d.ts:19）
    // 塌成 `any[]`，类型面当场作废并让返回值变成 unsafe return。数组性由这个不收窄的
    // 判据挡住，返回的仍是官方形状。
    if (!isArrayDelivery(observation.events)) {
      return [];
    }
    return observation.events;
  } catch {
    return [];
  }
}

/** 注册 /lessons-digest 命令（人工触发蒸馏；commands 服务可选读——缺失只 warn 一次）。
 *  与 report 同一闸门：插件关闭期间既不烧 LLM 也不写候选卡。命令回显与进模型的蒸馏
 *  提示都随语言偏好走；蒸馏出来的规则条目是用户数据，原样透传。 */
function registerDigestCommand(
  svc: HostCtx,
  store: LessonStore,
  settingsOf: SettingsOf,
  messagesOf: MessagesOf,
): void {
  svc.effect(() => {
    const commandsRaw = svc.get?.("commands");
    if (!isCommandsService(commandsRaw)) {
      if (!commandsWarnState.warned) {
        commandsWarnState.warned = true;
        console.warn("[lesson-loop] commands service unavailable — /lessons-digest not registered");
      }
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
        // 面标了 `@deprecated` 并禁止新增调用。取不到（服务缺位 / 会话已卸载 / 品牌位读不出 /
        // 观察抛错）一律退**空背景**——蒸馏照跑，只是少了差评证据；命令绝不能因为读面缺失而炸。
        const events = await digestEvents(svc, session);
        try {
          const result = await runDigest(store, session, llm, selection, {
            messages,
            events,
            timeoutMs: settingsOf().digestTimeoutMs,
            ...(extra === undefined ? {} : { extra }),
          });
          if (result.created.length === 0) {
            return {
              kind: "success" as const,
              text: fill(messages.digestNoNewRules, { count: result.feedbackCount }),
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

/**
 * `settleQuietly` 在三个收尾位（session/disposed 两支 + 卸载清算）共用同一句失败日志前缀：
 * 三处清算的都是 `store.sessionEnded`，措辞漂移会让同一条错误在日志里变成三种样子。
 */
const SESSION_ENDED_FAILURE_LABEL = "sessionEnded failed";

/**
 * 收尾清算的异步兜底：sessionEnded 要 await provider 落盘。
 * **事件回调**位（agent/disposed、session/disposed）仍是同步契约 → 起链、失败只记日志
 * （单条会话炸了不许拖垮其余、更不许把事件派发带炸；未处理的 rejection 在 Node 默认
 * 配置下会直接退出进程）。**卸载**位不用这个函数：那里交回可 await 的 disposer，见
 * settleOpenSessionsOnDispose。
 */
async function settleQuietly(promise: Promise<unknown>, label: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    console.error(`[lesson-loop] ${label}: ${errorText(error)}`);
  }
}

/**
 * 卸载时清算仍未收到 session/disposed 的会话。
 *
 * 为什么需要：headless/CLI 进程只跑一个任务就退出，Cordis 拆树时插件 fiber 先于会话
 * 事件销毁——只挂在 session/disposed 上的收尾清算在这些进程里**永远不执行**，
 * samples/observed 因此恒为 0，armed 规则结构性落入"不可判定"，度量层等于没做。
 * 闸门与容错口径与事件版一致（关闭期间不清算、单条失败不拖垮其余），但**交回可 await 的
 * 异步 disposer**：官方明说异步 disposer 由拆纤 await（cordis fiber.d.ts:38-41），
 * 旧的 `void settleQuietly(...)` 是 fire-and-forget —— 在飞的 provider 写会被截断，
 * 违反 defensive-patterns.md:19-21「Dispose must reach quiescence」。
 */
function settleOpenSessionsOnDispose(args: {
  store: LessonStore;
  sessionWatch: SessionWatch;
  settingsOf: SettingsOf;
}): () => Promise<void> {
  const { store, sessionWatch, settingsOf } = args;
  return async (): Promise<void> => {
    if (!settingsOf().enabled) {
      return;
    }
    // 只删不增：Map 迭代器对"删除当前项"是安全的（规范保证），无需先复制一份。
    const pending: Promise<void>[] = [];
    for (const [sid, entry] of sessionWatch) {
      sessionWatch.delete(sid);
      pending.push(
        settleQuietly(
          store.sessionEnded(entry.project, entry.violated, entry.passed, sid),
          SESSION_ENDED_FAILURE_LABEL,
        ),
      );
    }
    await Promise.all(pending);
  };
}

/**
 * 会话开始：①预种会话台账（project 归因，供收尾清算 suppressed）；②注入 armed
 * 规则摘要（根会话；项目按 cwd 归因；全文不截断）。摘要帧的骨架行由消息表给，
 * 规则正文（statement）原样透传——那是规则库里的用户数据，不随界面语言改写。
 */
function onSessionStart(args: {
  agent: StartAgent;
  settingsOf: SettingsOf;
  store: LessonStore;
  sessionWatch: SessionWatch;
  pruneWatch: () => void;
  messages: LessonLoopMessages;
}): void {
  const { agent, settingsOf, store, sessionWatch, pruneWatch, messages } = args;
  try {
    const cfg = settingsOf();
    if (!cfg.enabled) {
      return;
    }
    const { session } = agent;
    const sid = typeof session?.id === "string" ? session.id : undefined;
    const project = deriveProject(session?.header?.cwd);
    if (sid !== undefined) {
      const seeded = sessionWatch.get(sid);
      if (seeded === undefined) {
        sessionWatch.set(sid, { project, violated: new Set(), passed: new Set() });
      } else {
        seeded.project = project;
      }
      pruneWatch();
    }
    if (!cfg.injectEnabled) {
      return;
    }
    if (session === undefined || typeof agent.inject !== "function") {
      return;
    }
    // 根会话判定（ctx-observe isRootSession 同款：delegationDepth>0 或 origin==='subagent' 非根）。
    const { header } = session;
    if (
      header &&
      ((typeof header.delegationDepth === "number" && header.delegationDepth > 0) ||
        header.origin === "subagent")
    ) {
      return;
    }
    const digest = renderRulesDigest(store.rules(), project, messages);
    if (digest === null) {
      return;
    }
    // inject 属于 Agent 面（core/agent runtime-types：排入最近一个 pre-step 的
    // 模型侧上下文，不唤醒 driver）；Session 没有这个方法。
    // form:'instructions'（packages/llm/llm/src/message.ts 的 ContextForm）显式声明
    // 这段上下文的语义是"模型要遵守的指令"；其中不可信的规则正文已在
    // renderRulesDigest 内逐行定界，帧结构符只可能由本插件产生。
    agent.inject({
      // 载荷就此受官方 `UserMessage` 约束（`Agent["inject"](message: UserMessage)`，
      // installed @deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts）：`id` 是品牌
      // `MessageId`，只能由官方 `brandString` 送出；`source.kind` 由 lib/prompt.ts 那条
      // producer 声明进 `MessageSourceMap`，`form` 是本包自有的上下文语义位。
      id: brandString<MessageId>(`${PLUGIN_NAME}-${randomUUID()}`),
      role: "user",
      content: [{ type: "text", text: digest }],
      source: { kind: LESSON_SOURCE_KIND, form: "instructions" },
    });
    console.info(
      `[lesson-loop] injected ${digest.split("\n").length - 1} armed rule(s) for project ${project}`,
    );
  } catch (error) {
    console.error(`[lesson-loop] session-start inject failed: ${errorText(error)}`);
  }
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
 * 对外服务面（danger-guard / quality-gate / session-rescue 经 ctx.get 消费）。
 * 名字与成员逐个照旧：这份面是 sibling 插件的调用契约，改一位就等于改它们的运行时。
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
  settingsOf: SettingsOf;
  localeMessages: MessagesOf;
  sessionWatch: SessionWatch;
  pruneWatch: () => void;
  syncStore: () => ResolvedSettings;
}

/** 页面策略声明：本包自带卡片，别让宿主再生成一份自动表单页。
 *  0.1.7 起注册是**隐式**的（命名空间 = profile 条目 id，见 cordis.patch.yml），可编辑
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
    // 两枚是**非 volatile** 的部署值：cordis 交进来的是值而不是引用（改值随重启生效）
    // ——带 .get() 会读到一个函数。
    digestTimeoutMs: config.digestTimeoutMs,
    decayIntervalMs: config.decayIntervalMs,
  };
}

/** 建总线与规则引擎：装载期一次性取阈值给构造器，之后每次 report/decay 前都会 syncStore
 *  现读，改动不必重启。 */
function buildLessonStore(
  svc: HostCtx,
  settingsOf: SettingsOf,
  localeMessages: MessagesOf,
): LessonStore {
  const boot = settingsOf();
  return new LessonStore({
    // 事件流水：官方 cache 目录，单写者追加（语义与旧 metrics/lessons.jsonl 一致）。
    lessonsFile: cacheFile("events.jsonl"),
    // 规则库：本条目设置命名空间里的 `rules` 数组（provider 写锁 + revision CAS）。
    rules: createRulesFacet(svc.settings),
    // 起草规则卡正文用的模板表：给取用口而非当下那份，换语言即刻生效（不重启）。
    messages: localeMessages,
    maxLessonsBytes: boot.maxLessonsBytes,
    promoteThreshold: boot.promoteThreshold,
    demoteThreshold: boot.demoteThreshold,
    demoteMinSamples: boot.demoteMinSamples,
    demoteRatio: boot.demoteRatio,
    decayDays: boot.decayDays,
    reviveThreshold: boot.reviveThreshold,
  });
}

/** 装载期一次性迁移：provider 写是异步的，apply 是同步契约 → 起一条链按旧顺序跑
 *  （先收签名碎片、再重算 project 键），两个 helper 各自 catch，故链上不会 reject。 */
function startBootMigrations(store: LessonStore): void {
  void (async (): Promise<void> => {
    await runFragmentMigration(store);
    await runProjectKeyMigration(store);
  })();
}

/** 会话台账 + 它的容量修剪。
 *  sessionId → {project, violated}：会话内复发记账，session/disposed 时清算 suppressed。
 *  容量纪律同 ctx-observe（超 200 丢最旧，防长驻进程无界）。 */
function createSessionWatch(): { sessionWatch: SessionWatch; pruneWatch: () => void } {
  const sessionWatch: SessionWatch = new Map();
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
  return { sessionWatch, pruneWatch };
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
  });
  return cfg;
}

/** 记一条教训。全同步、容错：总线任何故障不外抛（报告方多在守卫热路径上）。 */
async function reportLesson(
  runtime: ApplyRuntime,
  input: LessonReportInput,
): Promise<ReportReceipt> {
  const { store, sessionWatch, pruneWatch, syncStore } = runtime;
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
    // 会话内复发记账（供 suppressed 清算）：armed 命中即登记。
    if (input.sessionId !== undefined && receipt.violationOf !== undefined) {
      const watchEntry = sessionWatch.get(input.sessionId) ?? {
        project,
        violated: new Set<string>(),
        passed: new Set<string>(),
      };
      watchEntry.project = project;
      watchEntry.violated.add(receipt.violationOf.id);
      sessionWatch.set(input.sessionId, watchEntry);
      pruneWatch();
    }
    if (receipt.violationOf !== undefined) {
      console.warn(
        `[lesson-loop] armed rule violated: ${receipt.violationOf.statement.slice(0, 80)}（violation=${receipt.violationOf.violation}）`,
      );
    } else if (receipt.candidate !== undefined && receipt.ready === true) {
      console.info(
        `[lesson-loop] candidate ready for review: ${receipt.candidate.category} / ${receipt.candidate.signature}`,
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
  const { store, sessionWatch, pruneWatch, syncStore } = runtime;
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
      const watchEntry = sessionWatch.get(input.sessionId) ?? {
        project,
        violated: new Set<string>(),
        passed: new Set<string>(),
      };
      watchEntry.project = project;
      watchEntry.passed.add(rule.id);
      sessionWatch.set(input.sessionId, watchEntry);
      pruneWatch();
    }
    return { ok: true };
  } catch (error) {
    console.error(`[lesson-loop] pass failed: ${errorText(error)}`);
    return { ok: false };
  }
}

/** 管理面快照（/stats 的原样载荷 + 卡片副标题用的计数）。 */
function statsSnapshot(runtime: ApplyRuntime): Record<string, unknown> {
  const { store, settingsOf } = runtime;
  const cfg = settingsOf();
  const rules = store.rules();
  return {
    rules,
    lessonsCount: store.lessonsCount(),
    undeterminableCount: store.undeterminableRules().length,
    config: {
      enabled: cfg.enabled,
      reportEnabled: cfg.reportEnabled,
      injectEnabled: cfg.injectEnabled,
      sectionEnabled: cfg.sectionEnabled,
      promoteThreshold: cfg.promoteThreshold,
      demoteThreshold: cfg.demoteThreshold,
      decayDays: cfg.decayDays,
      maxLessonsBytes: cfg.maxLessonsBytes,
    },
  };
}

/** 装配对外服务面：六位里四位是 store 的直通，report/pass/stats 各走自己的 helper。 */
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
      // 规则库落库是异步的（CAS 写），服务面对外契约也是 Promise：等它真的写完再回执。
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
function onAgentCreated(runtime: ApplyRuntime, payloadRaw: AgentCreatedPayload): void {
  const { store, settingsOf, sessionWatch, pruneWatch, localeMessages } = runtime;
  const { agent } = payloadRaw;
  if (agent === undefined) {
    return;
  }
  onSessionStart({
    agent,
    settingsOf,
    store,
    sessionWatch,
    pruneWatch,
    messages: localeMessages(),
  });
}

/** 会话收尾清算：只对本会话 pass 过且未违规的 armed 规则计 suppressed（pass 信号
 *  驱动）。与上报同受 enabled 闸门：插件关闭期间不清算。 */
function onDisposedSession(runtime: ApplyRuntime, sessionRaw: unknown): void {
  const { store, settingsOf, sessionWatch } = runtime;
  if (!settingsOf().enabled) {
    return;
  }
  const idVal = fieldOf(sessionRaw, "id");
  const sid = typeof idVal === "string" ? idVal : undefined;
  if (sid === undefined) {
    return;
  }
  const watchEntry = sessionWatch.get(sid);
  sessionWatch.delete(sid);
  if (watchEntry !== undefined) {
    void settleQuietly(
      store.sessionEnded(watchEntry.project, watchEntry.violated, watchEntry.passed, sid),
      SESSION_ENDED_FAILURE_LABEL,
    );
    return;
  }
  // 兜底：无 start 预种（插件中途装载/旧档续跑）→ 从 header 回填项目，按零复发/零 pass 清算。
  const header = fieldOf(sessionRaw, "header");
  const headerCwd = isRecord(header) ? fieldOf(header, "cwd") : undefined;
  void settleQuietly(
    store.sessionEnded(deriveProject(headerCwd), new Set(), new Set(), sid),
    SESSION_ENDED_FAILURE_LABEL,
  );
}

/** 两枚会话事件的接线（顺序即注册顺序，与拆出前一致）。 */
function wireSessionEvents(runtime: ApplyRuntime): void {
  const { svc } = runtime;
  svc.on("agent/created", (payloadRaw) => {
    onAgentCreated(runtime, payloadRaw);
  });
  svc.on("session/disposed", (sessionRaw) => {
    onDisposedSession(runtime, sessionRaw);
  });
}

/** 常驻 systemPrompt 段（项目无关；webServer/timer/commands 皆可选读）。
 *  开关用动态 text 而不是「注册时读一次」：section 注册在 effect 里只跑一次，
 *  读一次的写法要让设置卡改动生效必须重启。renderPrompt 会丢掉空 text 段
 *  （core/system-prompt/src/index.ts:283），所以关闭时返回空串即完全不参与拼装。 */
function registerPromptSection(runtime: ApplyRuntime): void {
  const { svc, settingsOf, localeMessages } = runtime;
  svc.effect(() => {
    const spRaw = svc.get?.("systemPrompt");
    if (!isSystemPromptService(spRaw)) {
      return noDisposer;
    }
    return spRaw.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text: () => (settingsOf().sectionEnabled ? renderSectionText(localeMessages()) : ""),
    });
  }, "lesson-loop: systemPrompt section");
}

/** 衰减一轮：阈值现读 + 跑 decay；失败只记日志（一轮炸了不许带走后面的轮次）。 */
async function decayOnce(runtime: ApplyRuntime): Promise<void> {
  const { store, syncStore } = runtime;
  try {
    syncStore();
    await store.runDecay();
  } catch (error) {
    console.error(`[lesson-loop] decay failed: ${errorText(error)}`);
  }
}

/** 周期衰减：apply 时立即跑一次，此后每 `decayIntervalMs`（部署值，默认 24h）一轮
 *  （timer 可选读；缺失退化为主管人工）。 */
function registerDecayTimer(runtime: ApplyRuntime): void {
  const { svc, settingsOf } = runtime;
  svc.effect(() => {
    const timerRaw = svc.get?.("timer");
    if (!isTimerService(timerRaw)) {
      return noDisposer;
    }
    const timer = timerRaw;
    // 非 volatile 的部署值：装载期读一次即可（改值随重启生效），故不进 tick 现读。
    const intervalMs = settingsOf().decayIntervalMs;
    void decayOnce(runtime);
    let stopped = false;
    let last: TimerDisposer | undefined;
    const tick = (): void => {
      if (stopped) {
        return;
      }
      // 衰减一轮是异步的（provider 写）：tick 本身仍是 timer 的同步回调，失败由
      // decayOnce 内部 catch，故这里只 void 起链。
      void decayOnce(runtime);
      last = timer.timeout(tick, intervalMs);
    };
    last = timer.timeout(tick, intervalMs);
    return () => {
      stopped = true;
      last?.();
    };
  }, "lesson-loop: decay timer");
}

export function apply(ctx: Context, config: Config): void {
  // 契约守卫收窄（不写断言）：宿主 ctx 必满足 HostCtx 结构，否则属集成错误急停。
  if (!isHostCtx(ctx)) {
    throw new Error("[lesson-loop] host context contract violated");
  }
  const svc: HostCtx = ctx;

  // 命名空间与可编辑字段都是隐式的（宿主从条目 Config 反推，见 cordis.patch.yml），
  // apply 只声明页面策略那一位。
  applySettingsPagePolicy(svc);

  // 每次现读引用当前值：设置卡改完下一个事件/回合即生效，不必重挂载插件。
  const settingsOf: SettingsOf = () => settingsSnapshot(config);

  // host 侧一切文案随官方 locale 偏好走：用户在「设置 → 常规」改语言后，下一条回显/注入
  // 就是新语言（不重启、不另开本包自己的 locale 设置项）。起草新规则卡的 statement 正文
  // 也在这条链上；条目 `rules` 里**已落库**的正文是用户数据，永不因语言切换被改写。
  // 跨命名空间读在 0.1.7 只有 describe() 一条路（未装 client-locale / 那条没有 volatile
  // 字段 → 宿主不投影它 → undefined → 中文默认）。返回值域按 `readonly unknown[]` 收，
  // 故字段一律经 `fieldOf` 从 unknown 读——与规则库那条链同一口径：「读到了东西」不等于
  // 「读得懂」，读不懂就退中文默认，绝不按声明猜。
  //
  // 偏好读一次即缓存：describe() 对每个活跃条目都要 schema.toJSON() + JSON.stringify 算
  // revision 再投影三份，而 systemPrompt section 的 text 每次提示词装配都求值——那是本包
  // 频度最高的读点。失效靠宿主推送：写配置 → app-boot/config-reload → SettingsForms
  // invalidate() → 微任务里 describe() → 对 raw 变化的条目 emit('settings/document-updated')。
  let cachedPreference: unknown = undefined;
  let hasCachedPreference = false;
  svc.on("settings/document-updated", (ns: unknown) => {
    if (ns === LOCALE_SETTINGS_NAMESPACE) {
      hasCachedPreference = false;
    }
  });
  const localeMessages: MessagesOf = (): LessonLoopMessages => {
    // **缺席不缓存**：locale 条目可能晚于本条目才到位，缓存一次缺席就把语言跟随永久钉死。
    if (!hasCachedPreference) {
      const row = svc.settings
        .describe()
        .find((item) => fieldOf(item, "ns") === LOCALE_SETTINGS_NAMESPACE);
      if (row !== undefined) {
        cachedPreference = fieldOf(row, "value");
        hasCachedPreference = true;
      }
    }
    return messagesFor(
      MESSAGES,
      resolveLocalePreference(hasCachedPreference ? cachedPreference : undefined),
    );
  };

  const store = buildLessonStore(svc, settingsOf, localeMessages);

  startBootMigrations(store);

  // sessionId → 台账：会话内复发记账，session/disposed 时清算 suppressed。
  const { sessionWatch, pruneWatch } = createSessionWatch();

  // settings → store 的阈值同步（pull：每次 report/decay 前执行）。
  const syncStore = (): ResolvedSettings => syncStoreFrom(store, settingsOf);

  // 各段共用的运行期：一次装载构造一份，按引用往下传（Map/store 原地读写，不必再装箱）。
  const runtime: ApplyRuntime = {
    svc,
    store,
    settingsOf,
    localeMessages,
    sessionWatch,
    pruneWatch,
    syncStore,
  };

  /** 对外服务面（danger-guard / quality-gate / session-rescue 经 ctx.get 消费）。 */
  const service = createLessonLoopService(runtime);

  provideLessonLoopService(svc, service);

  // 会话事件接线：agent/created → 预种台账 + armed 规则注入；session/disposed → 收尾清算。
  wireSessionEvents(runtime);

  // 退出/热卸载兜底清算：headless 与 CLI 进程里 session/disposed 往往来不及送达，
  // 只挂事件的收尾在这些进程恒不执行（度量因此恒 0、规则永远不可判定）。
  svc.effect(
    () => settleOpenSessionsOnDispose({ store, sessionWatch, settingsOf }),
    "lesson-loop: 退出清算",
  );

  // 常驻 systemPrompt 段（项目无关；webServer/timer/commands 皆可选读）。
  registerPromptSection(runtime);

  // /lessons-digest 命令（人工触发蒸馏；commands 服务可选读——缺失只 warn 一次）。
  registerDigestCommand(svc, store, settingsOf, localeMessages);

  // 周期衰减：apply 时立即跑一次，此后每 `decayIntervalMs`（部署值，默认 24h）一轮
  // （timer 可选读；缺失退化为主管人工）。
  registerDecayTimer(runtime);

  // webServer 端点：GET stats/rules/lessons（下发 csrf）+ POST rule-action（csrf 校验）。
  // ⚠ 这里走 inject 而不是在 apply 里读一次服务：`ctx.get` 是无 inject 语义的存储读，官方
  // 注释本身就写着 "or `undefined` when not (**yet**) provided"（installed
  // @deepseek-ai/cordis/lib/types/reflect.d.ts:10-14）。真实宿主上 webServer 比本条目晚到位
  // （隔离 DSH_HOME 实测：apply 当场 get 返回 undefined，+1.3s 才交得出实例），旧写法的后果是
  // 四条路由永不注册、设置页只剩一张空白卡片，而卡片端两头都没有报错。子 fiber 在依赖到位时
  // 才激活、依赖换实例时先卸后装（同文件 registry.d.ts:97），效应挂在**子上下文**上即得
  // 「后到即注册、重启即重注册」。不写进插件级 inject：那会让没有 webServer 的宿主（TUI）
  // 连沉淀与注入一并失活——那些能力只需要 settings。
  svc.inject(["webServer"], (child) => {
    registerRoutes(svc, child, store, () => service.stats(), localeMessages);
  });
}

export default {
  inject: ["settings"],
  // 入口键必须是 `Config`（cordis registry 只认这个键；写成 ConfigSchema 时校验静默失效）。
  Config: configSchema,
  apply,
};
