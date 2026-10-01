// host 全链测试：mock ctx 驱动 lesson-loop 的注册面（0.1.7 隐式设置投影 + 页面策略）
// 与服务供给 / 上报 / 收尾清算 / 会话开始注入 / webServer 端点（csrf）/ /lessons-digest
// 命令 / 衰减定时器。
import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as flushAsync } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import plugin, { cacheFile, isSettingsProvider } from "../host.ts";
import { LessonStore, PERSIST_FAILED, deriveProject } from "../lib/lesson-store.ts";
import type {
  LessonRecord,
  ReportReceipt,
  RuleActionResult,
  RuleCard,
} from "../lib/lesson-store.ts";
import { RULES_FIELD, SETTINGS_NAMESPACE, cardsOfValue } from "../lib/rules-layout.ts";
import { MESSAGES, fill } from "../lib/messages.ts";
import { makeSettingsProvider } from "./rules-fake.ts";
import type { SettingsProviderFake } from "./rules-fake.ts";
import type { LlmService } from "../lib/digest.ts";

let scratch: string;
let origDshHome: string | undefined;

// ── mock ctx ─────────────────────────────────────────────────────────────

interface FakeReq {
  method: string;
  url?: string;
  headers?: Record<string, unknown>;
  /** 供 readBody 的 `for await` 逐 chunk 消费的请求载荷。 */
  chunks: unknown[];
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
}

interface FakeRes {
  code?: number;
  body?: string;
  headers?: Record<string, unknown>;
  writeHead: (code: number, headers?: Record<string, unknown>) => FakeRes;
  end: (body?: string) => FakeRes;
  setHeader: (name: string, value: unknown) => FakeRes;
}

/**
 * 0.1.7 的 settings 服务面（`register`/`get`/`installSection` 已被宿主移除）：
 * describe（读，含跨命名空间的 locale）+ update（规则库 CAS 写）+ configure（页面策略）。
 * 对照 installed `@deepseek-ai/dsh-settings/lib/types/index.d.ts`：SettingsForms 残面是
 * `configure`(:80) / `prepareDocument`(:91) / `describe`(:96) / `update`(:102) /
 * `replace`(:108) / `mutate`(:114)。本包只装用得到的三件——写走 `update(ns, patch,
 * expectedRevision)`（merge 写，数组键整片覆盖，正是规则库要的语义），不用 `mutate`
 * （那是给脱敏视图做路径级编辑、避免覆掉 secret 的路子，本包一段里没有 secret）。
 * ⚠ 这份清单**不许**再补回 register/get：假件一旦有它们，host.ts 里"没有注册可被打回"
 * 那几条降级分支就只能在假绿里躺着（真宿主 0.1.7 根本没有那两个方法）。
 */
interface SettingsSurface {
  describe: () => unknown[];
  update: (ns: string, patch: object, expectedRevision?: number) => Promise<void>;
  configure: (presentation: { auto?: boolean }, owner?: unknown) => () => void;
}

/** 一次 settings.configure() 的调用记录（页面策略断言用）。 */
interface ConfigureCall {
  presentation: { auto?: boolean };
  owner: unknown;
}

interface FakeCtx {
  /** 条目段在假件文档里的那一层原文（测试中途翻开关就是翻它）。 */
  value: Record<string, unknown>;
  /** 交进 apply 的那份 Config：volatile 字段是读穿假件的引用，非 volatile 是普通值。 */
  config: Record<string, unknown>;
  services: Record<string, unknown>;
  handlers: Record<string, ((payload: unknown, ...rest: unknown[]) => void)[]>;
  provided: Record<string, unknown>;
  /** 官方 Disposable 允许异步（fiber.d.ts:41 注释：异步 disposer 由卸载 await）。 */
  effects: (() => unknown)[];
  routes: Record<string, (req: FakeReq, res: FakeRes) => void>;
  command: {
    desc: Record<string, unknown>;
    handler: (
      inv: unknown,
    ) => { kind: string; text: string } | Promise<{ kind: string; text: string }>;
  } | null;
  section: {
    name: string;
    order: number;
    text: string | ((context: unknown) => string);
  } | null;
  timerCallbacks: (() => void)[];
  /** 与 timerCallbacks 同序登记的毫秒数（decayIntervalMs 走配置就得在这里看得见）。 */
  timerMs: number[];
  /** 本插件 fiber 的替身：configure 的 owner 必须原样带回它（身份断言用）。 */
  fiber: unknown;
  /** settings.configure 的调用记录（页面策略断言用）。 */
  configureCalls: ConfigureCall[];
  /** ctx.inject 收到的依赖清单（页面策略挂在哪个子上下文上，靠它核对）。 */
  injectDeps: string[][];
  /** 官方 locale 命名空间那一行的 value（0.1.7 唯一的读口是 `describe()`：宿主已无
   *  `settings.get`。可装载后翻动，模拟换语言即时生效；undefined = 未注册 → 中文）。 */
  localeValue: Record<string, unknown> | undefined;
  settings: SettingsSurface;
  /** 规则库落在那儿的 settings 假件：注入存量行、数写次数、制造冲突都走它。 */
  rulesProvider: SettingsProviderFake;
  provide: (name: string, value: unknown) => () => void;
  get: (name: string) => unknown;
  /** 官方 `ctx.sessionQuery.observeSession()` 交回的事件流（/lessons-digest 的差评来源）。
   *  迁移前这一档由 `agent.session.snapshotEvents()` 给；官方已把那条同步读面标为
   *  `@deprecated`，host 侧改走 sessionQuery（见 host.ts 的 digestEvents），假件因此挪到这里。 */
  sessionEvents: Record<string, unknown>[];
  inject: (deps: readonly string[], attach: (child: unknown) => void) => void;
  on: (event: string, handler: (payload: unknown, ...rest: unknown[]) => void) => void;
  effect: (fn: () => (() => void) | undefined) => void;
}

/** 段文本求值：text 允许是 provider（每次拼装时求值）。 */
function textOf(section: { text: string | ((context: unknown) => string) } | null): string {
  const text = section?.text;
  if (typeof text === "function") {
    return text(undefined);
  }
  return text ?? "";
}

/** 导出 Config schema 的字段名清单（单源：不手写，漏字段就是测试的事）。 */
const CONFIG_KEYS: string[] = Object.keys(
  (plugin.Config as unknown as { dict: Record<string, unknown> }).dict,
);

/**
 * 复刻 cordis 交进 apply 的那份 Config：每个 volatile 字段一枚**稳定引用**，其 get() 现读
 * 假件解析值——与真实 Volatile 的"引用不变、值可变"同构（官方读面只有 `get()`，见
 * vendor/cosmokit/src/volatile.ts:9-11；createVolatile 的返回值另挂 symbol 键 `[write]`，
 * 见同文件 :39-45，故按 `get()` 认形状即可）。
 */
function liveConfigRefs(read: (key: string) => unknown): Record<string, unknown> {
  // volatile 字段是稳定引用（值可变）；**非 volatile**（蒸馏超时与衰减周期）是普通
  // 值快照——给它们 .get() 会让插件读到一个函数，真宿主从不这样交。
  const { dict } = plugin.Config as unknown as { dict: Record<string, SchemaNode> };
  return Object.fromEntries(
    CONFIG_KEYS.map((key) =>
      dict[key]?.meta?.["volatile"] === true
        ? [key, { get: () => read(key) }]
        : [key, read(key) ?? dict[key]?.meta?.["default"]],
    ),
  );
}

function makeCtx(
  over: {
    /** 行级 config 的等价物：直接落进条目段的那一层原文（缺省字段由 schema 默认填）。 */
    value?: Record<string, unknown>;
    services?: Record<string, unknown>;
    /** 规则库的存量行（装载期迁移与"另一进程已写过"的场景都从这里注入）。 */
    rules?: readonly (RuleCard | Record<string, unknown>)[];
    /** 官方 locale 命名空间的初值（describe() 里 ns==='locale' 那条的 value）；
     *  缺省 = 未注册 → 中文。装载后翻动 `ctx.localeValue` 即可模拟换语言。 */
    locale?: Record<string, unknown> | null;
  } = {},
): FakeCtx {
  const initialRules = over.rules ?? [];
  // 0.1.7：一个条目一段——开关与 rules 数组同处 `lesson-loop` 段（假件按真实导出的
  // Config 解析，默认值与 .loose() 因此都与宿主同源）。
  const rulesProvider = makeSettingsProvider({
    [SETTINGS_NAMESPACE]: { [RULES_FIELD]: [...initialRules], ...over.value },
  });
  const ctx: FakeCtx = {
    // 假件文档里的那一层原文（同一引用：翻它 = 翻条目段，下一次读即生效）。
    value: rulesProvider.peek(SETTINGS_NAMESPACE) ?? {},
    config: liveConfigRefs((key) => rulesProvider.resolvedOf(SETTINGS_NAMESPACE)[key]),
    services: over.services ?? {},
    // 蒸馏事件流的默认交付：空表（个别用例往里塞 feedback 事件）。
    sessionEvents: [],
    // 这四个假件字段不写 `{} as …` 断言：`const ctx: FakeCtx` 已给出上下文类型，
    // 断言在 oxlint 的类型感知规则下就是冗余（0.1.7 迁移把 describe() 的返回收成
    // unknown[]、给 ctx 补上 FakeCtx 标注之后，它们成了迁移漏下的四条 lint 错）。
    handlers: {},
    provided: {},
    effects: [],
    routes: {},
    command: null as null | {
      desc: Record<string, unknown>;
      handler: (
        inv: unknown,
      ) => { kind: string; text: string } | Promise<{ kind: string; text: string }>;
    },
    section: null as null | {
      name: string;
      order: number;
      text: string | ((context: unknown) => string);
    },
    timerCallbacks: [] as (() => void)[],
    timerMs: [] as number[],
    fiber: { id: "lesson-loop-fiber" },
    configureCalls: [],
    injectDeps: [],
    localeValue: over.locale as Record<string, unknown> | undefined,
    rulesProvider,
    settings: {
      /** 唯一的读口：本条目那一行（规则库）+ 可选的官方 locale 行（跨命名空间读）。 */
      describe: () => {
        const rows = rulesProvider.describe();
        return ctx.localeValue === undefined
          ? rows
          : [...rows, { ns: "locale", value: ctx.localeValue }];
      },
      update: (ns: string, patch: object, expectedRevision?: number) =>
        rulesProvider.update(ns, patch, expectedRevision),
      /** 页面策略登记：宿主用它决定要不要自动生成表单页。 */
      configure: (presentation: { auto?: boolean }, owner?: unknown) => {
        ctx.configureCalls.push({ presentation, owner });
        return (): void => {
          void 0;
        };
      },
    },
    provide(name: string, value: unknown) {
      ctx.provided[name] = value;
      return () => {
        Reflect.deleteProperty(ctx.provided, name);
      };
    },
    get(name: string) {
      return ctx.services[name];
    },
    /** ctx.inject(deps, fn)：cordis 立即用带齐依赖的子上下文回调一次。 */
    inject(deps: readonly string[], attach: (child: unknown) => void) {
      ctx.injectDeps.push([...deps]);
      attach({
        settings: {
          configure: ctx.settings.configure,
        },
        // 子上下文的 effect 与父面**同构**：disposer 一样进 ctx.effects。少了这一层，
        // "卸载 → 四条路由全部注销"那条断言就失去了观测点（旧实现把路由效应挂在父 ctx 上，
        // disposer 自然在清单里；改挂子 ctx 后若子面丢弃 disposer，注销语义就成了空话）。
        effect(factory: () => (() => unknown) | undefined) {
          const disposer = factory();
          if (typeof disposer === "function") {
            ctx.effects.push(disposer);
          }
        },
      });
    },
    on(event: string, handler: (payload: unknown, ...rest: unknown[]) => void) {
      (ctx.handlers[event] ??= []).push(handler);
    },
    effect(fn: () => (() => unknown) | undefined) {
      const disposer = fn();
      if (typeof disposer === "function") {
        ctx.effects.push(disposer);
      }
    },
  };
  // 默认服务面（测试按需覆盖 services 字段）
  ctx.services["webServer"] = {
    register(route: { path: string; handler: (req: FakeReq, res: FakeRes) => void }) {
      ctx.routes[route.path] = route.handler;
      return () => {
        Reflect.deleteProperty(ctx.routes, route.path);
      };
    },
  };
  ctx.services["systemPrompt"] = {
    section(desc: { name: string; order: number; text: string }) {
      ctx.section = desc;
      return () => {
        // 测试 ctx：systemPrompt 段无收尾资源
      };
    },
  };
  ctx.services["timer"] = {
    timeout(fn: () => void, ms: number) {
      ctx.timerCallbacks.push(fn);
      ctx.timerMs.push(ms);
      return () => {
        // 测试 ctx：timer 无收尾资源
      };
    },
  };
  // 蒸馏要用的会话事件流经**官方** `ctx.sessionQuery.observeSession()` 取（host 侧
  // digestEvents 的读面）：默认空事件流，个别用例改 ctx.queryEvents。
  ctx.services["sessionQuery"] = {
    observeSession: async () => ({ events: ctx.sessionEvents }),
  };
  ctx.services["commands"] = {
    register(desc: Record<string, unknown>, handler?: unknown) {
      // dsh commands.register(desc) — handler 在 desc 内（command-feedback 契约）
      const cmdHandler = (desc as { handler?: unknown }).handler ?? handler;
      ctx.command = { desc, handler: cmdHandler as never };
      return () => {
        // 测试 ctx：command 无收尾资源
      };
    },
  };
  return ctx;
}

function apply(ctx: FakeCtx): void {
  plugin.apply(ctx as never, ctx.config as never);
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    writeHead(code, headers) {
      res.code = code;
      if (headers !== undefined) {
        // Node 的 writeHead(status, headers) 是**并入**已 setHeader 的项，不是替换；
        // 这里原来是整份覆盖，于是 405 的 `Allow` 在假响应里凭空消失（真机上不会）。
        // 夹具按 Node 的语义合，断言才落在被测代码上而不是夹具上。
        res.headers = { ...res.headers, ...headers };
      }
      return res;
    },
    end(body) {
      if (body !== undefined) {
        res.body = body;
      }
      return res;
    },
    setHeader(name, value) {
      res.headers = { ...res.headers, [name]: value };
      return res;
    },
  };
  return res;
}

function makeReq(over: Partial<FakeReq> = {}): FakeReq {
  const chunks = over.chunks ?? [];
  const req: FakeReq = {
    method: over.method ?? "GET",
    url: over.url ?? "/",
    headers: over.headers ?? {},
    chunks,
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      let cursor = 0;
      return {
        next: async () => {
          if (cursor < chunks.length) {
            const block = chunks[cursor];
            cursor += 1;
            return { value: block, done: false };
          }
          return { value: undefined, done: true };
        },
      };
    },
  };
  return req;
}

/** rule-action 端点 handler 是 fire-and-forget（同步 wrapper + void 内部 async），
 *  落盘响应在微任务队列完成；setImmediate（宏任务）可保证其已 flush（防时序假设）。 */

/** rule-action POST：模拟 async-iterable body（readBody 的 for await 消费 chunks）。
 *  触发 handler 后冲刷宏任务，待内部 async 处理完成再回读响应。 */
async function postJson(
  ctx: FakeCtx,
  routePath: string,
  body: unknown,
  headers: Record<string, unknown> = {},
): Promise<FakeRes> {
  return (async () => {
    const res = makeRes();
    const req = makeReq({
      method: "POST",
      url: routePath,
      headers,
      chunks: [JSON.stringify(body)],
    });
    ctx.routes[routePath]?.(req, res);
    await flushAsync();
    return res;
  })();
}

// ── 端点/服务面公共小件 ───────────────────────────────────────────────────

const STATS_ROUTE = "/_dsh/lesson-loop/stats";
const RULES_ROUTE = "/_dsh/lesson-loop/rules";
const LESSONS_ROUTE = "/_dsh/lesson-loop/lessons";
const RULE_ACTION_ROUTE = "/_dsh/lesson-loop/rule-action";

// ── 夹具字面量（本文件内重复的输入数据与期望值，逐枚命名）───────────────
// 全部是测试侧自己写的字面量：本文件从不指向 lib/prompt.ts 的 PLUGIN_NAME/SECTION_NAME
// 或 lesson-store 的来源枚举——引常量就成了自证，常量改了该先红。
/** 本包条目 id = 设置命名空间 = systemPrompt 段名 = cache 子目录名（宿主按同一个串匹配）。 */
const PLUGIN_ID_FIXTURE = "lesson-loop";
/** 事件流水的文件名（落在 `cache/<条目 id>/` 下，host 侧由 cacheFile 拼）。 */
const EVENTS_FILE_NAME = "events.jsonl";
/** 门禁失败上报夹具四件套：来源 / 分类 / 工作目录 / 签名（armedRule 造卡与各处回读同一笔）。 */
const SOURCE_QUALITY_GATE = "quality-gate";
const CATEGORY_GATE_FAILURE = "gate-failure";
const GATE_PROJECT_CWD = "/repo/proj";
const SIGNATURE_GATE_COMMAND = "pnpm check";
/** danger-guard 来源 + factgate-deny 分类：碎片行/迁移样本用的另一对生产者与分类。 */
const SOURCE_DANGER_GUARD = "danger-guard";
const CATEGORY_FACTGATE_DENY = "factgate-deny";
/** 桶键夹具（project 键迁移用例的新旧键之一）。 */
const PROJECT_KEY_FIXTURE = "proj-6b906b9c";
/** 官方 `StreamChunk` 的文本增量判别位（假 llm 回包用）。 */
const CHUNK_TEXT_DELTA = "text-delta";
/** HOME 兜底用例里假定的家目录（DSH_HOME 未设时 cache 应落在这里）。 */
const TEST_HOME_DIR = "/home/tester";
/** 门禁命令的另一种形态：gate-failure 签名夹具（与 pnpm check 同位、不同值）。 */
const SIGNATURE_CARGO_TEST = "cargo test";

/** 规则库段落的存量行注入用（makeCtx({rules}) 与持久化断言都读它）。 */
const rulesOf = (ctx: FakeCtx): RuleCard[] =>
  cardsOfValue(ctx.rulesProvider.peek(SETTINGS_NAMESPACE));

/** lessonLoop 服务面的动作名（与 host 的 ruleAction 参数同集）。 */
type ActionName = "arm" | "reject" | "demote" | "archive" | "edit" | "revive";

/** lessonLoop 服务面投影（测试只用到这些方法；report/ruleAction 自规则库进 settings 起即异步）。 */
interface LoopService {
  report: (input: Record<string, unknown>) => Promise<ReportReceipt>;
  pass: (input: Record<string, unknown>) => { ok: boolean };
  rules: () => RuleCard[];
  ruleAction: (id: string, action: ActionName, statement?: string) => Promise<RuleActionResult>;
  recentLessons: (project?: string, limit?: number) => LessonRecord[];
  stats: () => Record<string, unknown>;
}

function loopService(ctx: FakeCtx): LoopService {
  const svc = ctx.provided["lessonLoop"];
  assert.notEqual(svc, undefined, "lessonLoop 服务未提供");
  return svc as LoopService;
}

/** 触发官方 agent/created（0.1.6-alpha.2 载荷 {agent, source, signal}）。 */
function fireCreated(ctx: FakeCtx, agent: unknown): void {
  assert.ok(ctx.handlers["agent/created"]?.[0], "agent/created 未接线");
  ctx.handlers["agent/created"][0]({ agent });
}

/** 触发 session/disposed。 */
function fireDisposed(ctx: FakeCtx, session: unknown): void {
  assert.ok(ctx.handlers["session/disposed"]?.[0], "session/disposed 未接线");
  ctx.handlers["session/disposed"][0](session);
}

/** 触发 settings/document-updated：宿主在某命名空间的设置文档变化时推送，
 *  locale 偏好缓存据此失效。命名空间原样传入，便于验证"别的条目变更不误伤本包缓存"。 */
function fireSettingsUpdated(ctx: FakeCtx, ns: string): void {
  const handlers = ctx.handlers["settings/document-updated"] ?? [];
  assert.ok(handlers.length > 0, "settings/document-updated 未接线");
  for (const handler of handlers) {
    handler(ns);
  }
}

/** 从 stats GET 取本实例的 csrf（rule-action 端点要带它）。 */
function csrfOf(ctx: FakeCtx): string {
  const res = makeRes();
  ctx.routes[STATS_ROUTE]?.(makeReq(), res);
  return String((JSON.parse(String(res.body)) as { csrf?: string }).csrf);
}

/** 走真实总线造一张 armed 规则卡（gate-failure / pnpm check @ /repo/proj），返回 id。 */
async function armedRule(ctx: FakeCtx, over: Record<string, unknown> = {}): Promise<string> {
  const svc = loopService(ctx);
  const receipt = await svc.report({
    source: SOURCE_QUALITY_GATE,
    category: CATEGORY_GATE_FAILURE,
    cwd: GATE_PROJECT_CWD,
    signature: SIGNATURE_GATE_COMMAND,
    detail: "门禁失败一次",
    ...over,
  });
  const id = receipt.candidate?.id;
  if (id === undefined) {
    throw new Error("候选卡缺失");
  }
  assert.equal(await svc.ruleAction(id, "arm"), "persisted");
  return id;
}

/** 固定回包的假 llm（可顺带捕获真正进模型的提示词全文）。 */
function fakeLlm(response: string, capture?: { prompt?: string | undefined }): LlmService {
  return {
    async *stream(options: Parameters<LlmService["stream"]>[0]) {
      if (capture !== undefined) {
        // 官方 content 是 `readonly ContentBlock[]` 判别联合：按 kind 收窄再读 text。
        const first = options.messages[0]?.content[0];
        capture.prompt = first?.type === "text" ? first.text : undefined;
      }
      yield { type: CHUNK_TEXT_DELTA, index: 0, text: response };
      yield { type: "finish", reason: { kind: "stop" } };
    },
  };
}

/** /lessons-digest 的最小会话内 invocation（事件流由 ctx.sessionEvents 给，不在这里挂）。 */
function digestInvocation(rawInput = "", cwd = GATE_PROJECT_CWD): Record<string, unknown> {
  return {
    agent: { session: { id: "s1", header: { cwd } } },
    rawInput,
  };
}

/** 规则库里的路径型碎片行（存量迁移测试的样本）。 */
function fragmentRow(id: string, signature: string): Record<string, unknown> {
  return {
    id,
    project: "p-1234abcd",
    category: CATEGORY_FACTGATE_DENY,
    signature,
    statement: `编辑 ${signature} 前先 read`,
    status: "candidate",
    createdAt: 1,
    updatedAt: 1,
    occurrences: 1,
    sources: [],
    violation: 0,
    suppressed: 0,
    recurrences: 0,
    evidence: [],
    origin: "threshold",
  };
}

/** project 键迁移的存量行：带 cwd（migrateProjectKeys 的唯一依据）与旧/新桶键。
 *  两张同 category+signature 的行只有 project 不同，重算后必然撞同一张卡。 */
function projectKeyRow(id: string, project: string, cwd: string): Record<string, unknown> {
  return {
    ...fragmentRow(id, SIGNATURE_GATE_COMMAND),
    project,
    cwd,
    category: CATEGORY_GATE_FAILURE,
    statement: `门禁 pnpm check（${id}）`,
    evidence: [{ ts: 1, source: SOURCE_DANGER_GUARD, detail: `${id} 证据` }],
  };
}

/** 预置一张"armed 极久、零复发零遵守、连 samples 字段都没有"的存量卡行。
 *  走真实装载路径，顺带验证 legacy 缺 samples 归一为 0、迁移不碰它。 */
function undeterminableRow(): Record<string, unknown> {
  return {
    id: "rule-und",
    project: PROJECT_KEY_FIXTURE,
    category: CATEGORY_GATE_FAILURE,
    signature: SIGNATURE_GATE_COMMAND,
    statement: "从没被测到过的老规则",
    status: "armed",
    createdAt: 1,
    updatedAt: 1,
    armedAt: 1,
    occurrences: 1,
    sources: [],
    violation: 0,
    suppressed: 0,
    recurrences: 0,
    evidence: [],
    origin: "threshold",
  };
}

/** 入口 Config schema 的同步校验结果（standard-schema 允许异步，schemastery 不异步；
 *  cordis 的 resolveConfig 遇到 Promise 结果直接抛 TypeError，故异步形状即契约漂移）。 */
function configIssues(value: unknown): readonly unknown[] | undefined {
  const result = plugin.Config["~standard"].validate(value);
  if (typeof result === "object" && "then" in result) {
    throw new TypeError("config schema 必须同步校验");
  }
  return result.issues;
}

/** 按 cordis 的同一条路解析一份行 config，取某个 volatile 字段的当前值。 */
function resolvedFieldOf(section: unknown, key: string): unknown {
  const result = plugin.Config["~standard"].validate(section) as {
    value?: Record<string, { get: () => unknown }>;
  };
  return result.value?.[key]?.get();
}

/** Config schema 的字段节点（读 meta/type/dict 用，不复制 schema 结构）。 */
interface SchemaNode {
  type?: string;
  meta?: Record<string, unknown>;
  dict?: Record<string, SchemaNode>;
}

/** 导出 Config schema 的 dict（单源：字段名与元数据都从宿主实际读的那份来）。 */
function configDict(): Record<string, SchemaNode> {
  return (plugin.Config as unknown as SchemaNode).dict ?? {};
}

/** 逐字段 schema 默认 —— 等价于 0.1.6 交给 `settings.register(ns, schema, { base })`
 *  的那份 BUILTIN_BASE，0.1.7 把它搬到了 schema 的 `.default()` 上（少一层「底座」）。 */
function schemaDefaults(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(configDict()).map(([key, field]) => [key, field.meta?.["default"]]),
  );
}

/**
 * 复刻宿主 packages/settings/settings/src/schema.ts:37-47 的 volatileForm()：
 * 「自身标了 volatile」或「是 object 且子树里有可编辑字段」的字段才进表单。
 * @returns 顶层 object 时给表单字段名清单；叶子可编辑时给 []；
 *  null = 该子树没有任何可编辑字段 → 宿主 describe() 会整条跳过本条目
 *  （settings/index.ts:308-309），写入则抛 `has no volatile fields`（:386）。
 *  （用 null 而不是 undefined 表"没有"：本仓 lint 的 consistent-return 配了
 *  `treatUndefinedAsUnspecified`，`return undefined` 记作无值返回、与 `return []` 冲突。）
 */
function volatileFormOf(node: SchemaNode): string[] | null {
  if (node.meta?.["volatile"] === true) {
    return [];
  }
  if (node.type !== "object") {
    return null;
  }
  const kept = Object.entries(node.dict ?? {}).flatMap(([key, child]) =>
    volatileFormOf(child) === null ? [] : [key],
  );
  return kept.length === 0 ? null : kept;
}

/** cordis.patch.yml 里的裸条目 id —— 0.1.7 的 settings 命名空间就是它。
 *  读文件而不是抄常量：卡片绑的段 / 端点前缀 / 规则库读的段都按它对齐，写死会让测试与包体漂移。 */
function patchEntryId(): string {
  const yml = readFileSync(fileURLToPath(new URL("../cordis.patch.yml", import.meta.url)), "utf8");
  const match = /^\s*-\s+id:\s*(?<id>\S+)\s*$/mu.exec(yml);
  const id = match?.groups?.["id"];
  assert.ok(typeof id === "string" && id.length > 0, "cordis.patch.yml 里没有裸 `- id:` 条目");
  return id;
}

/** disposer 交回值是否可 await（官方允许异步 disposer 并由拆纤 await，
 *  cordis fiber.d.ts:38-41「they may be async, in which case unloading awaits them」）。 */
function isThenable(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return "then" in value && typeof value["then"] === "function";
}

/** 设置卡该能编辑的字段：11 项开关/阈值 + 规则库那枚数组，一个都不该漏。 */
/** 字段化的两枚部署值：在 Config 上但**不标** volatile ⇒ 不进设置卡。 */
const DEPLOYMENT_FIELDS = ["digestTimeoutMs", "decayIntervalMs"];

const EDITABLE_FIELDS = [
  "decayDays",
  "demoteMinSamples",
  "demoteRatio",
  "demoteThreshold",
  "enabled",
  "injectEnabled",
  "maxLessonsBytes",
  "promoteThreshold",
  "reportEnabled",
  "reviveThreshold",
  "rules",
  "sectionEnabled",
];

describe("host：lesson-loop 的宿主半", () => {
  beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "lesson-host-"));
    origDshHome = process.env["DSH_HOME"];
    process.env["DSH_HOME"] = scratch;
  });

  afterEach(() => {
    // 兜底：任何一条断言先炸也不把 prototype spy 漏给下一条（各测试内不再手写 restore）。
    vi.restoreAllMocks();
    if (origDshHome === undefined) {
      delete process.env["DSH_HOME"];
    } else {
      process.env["DSH_HOME"] = origDshHome;
    }
    rmSync(scratch, { recursive: true, force: true });
  });

  describe("服务供给", () => {
    it("apply 后 ctx.provide 挂上 lessonLoop 服务（report/rules/ruleAction/stats）", () => {
      const ctx = makeCtx();
      apply(ctx);
      const svc = ctx.provided["lessonLoop"] as Record<string, unknown> | undefined;
      assert.ok(svc, "lessonLoop 服务未提供");
      for (const method of ["report", "rules", "ruleAction", "stats", "recentLessons"]) {
        assert.equal(typeof svc[method], "function", `缺方法 ${method}`);
      }
    });

    it("常驻 systemPrompt 段注册（order 1560，text 为每次拼装求值的 provider）", () => {
      const ctx = makeCtx();
      apply(ctx);
      assert.equal(ctx.section?.name, PLUGIN_ID_FIXTURE);
      assert.equal(ctx.section.order, 1560);
      assert.match(textOf(ctx.section), /自进化环/u);
    });

    it("locale 偏好读一次即缓存：重复求值不重复 describe，推送失效信号后才重读", () => {
      // 段的 text 每次提示词装配都求值 → localeMessages 是本包频度最高的读点，
      // 而 describe() 对每个活跃条目都要 schema.toJSON() + JSON.stringify 算 revision。
      const ctx = makeCtx();
      ctx.localeValue = { preference: "zh" };
      let describeCalls = 0;
      const base = ctx.settings.describe;
      ctx.settings.describe = (): unknown[] => {
        describeCalls += 1;
        return base();
      };
      apply(ctx);
      // 那个读口还被规则库共用，装配期就调过若干次；且装配链路（store/digest）会先
      // 取一次 locale 把缓存捂热。故以「装配后的计数」为基线，只看后续的增量。
      const warm = describeCalls;
      assert.match(textOf(ctx.section), /自进化环/u, "缓存捂热时装配期读的是中文");
      assert.equal(describeCalls, warm, "缓存捂热后重复求值不再读 describe()");

      fireSettingsUpdated(ctx, "other-plugin");
      assert.match(textOf(ctx.section), /自进化环/u, "别的命名空间变更后仍走缓存");
      assert.equal(describeCalls, warm, "别的命名空间变更不误伤本包的缓存");

      // 宿主推的是「locale 这条变了」，但描述符此刻还没变：仍用已缓存的文案。
      fireSettingsUpdated(ctx, "locale");
      textOf(ctx.section);
      assert.equal(describeCalls, warm + 1, "locale 失效后重读一次");

      // 上一步重读到的是「失效那一刻」的描述符，那会儿还是中文。描述符真变了之后，
      // 宿主再推一次失效信号，重读才拿得到新文案——这正是推送式失效的契约。
      ctx.localeValue = { preference: "en" };
      fireSettingsUpdated(ctx, "locale");
      assert.match(textOf(ctx.section), /self-evolution loop/u, "重读后文案换成英文");
      assert.equal(describeCalls, warm + 2, "换语言那趟又读了一次");
      assert.match(textOf(ctx.section), /self-evolution loop/u, "此后回到缓存");
      assert.equal(describeCalls, warm + 2, "新语言同样只读一次");
    });

    it("缺席不缓存：locale 条目迟到时每趟都重读，语言不会被永久钉死", () => {
      const ctx = makeCtx();
      let describeCalls = 0;
      const base = ctx.settings.describe;
      ctx.settings.describe = (): unknown[] => {
        describeCalls += 1;
        return base();
      };
      apply(ctx);
      const afterApply = describeCalls;
      textOf(ctx.section);
      const afterFirst = describeCalls;
      assert.ok(afterFirst > afterApply, "条目缺席时不缓存：这一趟又读了 describe()");
      textOf(ctx.section);
      assert.ok(describeCalls > afterFirst, "缺席时每趟都重读");

      ctx.localeValue = { preference: "en" };
      assert.match(textOf(ctx.section), /self-evolution loop/u, "条目到位后立即跟上语言");
    });

    it("sectionEnabled=false → 段仍在，但 text 求值为空串（renderPrompt 丢掉空段）", () => {
      // 注册发生在 effect 里、只跑一次：用动态 text 才能让设置卡改动即时生效，
      // 不必重启（core/system-prompt/src/index.ts renderPrompt 过滤空 text）。
      const ctx = makeCtx({ value: { sectionEnabled: false } });
      apply(ctx);
      assert.ok(ctx.section, "段应始终注册");
      assert.equal(textOf(ctx.section), "");
      ctx.value["sectionEnabled"] = true;
      assert.match(textOf(ctx.section), /自进化环/u);
    });
  });

  describe("report 上报链", () => {
    it("教训落盘 + 候选卡归并 + 达阈值 ready", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      const lesson = {
        source: SOURCE_DANGER_GUARD,
        category: CATEGORY_FACTGATE_DENY,
        cwd: GATE_PROJECT_CWD,
        sessionId: "s1",
        signature: "/repo/proj/a.ts",
      };
      const r1 = await svc.report({ ...lesson, detail: "d1" });
      assert.equal(r1.ok, true);
      assert.ok(existsSync(cacheFile(EVENTS_FILE_NAME)), "events.jsonl 未落盘");
      assert.equal(r1.candidate?.occurrences, 1);
      assert.equal(r1.ready, false);
      await svc.report({ ...lesson, detail: "d2" });
      const r3 = await svc.report({ ...lesson, detail: "d3" });
      assert.equal(r3.ready, true);
      // detail 全量在盘（不截断）
      const raw = readFileSync(cacheFile(EVENTS_FILE_NAME), "utf8");
      assert.ok(raw.includes("d3"));
    });

    it("enabled=false / reportEnabled=false → 丢弃上报", async () => {
      const ctx = makeCtx({ value: { enabled: false } });
      apply(ctx);
      const svc = loopService(ctx);
      const dropped = await svc.report({
        source: "manual",
        category: "c",
        signature: "s",
        detail: "d",
      });
      assert.equal(dropped.ok, false);
      const ctx2 = makeCtx({ value: { reportEnabled: false } });
      apply(ctx2);
      const svc2 = loopService(ctx2);
      const second = await svc2.report({
        source: "manual",
        category: "c",
        signature: "s",
        detail: "d",
      });
      assert.equal(second.reason, "disabled");
    });
  });

  describe("armed 度量与收尾清算", () => {
    it("armed 命中 → violation++；通过规则场景（pass）→ suppressed++；违规会话不计", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      const cwd = GATE_PROJECT_CWD;
      const lesson = {
        source: SOURCE_QUALITY_GATE,
        category: CATEGORY_GATE_FAILURE,
        cwd,
        signature: SIGNATURE_GATE_COMMAND,
      };
      const first = await svc.report({ ...lesson, sessionId: "s1", detail: "f1" });
      const { id } = first.candidate!;
      assert.equal(await svc.ruleAction(id, "arm"), "persisted");
      // 本会话复发
      const r2 = await svc.report({ ...lesson, sessionId: "s1", detail: "f2" });
      assert.equal(r2.violationOf?.violation, 1);
      assert.equal(r2.violationOf.id, id);
      // 复发会话收尾：不计 suppressed
      fireDisposed(ctx, { id: "s1" });
      await flushAsync();
      assert.equal(svc.rules()[0]?.suppressed, 0);
      // 另一会话：经过规则场景（pass 信号）→ 收尾计 suppressed
      // agent/created 载荷 {agent, source, signal}（事件契约修正后）。
      fireCreated(ctx, { session: { id: "s2", header: { cwd } } });
      svc.pass({
        category: CATEGORY_GATE_FAILURE,
        cwd,
        sessionId: "s2",
        signature: SIGNATURE_GATE_COMMAND,
      });
      fireDisposed(ctx, { id: "s2" });
      await flushAsync();
      assert.equal(svc.rules()[0]?.suppressed, 1);
      // 无 pass 的会话（兜底路径）→ 不计 suppressed
      fireDisposed(ctx, { id: "s3", header: { cwd } });
      await flushAsync();
      assert.equal(svc.rules()[0]?.suppressed, 1, "无 pass 的会话不记 observed");
    });

    it("插件先于 session/disposed 卸载（短命进程退出）→ 台账会话就地清算，samples 不丢", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      const cwd = GATE_PROJECT_CWD;
      const first = await svc.report({
        source: SOURCE_QUALITY_GATE,
        category: CATEGORY_GATE_FAILURE,
        cwd,
        sessionId: "s9",
        signature: SIGNATURE_GATE_COMMAND,
        detail: "f",
      });
      assert.equal(await svc.ruleAction(first.candidate!.id, "arm"), "persisted");
      fireCreated(ctx, { session: { id: "s9", header: { cwd } } });
      // headless/CLI 进程退出时 Cordis 先卸载插件：session/disposed 永远不来，
      // 不就地清算就会把这条暴露度观察整批丢掉（度量恒 0 → 规则永远不可判定）。
      // 异步 disposer 由卸载 await（cordis fiber.d.ts:38-41「they may be async, in which
      // case unloading awaits them」）→ 这里 await 全部释放器，观测点从"给一次宏任务"
      // 升级成"退出清算真的写完了"。
      await Promise.all(ctx.effects.map((dispose) => dispose()));
      assert.equal(svc.rules()[0]?.samples, 1, "退出清算必须补记这条 samples");
    });

    it("卸载时闭环已关闭 → 不做退出清算（与事件版同一闸门）", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      const cwd = GATE_PROJECT_CWD;
      const first = await svc.report({
        source: SOURCE_QUALITY_GATE,
        category: CATEGORY_GATE_FAILURE,
        cwd,
        sessionId: "s9",
        signature: SIGNATURE_GATE_COMMAND,
        detail: "f",
      });
      assert.equal(await svc.ruleAction(first.candidate!.id, "arm"), "persisted");
      fireCreated(ctx, { session: { id: "s9", header: { cwd } } });
      ctx.value["enabled"] = false;
      // 异步 disposer 由卸载 await（cordis fiber.d.ts:38-41「they may be async, in which
      // case unloading awaits them」）→ 这里 await 全部释放器，观测点从"给一次宏任务"
      // 升级成"退出清算真的写完了"。
      await Promise.all(ctx.effects.map((dispose) => dispose()));
      assert.equal(svc.rules()[0]?.samples, 0, "插件关闭期间不写度量");
    });

    it("退出清算单条抛错 → 记日志且不把卸载带炸", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      const cwd = GATE_PROJECT_CWD;
      await svc.report({
        source: SOURCE_QUALITY_GATE,
        category: CATEGORY_GATE_FAILURE,
        cwd,
        sessionId: "s9",
        signature: SIGNATURE_GATE_COMMAND,
        detail: "f",
      });
      fireCreated(ctx, { session: { id: "s9", header: { cwd } } });
      const ended = vi.spyOn(LessonStore.prototype, "sessionEnded").mockImplementation(async () => {
        throw new Error("store 已坏");
      });
      const error = vi.spyOn(console, "error").mockImplementation(() => {
        // 断言在下方
      });
      // 异步 disposer 由卸载 await（cordis fiber.d.ts:38-41「they may be async, in which
      // case unloading awaits them」）→ 这里 await 全部释放器，观测点从"给一次宏任务"
      // 升级成"退出清算真的写完了"。
      await Promise.all(ctx.effects.map((dispose) => dispose()));
      assert.ok(
        error.mock.calls.some((call) => String(call[0]).includes("sessionEnded failed")),
        "抛错要留下日志",
      );
      ended.mockRestore();
      error.mockRestore();
    });
  });

  describe("会话开始注入", () => {
    it("根会话 + 项目有 armed 规则 → agent.inject 全文摘要", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      const first = await svc.report({
        source: SOURCE_DANGER_GUARD,
        category: CATEGORY_FACTGATE_DENY,
        cwd: GATE_PROJECT_CWD,
        signature: "/a.ts",
        detail: "d",
      });
      assert.equal(await svc.ruleAction(first.candidate!.id, "arm"), "persisted");
      const injected: unknown[] = [];
      // inject 属 Agent 面（Session 无此方法）：挂在 session 上会让这条链永不触发。
      const agent = {
        inject: (message: unknown) => {
          injected.push(message);
        },
        session: { id: "s1", header: { cwd: GATE_PROJECT_CWD } },
      };
      fireCreated(ctx, agent);
      assert.equal(injected.length, 1);
      const msg = injected[0] as {
        source?: Record<string, unknown>;
        content?: { text?: string }[];
      };
      assert.equal(msg.source?.["kind"], "plugin:lesson-loop");
      assert.match(msg.content![0]!.text!, /经验规则/u);
    });

    it("注入 source 必须是 producer-owned kind（不得回退到 'plugin'）", async () => {
      // 0.1.7 的 V4 准入（session-format-v3-to-v4/src/message-sources.ts）对每个
      // 声明的持久消息位拒收退役包装 `{ kind: 'plugin', plugin }`，抛
      // "format v4 message requires a producer-owned source kind"：agent.inject 的
      // 消息经 inbox 落 `agent/inbox/spliced`（agent-loop/src/inbox.ts 的 inserted
      // 数组，sources.ts 遍历的持久位之一），一条这样的注入就会把整个会话的落盘
      // 拒绝掉。`form` 是本插件自有元数据，迁移表原样保留——身份变了它不能丢。
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      const first = await svc.report({
        source: SOURCE_DANGER_GUARD,
        category: CATEGORY_FACTGATE_DENY,
        cwd: GATE_PROJECT_CWD,
        signature: "/a.ts",
        detail: "d",
      });
      assert.equal(await svc.ruleAction(first.candidate!.id, "arm"), "persisted");
      const injected: unknown[] = [];
      const agent = {
        inject: (message: unknown) => {
          injected.push(message);
        },
        session: { id: "s1", header: { cwd: GATE_PROJECT_CWD } },
      };
      fireCreated(ctx, agent);
      assert.equal(injected.length, 1);
      const { source } = injected[0] as { source: Record<string, unknown> };
      assert.notEqual(source["kind"], "plugin");
      assert.equal(typeof source["kind"], "string");
      assert.equal(source["kind"], "plugin:lesson-loop", "kind 须是本插件的 producer-owned 串");
      assert.equal(source["plugin"], undefined, "退役包装的 plugin 字段不得再出现");
      assert.equal(source["form"], "instructions", "自有 form 字段必须保留");
    });

    it("无 armed 规则 / 子代理 / 开关关 → 不注入", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const injected: unknown[] = [];
      const mkAgent = (
        headerRaw?: Record<string, unknown>,
      ): {
        inject: (message: unknown) => void;
        session: { id: string; header: Record<string, unknown> };
      } => {
        const header = headerRaw ?? { cwd: GATE_PROJECT_CWD };
        return {
          inject: (message: unknown) => {
            injected.push(message);
          },
          session: { id: "s1", header },
        };
      };
      fireCreated(ctx, mkAgent());
      // 无规则
      assert.equal(injected.length, 0);
      const ctx2 = makeCtx();
      apply(ctx2);
      const svc2 = loopService(ctx2);
      const second = await svc2.report({
        source: SOURCE_DANGER_GUARD,
        category: "c",
        cwd: GATE_PROJECT_CWD,
        signature: "s",
        detail: "d",
      });
      assert.equal(await svc2.ruleAction(second.candidate!.id, "arm"), "persisted");
      fireCreated(ctx2, mkAgent({ cwd: GATE_PROJECT_CWD, delegationDepth: 1 }));
      // 子代理
      assert.equal(injected.length, 0);
      const ctx3 = makeCtx({ value: { injectEnabled: false } });
      apply(ctx3);
      fireCreated(ctx3, mkAgent());
      // 开关关
      assert.equal(injected.length, 0);
    });
  });

  describe("webServer 端点", () => {
    it("stats GET 下发 csrf + 全量规则 + 教训计数", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      await svc.report({ source: "manual", category: "c", signature: "s", detail: "d" });
      const res = makeRes();
      ctx.routes[STATS_ROUTE]?.(makeReq({ url: STATS_ROUTE }), res);
      const body = JSON.parse(res.body!) as {
        ok: boolean;
        csrf: string;
        rules: unknown[];
        lessonsCount: number;
      };
      assert.equal(body.ok, true);
      assert.match(body.csrf, /[0-9a-f-]{36}/u);
      assert.equal(body.lessonsCount, 1);
      assert.equal(body.rules.length, 1);
    });

    it("rule-action POST：csrf 校验 + arm 生效 + 异常路径", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      const first = await svc.report({
        source: "manual",
        category: "c",
        signature: "s",
        detail: "d",
      });
      const { id } = first.candidate!;
      const statsRes = makeRes();
      ctx.routes[STATS_ROUTE]?.(makeReq(), statsRes);
      const { csrf } = JSON.parse(statsRes.body!) as { csrf: string };

      // 错 csrf → 403
      const bad = await postJson(
        ctx,
        RULE_ACTION_ROUTE,
        { id, action: "arm" },
        { "x-lesson-csrf": "wrong" },
      );
      assert.equal(bad.code, 403);
      // 未知 action → 400
      const unknownAction = await postJson(
        ctx,
        RULE_ACTION_ROUTE,
        { id, action: "nuke" },
        { "x-lesson-csrf": csrf },
      );
      assert.equal(unknownAction.code, 400);
      // 未知 id → 404
      const unknownId = await postJson(
        ctx,
        RULE_ACTION_ROUTE,
        { id: "rule-nope", action: "arm" },
        { "x-lesson-csrf": csrf },
      );
      assert.equal(unknownId.code, 404);
      // 正确 arm（带 statement 改写）
      const ok = await postJson(
        ctx,
        RULE_ACTION_ROUTE,
        { id, action: "arm", statement: "改写后的规则" },
        { "x-lesson-csrf": csrf },
      );
      assert.equal(ok.code, 200);
      assert.equal(svc.rules()[0]?.status, "armed");
      assert.equal(svc.rules()[0]?.statement, "改写后的规则");
    });

    it("lessons GET：project 过滤 + 全量缺省", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      await svc.report({
        source: "manual",
        category: "c",
        signature: "s1",
        detail: "d1",
        cwd: GATE_PROJECT_CWD,
      });
      await svc.report({
        source: "manual",
        category: "c",
        signature: "s2",
        detail: "d2",
        cwd: "/other",
      });
      const res = makeRes();
      const projectUrl = `/_dsh/lesson-loop/lessons?project=${encodeURIComponent(deriveProject(GATE_PROJECT_CWD))}`;
      ctx.routes[LESSONS_ROUTE]?.(makeReq({ url: projectUrl }), res);
      const body = JSON.parse(res.body!) as { count: number; lessons: { detail: string }[] };
      assert.equal(body.count, 1);
      assert.equal(body.lessons[0]?.detail, "d1");
      const all = makeRes();
      ctx.routes[LESSONS_ROUTE]?.(makeReq({ url: LESSONS_ROUTE }), all);
      assert.equal((JSON.parse(all.body!) as { count: number }).count, 2);
    });

    it("端点方法守卫：stats/rules/lessons 非 GET、rule-action 非 POST → 405 + Allow", () => {
      const ctx = makeCtx();
      apply(ctx);
      const getRoutes = [STATS_ROUTE, RULES_ROUTE, LESSONS_ROUTE];
      for (const routePath of getRoutes) {
        const res = makeRes();
        ctx.routes[routePath]?.(makeReq({ method: "POST", url: routePath }), res);
        assert.equal(res.code, 405, `${routePath} 非 GET 应 405`);
        assert.equal(res.headers?.["Allow"], "GET");
        // 405 不再是空体，与全仓统一的 JSON 回执由这条针钉住。
        assert.match(res.body ?? "", /"error":"GET only"/u, routePath);
      }
      const postRes = makeRes();
      ctx.routes[RULE_ACTION_ROUTE]?.(makeReq({ method: "GET", url: RULE_ACTION_ROUTE }), postRes);
      assert.equal(postRes.code, 405);
      assert.equal(postRes.headers?.["Allow"], "POST");
    });

    it("rule-action 跨域 → 403（csrf 前的纵深防线）", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const res = await postJson(
        ctx,
        RULE_ACTION_ROUTE,
        { id: "x", action: "arm" },
        { "sec-fetch-site": "cross-site" },
      );
      assert.equal(res.code, 403);
      assert.match(res.body!, /cross-origin/u);
    });

    it("rule-action body 超限 → 413", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const statsRes = makeRes();
      ctx.routes[STATS_ROUTE]?.(makeReq(), statsRes);
      const { csrf } = JSON.parse(statsRes.body!) as { csrf: string };
      const bigStatement = "x".repeat(1024 * 1024 + 16);
      const res = await postJson(
        ctx,
        RULE_ACTION_ROUTE,
        { id: "rule-1", action: "arm", statement: bigStatement },
        { "x-lesson-csrf": csrf },
      );
      assert.equal(res.code, 413);
    });

    it("rule-action body 非合法 JSON → 400", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const statsRes = makeRes();
      ctx.routes[STATS_ROUTE]?.(makeReq(), statsRes);
      const { csrf } = JSON.parse(statsRes.body!) as { csrf: string };
      const res = makeRes();
      const req = makeReq({
        method: "POST",
        url: RULE_ACTION_ROUTE,
        headers: { "x-lesson-csrf": csrf },
        chunks: ["not-json{{{"],
      });
      ctx.routes[RULE_ACTION_ROUTE]?.(req, res);
      await flushAsync();
      assert.equal(res.code, 400);
      assert.ok(String(res.body).includes(MESSAGES.zh.errInvalidJsonBody));
    });

    it("rule-action 缺 id/action → 400；未知 action → 400", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const statsRes = makeRes();
      ctx.routes[STATS_ROUTE]?.(makeReq(), statsRes);
      const { csrf } = JSON.parse(statsRes.body!) as { csrf: string };
      const noId = await postJson(
        ctx,
        RULE_ACTION_ROUTE,
        { action: "arm" },
        { "x-lesson-csrf": csrf },
      );
      assert.equal(noId.code, 400);
      assert.ok(String(noId.body).includes(MESSAGES.zh.errIdAndActionRequired));
      const unknownAction = await postJson(
        ctx,
        RULE_ACTION_ROUTE,
        { id: "rule-1", action: "boom" },
        { "x-lesson-csrf": csrf },
      );
      assert.equal(unknownAction.code, 400);
      // 未知动作回显带原值（白名单外一律拒，并把发来的名字点出来便于定位）
      const expectedUnknown = fill(MESSAGES.zh.errUnknownAction, { action: "boom" });
      assert.ok(String(unknownAction.body).includes(expectedUnknown));
    });

    it("rules GET：project 过滤命中与未命中", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      await svc.report({ cwd: GATE_PROJECT_CWD, category: "c", signature: "s1", detail: "d1" });
      await svc.report({ cwd: "/other", category: "c", signature: "s2", detail: "d2" });
      const hit = makeRes();
      const projectUrl = `/_dsh/lesson-loop/rules?project=${encodeURIComponent(deriveProject(GATE_PROJECT_CWD))}`;
      ctx.routes[RULES_ROUTE]?.(makeReq({ url: projectUrl }), hit);
      const hitBody = JSON.parse(hit.body!) as { rules: { project: string }[] };
      assert.equal(hitBody.rules.length, 1);
      const miss = makeRes();
      ctx.routes[RULES_ROUTE]?.(makeReq({ url: "/_dsh/lesson-loop/rules?project=none" }), miss);
      assert.equal((JSON.parse(miss.body!) as { rules: unknown[] }).rules.length, 0);
    });

    it("lessons GET：limit 生效且非法 limit 回落全量", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      await svc.report({ source: "manual", category: "c", signature: "s1", detail: "d1" });
      await svc.report({ source: "manual", category: "c", signature: "s2", detail: "d2" });
      await svc.report({ source: "manual", category: "c", signature: "s3", detail: "d3" });
      const limited = makeRes();
      ctx.routes[LESSONS_ROUTE]?.(makeReq({ url: "/_dsh/lesson-loop/lessons?limit=2" }), limited);
      assert.equal((JSON.parse(limited.body!) as { count: number }).count, 2);
      const zero = makeRes();
      ctx.routes[LESSONS_ROUTE]?.(makeReq({ url: "/_dsh/lesson-loop/lessons?limit=abc" }), zero);
      assert.equal((JSON.parse(zero.body!) as { count: number }).count, 3);
    });
  });

  describe("cacheFile 路径解析（官方 dsh-home-paths 通道）", () => {
    it("DSH_HOME 已设 → $DSH_HOME/cache/lesson-loop/<name>", () => {
      const previousDshHome = process.env["DSH_HOME"];
      process.env["DSH_HOME"] = "/tmp/custom-dsh";
      try {
        assert.equal(
          cacheFile(EVENTS_FILE_NAME),
          path.join("/tmp/custom-dsh", "cache", PLUGIN_ID_FIXTURE, EVENTS_FILE_NAME),
        );
      } finally {
        if (previousDshHome === undefined) {
          delete process.env["DSH_HOME"];
        } else {
          process.env["DSH_HOME"] = previousDshHome;
        }
      }
    });

    it("DSH_HOME 未设 → 回退 <HOME>/.dsh/cache/lesson-loop/<name>", () => {
      const previousDshHome = process.env["DSH_HOME"];
      const previousHome = process.env["HOME"];
      delete process.env["DSH_HOME"];
      process.env["HOME"] = TEST_HOME_DIR;
      try {
        assert.equal(
          cacheFile(EVENTS_FILE_NAME),
          path.join(TEST_HOME_DIR, ".dsh", "cache", PLUGIN_ID_FIXTURE, EVENTS_FILE_NAME),
        );
      } finally {
        if (previousDshHome === undefined) {
          delete process.env["DSH_HOME"];
        } else {
          process.env["DSH_HOME"] = previousDshHome;
        }
        if (previousHome === undefined) {
          delete process.env["HOME"];
        } else {
          process.env["HOME"] = previousHome;
        }
      }
    });

    /** 官方包（@deepseek-ai/dsh-home-paths）口径：空白 $DSH_HOME 视同未设。旧实现自带
     *  "DSH_HOME/HOME 都取不到就抛"的三态回退，那条分支随自实现路径解析一起删掉——
     *  解析归官方包，插件不再自己造失败口径。 */
    it("DSH_HOME 只有空白 → 按未设回退，绝不落进空白目录", () => {
      const previousDshHome = process.env["DSH_HOME"];
      const previousHome = process.env["HOME"];
      process.env["DSH_HOME"] = "   ";
      process.env["HOME"] = TEST_HOME_DIR;
      try {
        assert.equal(
          cacheFile(EVENTS_FILE_NAME),
          path.join(TEST_HOME_DIR, ".dsh", "cache", PLUGIN_ID_FIXTURE, EVENTS_FILE_NAME),
        );
      } finally {
        if (previousDshHome === undefined) {
          delete process.env["DSH_HOME"];
        } else {
          process.env["DSH_HOME"] = previousDshHome;
        }
        if (previousHome === undefined) {
          delete process.env["HOME"];
        } else {
          process.env["HOME"] = previousHome;
        }
      }
    });
  });

  describe("/lessons-digest 命令", () => {
    it("注册并成功蒸馏（假 llm + 模型选择）", async () => {
      const llm = {
        async *stream() {
          yield {
            type: CHUNK_TEXT_DELTA,
            text: '[{"category":"unfinished-turn","signature":"todo","statement":"收口任务清单"}]',
          };
          yield { type: "finish", reason: { kind: "stop" } };
        },
      };
      const ctx = makeCtx({
        services: {
          llm,
          agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) },
        },
      });
      apply(ctx);
      assert.ok(ctx.command, "命令未注册");
      assert.equal((ctx.command.desc as { name?: string }).name, "lessons-digest");
      // 差评事件经官方 sessionQuery 交付（不再是 agent.session.snapshotEvents()）。
      ctx.sessionEvents = [
        {
          type: "feedback/message-put",
          data: { item: { messageId: "m", rating: "negative", note: "留了半截" } },
        },
      ];
      const result = await ctx.command.handler({
        agent: { session: { id: "s1", header: { cwd: GATE_PROJECT_CWD } } },
        rawInput: "",
      });
      assert.equal(result.kind, "success");
      assert.match(result.text, /候选规则/u);
    });

    it("llm 缺失 → error 回执；非会话内 → error 回执", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const r1 = await ctx.command?.handler({
        agent: { session: { id: "s1", header: { cwd: "/x" } } },
        rawInput: "",
      });
      assert.equal(r1?.kind, "error");
      const r2 = await ctx.command?.handler({});
      assert.equal(r2?.kind, "error");
    });

    // 事件流的取数已迁到官方 `ctx.sessionQuery.observeSession()`（旧写法是
    // `agent.session.snapshotEvents()`，官方把那条同步读面标了 @deprecated）。
    // 下面几条钉的是迁移后必须仍然成立的降级口径：**任一条读不到都只少背景，不炸命令**。
    it("事件流读不到的两条降级：蒸馏仍成功（差评数 0）", async () => {
      const llm = {
        async *stream() {
          yield { type: CHUNK_TEXT_DELTA, index: 0, text: "[]" };
          yield { type: "finish", reason: { kind: "stop" } };
        },
      };
      // 1. 会话有 id、sessionQuery 在位，但该命名空间读不出任何事件（空日志会话）。
      const withId = makeCtx();
      withId.services["llm"] = llm;
      withId.services["agentDefaultModel"] = {
        currentSelection: () => ({ provider: "p", model: "m" }),
      };
      apply(withId);
      const first = await withId.command?.handler(digestInvocation());
      assert.equal(first?.kind, "success", "空事件流只是少背景");
      // 2. 递来的会话**没有 id**：按 sessionId 查询这一步无法发起（旧同步读面不需要 id，
      //    迁移后这是一道新增的守卫——它挡的是"命令在半截 invocation 上被调用"这一真实形态）。
      const noId = makeCtx();
      noId.services["llm"] = llm;
      noId.services["agentDefaultModel"] = {
        currentSelection: () => ({ provider: "p", model: "m" }),
      };
      apply(noId);
      const second = await noId.command?.handler({
        agent: { session: { header: { cwd: GATE_PROJECT_CWD } } },
        rawInput: "",
      });
      assert.equal(second?.kind, "success", "拿不到 SessionId 也只是少背景，不炸命令");
    });

    it("sessionQuery 未装配 → 空背景，命令仍成功", async () => {
      const ctx = makeCtx();
      ctx.services["llm"] = {
        async *stream() {
          yield { type: CHUNK_TEXT_DELTA, index: 0, text: "[]" };
          yield { type: "finish", reason: { kind: "stop" } };
        },
      };
      ctx.services["agentDefaultModel"] = {
        currentSelection: () => ({ provider: "p", model: "m" }),
      };
      delete ctx.services["sessionQuery"];
      apply(ctx);
      const result = await ctx.command?.handler(digestInvocation());
      assert.equal(result?.kind, "success");
    });

    it("observeSession 拒绝（会话已卸载/存储读不出）→ 空背景，命令仍成功", async () => {
      const ctx = makeCtx();
      ctx.services["llm"] = {
        async *stream() {
          yield { type: CHUNK_TEXT_DELTA, index: 0, text: "[]" };
          yield { type: "finish", reason: { kind: "stop" } };
        },
      };
      ctx.services["agentDefaultModel"] = {
        currentSelection: () => ({ provider: "p", model: "m" }),
      };
      ctx.services["sessionQuery"] = {
        observeSession: async () => {
          throw new Error("session log unreadable");
        },
      };
      apply(ctx);
      const result = await ctx.command?.handler(digestInvocation());
      assert.equal(result?.kind, "success");
    });

    it("observation.events 不是数组（契约外交付）→ 退空背景且类型面不被收窄成 any", async () => {
      const ctx = makeCtx();
      ctx.services["llm"] = {
        async *stream() {
          yield { type: CHUNK_TEXT_DELTA, index: 0, text: "[]" };
          yield { type: "finish", reason: { kind: "stop" } };
        },
      };
      ctx.services["agentDefaultModel"] = {
        currentSelection: () => ({ provider: "p", model: "m" }),
      };
      ctx.services["sessionQuery"] = {
        observeSession: async () => ({ events: "not-an-array" }),
      };
      apply(ctx);
      const result = await ctx.command?.handler(digestInvocation());
      assert.equal(result?.kind, "success");
    });
  });

  describe("衰减定时器", () => {
    it("apply 立即跑一次；timer 缺失不炸", () => {
      const ctx = makeCtx();
      apply(ctx);
      // 24h 周期
      assert.equal(ctx.timerCallbacks.length, 1);
      const ctxNoTimer = makeCtx();
      delete ctxNoTimer.services["timer"];
      // 不抛
      apply(ctxNoTimer);
    });

    it("周期 tick 再次执行 decay", () => {
      vi.useFakeTimers();
      try {
        const ctx = makeCtx();
        apply(ctx);
        assert.equal(ctx.timerCallbacks.length, 1);
        ctx.timerCallbacks[0]?.();
        // 重新武装下一轮
        assert.equal(ctx.timerCallbacks.length, 2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("effect 卸载 → 停止周期衰减（stopped 防重入）", () => {
      const ctx = makeCtx();
      apply(ctx);
      assert.equal(ctx.timerCallbacks.length, 1);
      // apply 的 effect 顺序：provide → systemPrompt section → decay timer → webServer routes。
      // decay disposer 是倒数第二个。
      const decayDisposer = ctx.effects.at(-2);
      if (decayDisposer === undefined) {
        throw new Error("decay disposer 缺失");
      }
      decayDisposer();
      // 已注册的 tick 再触发 → stopped 早退，不再武装下一轮
      ctx.timerCallbacks[0]?.();
      assert.equal(ctx.timerCallbacks.length, 1);
    });
  });

  describe("命令名防冲突（commands.register 契约）", () => {
    it("recordInput=false + description 完整", () => {
      const ctx = makeCtx();
      apply(ctx);
      assert.equal((ctx.command!.desc as { recordInput?: boolean }).recordInput, false);
      assert.match((ctx.command!.desc as { description?: string }).description!, /差评/u);
    });
  });

  describe("可选服务缺失（一律空清理，不注册任何面）", () => {
    it("webServer/commands/systemPrompt/timer 全缺 → 装载照跑；commands 只在首个实例 warn", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {
        // 断言在下方
      });
      const ctx = makeCtx();
      for (const name of ["webServer", "commands", "systemPrompt", "timer"]) {
        Reflect.deleteProperty(ctx.services, name);
      }
      apply(ctx);
      assert.equal(ctx.section, null, "systemPrompt 缺失不该注册段");
      assert.equal(ctx.command, null, "commands 缺失不该注册命令");
      assert.deepEqual(Object.keys(ctx.routes), []);
      assert.deepEqual(ctx.timerCallbacks, []);
      // 每个 effect 都登记了空清理（noDisposer）：调用它们必须无害
      for (const dispose of ctx.effects) {
        dispose();
      }
      const warned = (): number =>
        warn.mock.calls.filter((call) => String(call[0]).includes("commands service")).length;
      assert.equal(warned(), 1);
      // 同进程内二次装载不再刷屏（模块级命令闸门）
      const second = makeCtx();
      Reflect.deleteProperty(second.services, "commands");
      apply(second);
      assert.equal(second.command, null);
      assert.equal(warned(), 1);
    });

    it("ctx.provide 不可用 → error 日志点破，报告方看不见总线", () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {
        // 断言在下方
      });
      const ctx = makeCtx();
      Reflect.deleteProperty(ctx, "provide");
      apply(ctx);
      assert.match(String(error.mock.calls[0]?.[0]), /ctx\.provide unavailable/u);
      assert.deepEqual(ctx.provided, {});
      for (const dispose of ctx.effects) {
        dispose();
      }
    });
  });

  describe("ctx 契约与行 config 底座", () => {
    it("ctx 不满足 HostCtx 结构 → 急停抛错（不用断言糊过去）", () => {
      // 核验的是 0.1.7 的实际调用面：effect/on 接线、inject+fiber 挂页面策略、
      // settings.describe 做 locale 跨命名空间读与规则库读。缺任一项都是集成错误。
      assert.throws(() => {
        plugin.apply(null as never, {} as never);
      }, /contract violated/u);
      assert.throws(() => {
        plugin.apply({ settings: {} } as never, {} as never);
      }, /contract violated/u);
      const noInject = makeCtx();
      Reflect.deleteProperty(noInject, "inject");
      assert.throws(
        () => {
          plugin.apply(noInject as never, noInject.config as never);
        },
        /contract violated/u,
        "缺 inject 就没法挂页面策略，不许半截装载",
      );
      const noFiber = makeCtx();
      noFiber.fiber = undefined;
      assert.throws(
        () => {
          plugin.apply(noFiber as never, noFiber.config as never);
        },
        /contract violated/u,
        "缺 fiber 时 configure 会落到 settings 自己的 fiber 上（给别人定策略）",
      );
    });

    it("行 config 经条目 Config 解析后交进 apply：覆盖项生效、未写项退 schema 默认", async () => {
      // 旧断言盯的是「插件把行 config 合进 BUILTIN_BASE 后交给 settings.register 的 base」。
      // 0.1.7 把合并与填默认都收进了 cordis 装载期（fiber._resolveConfig → resolveConfig），
      // 插件侧不再有 base 层，于是这里改盯**仍然由本包负责**的两件事：读的是引用（不是
      // apply 期快照），且引用背后的值就是按 schema 解析出来的那一份。
      const ctx = makeCtx({ value: { promoteThreshold: 7 } });
      apply(ctx);
      const stats = loopService(ctx).stats()["config"] as Record<string, unknown>;
      assert.equal(stats["promoteThreshold"], 7, "行 config 的覆盖项必须经 schema 解析后抵达闸门");
      assert.equal(stats["decayDays"], 30, "行 config 没写的字段仍是 schema 默认（base 层已移除）");
      assert.equal(stats["maxLessonsBytes"], 0, "0 = 不设上限这条默认没被写歪");
      // 设置卡改完下一个读即生效：同一枚引用、不重挂载。
      ctx.value["promoteThreshold"] = 5;
      assert.equal(
        (loopService(ctx).stats()["config"] as Record<string, unknown>)["promoteThreshold"],
        5,
        "读的是引用而不是快照",
      );
    });

    it("config 校验挂在 cordis 真正读取的入口键 Config 上（写成 ConfigSchema 即静默失效）", () => {
      // registry 只认 `Config`（vendor/cordis/src/registry.ts:104 Plugin.Base.Config →
      // fiber._resolveConfig → resolveConfig：`if (!runtime.Config) return config`）。
      // 本包曾把它挂在 `ConfigSchema` 键上，于是这条校验**从未跑过**：越界的行 config
      // 一路透传进 apply。键名与"它真的会拒"两件事都在这里钉住。
      assert.equal("ConfigSchema" in plugin, false, "退役的入口键名不得再出现");
      assert.equal(
        configIssues({ promoteThreshold: 7, decayDays: 30 }),
        undefined,
        "合法行 config 必须通过",
      );
      assert.notEqual(
        configIssues({ promoteThreshold: 99 }),
        undefined,
        "越上界必须被拒（max 20）",
      );
      assert.notEqual(configIssues({ enabled: "yes" }), undefined, "布尔位给字符串必须被拒");
      assert.notEqual(configIssues({ decayDays: 0 }), undefined, "min 1 必须被拒");
      // 规则库与开关同段之后，这一条从"锦上添花"变成了硬要求：条目 Config 的校验发生在
      // cordis 装载期且**无处 catch**（抛错 = 整条插件不加载、开关与服务一起没）。人改坏
      // rules 只能让规则面降级，不许打死别的东西——所以这个字段是 .loose() 的。
      assert.equal(
        configIssues({ [RULES_FIELD]: "用户手改坏的存量段" }),
        undefined,
        "坏 rules 不得让整条目校验失败（同段之后那就是整条插件不加载）",
      );
      assert.deepEqual(
        resolvedFieldOf({ [RULES_FIELD]: "用户手改坏的存量段" }, RULES_FIELD),
        [],
        "坏 rules 解析成空库：条目照常装载，坏的只有规则面",
      );
    });
  });

  it("isSettingsProvider 三态：非记录 / 记录但缺 CAS 方法 / 齐全", () => {
    // 0.1.7 的 CAS 面只有 describe + update；`register` 已随宿主移除，绝不能再当判据
    // （探它 = 每一条真宿主都被判成"没有 CAS 面"，规则库结构性失效）。
    assert.equal(isSettingsProvider("not-a-provider"), false);
    assert.equal(isSettingsProvider(null), false);
    assert.equal(isSettingsProvider({ update: (): void => undefined }), false);
    assert.equal(isSettingsProvider({ describe: (): void => undefined }), false);
    assert.equal(
      isSettingsProvider({
        describe: (): void => undefined,
        update: (): void => undefined,
      }),
      true,
    );
  });

  describe("规则面降级：装载不许被存量数据或半装配炸断", () => {
    it("settings 没有 CAS 面（缺 update）⇒ 记 error 日志、服务与开关面照常装载", () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {
        // 断言在下方
      });
      const ctx = makeCtx();
      // 留 describe（ctx 契约要求它）、拿掉 update：isSettingsProvider 认不出这套半装配的面。
      const surface = ctx.settings as unknown as Record<string, unknown>;
      Reflect.deleteProperty(surface, "update");
      apply(ctx);
      assert.match(
        error.mock.calls.map(String).join("\n"),
        /no CAS surface/u,
        "要把『规则库不可用、开关仍生效』点破",
      );
      assert.notEqual(
        ctx.provided["lessonLoop"],
        undefined,
        "规则面不可用不许连带打死总线与设置卡读的那一段",
      );
      for (const dispose of ctx.effects) {
        dispose();
      }
      error.mockRestore();
    });

    it("条目段的 rules 被存量坏数据改成非数组 ⇒ 记日志并降级为读空/拒写，装载不抛", async () => {
      // 0.1.6 这条路的入口是"register 被 schema 打回"；0.1.7 没有 register 可打回，坏值
      // 由 Config 的 .loose() 在解析期吸收成 []。降级因此改挂在 describe().user 那层原文
      // 上（value 已被修成看起来合法），并且比旧版更严：坏内容留在文档里等人修，
      // 本进程一次都不写。
      const error = vi.spyOn(console, "error").mockImplementation(() => {
        // 断言在下方
      });
      const ctx = makeCtx();
      ctx.value[RULES_FIELD] = "用户手改坏的存量段";
      apply(ctx);
      assert.match(
        error.mock.calls.map(String).join("\n"),
        /rules namespace rejected/u,
        "坏数据要被点名，而不是静默当成空库",
      );
      const svc = loopService(ctx);
      assert.deepEqual(svc.rules(), [], "读空");
      const receipt = await svc.report({
        source: "manual",
        category: "c",
        cwd: GATE_PROJECT_CWD,
        signature: "s",
        detail: "d",
      });
      assert.equal(receipt.ok, false);
      assert.equal(receipt.reason, PERSIST_FAILED, "读不懂的这一刻不许写");
      assert.equal(ctx.rulesProvider.writesOf(SETTINGS_NAMESPACE), 0, "整段一次都没被写过");
      assert.equal(
        ctx.rulesProvider.peek(SETTINGS_NAMESPACE)?.[RULES_FIELD],
        "用户手改坏的存量段",
        "坏内容保持原样等人修，开关段也不被顺手覆写",
      );
      // 同段之后最容易丢的就是这条：规则面降级不许牵连开关面的读写。
      ctx.value["injectEnabled"] = false;
      assert.equal(
        (loopService(ctx).stats()["config"] as Record<string, unknown>)["injectEnabled"],
        false,
        "开关照改照生效",
      );
      error.mockRestore();
    });
  });

  // ── 0.1.7 隐式注册验收：命名空间与可编辑字段都是"从 Config 反推"出来的 ──────
  //
  // 为什么单独要这一组：0.1.7 没有 `settings.register` 了，可编辑字段全靠 schema 上的
  // `.volatile()` 标记。漏标一个不会报错，只会让那一项从设置卡上**静默消失**（宿主
  // 的 describe() 只投影 volatileForm 的结果）；全漏则整条被跳过
  // （packages/settings/settings/src/index.ts:308-309），写入抛 `has no volatile fields`
  // （:386）。这类退化在功能测试里全绿——只有拿宿主同一个判据回头看 schema 才拦得住。
  //
  // ⚠ 它拦不住的：条目 id 与已装配 profile 里那一行的对应关系（宿主读的是装配后的
  // `entry.options.id`，本包 cordis.patch.yml 只是它的来源），以及"cordis 真把 Config 挂上
  // fiber.runtime"这一步（test/integration/bus-boot.test.ts 用真实 Loader 覆盖前者的一半）。

  describe("0.1.7 隐式注册验收（volatileForm(Config) 的字段集 = 设置面可编辑集）", () => {
    it("命名空间 = cordis.patch.yml 的条目 id，且就是规则库读写的那一段", () => {
      assert.equal(patchEntryId(), PLUGIN_ID_FIXTURE);
      assert.equal(SETTINGS_NAMESPACE, patchEntryId(), "代码里的段名与 profile 条目 id 同源");
    });

    it("假件的 settings 面就是 0.1.7 的残面：三项在、被移除的三项绝不在", () => {
      // 0.1.6 的假件里有 register（两段各注册一次）与 get（读 locale）。迁移时若只把调用
      // 点改掉、假件却留着这两扇门，host.ts 那些"没有注册可被打回""describe 是唯一读口"的
      // 分支就会在假绿里静默失真——真宿主 0.1.7 上它们不存在，插件会当场 TypeError。
      // 故这里直接钉假件自己的形状：本包用到的就是 describe/update/configure 三件。
      const ctx = makeCtx();
      const surface = ctx.settings as unknown as Record<string, unknown>;
      assert.deepEqual(
        Object.keys(surface).toSorted(),
        ["configure", "describe", "update"],
        "假件面与本包实际用到的 0.1.7 残面一一对应（多一项即有人偷偷补回旧 API）",
      );
      for (const removed of ["register", "get", "installSection"]) {
        assert.equal(
          surface[removed],
          undefined,
          `settings.${removed}() 已被 0.1.7 移除，假件不许提供`,
        );
      }
    });

    it("规则库与开关同段：整条链只碰 `lesson-loop` 一段，0.1.6 的第二段不再被创建", async () => {
      // 0.1.6 这里有**两段**：`lesson-loop`（开关，settings.register(PLUGIN_NAME, …)）与
      // `lesson-loop-rules`（规则库，register(RULES_NAMESPACE, RulesSchema, {base})）。
      // 0.1.7 的命名空间就是 profile 条目 id 且一条目一份 Config，第二段因此无处安放——
      // 迁移的落点是把规则数组并成同一 Config 的第 12 个 volatile 字段（rules）。
      // 这条断言钉的是拓扑本身：卡片必须落在开关那一段里，而旧段名一次都不许被写出来
      // （写进孤儿段 = 宿主 describe() 永远看不见，规则库静默失联）。
      const ctx = makeCtx();
      apply(ctx);
      await armedRule(ctx);
      const section = ctx.rulesProvider.peek(SETTINGS_NAMESPACE);
      assert.ok(Array.isArray(section?.[RULES_FIELD]), "armed 卡片要落在开关同段的 rules 数组里");
      assert.equal(rulesOf(ctx).length, 1);
      // 同一段里两样东西各有各的形态：规则是文档原文写进去的（用户可直接编辑），
      // 开关没写进文档、由 schema 的 .default() 解析出来（0.1.7 无 base 层）。
      assert.equal(ctx.rulesProvider.resolvedOf(SETTINGS_NAMESPACE)["enabled"], true);
      assert.ok(ctx.rulesProvider.writesOf(SETTINGS_NAMESPACE) > 0, "写的就是条目 id 那一段");
      assert.equal(
        ctx.rulesProvider.peek("lesson-loop-rules"),
        undefined,
        "退役的第二段不得再被创建（0.1.7 一条目一段）",
      );
    });

    it("volatileForm(Config) 的字段集恰为十二项（十一开关/阈值 + rules）", () => {
      const form = volatileFormOf(plugin.Config as unknown as SchemaNode);
      assert.ok(form !== null, "没有任何 volatile 字段 → 宿主 describe() 整条跳过本条目");
      assert.deepEqual(form.toSorted(), EDITABLE_FIELDS, "投影字段集与设置面预期可编辑项不一致");
      assert.deepEqual(
        Object.keys(configDict()).toSorted(),
        [...EDITABLE_FIELDS, ...DEPLOYMENT_FIELDS].toSorted(),
        "schema 字段全集与投影字段集不一致：要么漏标了 .volatile()（那一项从设置卡上静默消失），" +
          "要么新增了字段没同步这张期望清单",
      );
    });

    it("Config 默认值逐字段对齐 0.1.6 的 BUILTIN_BASE（base 层移除后的等价迁移）", () => {
      assert.deepEqual(schemaDefaults(), {
        enabled: true,
        reportEnabled: true,
        injectEnabled: true,
        sectionEnabled: true,
        promoteThreshold: 3,
        demoteThreshold: 3,
        demoteMinSamples: 5,
        demoteRatio: 0.5,
        decayDays: 30,
        reviveThreshold: 3,
        // 0 = 不设上限：用户拍板"不为省 token 截断内容"。
        maxLessonsBytes: 0,
        // 原 RULES_BASE 的 { rules: [] }：数组整片覆盖，空库的完整默认就是 []。
        rules: [],
        // 两枚部署值：默认与旧常量同值（120s 蒸馏墙钟 / 24h 衰减周期），行为冻结。
        // 手写字面值而不引常量——引常量就成了自证，常量改了该先红。
        digestTimeoutMs: 120_000,
        decayIntervalMs: 24 * 60 * 60_000,
      });
    });

    it("页面策略：settings.configure({ auto: false }) 恰好一次且 owner 是本插件 fiber", () => {
      // 本包自带卡片：不声明这条，宿主会按 volatileForm 再生成一份自动表单页（两页同存）。
      // owner 缺省是 settings 服务自己的 fiber —— 传错就等于给别人的页面定了策略。
      const ctx = makeCtx();
      apply(ctx);
      // 装载期一共两份依赖声明：`settings`（页面策略）与 `webServer`（四条路由）。
      // 后者是**子 fiber**：ctx.get 是无 inject 语义的存储读，官方注释写着 "or `undefined`
      // when not (yet) provided"（installed @deepseek-ai/cordis/lib/types/reflect.d.ts:10-14），
      // 真实宿主上 webServer 比本条目晚到位（隔离 DSH_HOME 实测 apply 当场 undefined、约 1s 后
      // 才有实例），只在 apply 里读一次的结果是四条路由永不注册。
      assert.deepEqual(
        ctx.injectDeps,
        [["settings"], ["webServer"]],
        "两份子依赖：settings 管页面策略，webServer 管路由；此外不多要一枚",
      );
      assert.equal(ctx.configureCalls.length, 1, "一次装载一次策略登记（重复登记宿主会抛）");
      const [call] = ctx.configureCalls;
      assert.equal(call?.presentation.auto, false);
      assert.equal(call.owner, ctx.fiber, "owner 必须是本插件 fiber");
    });
  });

  describe("端点注册与失败面", () => {
    it("effect 卸载 → 四条路由全部注销", () => {
      const ctx = makeCtx();
      apply(ctx);
      assert.equal(Object.keys(ctx.routes).length, 4);
      const disposeRoutes = ctx.effects.at(-1);
      assert.ok(disposeRoutes, "routes disposer 缺失");
      disposeRoutes();
      assert.deepEqual(Object.keys(ctx.routes), []);
    });

    it("rules GET 无 project → 全量下发（不过滤）", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      // 两笔 report 都要等落库：规则库存 settings 命名空间，整段是「读 → 重放 → 带
      // revision 的 CAS 覆写」，第二笔要看得见第一笔；GET 也得等两笔都写完才有意义。
      await svc.report({
        source: "manual",
        category: "c",
        cwd: "/repo/one",
        signature: "s1",
        detail: "d1",
      });
      await svc.report({
        source: "manual",
        category: "c",
        cwd: "/repo/two",
        signature: "s2",
        detail: "d2",
      });
      const res = makeRes();
      ctx.routes[RULES_ROUTE]?.(makeReq({ url: RULES_ROUTE }), res);
      assert.equal((JSON.parse(String(res.body)) as { rules: unknown[] }).rules.length, 2);
    });

    it("规则库落不进盘 → 回执 PERSIST_FAILED 且端点回 500（不能假装成功）", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {
        // 断言在下方
      });
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      // 先落一张真进得了库的卡：拒写之后 report() 不再留任何内存副本（commit 改的是本次
      // 读取的副本，随调用返回即丢弃），端点连"这条规则存在"都无从知道——那种情形下的
      // 正确回执是 404（rejected 不复活），拿它当"落盘失败回 500"的证据会测不到东西。
      const seeded = await svc.report({
        source: "manual",
        category: "c",
        cwd: GATE_PROJECT_CWD,
        signature: "s-seeded",
        detail: "d",
      });
      const id = seeded.candidate?.id;
      if (id === undefined) {
        throw new Error("候选卡缺失");
      }
      assert.equal(seeded.ok, true, "种子卡要真写进库");
      // provider 拒写（端口回执 rejected）：规则库这一段整片写不进去
      ctx.rulesProvider.failWrites(99);
      const receipt = await svc.report({
        source: "manual",
        category: "c",
        cwd: GATE_PROJECT_CWD,
        signature: "s",
        detail: "d",
      });
      assert.equal(receipt.ok, false);
      assert.equal(receipt.reason, PERSIST_FAILED);
      const res = await postJson(
        ctx,
        RULE_ACTION_ROUTE,
        { id, action: "arm" },
        { "x-lesson-csrf": csrfOf(ctx) },
      );
      assert.equal(res.code, 500);
      assert.match(String(res.body), new RegExp(PERSIST_FAILED, "u"));
      // 库里还是旧状态：那次 arm 没生效
      assert.equal(
        rulesOf(ctx).find((row) => row.id === id)?.status,
        "candidate",
        "拒写不得留下半截改动",
      );
      // 磁盘没存住必须留 error 日志（首条是 lessons 的同类失败，故整体查找）
      assert.ok(
        error.mock.calls.some((call) => String(call[0]).includes("rules write failed")),
        "规则库落盘失败未记 error 日志",
      );
    });

    it("handler 内任何抛错都被兜住 → 500 + error 日志（响应绝不挂住）", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {
        // 断言在下方
      });
      const ctx = makeCtx();
      apply(ctx);
      const id = await armedRule(ctx);
      vi.spyOn(LessonStore.prototype, "ruleAction").mockImplementation(async () => {
        throw new Error("端点里炸了");
      });
      const res = await postJson(
        ctx,
        RULE_ACTION_ROUTE,
        { id, action: "arm" },
        { "x-lesson-csrf": csrfOf(ctx) },
      );
      assert.equal(res.code, 500);
      assert.ok(String(res.body).includes(MESSAGES.zh.errRuleActionFailed));
      assert.match(String(error.mock.calls[0]?.[0]), /rule-action handler failed: 端点里炸了/u);
    });

    it("body 是 JSON 标量 / 缺 action → 400（非对象取字段一律为空）", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const csrf = csrfOf(ctx);
      const scalar = await postJson(ctx, RULE_ACTION_ROUTE, "just-a-string", {
        "x-lesson-csrf": csrf,
      });
      assert.equal(scalar.code, 400);
      assert.ok(String(scalar.body).includes(MESSAGES.zh.errIdAndActionRequired));
      const noAction = await postJson(
        ctx,
        RULE_ACTION_ROUTE,
        { id: "rule-1" },
        { "x-lesson-csrf": csrf },
      );
      assert.equal(noAction.code, 400);
      assert.ok(String(noAction.body).includes(MESSAGES.zh.errIdAndActionRequired));
    });
  });

  describe("/lessons-digest 的开关与失败面", () => {
    it("总开关或上报开关关闭 → 拒绝蒸馏（不烧 LLM 也不写候选卡）", async () => {
      const off = makeCtx({ value: { enabled: false } });
      apply(off);
      const first = await off.command?.handler(digestInvocation());
      assert.equal(first?.kind, "error");
      assert.equal(first.text, MESSAGES.zh.digestRejectedDisabled);
      const offReport = makeCtx({ value: { reportEnabled: false } });
      apply(offReport);
      const second = await offReport.command?.handler({});
      assert.equal(second?.kind, "error");
      assert.equal(second.text, MESSAGES.zh.digestRejectedDisabled);
    });

    it("有 llm 但没有模型选择 → 蒸馏失败回执", async () => {
      const ctx = makeCtx({ services: { llm: fakeLlm("[]") } });
      apply(ctx);
      const result = await ctx.command?.handler(digestInvocation());
      assert.equal(result?.kind, "error");
      assert.ok(
        result.text.startsWith(fill(MESSAGES.zh.digestFailed, { reason: "" })),
        "回显 = 字典前缀 + 错误摘要",
      );
    });

    it("模型没归纳出新规则 → 明确回执；rawInput 作为附加说明进提示词", async () => {
      const capture: { prompt?: string } = {};
      const ctx = makeCtx({
        services: {
          llm: fakeLlm("[]", capture),
          agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) },
        },
      });
      apply(ctx);
      const result = await ctx.command?.handler(digestInvocation("重点看门禁"));
      assert.equal(result?.kind, "success");
      assert.equal(result.text, fill(MESSAGES.zh.digestNoNewRules, { count: 0 }));
      // capture.prompt 只有在 handler 把附加说明拼进提示词后才有值
      assert.match(String(capture.prompt), /重点看门禁/u);
    });
  });

  describe("会话开始注入的分支", () => {
    it("enabled=false → 不预种台账也不注入", () => {
      const ctx = makeCtx({ value: { enabled: false } });
      apply(ctx);
      const injected: unknown[] = [];
      fireCreated(ctx, {
        inject: (message: unknown) => {
          injected.push(message);
        },
        session: { id: "s1", header: { cwd: GATE_PROJECT_CWD } },
      });
      assert.deepEqual(injected, []);
      const ended = vi.spyOn(LessonStore.prototype, "sessionEnded");
      fireDisposed(ctx, { id: "s1" });
      // 闸门关闭期间既不清算也不记账
      assert.equal(ended.mock.calls.length, 0);
    });

    it("agent 缺失 / 无 session → 不碰台账、不注入", () => {
      const ctx = makeCtx();
      apply(ctx);
      const injected: unknown[] = [];
      fireCreated(ctx, {
        inject: (message: unknown) => {
          injected.push(message);
        },
      });
      fireCreated(ctx, undefined);
      assert.deepEqual(injected, []);
      const ended = vi.spyOn(LessonStore.prototype, "sessionEnded");
      fireDisposed(ctx, {});
      fireDisposed(ctx, { id: 7 });
      // id 不是字符串 → 连兜底清算都不做（无法归因到会话）
      assert.equal(ended.mock.calls.length, 0);
    });

    it("同一会话二次 created → 台账按最新 cwd 归因", () => {
      const ctx = makeCtx();
      apply(ctx);
      fireCreated(ctx, { session: { id: "s1", header: { cwd: "/repo/aaa" } } });
      fireCreated(ctx, { session: { id: "s1", header: { cwd: "/repo/bbb" } } });
      const ended = vi.spyOn(LessonStore.prototype, "sessionEnded");
      fireDisposed(ctx, { id: "s1" });
      assert.equal(ended.mock.calls.length, 1);
      assert.equal(ended.mock.calls[0]?.[0], deriveProject("/repo/bbb"));
    });

    it("agent.inject 抛错 → 只记日志，注入链不炸总线", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {
        // 断言在下方
      });
      const ctx = makeCtx();
      apply(ctx);
      await armedRule(ctx);
      fireCreated(ctx, {
        inject: () => {
          throw new Error("注入炸了");
        },
        session: { id: "s9", header: { cwd: GATE_PROJECT_CWD } },
      });
      assert.match(String(error.mock.calls[0]?.[0]), /session-start inject failed: 注入炸了/u);
    });
  });

  describe("总线 report / pass 的分支", () => {
    it("report 带 turn 与 evidence → 全字段进台账；recentLessons 转发 project/limit", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      await svc.report({
        source: "manual",
        category: "c",
        cwd: GATE_PROJECT_CWD,
        sessionId: "s1",
        turn: 7,
        evidence: { tool: "bash" },
        signature: "s",
        detail: "d",
      });
      const [lesson] = svc.recentLessons(deriveProject(GATE_PROJECT_CWD), 5);
      assert.equal(lesson?.turn, 7);
      assert.deepEqual(lesson.evidence, { tool: "bash" });
      // limit 缺省 = 0（全量，不截断）
      assert.equal(svc.recentLessons().length, 1);
    });

    it("report / pass 内部炸 → 回执降级 + error 日志（总线永不外抛）", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {
        // 断言在下方
      });
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      vi.spyOn(LessonStore.prototype, "report").mockImplementation(async () => {
        throw new Error("总线炸了");
      });
      const receipt = await svc.report({
        source: "manual",
        category: "c",
        signature: "s",
        detail: "d",
      });
      assert.deepEqual(receipt, { ok: false, reason: "error" });
      assert.match(String(error.mock.calls[0]?.[0]), /report failed: 总线炸了/u);
      vi.spyOn(LessonStore.prototype, "pass").mockImplementation(() => {
        throw new Error("pass 炸了");
      });
      assert.deepEqual(svc.pass({ category: "c", signature: "s" }), { ok: false });
      assert.match(String(error.mock.calls[1]?.[0]), /pass failed: pass 炸了/u);
    });

    it("pass：闸门关 / 无 armed 命中 / 无 sessionId 都不登台账", async () => {
      const off = makeCtx({ value: { enabled: false } });
      apply(off);
      assert.deepEqual(
        loopService(off).pass({
          category: CATEGORY_GATE_FAILURE,
          signature: SIGNATURE_GATE_COMMAND,
        }),
        {
          ok: false,
        },
      );
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      assert.deepEqual(
        svc.pass({
          category: CATEGORY_GATE_FAILURE,
          cwd: GATE_PROJECT_CWD,
          sessionId: "nope",
          signature: "none",
        }),
        { ok: true },
      );
      const id = await armedRule(ctx);
      assert.deepEqual(
        svc.pass({
          category: CATEGORY_GATE_FAILURE,
          cwd: GATE_PROJECT_CWD,
          signature: SIGNATURE_GATE_COMMAND,
        }),
        { ok: true },
      );
      const ended = vi.spyOn(LessonStore.prototype, "sessionEnded");
      // 两条都没留下台账：收尾只能走空集合兜底
      fireDisposed(ctx, { id: "nope" });
      assert.deepEqual(ended.mock.calls[0]?.[2], new Set());
      // 有 sessionId 但从未 created 预种 → pass 现场新建台账，收尾照常清算
      svc.pass({
        category: CATEGORY_GATE_FAILURE,
        cwd: GATE_PROJECT_CWD,
        sessionId: "fresh",
        signature: SIGNATURE_GATE_COMMAND,
      });
      fireDisposed(ctx, { id: "fresh" });
      assert.deepEqual(ended.mock.calls[1]?.[2], new Set([id]));
      await flushAsync();
      assert.equal(svc.rules().find((rule) => rule.id === id)?.suppressed, 1);
    });
  });

  describe("会话台账容量与收尾容错", () => {
    it("台账超出上限 → 按插入序丢最旧一条，刚登记的会话不会被误丢", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      const id = await armedRule(ctx);
      // s0 先拿到 pass 记账：它排在插入序最前，正是溢出时要丢的那条
      svc.pass({
        category: CATEGORY_GATE_FAILURE,
        cwd: GATE_PROJECT_CWD,
        sessionId: "s0",
        signature: SIGNATURE_GATE_COMMAND,
      });
      for (let index = 1; index <= 200; index += 1) {
        fireCreated(ctx, { session: { id: `s${index}`, header: { cwd: GATE_PROJECT_CWD } } });
      }
      const ended = vi.spyOn(LessonStore.prototype, "sessionEnded");
      // s0 已被丢出 → 收尾走"无台账"兜底，pass 集合为空（没被丢就会带着 id）
      fireDisposed(ctx, { id: "s0", header: { cwd: GATE_PROJECT_CWD } });
      assert.deepEqual(ended.mock.calls[0]?.[2], new Set());
      // 末位的新会话还在表里：pass 记账照常清算
      svc.pass({
        category: CATEGORY_GATE_FAILURE,
        cwd: GATE_PROJECT_CWD,
        sessionId: "s200",
        signature: SIGNATURE_GATE_COMMAND,
      });
      fireDisposed(ctx, { id: "s200" });
      assert.deepEqual(ended.mock.calls[1]?.[2], new Set([id]));
    });

    it("无台账且无 header → 按 default 项目清算（插件中途装载的兜底）", () => {
      const ctx = makeCtx();
      apply(ctx);
      const ended = vi.spyOn(LessonStore.prototype, "sessionEnded");
      fireDisposed(ctx, { id: "ghost" });
      assert.deepEqual(ended.mock.calls[0], ["default", new Set(), new Set(), "ghost"]);
    });

    it("sessionEnded 抛错 → 只记日志", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {
        // 断言在下方
      });
      const ctx = makeCtx();
      apply(ctx);
      vi.spyOn(LessonStore.prototype, "sessionEnded").mockImplementation(async () => {
        throw new Error("清算炸了");
      });
      fireDisposed(ctx, { id: "s1", header: { cwd: GATE_PROJECT_CWD } });
      await flushAsync();
      assert.match(String(error.mock.calls[0]?.[0]), /sessionEnded failed: 清算炸了/u);
    });
  });

  describe("装载期容错（存量迁移与周期衰减）", () => {
    it("存量碎片迁移有归并 → info 日志 + 碎片收敛成稳定签名卡", async () => {
      const info = vi.spyOn(console, "info").mockImplementation(() => {
        // 断言在下方
      });
      const ctx = makeCtx({
        rules: [fragmentRow("f1", "/repo/src/a.ts"), fragmentRow("f2", "/repo/src/b.ts")],
      });
      apply(ctx);
      await flushAsync();
      assert.match(String(info.mock.calls[0]?.[0]), /migrated 1 fragment rule/u);
      const [primary] = loopService(ctx).rules();
      assert.equal(primary?.signature, "edit-before-factgate");
      assert.equal(primary.occurrences, 2);
    });

    it("迁移抛错 → 只记日志，服务照常供给", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {
        // 断言在下方
      });
      vi.spyOn(LessonStore.prototype, "migrateFragmentRules").mockImplementation(async () => {
        throw new Error("迁移炸了");
      });
      const ctx = makeCtx();
      apply(ctx);
      await flushAsync();
      assert.match(String(error.mock.calls[0]?.[0]), /fragment migration failed: 迁移炸了/u);
      assert.notEqual(ctx.provided["lessonLoop"], undefined, "迁移失败不该影响服务供给");
    });

    it("存量 project 键重算且撞车 → info 日志带出归并数，两键收敛成一张卡", async () => {
      const info = vi.spyOn(console, "info").mockImplementation(() => {
        // 断言在下方
      });
      const ctx = makeCtx({
        rules: [
          projectKeyRow("k1", "proj-93e3dace", "/repo/other/../proj"),
          projectKeyRow("k2", PROJECT_KEY_FIXTURE, GATE_PROJECT_CWD),
        ],
      });
      apply(ctx);
      await flushAsync();
      assert.match(
        String(info.mock.calls[0]?.[0]),
        /normalized 1 rule project key\(s\), merged 1 collision/u,
      );
      const rules = loopService(ctx).rules();
      assert.equal(rules.length, 1);
      assert.equal(rules[0]?.project, PROJECT_KEY_FIXTURE);
      assert.equal(rules[0].occurrences, 2);
    });

    it("只重算不撞车 → 日志不带 collision 段；再装载一次不再打日志（幂等）", async () => {
      const info = vi.spyOn(console, "info").mockImplementation(() => {
        // 断言在下方
      });
      // 第一次装载：同一份假件里躺着旧键行，迁移把它写成规范键
      const seeded = makeCtx({
        rules: [projectKeyRow("k3", "proj-93e3dace", "/repo/other/../proj")],
      });
      apply(seeded);
      await flushAsync();
      assert.match(String(info.mock.calls[0]?.[0]), /normalized 1 rule project key\(s\)$/u);
      assert.doesNotMatch(String(info.mock.calls.map(String)), /collision/u);
      // 第二次装载：project 已是规范键 → 零改写、零日志（把已归一的段落交给新实例）
      info.mockClear();
      const again = makeCtx({ rules: rulesOf(seeded) });
      apply(again);
      await flushAsync();
      assert.equal(
        info.mock.calls.map(String).filter((line) => line.includes("project key")).length,
        0,
      );
    });

    it("project 键迁移抛错 → 只记日志，服务照常供给", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {
        // 断言在下方
      });
      vi.spyOn(LessonStore.prototype, "migrateProjectKeys").mockImplementation(async () => {
        throw new Error("键炸了");
      });
      const ctx = makeCtx();
      apply(ctx);
      await flushAsync();
      assert.match(String(error.mock.calls[0]?.[0]), /project key migration failed: 键炸了/u);
      assert.notEqual(ctx.provided["lessonLoop"], undefined, "迁移失败不该影响服务供给");
    });

    it("decay 抛错 → decay failed 日志，且仍武装下一轮", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {
        // 断言在下方
      });
      vi.spyOn(LessonStore.prototype, "runDecay").mockImplementation(async () => {
        throw new Error("衰减炸了");
      });
      const ctx = makeCtx();
      apply(ctx);
      await flushAsync();
      assert.match(String(error.mock.calls[0]?.[0]), /decay failed: 衰减炸了/u);
      assert.equal(ctx.timerCallbacks.length, 1);
    });
  });

  describe("不可判定态的投影（/stats + /rules）", () => {
    it("stats GET 的规则投影带 undeterminable:true，并汇总 undeterminableCount", async () => {
      const ctx = makeCtx({ rules: [undeterminableRow()] });
      apply(ctx);
      await flushAsync();
      const res = makeRes();
      ctx.routes[STATS_ROUTE]?.(makeReq({ url: STATS_ROUTE }), res);
      const body = JSON.parse(String(res.body)) as {
        undeterminableCount: number;
        rules: { id: string; undeterminable: boolean; samples: number }[];
      };
      assert.equal(body.undeterminableCount, 1);
      assert.equal(body.rules.find((rule) => rule.id === "rule-und")?.undeterminable, true);
      assert.equal(body.rules.find((rule) => rule.id === "rule-und")?.samples, 0);
    });

    it("rules GET 同样带 undeterminable；新升格的 armed 规则为 false", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const id = await armedRule(ctx);
      const res = makeRes();
      ctx.routes[RULES_ROUTE]?.(makeReq({ url: RULES_ROUTE }), res);
      const body = JSON.parse(String(res.body)) as {
        rules: { id: string; undeterminable: boolean }[];
      };
      assert.equal(body.rules.find((rule) => rule.id === id)?.undeterminable, false);
    });

    it("runDecay 的不可判定日志：不降级、不改状态，只报 undeterminable 计数", async () => {
      const info = vi.spyOn(console, "info").mockImplementation(() => {
        // 断言在下方
      });
      const ctx = makeCtx({ rules: [undeterminableRow()] });
      apply(ctx);
      await flushAsync();
      const line = info.mock.calls.map(String).find((entry) => entry.includes("decay:"));
      assert.match(String(line), /0 demoted, 1 undeterminable/u);
      assert.equal(
        loopService(ctx)
          .rules()
          .find((rule) => rule.id === "rule-und")?.status,
        "armed",
      );
    });
  });

  // ── 双语（P6）：host 侧文案随官方 locale 偏好走，规则数据永不改写 ─────────
  // 读的是官方 dsh-client-locale 拥有的 settings 命名空间 `locale`（假件里由
  // makeCtx({ locale }) 递值）；未注册即中文——上面 60 多条既有断言全走中文路径，
  // 它们本身就是「默认语言 = zh」的回归网。这里只补 en 分支与数据面红线。
  describe("host 文案的语言偏好（locale.preference）", () => {
    /** 常驻段 + 命令注册面（description / input.hint 在装载期求值一次）。 */
    it("preference=en-US → 常驻 systemPrompt 段是英文（主语言子标签判定）", () => {
      const ctx = makeCtx({ locale: { preference: "en-US" } });
      apply(ctx);
      assert.ok(textOf(ctx.section).includes("self-evolution loop"));
      assert.doesNotMatch(textOf(ctx.section), /\p{Script=Han}/u);
    });

    it("locale 命名空间未注册 / 偏好值不认识 → 中文默认，不抛", () => {
      const unregistered = makeCtx();
      apply(unregistered);
      assert.ok(textOf(unregistered.section).includes("自进化环"));
      const bogus = makeCtx({ locale: { preference: "fr-FR" } });
      apply(bogus);
      assert.ok(textOf(bogus.section).includes("自进化环"));
      const notARecord = makeCtx({ locale: null });
      apply(notARecord);
      assert.ok(textOf(notARecord.section).includes("自进化环"));
    });

    it("en：命令的 description 与 input.hint 是英文（注册面也吃偏好）", () => {
      const ctx = makeCtx({ locale: { preference: "en" } });
      apply(ctx);
      const desc = ctx.command?.desc as { description?: string; input?: { hint?: string } };
      assert.equal(desc.description, MESSAGES.en.digestCommandDescription);
      assert.equal(desc.input?.hint, MESSAGES.en.digestInputHint);
      const zhCtx = makeCtx();
      apply(zhCtx);
      const zhDesc = zhCtx.command?.desc as { description?: string };
      assert.equal(zhDesc.description, MESSAGES.zh.digestCommandDescription);
    });

    it("en：/lessons-digest 的闸门回显、失败回显与成功清单都是英文", async () => {
      const off = makeCtx({ locale: { preference: "en" }, value: { enabled: false } });
      apply(off);
      const rejected = await off.command?.handler(digestInvocation());
      assert.equal(rejected?.text, MESSAGES.en.digestRejectedDisabled);

      const noLlm = makeCtx({ locale: { preference: "en" } });
      apply(noLlm);
      const llmless = await noLlm.command?.handler(digestInvocation());
      assert.equal(llmless?.text, MESSAGES.en.digestRejectedNoLlm);

      const capture: { prompt?: string } = {};
      const ok = makeCtx({
        locale: { preference: "en" },
        services: {
          llm: fakeLlm(
            '[{"category":"unfinished-turn","signature":"todo","statement":"close the task list"}]',
            capture,
          ),
          agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) },
        },
      });
      apply(ok);
      const done = await ok.command?.handler(digestInvocation("focus on the gate"));
      assert.equal(done?.kind, "success");
      const head = fill(MESSAGES.en.digestCreated, { count: 1, lines: "" });
      assert.ok(done.text.startsWith(head.slice(0, -1)), "回执以 en 模板起头");
      assert.ok(done.text.includes("close the task list"), "蒸馏出的规则正文不改写");
      // 进模型的提示词整帧换语言（差评/背景条目是数据，原样定界透传）
      assert.ok(String(capture.prompt).includes(MESSAGES.en.digestSectionFeedback));
      assert.ok(!String(capture.prompt).includes(MESSAGES.zh.digestSectionFeedback));
    });

    it("en：模型侧失败原因经命令回显也是英文（runDigest 抛的串吃同一份消息表）", async () => {
      const ctx = makeCtx({
        locale: { preference: "en" },
        services: { llm: fakeLlm("[]") },
      });
      apply(ctx);
      const result = await ctx.command?.handler(digestInvocation());
      assert.equal(result?.kind, "error");
      assert.equal(
        result.text,
        fill(MESSAGES.en.digestFailed, { reason: MESSAGES.en.errNoModelSelection }),
        "回显 = en 前缀 + en 失败原因（runDigest 抛的串吃同一份消息表）",
      );
    });

    it("en：armed 规则注入帧换语言，新起草的正文是英文，已落库正文逐字保留", async () => {
      const ctx = makeCtx({
        locale: { preference: "en" },
        // 存量卡：上一版（或人工）写下并已生效的中文正文，属条目段 rules 里的用户数据。
        rules: [{ ...undeterminableRow(), id: "legacy", signature: SIGNATURE_CARGO_TEST }],
      });
      apply(ctx);
      const svc = loopService(ctx);
      const first = await svc.report({
        source: SOURCE_DANGER_GUARD,
        category: CATEGORY_GATE_FAILURE,
        cwd: GATE_PROJECT_CWD,
        signature: SIGNATURE_GATE_COMMAND,
        detail: "门禁失败",
      });
      assert.equal(await svc.ruleAction(first.candidate!.id, "arm"), "persisted");
      const injected: unknown[] = [];
      fireCreated(ctx, {
        inject: (message: unknown) => {
          injected.push(message);
        },
        session: { id: "s1", header: { cwd: GATE_PROJECT_CWD } },
      });
      const text = String((injected[0] as { content: { text: string }[] }).content[0]?.text);
      assert.ok(text.includes(MESSAGES.en.digestHeading), "帧抬头是英文");
      // 新起草的正文是本包自己的模板 → 随 locale 走英文
      const drafted = first.candidate?.statement ?? "";
      assert.equal(
        drafted,
        fill(MESSAGES.en.statementGateFailure, { signature: SIGNATURE_GATE_COMMAND }),
      );
      assert.doesNotMatch(drafted, /\p{Script=Han}/u);
      assert.ok(text.includes(drafted), "en 正文进了注入帧");
      // 已落库的正文一个字都不动（连语言切换也不例外）
      assert.ok(text.includes("从没被测到过的老规则"), "存量中文正文一字不改");
      assert.ok(text.includes("armed on"), "生效日期尾巴走 en 模板");
    });

    it("en：装载后改偏好，下一条起草的规则卡正文即换成英文（消息表按取用口现取）", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      const zhCard = await svc.report({
        source: SOURCE_DANGER_GUARD,
        category: "max-tokens",
        cwd: GATE_PROJECT_CWD,
        signature: "long-output",
        detail: "输出被截断",
      });
      assert.equal(zhCard.candidate?.statement, MESSAGES.zh.statementMaxTokens);
      ctx.localeValue = { preference: "en" };
      const enCard = await svc.report({
        source: SOURCE_DANGER_GUARD,
        category: CATEGORY_GATE_FAILURE,
        cwd: GATE_PROJECT_CWD,
        signature: SIGNATURE_CARGO_TEST,
        detail: "门禁失败",
      });
      assert.equal(
        enCard.candidate?.statement,
        fill(MESSAGES.en.statementGateFailure, { signature: SIGNATURE_CARGO_TEST }),
      );
    });

    it("en：rule-action 端点的 error 回显换语言（卡片直接显示它）", async () => {
      const ctx = makeCtx({ locale: { preference: "en" } });
      apply(ctx);
      const csrf = csrfOf(ctx);
      const unknown = await postJson(
        ctx,
        RULE_ACTION_ROUTE,
        { id: "rule-1", action: "boom" },
        { "x-lesson-csrf": csrf },
      );
      assert.ok(
        String(unknown.body).includes(fill(MESSAGES.en.errUnknownAction, { action: "boom" })),
      );
      const missing = await postJson(
        ctx,
        RULE_ACTION_ROUTE,
        { action: "arm" },
        { "x-lesson-csrf": csrf },
      );
      assert.ok(String(missing.body).includes(MESSAGES.en.errIdAndActionRequired));
      const notFound = await postJson(
        ctx,
        RULE_ACTION_ROUTE,
        { id: "rule-nope", action: "arm" },
        { "x-lesson-csrf": csrf },
      );
      assert.ok(String(notFound.body).includes(MESSAGES.en.errRuleNotFound));
      const broken = makeRes();
      ctx.routes[RULE_ACTION_ROUTE]?.(
        makeReq({
          method: "POST",
          url: RULE_ACTION_ROUTE,
          headers: { "x-lesson-csrf": csrf },
          chunks: ["{"],
        }),
        broken,
      );
      await flushAsync();
      assert.ok(String(broken.body).includes(MESSAGES.en.errInvalidJsonBody));
    });

    it("改偏好即时生效：同一次装载里上一条 zh、下一条 en（不重启、不重装载）", async () => {
      const ctx = makeCtx({ value: { enabled: false } });
      apply(ctx);
      const off = await ctx.command?.handler(digestInvocation());
      assert.equal(off?.text, MESSAGES.zh.digestRejectedDisabled);
      ctx.localeValue = { preference: "en" };
      const after = await ctx.command?.handler(digestInvocation());
      assert.equal(after?.text, MESSAGES.en.digestRejectedDisabled);
    });
  });

  // ── 开机那一刻"本条目还没被投影"：不出声 ────────────────────────────────────
  // 真实宿主隔离实测：插件 apply 早于自己那条 fiber 变 ACTIVE，而 0.1.7 的 describe()
  // 只收 ACTIVE 条目（apply 那一刻只投出别的行，不含 lesson-loop）。这种"读不出形状"是
  // 装载次序的既定事实，不是数据坏了：把它报成 rejected，人就会去修根本没坏的数据；报成
  // 一行 warn，则是每次正常开机都多一条与故障无关的噪声（用户报的日志噪点正是这条）。
  // 真正的坏形状（行在投影里、rules 却不是数组）仍必须出声——两条在这里分开钉。
  describe("规则面装载期降级说法（apply 早于条目 ACTIVE）", () => {
    it("本条目尚未进 describe() 投影 ⇒ 装载期一律不出声（既不 rejected 也不 warn）", () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {
        // 断言在下方
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {
        // 断言在下方
      });
      const ctx = makeCtx();
      // 模拟"投影里还没有本条目"：整个 describe() 一行都不给。
      ctx.settings.describe = () => [];
      apply(ctx);
      assert.deepEqual(error.mock.calls, [], "没投影不等于数据坏，不许报 rejected");
      assert.deepEqual(warn.mock.calls, [], "时序不是故障，不该每次开机刷一行");
      error.mockRestore();
      warn.mockRestore();
    });

    it("行已在投影里、rules 却是非数组 ⇒ 出 rejected 那条 error", () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {
        // 断言在下方
      });
      const ctx = makeCtx();
      // 直接给一张"本条目的行在、user.rules 是字符串"的投影：假件的 describe() 面就是
      // readonly unknown[]，故按行造数据而不是改写原投影（那需要往 unknown 上再断言一层）。
      ctx.settings.describe = () => [
        {
          ns: PLUGIN_ID_FIXTURE,
          value: { rules: [] },
          user: { rules: "not-an-array" },
          revision: 0,
        },
      ];
      apply(ctx);
      assert.match(
        error.mock.calls.map(String).join("\n"),
        /rules namespace rejected/u,
        "行在投影里却读不懂，就是数据坏了，必须点名",
      );
      error.mockRestore();
    });
  });

  describe("信任闸门：/_dsh/lesson-loop/* 的三判据", () => {
    /** DNS 重绑定的真实形状：Host 是外域，sec-fetch-site 与 Origin 都自洽 ⇒ 只有 Host 腿拒得了。 */
    const REBINDING: Record<string, unknown> = {
      host: "evil.test:8787",
      origin: "http://evil.test:8787",
      "sec-fetch-site": "same-origin",
    };

    it("token 下发的 GET 与写端点的 POST 都拒重绑定（本包一半暴露面在 token GET 上）", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const statsRes = makeRes();
      ctx.routes[STATS_ROUTE]?.(makeReq({ url: STATS_ROUTE, headers: REBINDING }), statsRes);
      assert.equal(statsRes.code, 403);
      assert.match(statsRes.body ?? "", /untrusted host authority/u);
      assert.doesNotMatch(statsRes.body ?? "", /csrf/u, "被拒的响应里不许带出 token");

      const action = await postJson(ctx, RULE_ACTION_ROUTE, { action: "arm" }, REBINDING);
      assert.equal(action.code, 403);
      assert.match(action.body ?? "", /untrusted host authority/u);
    });

    it("四条路由逐条都被拒（防「只装了其中两条」的漏装）", async () => {
      const ctx = makeCtx();
      apply(ctx);
      // 闸门的判据与写响应都是同步的 ⇒ 先把四次打完，再统一断言。
      const hits: { routePath: string; res: FakeRes }[] = [];
      for (const routePath of [STATS_ROUTE, RULES_ROUTE, LESSONS_ROUTE, RULE_ACTION_ROUTE]) {
        const res = makeRes();
        ctx.routes[routePath]?.(makeReq({ url: routePath, headers: REBINDING }), res);
        hits.push({ routePath, res });
      }
      await Promise.resolve();
      assert.equal(hits.length, 4);
      for (const one of hits) {
        assert.equal(one.res.code, 403, one.routePath);
        assert.match(one.res.body ?? "", /untrusted host/u, one.routePath);
        assert.doesNotMatch(one.res.body ?? "", /csrf/u, `${one.routePath} 被拒时不许带出 token`);
      }
    });

    it("判据次序：恶意 Host 与 cross-site 同现时报 Host 腿那句（钉住闸门顺序）", () => {
      const ctx = makeCtx();
      apply(ctx);
      const res = makeRes();
      ctx.routes[STATS_ROUTE]?.(
        makeReq({
          url: STATS_ROUTE,
          headers: { host: "evil.test:8787", "sec-fetch-site": "cross-site" },
        }),
        res,
      );
      assert.equal(res.code, 403);
      assert.match(res.body ?? "", /untrusted host authority/u);
    });

    it("缺 Host 仍按旧口径走（本地 CLI 面）：token 正常下发，闸门不插手", async () => {
      // 这条是"本波新增 17 处插桩却一条既有断言都不用改"的针：171 个手搓构造点都不带 host，
      // requestTrust 那一侧退回看对端（无 socket ⇒ 未知），于是继续走它自己的 CSRF 判据。
      const ctx = makeCtx();
      apply(ctx);
      const res = makeRes();
      ctx.routes[STATS_ROUTE]?.(makeReq({ url: STATS_ROUTE }), res);
      assert.equal(res.code, 200);
      const body = JSON.parse(res.body ?? "{}") as { csrf?: string };
      assert.match(String(body.csrf), /[0-9a-f-]{36}/u);
    });

    it("回环 Host + 同源 Origin 正常通过；异源 Origin 即便 Host 是回环也拒", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const okRes = makeRes();
      ctx.routes[STATS_ROUTE]?.(
        makeReq({
          url: STATS_ROUTE,
          headers: { host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" },
        }),
        okRes,
      );
      assert.equal(okRes.code, 200);

      const badRes = makeRes();
      ctx.routes[STATS_ROUTE]?.(
        makeReq({
          url: STATS_ROUTE,
          headers: { host: "127.0.0.1:8787", origin: "http://evil.test" },
        }),
        badRes,
      );
      assert.equal(badRes.code, 403);
      assert.match(badRes.body ?? "", /cross-origin request rejected/u);
    });
  });

  // ── 蒸馏超时/衰减周期进 entry config；退出清算改可 await 的异步 disposer ────────

  describe("部署值与退出清算静默", () => {
    it("行 config 覆盖 decayIntervalMs → 周期衰减按配置时长武装（不再写死 24h）", () => {
      const ctx = makeCtx({ value: { decayIntervalMs: 60_000 } });
      apply(ctx);
      assert.deepEqual(ctx.timerMs, [60_000], "衰减定时器是本包唯一的 timer.timeout 消费点");
    });

    it("两枚部署值不标 volatile ⇒ 设置表单仍是十二项", () => {
      const form = volatileFormOf(plugin.Config as unknown as SchemaNode);
      assert.equal(form?.length, 12, "部署值不进表单，投影字段集不变");
      for (const key of DEPLOYMENT_FIELDS) {
        assert.equal(configDict()[key]?.meta?.["volatile"], undefined, `${key} 不该是 volatile`);
      }
    });

    it("退出清算 await 得下来：await 之后那条会话才真的结算", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      const cwd = GATE_PROJECT_CWD;
      const first = await svc.report({
        source: SOURCE_QUALITY_GATE,
        category: CATEGORY_GATE_FAILURE,
        cwd,
        sessionId: "s-w4",
        signature: SIGNATURE_GATE_COMMAND,
        detail: "f",
      });
      assert.equal(await svc.ruleAction(first.candidate!.id, "arm"), "persisted");
      fireCreated(ctx, { session: { id: "s-w4", header: { cwd } } });
      // 换一枚"要跨一个宏任务才写完"的 sessionEnded：同步 disposer 会在拆纤当场把它丢下
      const settled: string[] = [];
      vi.spyOn(LessonStore.prototype, "sessionEnded").mockImplementation(async () => {
        await Promise.resolve();
        settled.push("s-w4");
      });
      const pending = Promise.all(ctx.effects.map((dispose) => dispose()));
      assert.deepEqual(settled, [], "await 之前不许声称已经静默（defensive-patterns:19-21）");
      await pending;
      assert.deepEqual(settled, ["s-w4"], "退出清算把这条会话的度量写完了才交回控制权");
    });

    it("退出清算交回的是异步 disposer（形状钉：不靠宏任务赌一拍）", async () => {
      const ctx = makeCtx();
      apply(ctx);
      fireCreated(ctx, { session: { id: "s-shape", header: { cwd: GATE_PROJECT_CWD } } });
      const results = ctx.effects.map((dispose) => dispose());
      assert.ok(
        results.some((value) => isThenable(value)),
        "至少一枚释放器必须是可 await 的：否则在飞的 provider 写会被拆纤截断",
      );
      await Promise.all(results);
    });
  });
});
