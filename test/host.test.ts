// host 全链测试：mock ctx 驱动 lesson-loop 的注册入口（0.2.1-alpha.2 隐式设置投影 + 页面策略）
// 与服务供给 / 上报 / 收尾清算 / 会话开始注入 / webServer 端点（csrf）/ /lessons-digest
// 命令 / 衰减定时器。
import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as flushAsync } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import plugin, { cacheFile } from "../host.ts";
import { DatabaseSync } from "node:sqlite";
import { LESSON_DB_FILE, LedgerConsumedElsewhereError, LessonDb } from "../lib/lesson-db.ts";
import { LessonStore, deriveProject } from "../lib/lesson-store.ts";
import type {
  LessonRecord,
  ReportReceipt,
  RuleActionResult,
  RuleCard,
} from "../lib/lesson-store.ts";
import { RULES_FIELD, SETTINGS_NAMESPACE } from "../lib/rules-layout.ts";
import { MESSAGES, fill } from "../lib/messages.ts";
import { UI_MESSAGES } from "../src/ui-messages.ts";
import { loggedText } from "./setup-logs.ts";
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
 * 0.2.1-alpha.2 的 settings 宿主服务（`register`/`get`/`installSection` 已被宿主移除）：
 * describe（读，含跨命名空间的 locale）+ update（规则库 CAS 写）+ configure（页面策略）。
 * 对照 installed `@deepseek-ai/dsh-settings/lib/types/index.d.ts`：SettingsForms 残缺是
 * `configure`(:80) / `prepareDocument`(:91) / `describe`(:96) / `update`(:102) /
 * `replace`(:108) / `mutate`(:114)。本包只装用得到的三件——写走 `update(ns, patch,
 * expectedRevision)`（merge 写，数组键整片覆盖，正是规则库要的语义），不用 `mutate`
 * （那是给脱敏视图做路径级编辑、避免覆掉 secret 的路子，本包一段里没有 secret）。
 * ⚠ 这份清单**不许**再补回 register/get：假件一旦有它们，host.ts 里"没有注册可被打回"
 * 那几条降级分支就只能在误判通过里躺着（真宿主 0.2.1-alpha.2 根本没有那两个方法）。
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
  handlers: Record<string, ((payload: unknown, ...rest: unknown[]) => unknown)[]>;
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
    /** 0.2.2-rc.5 起的段通知两枚：宿主在**装配**时把它们贴到变更/退役通知上
     *  （packages/core/system-prompt/src/index.ts:93-104）。 */
    replacement?: string;
    retirement?: string;
    text: string | ((context: unknown) => string);
  } | null;
  /** 段注册次数：语言偏好变化时本包会"先撤再注册"一次（两枚通知文案随注册被捕获）。 */
  sectionRegistrations: number;
  /** 活着的 agent，按 session id 索引：`session/event` 的处理器只拿到 Session，
   *  要经官方 `ctx.agents.get(id)` 取回 Agent 面（注入只能发生在 Agent 上）。 */
  liveAgents: Map<string, unknown>;
  timerCallbacks: (() => void)[];
  /** 与 timerCallbacks 同序登记的毫秒数（decayIntervalMs 走配置就得在这里看得见）。 */
  timerMs: number[];
  /** 本插件 fiber 的替身：`configure` 的 owner 必须原样带回它（身份断言用）；
   *  `await()` 按 cordis 的生命周期语义建模——apply 跑在 fiber 变 ACTIVE **之前**，
   *  而真实宿主里 `settings.describe()` 只投影 ACTIVE 条目（harness
   *  packages/settings/settings/src/index.ts:305-306），所以装载期读规则库只有等
   *  `fiber.await()` 结算这一条路（host.ts 的 startBootMigrations）。假件里"结算"就是一个
   *  微任务边界：apply 期间同步读仍看不到行，await 之后的读取才落到 ACTIVE 语义上。 */
  fiber: { id: string; await: () => Promise<void>; state?: number };
  /** settings.configure 的调用记录（页面策略断言用）。 */
  configureCalls: ConfigureCall[];
  /** ctx.inject 收到的依赖清单（页面策略挂在哪个子上下文上，靠它核对）。 */
  injectDeps: string[][];
  /** 官方 locale 命名空间那一行的 value（0.2.1-alpha.2 唯一的读口是 `describe()`：宿主已无
   *  `settings.get`。可装载后翻动，模拟换语言即时生效；undefined = 未注册 → 中文）。 */
  localeValue: Record<string, unknown> | undefined;
  settings: SettingsSurface;
  /** 规则库落在那儿的 settings 假件：注入存量行、数写次数、制造冲突都走它。 */
  rulesProvider: SettingsProviderFake;
  provide: (name: string, value: unknown) => () => void;
  /** 官方服务注册口（Remote 服务构造时用）。 */
  reflect: { provide: (name: string, value: unknown) => () => void };
  get: (name: string) => unknown;
  /** 官方 `ctx.sessionQuery.observeSession()` 交回的事件流（/lessons-digest 的差评来源）。
   *  迁移前这一档由 `agent.session.snapshotEvents()` 给；官方已把那条同步读取接口标为
   *  `@deprecated`，host 侧改走 sessionQuery（见 host.ts 的 digestEvents），假件因此挪到这里。 */
  sessionEvents: Record<string, unknown>[];
  /** `observeSession` 的调用记录：投影模式必须显式为 none（只读事件时不该算全投影）。 */
  observeCalls: {
    sessionId: unknown;
    options: { projectionMode?: string } | undefined;
  }[];
  /** 观察租约的释放次数。 */
  disposeCalls: number;
  inject: (deps: readonly string[], attach: (child: unknown) => void) => void;
  on: (event: string, handler: (payload: unknown, ...rest: unknown[]) => unknown) => void;
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

/** 导出 Config schema 的字段名清单（唯一来源：不手写，漏字段就是测试的事）。 */
const CONFIG_KEYS: string[] = Object.keys(
  (plugin.Config as unknown as { dict: Record<string, unknown> }).dict,
);

/**
 * 复刻 cordis 交进 apply 的那份 Config：每个 volatile 字段一枚**稳定引用**，其 get() 现读
 * 假件解析值——与真实 Volatile 的"引用不变、值可变"同构（官方读取接口只有 `get()`，见
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
    /** 旧 `config.rules` 的原文替身（坏形状用例用；缺省 = over.rules 的数组）。 */
    rawRules?: unknown;
    /** 老 patch 里压根没有 `rules:` 这一键：config 上不挂该字段（新装用户的常态）。 */
    omitRawRules?: boolean;
    /** 官方 locale 命名空间的初值（describe() 里 ns==='locale' 那条的 value）；
     *  缺省 = 未注册 → 中文。装载后翻动 `ctx.localeValue` 即可模拟换语言。 */
    locale?: Record<string, unknown> | null;
  } = {},
): FakeCtx {
  const initialRules = over.rules ?? [];
  const rawRules = over.rawRules === undefined ? [...initialRules] : over.rawRules;
  const configRules = over.omitRawRules === true ? {} : { [RULES_FIELD]: rawRules };
  // 假件的设置段仍带一份 rules 原文：它模拟的是"老 profile 文档里还在"的那一段，
  // 插件的规则读取已改走 SQLite，迁移源则从 apply 的 config（未声明键透传）里取。
  const rulesProvider = makeSettingsProvider({
    [SETTINGS_NAMESPACE]: { [RULES_FIELD]: [...initialRules], ...over.value },
  });
  const ctx: FakeCtx = {
    // 假件文档里的那一层原文（同一引用：翻它 = 翻条目段，下一次读即生效）。
    value: rulesProvider.peek(SETTINGS_NAMESPACE) ?? {},
    config: {
      ...liveConfigRefs((key) => rulesProvider.resolvedOf(SETTINGS_NAMESPACE)[key]),
      // 字段已从 schema 摘除，但宿主对未声明键透传：迁移只读这一段原文。
      ...configRules,
    },
    services: over.services ?? {},
    // 蒸馏事件流的默认交付：空表（个别用例往里塞 feedback 事件）。
    sessionEvents: [],
    observeCalls: [],
    disposeCalls: 0,
    // 这四个假件字段不写 `{} as …` 断言：`const ctx: FakeCtx` 已给出上下文类型，
    // 断言在 oxlint 的类型感知规则下就是冗余（0.2.1-alpha.2 迁移把 describe() 的返回收成
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
      replacement?: string;
      retirement?: string;
      text: string | ((context: unknown) => string);
    },
    sectionRegistrations: 0,
    liveAgents: new Map<string, unknown>(),
    timerCallbacks: [] as (() => void)[],
    timerMs: [] as number[],
    fiber: {
      id: "lesson-loop-fiber",
      // 一微任务即"结算"：apply 内的同步读仍落在未 ACTIVE 的语义上（与真宿主一致）。
      await: () => Promise.resolve(),
      // 迁移只在 ACTIVE 后触发；替身在这一层按"已结算"给状态（真宿主的时序由
      // test/integration/activation-order.test.ts 单独钉）。
      state: 2,
    },
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
    reflect: {
      provide: (name: string, value: unknown) =>
        typeof ctx.provide === "function"
          ? ctx.provide(name, value)
          : () => {
              void 0;
            },
    },
    get(name: string) {
      return ctx.services[name] ?? ctx.provided[name];
    },
    /** ctx.inject(deps, fn)：cordis 立即用带齐依赖的子上下文回调一次——依赖名对应的
     *  服务从本假件的宿主服务取（缺位即 undefined，与真宿主"还没来"同形）。 */
    inject(deps: readonly string[], attach: (child: unknown) => void) {
      ctx.injectDeps.push([...deps]);
      const injected = Object.fromEntries(
        deps.map((name) => [name, ctx.services[name] ?? ctx.provided[name]]),
      );
      attach({
        ...injected,
        settings: {
          configure: ctx.settings.configure,
        },
        // 子上下文的 effect 与父上下文**同构**：disposer 一样进 ctx.effects。少了这一层，
        // "卸载 → 四条路由全部注销"那条断言就失去了观测点（旧实现把路由效应挂在父 ctx 上，
        // disposer 自然在清单里；改挂子 ctx 后若子上下文丢弃 disposer，注销语义就成了空话）。
        effect(factory: () => (() => unknown) | undefined) {
          const disposer = factory();
          if (typeof disposer === "function") {
            ctx.effects.push(disposer);
          }
        },
        // 子上下文上的 `on`：真宿主里 listener 归这条 inject 子 fiber 所有、返回值是撤除
        // 函数（vendor/cordis/src/events.ts:296-315）。假件必须同形，否则"effect 重跑留下
        // 旧监听"这个缺陷在单测里根本观测不到——父 ctx 的 `on` 不返回东西。
        on(event: string, handler: (payload: unknown) => void) {
          const list = ctx.handlers[event] ?? [];
          ctx.handlers[event] = list;
          list.push(handler);
          return (): void => {
            const at = list.indexOf(handler);
            if (at !== -1) {
              list.splice(at, 1);
            }
          };
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
  // 默认宿主服务（测试按需覆盖 services 字段）
  ctx.services["webServer"] = {
    // 宿主 0.2.1-alpha.2 起 `Config.host` 是任意本机 IP 字面量（通配地址载入即拒），
    // 替身照这个形状给一枚，别再留 undefined 让绑定侧的判据没机会跑。
    host: "127.0.0.1",
    register(route: { path: string; handler: (req: FakeReq, res: FakeRes) => void }) {
      ctx.routes[route.path] = route.handler;
      return () => {
        Reflect.deleteProperty(ctx.routes, route.path);
      };
    },
  };
  ctx.services["systemPrompt"] = {
    section(desc: {
      name: string;
      order: number;
      replacement?: string;
      retirement?: string;
      text: string | ((context: unknown) => string);
    }) {
      ctx.section = desc;
      ctx.sectionRegistrations += 1;
      return () => {
        // 撤下当前注册：重注册是"先 dispose 再 section"，故这里清空槽位，
        // 让"重注册之后槽里是新那份"这件事可观测。
        ctx.section = null;
      };
    },
  };
  // 官方 agent 注册表（`ctx.agents`）：`session/event` 的处理器要按 session id 取活 Agent。
  ctx.services["agents"] = {
    get(id: unknown) {
      return ctx.liveAgents.get(String(id));
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
  // digestEvents 的读取接口）：默认空事件流，个别用例改 ctx.queryEvents。
  ctx.services["sessionQuery"] = {
    observeSession: async (sessionId: unknown, options?: { projectionMode?: string }) => {
      ctx.observeCalls.push({ sessionId, options });
      return {
        events: ctx.sessionEvents,
        [Symbol.dispose]() {
          ctx.disposeCalls += 1;
        },
      };
    },
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

/** rule-action 端点 handler 是 fire-and-forget（同步 wrapper + void 内部 async），
 *  写到磁盘响应在微任务队列完成；setImmediate（宏任务）可保证其已 flush（防时序假设）。 */

// ── 端点/宿主服务公共小件 ───────────────────────────────────────────────────

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
const CATEGORY_TRANSIENT_FAILURE = "transient-failure";
const GATE_PROJECT_CWD = "/repo/proj";
const SIGNATURE_GATE_COMMAND = "pnpm check";
/** danger-guard 来源 + factgate-deny 分类：碎片行/迁移样本用的另一对生产者与分类。 */
const SOURCE_DANGER_GUARD = "danger-guard";
const CATEGORY_FACTGATE_DENY = "factgate-deny";
/** 折叠类别的代表：卡上的签名是类别级稳定键，输入给的是命令原文，两者必然不同。 */
const CATEGORY_DANGEROUS_BASH = "dangerous-bash";
const BASH_COMMAND_FIXTURE = "git commit --no-verify";
/** 桶键夹具：由被测别名按当前平台派生（Windows 的规范化结果带盘符，POSIX 字面量不能复用）。 */
const PROJECT_KEY_FIXTURE = deriveProject(GATE_PROJECT_CWD);
/** 官方 `StreamChunk` 的文本增量判别位（假 llm 回包用）。 */
const CHUNK_TEXT_DELTA = "text-delta";
/** HOME 兜底用例里假定的家目录（DSH_HOME 未设时 cache 应落在这里）。
 *  按宿主平台归一化；Windows 的 os.homedir() 读 USERPROFILE，用例同时注入两条。 */
const TEST_HOME_DIR = path.resolve("/home/tester");
/** 门禁命令的另一种形态：gate-failure 签名夹具（与 pnpm check 同位、不同值）。 */
const SIGNATURE_CARGO_TEST = "cargo test";

/** lessonLoop 宿主服务的动作名（与 host 的 ruleAction 参数同集）。 */
type ActionName = "arm" | "reject" | "demote" | "archive" | "edit" | "revive";

/** lessonLoop 宿主服务投影（测试只用到这些方法；report/ruleAction 自规则库进 settings 起即异步）。 */
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

/** 规则库的当前内容（走服务读取口：规则库主介质已换成 SQLite，不再读设置段）。 */
function rulesOf(ctx: FakeCtx): RuleCard[] {
  return loopService(ctx).rules();
}

/** 卸载之后"到底写进库没有"只能另开一条连接问：退出清算那条释放器在收尾时关闭了本插件的
 *  连接（`DatabaseSync` 不关就一直占着 WAL 的读快照），此后 `svc.rules()` 读到的是端口
 *  失败折成的空库——拿它断言等于把"库已关"读成"什么都没写"。 */
function cardsOnDisk(): RuleCard[] {
  const db = LessonDb.open({
    path: path.join(scratch, "data", PLUGIN_ID_FIXTURE, LESSON_DB_FILE),
  });
  assert.notEqual(db, null, "库须能打开");
  if (db === null) {
    return [];
  }
  const read = db.rules.load();
  db.close();
  return [...read.cards];
}

/** 触发官方 agent/created（0.1.6-alpha.2 载荷 {agent, source, signal}）。
 *  注入已改成幂等对账（读事件流 + 比对上一条），监听器交回 Promise 由宿主 await
 *  （packages/core/agent/src/index.ts:562-582 的 `await ctx.serial(...)`），
 *  所以这里也 await——不 await 就等于测"注入发生在首个回合之后"。 */
async function fireCreated(ctx: FakeCtx, agent: unknown): Promise<void> {
  const session = (agent as { session?: { id?: unknown } } | undefined)?.session;
  if (typeof session?.id === "string") {
    ctx.liveAgents.set(session.id, agent);
  }
  const handlers = ctx.handlers["agent/created"] ?? [];
  assert.ok(handlers.length > 0, "agent/created 未接线");
  for (const handler of handlers) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- 宿主按序 await 每个监听器（ctx.serial 语义）
    await handler({ agent });
  }
}

/**
 * 事件类型与来源标识的字面量（测试里多处造事件，sonarjs 的重复字面量由常量收口）。
 * 真源是 host.ts 的 `WORKSPACE_ROOT_CHANGE` / `COMPACTION_END` 与 `LESSON_SOURCE_KIND`；
 * 这里刻意写字符串而不 import：测试要能抓住"源码把事件名改掉"这类漂移。
 */
const EVENT_USER_MESSAGE = "user/message";
const EVENT_WORKSPACE_ROOT_CHANGE = "workspace-root/change";
const EVENT_COMPACTION_END = "compaction/end";
const LESSON_SOURCE_KIND_FIXTURE = "plugin:lesson-loop";

/** 注入消息的正文（`agent.inject` 的载荷形状：`{source, content:[{type,text}]}`）。 */
function injectedText(message: unknown): string {
  return (message as { content: { text: string }[] }).content[0]!.text;
}

/** 造一条本包注入的 `user/message` 事件（source.kind 取本包自有 producer 名）。 */
function ownMessageEvent(seq: number, text: string): Record<string, unknown> {
  return {
    type: EVENT_USER_MESSAGE,
    seq,
    time: 1,
    data: {
      id: `m${seq}`,
      role: "user",
      content: [{ type: "text", text }],
      source: { kind: LESSON_SOURCE_KIND_FIXTURE },
    },
  };
}

/** 取出本包那份摘要的正文：先真注入一次，再把这条正文当作"历史里那份"。 */
async function injectedDigest(ctx: FakeCtx): Promise<string> {
  const injected: unknown[] = [];
  await fireCreated(ctx, {
    inject: (message: unknown) => injected.push(message),
    session: { id: "s1", header: { cwd: GATE_PROJECT_CWD } },
  });
  const text = (injected[0] as { content?: { text?: string }[] } | undefined)?.content?.[0]?.text;
  assert.equal(typeof text, "string", "第一次注入没发生");
  return text!;
}

/** 触发官方 session/event（载荷 `(session, event)`，packages/core/session/src/index.ts:85）。
 *  处理器同步起链，调用方按需 `await flushAsync()`。 */
function fireSessionEvent(ctx: FakeCtx, session: unknown, event: unknown): void {
  const handlers = ctx.handlers["session/event"] ?? [];
  assert.ok(handlers.length > 0, "session/event 未接线");
  for (const handler of handlers) {
    handler(session, event);
  }
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
  // 规则库已跨上下文共享（SQLite 单库）：同一签名再次上报时命中的是既有卡，
  // 回执给 violationOf 而不是 candidate。已有 armed 卡就直接用它的 id。
  const id = receipt.candidate?.id ?? receipt.violationOf?.id;
  if (id === undefined) {
    throw new Error("候选卡缺失");
  }
  const rule = svc.rules().find((row) => row.id === id);
  if (rule?.status !== "armed") {
    assert.equal(await svc.ruleAction(id, "arm"), "persisted");
  }
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

/** Config schema 的字段节点（读 meta/type/dict 用，不复制 schema 结构）。 */
interface SchemaNode {
  type?: string;
  meta?: Record<string, unknown>;
  dict?: Record<string, SchemaNode>;
}

/** 导出 Config schema 的 dict（唯一来源：字段名与元数据都从宿主实际读的那份来）。 */
function configDict(): Record<string, SchemaNode> {
  return (plugin.Config as unknown as SchemaNode).dict ?? {};
}

/** 逐字段 schema 默认 —— 等价于 0.1.6 交给 `settings.register(ns, schema, { base })`
 *  的那份 BUILTIN_BASE，0.2.1-alpha.2 把它搬到了 schema 的 `.default()` 上（少一层「底座」）。 */
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

/** cordis.patch.yml 里的裸条目 id —— 0.2.1-alpha.2 的 settings 命名空间就是它。
 *  读文件而不是抄常量：卡片绑的段 / 端点前缀 / 规则库读的段都按它对齐，写死会让测试与包体漂移。 */
function patchEntryId(): string {
  const yml = readFileSync(fileURLToPath(new URL("../cordis.patch.yml", import.meta.url)), "utf8");
  const ids = Array.from(
    yml.matchAll(/^\s*-\s+id:\s*(?<id>\S+)\s*$/gmu),
    (row) => row.groups?.["id"] ?? "",
  );
  assert.ok(ids.includes("dsh-plugin-shared"), "shared 供应行必须使用固定 id");
  const id = ids.find((candidate) => candidate !== "" && candidate !== "dsh-plugin-shared");
  assert.ok(
    typeof id === "string" && id.length > 0,
    "cordis.patch.yml 里没有本包的裸 `- id:` 条目",
  );
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

/** 设置卡该能编辑的字段：12 项开关/阈值 + 证据页大小，一个都不该漏。 */
/** 字段化的三枚部署值：在 Config 上但**不标** volatile ⇒ 不进设置卡。 */
const DEPLOYMENT_FIELDS = ["digestTimeoutMs", "decayIntervalMs", "maxInjectedRules"];

const EDITABLE_FIELDS = [
  "decayDays",
  "demoteMinSamples",
  "demoteRatio",
  "demoteThreshold",
  "enabled",
  "evidencePageSize",
  "injectEnabled",
  "maxLessonsBytes",
  "maxStatementChars",
  "promoteThreshold",
  "reportEnabled",
  "reviveThreshold",
  "sectionEnabled",
];

// ── 非回环宿主服务判据的两枚夹具（描述块外声明：oxlint 的 consistent-function-scoping
//    不许把只读环境表的函数嵌进 describe，consistent-return 又禁 `return undefined`）──

/**
 * 上报一条差评并把它升格为 armed —— 「上报 + 人工升格」这对动作在多条用例里逐字相同。
 *
 * 收成一处是因为它两次撞上 sonarjs 的 no-identical-functions：复制一份就等于把
 * 「升格成功」这条判据散成多份，改一处漏一处的后果是某条用例在验一个已经不存在的契约。
 *
 * @param svc - 本插件对外服务
 * @param category - 差评分类
 * @param signature - 判据签名
 */
async function armingReport(
  svc: ReturnType<typeof loopService>,
  category: string,
  signature: string,
): Promise<void> {
  const receipt = await svc.report({
    source: SOURCE_QUALITY_GATE,
    category,
    cwd: GATE_PROJECT_CWD,
    signature,
    detail: "d",
  });
  assert.equal(await svc.ruleAction(receipt.candidate!.id, "arm"), "persisted");
}

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
    it("同一作用域第二次装配让路：不重复注册任何面、不抛错（market 热挂 + bundle 层双路径）", () => {
      // 双路径：market 的热挂子树与本包的 bundle 层解析到同一份模块，却各起一个 fiber、
      // 各跑一次 apply。第二份若照常装配，prompt 段 / Remote 服务 / 命令 / 定时器都会各挂一份
      // ——判定与写库都跑两遍，而 `append`/`on` 这类注册口**不抛错**，重复因此是静默的。
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {
        // 断言在下方
      });
      const ctx = makeCtx();
      apply(ctx);
      const providedAfterFirst = { ...ctx.provided };
      const effectsAfterFirst = ctx.effects.length;
      const commandAfterFirst = ctx.command;
      assert.doesNotThrow(() => {
        apply(ctx);
      });
      assert.deepEqual(ctx.provided, providedAfterFirst, "第二份不该再注册任何服务");
      assert.equal(ctx.effects.length, effectsAfterFirst, "第二份不该再挂任何 effect");
      assert.equal(ctx.command, commandAfterFirst, "第二份不该再注册命令");
      const printed = warn.mock.calls.map(([line]) => String(line));
      assert.equal(printed.length, 1, "让路时大声说明一次");
      assert.match(printed[0] ?? "", /检测到本插件已在同一作用域内装载/u);
      warn.mockRestore();
    });

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
    it("教训写到磁盘 + 候选卡归并 + 达阈值 ready", async () => {
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
      assert.ok(svc.recentLessons().length > 0, "教训必须落进规则库（events.jsonl 已退役）");
      assert.equal(r1.candidate?.occurrences, 1);
      assert.equal(r1.ready, false);
      await svc.report({ ...lesson, detail: "d2" });
      const r3 = await svc.report({ ...lesson, detail: "d3" });
      assert.equal(r3.ready, true);
      // detail 全量在库（不截断）
      const raw = JSON.stringify(svc.recentLessons());
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
      await fireCreated(ctx, { session: { id: "s2", header: { cwd } } });
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

    it("armed 命中日志带出原始签名：折叠类别能分辨是哪一条命令", async () => {
      // 卡片签名是折叠后的稳定键（dangerous-bash 这一类全部折成类别名），同一张卡上
      // 每条命中逐字相同；能区分单次的是这一条上报的原始签名。不写进日志的话，
      // "74 次里的哪一次"在日志里问不出来。
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      const lesson = {
        source: SOURCE_DANGER_GUARD,
        category: CATEGORY_DANGEROUS_BASH,
        cwd: GATE_PROJECT_CWD,
        signature: BASH_COMMAND_FIXTURE,
      };
      const seeded = await svc.report({ ...lesson, detail: "d1" });
      await svc.ruleAction(seeded.candidate!.id, "arm");
      const hit = await svc.report({ ...lesson, detail: "d2" });
      assert.equal(
        hit.violationOf?.signature,
        CATEGORY_DANGEROUS_BASH,
        "前置：卡上是折叠后的稳定键",
      );
      assert.ok(
        loggedText().includes(`raw=${BASH_COMMAND_FIXTURE}`),
        "原始签名必须出现在日志里，否则同一张卡的多次命中无法区分",
      );
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
      await fireCreated(ctx, { session: { id: "s9", header: { cwd } } });
      // headless/CLI 进程退出时 Cordis 先卸载插件：session/disposed 永远不来，
      // 不就地清算就会把这条暴露度观察整批丢掉（度量恒 0 → 规则永远不可判定）。
      // 异步 disposer 由卸载 await（cordis fiber.d.ts:38-41「they may be async, in which
      // case unloading awaits them」）→ 这里 await 全部释放器，观测点从"给一次宏任务"
      // 升级成"退出清算真的写完了"。清算写完那条释放器顺手关闭连接，故读数改走新连接。
      await Promise.all(ctx.effects.map((dispose) => dispose()));
      assert.equal(cardsOnDisk()[0]?.samples, 1, "退出清算必须补记这条 samples");
    });

    it("退出清算把内存桶与台账合并：同一 pass 只计一次 suppressed", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      const cwd = GATE_PROJECT_CWD;
      const sessionId = "s-exit-pass";
      await armedRule(ctx);
      await fireCreated(ctx, { session: { id: sessionId, header: { cwd } } });
      svc.pass({
        category: CATEGORY_GATE_FAILURE,
        cwd,
        sessionId,
        signature: SIGNATURE_GATE_COMMAND,
      });
      // 不触发 session/disposed，直接走卸载位；旧实现会先按内存桶计一次，再用
      // settleLedgerRemnants 按台账补一次。合并后只允许一次。
      await Promise.all(ctx.effects.map((dispose) => dispose()));
      await flushAsync();
      assert.equal(cardsOnDisk()[0]?.suppressed, 1, "同一 pass 不得被内存与台账各计一次");
      const db = LessonDb.open({
        path: path.join(scratch, "data", PLUGIN_ID_FIXTURE, LESSON_DB_FILE),
      });
      assert.deepEqual(db?.pendingLedger(sessionId), [], "清算后台账行必须落定");
    });

    it("pass 现场建台账：dispose 走同事务落定，规则计数与 settled_at 不分裂", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      const cwd = GATE_PROJECT_CWD;
      const ruleId = await armedRule(ctx);
      const sessionId = "s-pass-only";
      // 没有 agent/created 预种：pass 自己经 bucketOf + noteLedger 建出内存桶与台账行。
      svc.pass({
        category: CATEGORY_GATE_FAILURE,
        cwd,
        sessionId,
        signature: SIGNATURE_GATE_COMMAND,
      });
      fireDisposed(ctx, { id: sessionId, header: { cwd } });
      await flushAsync();
      assert.equal(svc.rules().find((rule) => rule.id === ruleId)?.suppressed, 1);
      const db = LessonDb.open({
        path: path.join(scratch, "data", PLUGIN_ID_FIXTURE, LESSON_DB_FILE),
      });
      assert.deepEqual(
        db?.pendingLedger(sessionId),
        [],
        "有实际 writes 的清算必须在 saveRules 事务里一起打上 settled_at",
      );
    });

    it("report 早于 watch 建立时，台账里的违规仍抑制该项目的 exposure", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      const cwd = GATE_PROJECT_CWD;
      const ruleId = await armedRule(ctx);
      const sessionId = "s-report-first";
      await svc.report({
        source: SOURCE_QUALITY_GATE,
        category: CATEGORY_GATE_FAILURE,
        cwd,
        sessionId,
        signature: SIGNATURE_GATE_COMMAND,
        detail: "violation before watch",
      });
      // 先报违规、后建立 watch：内存桶里没有这条 violated，只有库台账有。
      await fireCreated(ctx, { session: { id: sessionId, header: { cwd } } });
      fireDisposed(ctx, { id: sessionId });
      await flushAsync();
      const card = svc.rules().find((rule) => rule.id === ruleId);
      assert.equal(card?.samples, 0, "违规规则既不记 samples，也不能被内存空桶洗成 exposure");
    });

    it("进程重启后启动扫描会主动补算 pending 台账", async () => {
      const first = makeCtx();
      apply(first);
      const svc1 = loopService(first);
      const cwd = GATE_PROJECT_CWD;
      await armedRule(first);
      await fireCreated(first, { session: { id: "s-crash", header: { cwd } } });
      svc1.pass({
        category: CATEGORY_GATE_FAILURE,
        cwd,
        sessionId: "s-crash",
        signature: SIGNATURE_GATE_COMMAND,
      });
      // 模拟崩溃：不触发 session/disposed、不卸载插件；新进程用同一个 DSH_HOME 重新装载。
      const second = makeCtx();
      apply(second);
      const svc2 = loopService(second);
      await flushAsync();
      await flushAsync();
      assert.equal(
        svc2.rules().find((rule) => rule.category === CATEGORY_GATE_FAILURE)?.suppressed,
        1,
        "重启后的启动扫描必须把 pending pass 补成 suppressed",
      );
      const db = LessonDb.open({
        path: path.join(scratch, "data", PLUGIN_ID_FIXTURE, LESSON_DB_FILE),
      });
      assert.deepEqual(db?.pendingLedger("s-crash"), [], "补算成功后 pending 必须清空");
    });

    it("启动补算扫描失败 → 记日志、不阻断装载", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {
        // 断言在下方
      });
      vi.spyOn(LessonDb.prototype, "pendingLedgerAll").mockImplementation(() => {
        throw new Error("扫描炸了");
      });
      const ctx = makeCtx();
      apply(ctx);
      await flushAsync();
      await flushAsync();
      assert.match(String(error.mock.calls[0]?.[0]), /ledger recovery scan failed: 扫描炸了/u);
      // 扫描失败只影响补算这一腿：插件其余面照常装配。
      assert.equal(typeof loopService(ctx).report, "function");
    });

    it("库打不开时退出清算只走内存条目，不因缺库报错", async () => {
      vi.spyOn(LessonDb, "open").mockReturnValue(null);
      const ended = vi.spyOn(LessonStore.prototype, "sessionEnded").mockResolvedValue(true);
      const ctx = makeCtx();
      apply(ctx);
      const cwd = GATE_PROJECT_CWD;
      fireDisposed(ctx, { id: "s-no-db", header: { cwd } });
      await flushAsync();
      assert.equal(ended.mock.calls.length, 1, "缺库时仍要清算内存条目");
      assert.equal(ended.mock.calls[0]?.[0], deriveProject(cwd), "无台账可读时按 header 项目兜底");
    });

    it("台账读失败 → 内存桶照常清算，并尽力补打 settled_at", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {
        // 断言在下方
      });
      const pending = vi.spyOn(LessonDb.prototype, "pendingLedger").mockImplementation(() => {
        throw new Error("台账读炸了");
      });
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      const cwd = GATE_PROJECT_CWD;
      const sessionId = "s-ledger-read-fail";
      const ruleId = await armedRule(ctx);
      svc.pass({
        category: CATEGORY_GATE_FAILURE,
        cwd,
        sessionId,
        signature: SIGNATURE_GATE_COMMAND,
      });
      fireDisposed(ctx, { id: sessionId, header: { cwd } });
      await flushAsync();
      assert.equal(
        svc.rules().find((rule) => rule.id === ruleId)?.suppressed,
        1,
        "台账读坏不能连累内存桶这一份清算",
      );
      assert.match(String(error.mock.calls[0]?.[0]), /ledger read failed: 台账读炸了/u);
      pending.mockRestore();
      const db = LessonDb.open({
        path: path.join(scratch, "data", PLUGIN_ID_FIXTURE, LESSON_DB_FILE),
      });
      assert.deepEqual(
        db?.pendingLedger(sessionId),
        [],
        "读面失败时仍要在写成功后尽力补打 settled_at，避免下一轮补算重复计 suppressed",
      );
    });

    it("没有台账行时内存桶的 pass 仍能结清，不把写失败误判成已消费", async () => {
      const note = vi.spyOn(LessonDb.prototype, "noteLedger").mockImplementation(() => {
        // 模拟排队写失败：库里没有这一场的行，但内存桶已经记下 pass。
      });
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      const cwd = GATE_PROJECT_CWD;
      const sessionId = "s-no-ledger-row";
      const ruleId = await armedRule(ctx);
      svc.pass({
        category: CATEGORY_GATE_FAILURE,
        cwd,
        sessionId,
        signature: SIGNATURE_GATE_COMMAND,
      });
      fireDisposed(ctx, { id: sessionId, header: { cwd } });
      await flushAsync();
      assert.equal(
        svc.rules().find((rule) => rule.id === ruleId)?.suppressed,
        1,
        "行不存在时这一笔来自内存桶，必须允许新建空行结清",
      );
      note.mockRestore();
    });

    it("台账行已落定且队列空 → 内存桶不再重写，按已消费即成功收口", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      const cwd = GATE_PROJECT_CWD;
      const sessionId = "s-ledger-already-settled";
      const ruleId = await armedRule(ctx);
      svc.pass({
        category: CATEGORY_GATE_FAILURE,
        cwd,
        sessionId,
        signature: SIGNATURE_GATE_COMMAND,
      });
      // 另一条连接把这笔 pass 取走：行留着，队列空且 settled_at 已打；内存桶仍在本进程。
      const db = LessonDb.open({
        path: path.join(scratch, "data", PLUGIN_ID_FIXTURE, LESSON_DB_FILE),
      });
      db?.settleLedgerNow(sessionId, deriveProject(cwd), { violated: [], passed: [ruleId] }, true);
      db?.close();
      fireDisposed(ctx, { id: sessionId, header: { cwd } });
      await flushAsync();
      assert.equal(
        svc.rules().find((rule) => rule.id === ruleId)?.suppressed,
        0,
        "已落定行不能再把内存桶里的旧 id 计一遍",
      );
    });

    it("有台账行时把 markLedgerSettledNow 交给 sessionEnded 的 onPersisted（同事务落定）", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      const cwd = GATE_PROJECT_CWD;
      const sessionId = "s-on-persisted";
      await armedRule(ctx);
      await fireCreated(ctx, { session: { id: sessionId, header: { cwd } } });
      svc.pass({
        category: CATEGORY_GATE_FAILURE,
        cwd,
        sessionId,
        signature: SIGNATURE_GATE_COMMAND,
      });
      let callback: (() => void) | undefined;
      vi.spyOn(LessonStore.prototype, "sessionEnded").mockImplementation(async (...args) => {
        const { 5: onPersisted } = args as unknown as { 5?: () => void };
        callback = onPersisted;
        onPersisted?.();
        return true;
      });
      fireDisposed(ctx, { id: sessionId, header: { cwd } });
      await flushAsync();
      assert.equal(typeof callback, "function", "有台账行时必须挂同事务落定钩子");
      const db = LessonDb.open({
        path: path.join(scratch, "data", PLUGIN_ID_FIXTURE, LESSON_DB_FILE),
      });
      assert.deepEqual(db?.pendingLedger(sessionId), [], "钩子执行后台账行必须落定");
    });

    it("没有计数要写时事后补打台账：被别处取走不算失败（计数已由它落地）", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      const cwd = GATE_PROJECT_CWD;
      const sessionId = "s-drain-consumed";
      await armedRule(ctx);
      svc.pass({
        category: CATEGORY_GATE_FAILURE,
        cwd,
        sessionId,
        signature: SIGNATURE_GATE_COMMAND,
      });
      // save 提前返回（没有要写的规则计数）时不回调钩子，落定落到 drainLedger 那一腿。
      vi.spyOn(LessonStore.prototype, "sessionEnded").mockResolvedValue(true);
      vi.spyOn(LessonDb.prototype, "settleLedgerNow").mockImplementation(() => {
        throw new LedgerConsumedElsewhereError(sessionId, deriveProject(cwd));
      });
      const error = vi.spyOn(console, "error").mockImplementation(() => {
        // 断言在下方
      });
      fireDisposed(ctx, { id: sessionId, header: { cwd } });
      await flushAsync();
      assert.equal(
        error.mock.calls.some((call) => String(call[0]).includes("ledger settle failed")),
        false,
        "被别处取走时计数已经落地，这一轮不许记成失败",
      );
    });

    it("事后补打台账真出错 → 记 settle failed、不把卸载带炸", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      const cwd = GATE_PROJECT_CWD;
      const sessionId = "s-drain-throw";
      await armedRule(ctx);
      svc.pass({
        category: CATEGORY_GATE_FAILURE,
        cwd,
        sessionId,
        signature: SIGNATURE_GATE_COMMAND,
      });
      vi.spyOn(LessonStore.prototype, "sessionEnded").mockResolvedValue(true);
      vi.spyOn(LessonDb.prototype, "settleLedgerNow").mockImplementation(() => {
        throw new Error("台账补打炸了");
      });
      const error = vi.spyOn(console, "error").mockImplementation(() => {
        // 断言在下方
      });
      fireDisposed(ctx, { id: sessionId, header: { cwd } });
      await flushAsync();
      assert.ok(
        error.mock.calls.some((call) =>
          /ledger settle failed: 台账补打炸了/u.test(String(call[0])),
        ),
        "真出错要点名，否则这一笔永远留在 pending 里没人知道",
      );
    });

    it("启动补算单会话抛错 → 记 incomplete、不阻断其余补算", async () => {
      const first = makeCtx();
      apply(first);
      const cwd = GATE_PROJECT_CWD;
      await armedRule(first);
      const sessionId = "s-recover-throw";
      await fireCreated(first, { session: { id: sessionId, header: { cwd } } });
      loopService(first).pass({
        category: CATEGORY_GATE_FAILURE,
        cwd,
        sessionId,
        signature: SIGNATURE_GATE_COMMAND,
      });
      const error = vi.spyOn(console, "error").mockImplementation(() => {
        // 断言在下方
      });
      vi.spyOn(LessonStore.prototype, "sessionEnded").mockImplementation(async () => {
        throw new Error("补算炸了");
      });
      const second = makeCtx();
      apply(second);
      await flushAsync();
      await flushAsync();
      assert.ok(
        error.mock.calls.some((call) =>
          /ledger recovery incomplete for s-recover-throw: 补算炸了/u.test(String(call[0])),
        ),
        "单会话抛错要留下点名日志，而不是中断整轮扫描",
      );
      assert.equal(typeof loopService(second).report, "function", "补算失败不阻断插件装载");
    });

    it("卸载时闭环已关闭 → 不做退出清算（与事件版同一条规则）", async () => {
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
      await fireCreated(ctx, { session: { id: "s9", header: { cwd } } });
      ctx.value["enabled"] = false;
      // 异步 disposer 由卸载 await（cordis fiber.d.ts:38-41「they may be async, in which
      // case unloading awaits them」）→ 这里 await 全部释放器，观测点从"给一次宏任务"
      // 升级成"退出清算真的写完了"。
      await Promise.all(ctx.effects.map((dispose) => dispose()));
      assert.equal(cardsOnDisk()[0]?.samples, 0, "插件关闭期间不写度量");
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
      await fireCreated(ctx, { session: { id: "s9", header: { cwd } } });
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
      await fireCreated(ctx, agent);
      assert.equal(injected.length, 1);
      const msg = injected[0] as {
        source?: Record<string, unknown>;
        content?: { text?: string }[];
      };
      assert.equal(msg.source?.["kind"], LESSON_SOURCE_KIND_FIXTURE);
      assert.match(msg.content![0]!.text!, /经验规则/u);
    });

    it("注入 source 必须是 producer-owned kind（不得回退到 'plugin'）", async () => {
      // 0.2.1-alpha.2 的 V4 准入（session-format-v3-to-v4/src/message-sources.ts）对每个
      // 声明的持久消息位拒收退役包装 `{ kind: 'plugin', plugin }`，抛
      // "format v4 message requires a producer-owned source kind"：agent.inject 的
      // 消息经 inbox 落 `agent/inbox/spliced`（agent-loop/src/inbox.ts 的 inserted
      // 数组，sources.ts 遍历的持久位之一），一条这样的注入就会把整个会话的写到磁盘
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
      await fireCreated(ctx, agent);
      assert.equal(injected.length, 1);
      const { source } = injected[0] as { source: Record<string, unknown> };
      assert.notEqual(source["kind"], "plugin");
      assert.equal(typeof source["kind"], "string");
      assert.equal(
        source["kind"],
        LESSON_SOURCE_KIND_FIXTURE,
        "kind 须是本插件的 producer-owned 串",
      );
      assert.equal(source["plugin"], undefined, "退役包装的 plugin 字段不得再出现");
      assert.equal(source["form"], "instructions", "自有 form 字段必须保留");
    });

    it("注入条数上限：只注入最新 N 条、帧尾说明还剩多少，日志报 injected X of Y", async () => {
      // armed 只能人工升格、"零干净命中"的卡又永不自动降级或归档 ⇒ 条数没有自动收敛
      // 路径。这条上限是唯一兜住"注入单调增长"的地方，故它自己也要有人钉。
      const ctx = makeCtx({ value: { maxInjectedRules: 2 } });
      const info = vi.spyOn(console, "info").mockImplementation(() => {
        // 断言在下方
      });
      apply(ctx);
      const svc = loopService(ctx);
      // 三个**不同类别**各自成卡：同类别会被折叠到类别级稳定签名，三张会变一张。
      // 三次上报必须**串行**（后一次要看见前一次写到磁盘的规则库）。逐段 await 写在
      // 循环里会被 no-await-in-loop 拦，所以把「上报 + 升格」收成一个 helper，循环体只调用它。
      await armingReport(svc, CATEGORY_GATE_FAILURE, "gate-1");
      await armingReport(svc, CATEGORY_TRANSIENT_FAILURE, "transient-1");
      await armingReport(svc, "max-tokens", "max-1");
      const injected: unknown[] = [];
      await fireCreated(ctx, {
        inject: (message: unknown) => {
          injected.push(message);
        },
        session: { id: "s1", header: { cwd: GATE_PROJECT_CWD } },
      });
      assert.equal(injected.length, 1, "仍然只注入一条消息");
      const first = injected[0] as { content: { text: string }[] } | undefined;
      assert.ok(first);
      const [block] = first.content;
      assert.ok(block);
      const { text } = block;
      assert.equal(text.split("\n").length, 4, "抬头 + 2 条规则 + 1 行省略说明");
      assert.match(text, /共 3 条生效规则，此处只列最近 2 条/u);
      assert.match(
        String(info.mock.calls[0]?.[0]),
        /injected 2 of 3 armed rule\(s\)/u,
        "日志的计数不得按帧行数推（帧尾那行说明不是规则）",
      );
      info.mockRestore();
    });

    it("上限充裕时不截断：日志报 injected N of N，帧里没有省略说明", async () => {
      // 上一格钉的是「超上限时只列最近 N 条」，但那条走的永远是 Math.min 的**被压小**那一支。
      // 上限比 armed 数大时取的是 armedCount 本身——两个分支各要一次真实回执，
      // 否则「上限逻辑写反成恒取上限」这种错只会在生产里表现成一条虚报的计数。
      const ctx = makeCtx({ value: { maxInjectedRules: 10 } });
      const info = vi.spyOn(console, "info").mockImplementation(() => {
        // 断言在下方
      });
      apply(ctx);
      const svc = loopService(ctx);
      const receipt = await svc.report({
        source: SOURCE_QUALITY_GATE,
        category: CATEGORY_FACTGATE_DENY,
        cwd: GATE_PROJECT_CWD,
        signature: "/single.ts",
        detail: "d",
      });
      assert.equal(await svc.ruleAction(receipt.candidate!.id, "arm"), "persisted");
      const injected: unknown[] = [];
      await fireCreated(ctx, {
        inject: (message: unknown) => {
          injected.push(message);
        },
        session: { id: "s1", header: { cwd: GATE_PROJECT_CWD } },
      });
      const first = injected[0] as { content: { text: string }[] } | undefined;
      assert.ok(first);
      const [block] = first.content;
      assert.ok(block);
      assert.doesNotMatch(block.text, /此处只列最近/u, "没超上限就不该有那句省略说明");
      assert.match(
        String(info.mock.calls[0]?.[0]),
        /injected 1 of 1 armed rule\(s\)/u,
        "上限充裕时 shown 取 armedCount 本身",
      );
      info.mockRestore();
    });

    it("maxInjectedRules = 0 即不设上限：shows armedCount，帧尾无省略说明", async () => {
      // 0 是**有语义的**（与 maxLessonsBytes 同义：不设上限），不是"没配"。这条钉住
      // 那个三分支的假支：0 时 shown 必须等于 armedCount，而不是被 min 成 0。
      const ctx = makeCtx({ value: { maxInjectedRules: 0 } });
      const info = vi.spyOn(console, "info").mockImplementation(() => {
        // 断言在下方
      });
      apply(ctx);
      const svc = loopService(ctx);
      await armingReport(svc, CATEGORY_GATE_FAILURE, "zero-1");
      await armingReport(svc, CATEGORY_TRANSIENT_FAILURE, "zero-2");
      const injected: unknown[] = [];
      await fireCreated(ctx, {
        inject: (message: unknown) => {
          injected.push(message);
        },
        session: { id: "s1", header: { cwd: GATE_PROJECT_CWD } },
      });
      const first = injected[0] as { content: { text: string }[] } | undefined;
      assert.ok(first);
      const [block] = first.content;
      assert.ok(block);
      assert.doesNotMatch(block.text, /此处只列最近/u, "不设上限就没有省略说明");
      assert.match(
        String(info.mock.calls[0]?.[0]),
        /injected 2 of 2 armed rule\(s\)/u,
        "0 = 不设上限：shown 取 armedCount",
      );
      info.mockRestore();
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
      await fireCreated(ctx, mkAgent());
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
      await fireCreated(ctx2, mkAgent({ cwd: GATE_PROJECT_CWD, delegationDepth: 1 }));
      // 子代理
      assert.equal(injected.length, 0);
      const ctx3 = makeCtx({ value: { injectEnabled: false } });
      apply(ctx3);
      await fireCreated(ctx3, mkAgent());
      // 开关关
      assert.equal(injected.length, 0);
    });
  });

  describe("cacheFile 路径解析（官方 dsh-home-paths 通道）", () => {
    it("DSH_HOME 已设 → $DSH_HOME/cache/lesson-loop/<name>", () => {
      const previousDshHome = process.env["DSH_HOME"];
      process.env["DSH_HOME"] = "/tmp/custom-dsh";
      try {
        assert.equal(
          cacheFile(EVENTS_FILE_NAME),
          path.join(path.resolve("/tmp/custom-dsh"), "cache", PLUGIN_ID_FIXTURE, EVENTS_FILE_NAME),
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
      const previousUserProfile = process.env["USERPROFILE"];
      delete process.env["DSH_HOME"];
      process.env["HOME"] = TEST_HOME_DIR;
      process.env["USERPROFILE"] = TEST_HOME_DIR;
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
        if (previousUserProfile === undefined) {
          delete process.env["USERPROFILE"];
        } else {
          process.env["USERPROFILE"] = previousUserProfile;
        }
      }
    });

    /** 官方包（@deepseek-ai/dsh-home-paths）规则：空白 $DSH_HOME 视同未设。旧实现自带
     *  "DSH_HOME/HOME 都取不到就抛"的三态回退，那条分支随自实现路径解析一起删掉——
     *  解析归官方包，插件不再自己造失败规则。 */
    it("DSH_HOME 只有空白 → 按未设回退，绝不落进空白目录", () => {
      const previousDshHome = process.env["DSH_HOME"];
      const previousHome = process.env["HOME"];
      const previousUserProfile = process.env["USERPROFILE"];
      process.env["DSH_HOME"] = "   ";
      process.env["HOME"] = TEST_HOME_DIR;
      process.env["USERPROFILE"] = TEST_HOME_DIR;
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
        if (previousUserProfile === undefined) {
          delete process.env["USERPROFILE"];
        } else {
          process.env["USERPROFILE"] = previousUserProfile;
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

    it("事件读取只算 events（projectionMode none）并归还观察租约", async () => {
      const ctx = makeCtx({
        services: {
          llm: fakeLlm("[]"),
          agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) },
        },
      });
      apply(ctx);
      const result = await ctx.command?.handler(digestInvocation());
      assert.equal(result?.kind, "success");
      assert.deepEqual(ctx.observeCalls, [
        { sessionId: "s1", options: { projectionMode: "none" } },
      ]);
      assert.equal(ctx.disposeCalls, 1, "观察租约必须释放");
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
    // `agent.session.snapshotEvents()`，官方把那条同步读取接口标了 @deprecated）。
    // 下面几条钉的是迁移后必须仍然成立的降级规则：**任一条读不到都只少背景，不炸命令**。
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
      // 2. 递来的会话**没有 id**：按 sessionId 查询这一步无法发起（旧同步读取接口不需要 id，
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

    it("observation.events 不是数组（契约外交付）→ 退空背景且类型上不被收窄成 any", async () => {
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
    it("apply 立即跑一轮；timer 缺失不炸", async () => {
      const ctx = makeCtx();
      apply(ctx);
      // 装载期那一轮先跑衰减，**结算之后**才武装下一轮：apply 返回时还没有定时器。
      await flushAsync();
      assert.equal(ctx.timerCallbacks.length, 1, "一轮结算后武装下一轮（24h）");
      const ctxNoTimer = makeCtx();
      delete ctxNoTimer.services["timer"];
      // 不抛
      apply(ctxNoTimer);
    });

    it("上一轮结算后才排下一轮（不在起点就重排，避免两轮重叠）", async () => {
      vi.useFakeTimers();
      try {
        const ctx = makeCtx();
        apply(ctx);
        // 衰减尚未结算：还没有定时器。这正是"不重叠"的判据——旧实现 apply 时就排了。
        assert.equal(ctx.timerCallbacks.length, 0, "结算前不该有下一轮的定时器");
        await flushAsync();
        assert.equal(ctx.timerCallbacks.length, 1);
        // 触发这一轮 → 又进入"先衰减再排"的次序，仍然没有新的定时器
        ctx.timerCallbacks[0]?.();
        assert.equal(ctx.timerCallbacks.length, 1, "触发后到结算前仍是同一个数");
        await flushAsync();
        assert.equal(ctx.timerCallbacks.length, 2, "结算后才再武装一轮");
      } finally {
        vi.useRealTimers();
      }
    });

    it("effect 卸载 → 停止周期衰减（在途那一轮结束后不再武装）", async () => {
      const ctx = makeCtx();
      apply(ctx);
      await flushAsync();
      const decayDisposer = ctx.effects.at(-1);
      if (decayDisposer === undefined) {
        throw new Error("decay disposer 缺失");
      }
      decayDisposer();
      // 已注册的 tick 再触发 → 结算后 schedule 见 stopped 早退，不再武装
      const armedBefore = ctx.timerCallbacks.length;
      ctx.timerCallbacks[0]?.();
      await flushAsync();
      assert.equal(ctx.timerCallbacks.length, armedBefore, "卸载后不再武装下一轮");
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
    it("webServer/commands/systemPrompt/timer 全缺 → 装载照跑；缺席静默（inject 语义下不误报）", () => {
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
      // 缺席不再 warn：三个服务都改走 inject（服务就绪才回调），"还没来"与"永远不来"
      // 在 apply 时刻不可区分——为可能晚到的服务打缺席告警是误报；晚到时注册照常发生。
      assert.equal(warn.mock.calls.length, 0);
      // 二次装载同样静默：缺席语义不随实例数变化
      const second = makeCtx();
      Reflect.deleteProperty(second.services, "commands");
      apply(second);
      assert.equal(second.command, null);
      assert.equal(warn.mock.calls.length, 0);
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

  it("崩溃补算：清算写失败时台账行仍留未落定（下一轮开机还能补）", async () => {
    const dbFile = path.join(scratch, "data", PLUGIN_ID_FIXTURE, LESSON_DB_FILE);
    const before = LessonDb.open({ path: dbFile });
    assert.notEqual(before, null, "库须能打开");
    before!.noteLedger("s-rem", "p-rem", "violated", "r1");

    const ctx = makeCtx();
    apply(ctx);
    // 建一个内存桶：卸载时 flushSessions 先逐桶清算、再补算台账残留。
    await fireCreated(ctx, { session: { id: "s-rem", header: { cwd: GATE_PROJECT_CWD } } });
    // 毁掉规则表（旁路连接）⇒ 任何 commit 的 save 都被拒（settledOk(false)）：补算这一腿
    // 不许打落定标记——打了就等于把这笔会话从待补清单里删掉。
    const side = new DatabaseSync(dbFile);
    side.exec("DROP TABLE rules");
    side.close();
    for (const dispose of ctx.effects) {
      dispose();
    }
    await flushAsync();

    const after = LessonDb.open({ path: dbFile });
    assert.notEqual(after, null, "库须仍可打开");
    assert.deepEqual(
      after!.pendingLedger("s-rem").map((row) => row.project),
      ["p-rem"],
      "写没成功 ⇒ settled_at 不许打上，否则这一笔会话永远补不回来",
    );
  });

  describe("ctx 契约与行 config 底座", () => {
    it("ctx 不满足 HostCtx 结构 → 急停抛错（不用断言糊过去）", () => {
      // 核验的是 0.2.1-alpha.2 的实际调用形态：effect/on 接线、inject+fiber 挂页面策略、
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
      Reflect.deleteProperty(noFiber, "fiber");
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
      // 0.2.1-alpha.2 把合并与填默认都收进了 cordis 装载期（fiber._resolveConfig → resolveConfig），
      // 插件侧不再有 base 层，于是这里改盯**仍然由本包负责**的两件事：读的是引用（不是
      // apply 期快照），且引用背后的值就是按 schema 解析出来的那一份。
      const ctx = makeCtx({ value: { promoteThreshold: 7 } });
      apply(ctx);
      const stats = loopService(ctx).stats()["config"] as Record<string, unknown>;
      assert.equal(
        stats["promoteThreshold"],
        7,
        "行 config 的覆盖项必须经 schema 解析后才落到生效配置",
      );
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
      // 规则库字段已从 schema 摘除。cordis 的 `~standard.validate` 对未声明键是透传的，
      // 所以老 profile 里那段 `rules:` 仍会进到 apply 的 config（迁移靠它），但校验不认它：
      // 坏值也不会打死整条目（条目 Config 校验抛错 = 整条插件不加载）。
      assert.equal(
        configIssues({ [RULES_FIELD]: "用户手改坏的存量段" }),
        undefined,
        "未声明字段不得参与校验，更不许因此判整条目失败",
      );
      const passed = plugin.Config["~standard"].validate({
        [RULES_FIELD]: "用户手改坏的存量段",
      }) as { value?: Record<string, unknown> };
      assert.equal(
        passed.value?.[RULES_FIELD],
        "用户手改坏的存量段",
        "原文透传，读不读得懂由迁移端口自己判",
      );
    });
  });

  // ── 0.2.1-alpha.2 隐式注册验收：命名空间与可编辑字段都是"从 Config 反推"出来的 ──────
  //
  // 为什么单独要这一组：0.2.1-alpha.2 没有 `settings.register` 了，可编辑字段全靠 schema 上的
  // `.volatile()` 标记。漏标一个不会报错，只会让那一项从设置卡上**静默消失**（宿主
  // 的 describe() 只投影 volatileForm 的结果）；全漏则整条被跳过
  // （packages/settings/settings/src/index.ts:308-309），写入抛 `has no volatile fields`
  // （:386）。这类退化在功能测试里全绿——只有拿宿主同一个判据回头看 schema 才拦得住。
  //
  // ⚠ 它拦不住的：条目 id 与已装配 profile 里那一行的对应关系（宿主读的是装配后的
  // `entry.options.id`，本包 cordis.patch.yml 只是它的来源），以及"cordis 真把 Config 挂上
  // fiber.runtime"这一步（test/integration/bus-boot.test.ts 用真实 Loader 覆盖前者的一半）。

  describe("0.2.1-alpha.2 隐式注册验收（volatileForm(Config) 的字段集 = 设置面可编辑集）", () => {
    it("命名空间 = cordis.patch.yml 的条目 id，且就是规则库读写的那一段", () => {
      assert.equal(patchEntryId(), PLUGIN_ID_FIXTURE);
      assert.equal(SETTINGS_NAMESPACE, patchEntryId(), "代码里的段名与 profile 条目 id 同源");
    });

    it("假件的 settings 面就是 0.2.1-alpha.2 的残缺：三项在、被移除的三项绝不在", () => {
      // 0.1.6 的假件里有 register（两段各注册一次）与 get（读 locale）。迁移时若只把调用
      // 点改掉、假件却留着这两扇门，host.ts 那些"没有注册可被打回""describe 是唯一读口"的
      // 分支就会在误判通过里静默失真——真宿主 0.2.1-alpha.2 上它们不存在，插件会当场 TypeError。
      // 故这里直接钉假件自己的形状：本包用到的就是 describe/update/configure 三件。
      const ctx = makeCtx();
      const surface = ctx.settings as unknown as Record<string, unknown>;
      assert.deepEqual(
        Object.keys(surface).toSorted(),
        ["configure", "describe", "update"],
        "假件面与本包实际用到的 0.2.1-alpha.2 残面一一对应（多一项即有人偷偷补回旧 API）",
      );
      for (const removed of ["register", "get", "installSection"]) {
        assert.equal(
          surface[removed],
          undefined,
          `settings.${removed}() 已被 0.2.1-alpha.2 移除，假件不许提供`,
        );
      }
    });

    it("规则库不再写设置段：旧 rules 原文只作迁移源，搬进 SQLite 后原样留在文档里", async () => {
      // 用户拍板：`config.rules` 立即从 schema 摘除。插件不再从设置段读写规则，唯一用途
      // 是首次迁移把老 profile 里的原文搬进库；**不回写**（未知字段会被宿主 update 拒掉，
      // 留着也是库丢失后的最后一份存量）。
      const ctx = makeCtx({
        rules: [{ ...undeterminableRow(), id: "legacy", signature: "legacy-sig" }],
      });
      apply(ctx);
      await armedRule(ctx);
      const section = ctx.rulesProvider.peek(SETTINGS_NAMESPACE);
      assert.equal(
        (section?.[RULES_FIELD] as readonly unknown[] | undefined)?.length,
        1,
        "迁移不回写：旧数组原样留在文档里",
      );
      assert.equal(rulesOf(ctx).length, 2, "存量一张 + 新卡一张，规则库在 SQLite 里");
      assert.equal(ctx.rulesProvider.resolvedOf(SETTINGS_NAMESPACE)["enabled"], true);
      assert.equal(
        ctx.rulesProvider.writesOf(SETTINGS_NAMESPACE),
        0,
        "规则库的写路径已不在设置段：一次都不该写",
      );
      assert.equal(
        ctx.rulesProvider.peek("lesson-loop-rules"),
        undefined,
        "退役的第二段不得再被创建（0.2.1-alpha.2 一条目一段）",
      );
    });

    it("volatileForm(Config) 的字段集恰为十三项（十二开关/阈值 + rules）", () => {
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
        // 规则正文写入上限：4000 字符（armed 正文整段注入提示词）。
        maxStatementChars: 4000,
        // 证据时间线页大小：默认 20（设置卡可改，5-100）。
        evidencePageSize: 20,
        // 两枚部署值：默认与旧常量同值（120s 蒸馏墙钟 / 24h 衰减周期），行为冻结。
        // 手写字面值而不引常量——引常量就成了自证，常量改了该先红。
        digestTimeoutMs: 120_000,
        decayIntervalMs: 24 * 60 * 60_000,
        // 注入条数上限的部署默认：宽松但有限，兜的是"零干净命中的卡永不自动收敛"。
        maxInjectedRules: 50,
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
      // 真实宿主上 webServer 比本条目晚到位（隔离 DSH_HOME 实测 apply 当场 undefined、稍后
      // 才交得出实例），只在 apply 里读一次的结果是四条路由永不注册。
      assert.deepEqual(
        ctx.injectDeps,
        [["settings"], ["systemPrompt"], ["commands"], ["timer"]],
        "四份子依赖：settings 页面策略 + 三个可选服务（晚到即由 inject 补注册）",
      );
      assert.equal(ctx.configureCalls.length, 1, "一次装载一次策略登记（重复登记宿主会抛）");
      const [call] = ctx.configureCalls;
      assert.equal(call?.presentation.auto, false);
      assert.equal(call.owner, ctx.fiber, "owner 必须是本插件 fiber");
    });
  });

  describe("/lessons-digest 的开关与失败", () => {
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

    it("会话没有 header.cwd、也没有目录变更事件 → 归因留空，蒸馏照常跑完", async () => {
      // 归因从"会话当前工作目录"来（foldCwd）；连 header 都没有时要能不炸地跑完，
      // runDigest 退到不带 cwd 的老口径（没有 cwd 的项目键由 deriveProject 兜）。
      const ctx = makeCtx({
        services: {
          llm: fakeLlm("[]"),
          agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) },
        },
      });
      apply(ctx);
      const result = await ctx.command?.handler({
        agent: { session: { id: "s1", header: {} } },
        rawInput: "",
      });
      assert.equal(result?.kind, "success");
      assert.equal(ctx.observeCalls.length, 1, "没有目录也要读一次事件流");
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

    it("候选没写进规则库 → 回执是「部分失败」而不是「已蒸馏」（库里没有那张卡）", async () => {
      const ctx = makeCtx({
        services: {
          llm: fakeLlm(
            '[{"category":"gate-failure","signature":"pnpm check","statement":"先自检"}]',
          ),
          agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) },
        },
      });
      apply(ctx);
      // 端口从这一刻起拒写：模型提出了候选、但一条都落不进库（规则库主介质是 SQLite，
      // 这里直接让补录回执报 persisted:false，等价于"库没写成"）。
      const added = vi
        .spyOn(LessonStore.prototype, "addCandidate")
        .mockImplementation(async () => ({
          card: { id: "never-persisted" } as never,
          persisted: false,
        }));
      const handler = ctx.command?.handler;
      assert.ok(handler !== undefined, "命令已注册");
      const result = await handler(digestInvocation());
      assert.equal(result.kind, "error", "没落盘不许报成功");
      assert.equal(result.text, fill(MESSAGES.zh.digestPartialFailure, { count: 0, failed: 1 }));
      assert.ok(added.mock.calls.length > 0, "确实走了补录这条路");
      assert.equal(rulesOf(ctx).length, 0, "库里确实没有这张卡");
    });
  });

  describe("会话开始注入的分支", () => {
    it("enabled=false → 不预种台账也不注入", async () => {
      const ctx = makeCtx({ value: { enabled: false } });
      apply(ctx);
      const injected: unknown[] = [];
      await fireCreated(ctx, {
        inject: (message: unknown) => {
          injected.push(message);
        },
        session: { id: "s1", header: { cwd: GATE_PROJECT_CWD } },
      });
      assert.deepEqual(injected, []);
      const ended = vi.spyOn(LessonStore.prototype, "sessionEnded");
      fireDisposed(ctx, { id: "s1" });
      // 开关关闭期间既不清算也不记录下来
      assert.equal(ended.mock.calls.length, 0);
    });

    it("agent 缺失 / 无 session → 不碰台账、不注入", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const injected: unknown[] = [];
      await fireCreated(ctx, {
        inject: (message: unknown) => {
          injected.push(message);
        },
      });
      await fireCreated(ctx, undefined);
      assert.deepEqual(injected, []);
      const ended = vi.spyOn(LessonStore.prototype, "sessionEnded");
      fireDisposed(ctx, {});
      fireDisposed(ctx, { id: 7 });
      // id 不是字符串 → 连兜底清算都不做（无法归因到会话）
      assert.equal(ended.mock.calls.length, 0);
    });

    it("同一会话二次 created → 台账按最新 cwd 归因", async () => {
      const ctx = makeCtx();
      apply(ctx);
      await fireCreated(ctx, { session: { id: "s1", header: { cwd: "/repo/aaa" } } });
      await fireCreated(ctx, { session: { id: "s1", header: { cwd: "/repo/bbb" } } });
      const ended = vi.spyOn(LessonStore.prototype, "sessionEnded");
      fireDisposed(ctx, { id: "s1" });
      await flushAsync();
      // 归因是"会话当前目录"，而台账按项目分桶：这场会话在两个目录里各在场过一次，
      // 收尾就各清算一次（先入桶先清）。第二次 created 的 header 只改"最近所在桶"，
      // 不抹掉先前的桶——那正是改造前会丢 exposure 的地方。
      assert.equal(ended.mock.calls.length, 2);
      assert.deepEqual(
        ended.mock.calls.map((call) => call[0]),
        [deriveProject("/repo/aaa"), deriveProject("/repo/bbb")],
      );
    });

    it("agent.inject 抛错 → 只记日志，注入链不炸总线", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {
        // 断言在下方
      });
      const ctx = makeCtx();
      apply(ctx);
      await armedRule(ctx);
      await fireCreated(ctx, {
        inject: () => {
          throw new Error("注入炸了");
        },
        session: { id: "s9", header: { cwd: GATE_PROJECT_CWD } },
      });
      // 注入这一步已从"会话开始那一枪"扩成幂等对账（三个触发点共用），日志前缀随之改名。
      assert.match(String(error.mock.calls[0]?.[0]), /rule injection failed: 注入炸了/u);
    });
  });

  describe("注入对账（幂等 / 压缩补回 / 换目录重做）", () => {
    it("同内容仍在面上 → 跳过、不重复注入（resume 场景）", async () => {
      const ctx = makeCtx();
      apply(ctx);
      await armedRule(ctx);
      const digest = await injectedDigest(ctx);
      // resume：日志里那条本包注入还在，且它的 seq 仍在 surface.nodes 里。
      ctx.sessionEvents = [ownMessageEvent(3, digest)];
      const injected: unknown[] = [];
      await fireCreated(ctx, {
        inject: (message: unknown) => injected.push(message),
        session: { id: "s1", header: { cwd: GATE_PROJECT_CWD }, surface: { nodes: [0, 3] } },
      });
      assert.equal(injected.length, 0, "同内容不再重复注入");
    });

    it("旧块仍在面上但内容不同 → 前置「替换先前那份」的说明", async () => {
      const ctx = makeCtx();
      apply(ctx);
      await armedRule(ctx);
      ctx.sessionEvents = [ownMessageEvent(2, "上一份 lesson-loop 摘要（别处注入的）")];
      const injected: unknown[] = [];
      await fireCreated(ctx, {
        inject: (message: unknown) => injected.push(message),
        session: { id: "s1", header: { cwd: GATE_PROJECT_CWD }, surface: { nodes: [2] } },
      });
      assert.equal(injected.length, 1);
      const text = injectedText(injected[0]);
      assert.ok(
        text.startsWith(MESSAGES.zh.digestReplacesEarlier),
        "说明必须放在新正文之前，否则模型读不出这是替换",
      );
      assert.match(text, /经验规则/u);
    });

    it("旧块被压缩折进摘要（日志有、面上没有）→ 补回并说明替换", async () => {
      const ctx = makeCtx();
      apply(ctx);
      await armedRule(ctx);
      const digest = await injectedDigest(ctx);
      // 压缩把那条消息折进摘要：seq 离开 surface.nodes，但日志里不删事件。
      ctx.sessionEvents = [ownMessageEvent(7, digest)];
      const injected: unknown[] = [];
      await fireCreated(ctx, {
        inject: (message: unknown) => injected.push(message),
        session: { id: "s1", header: { cwd: GATE_PROJECT_CWD }, surface: { nodes: [0, 9] } },
      });
      assert.equal(injected.length, 1, "压缩之后必须补回一次");
      assert.ok(injectedText(injected[0]).startsWith(MESSAGES.zh.digestReplacesEarlier));
    });

    it("workspace-root/change → 归因换成新目录，按新桶重注", async () => {
      const ctx = makeCtx();
      apply(ctx);
      // 两个目录各一条 armed 规则；换成 B 之后注入的必须是 B 那份（正文里带 B 的路径）。
      await armedRule(ctx, { cwd: "/repo/a", signature: "sig-a" });
      await armedRule(ctx, { cwd: "/repo/b", signature: "sig-b" });
      const injected: unknown[] = [];
      const agent = {
        inject: (message: unknown) => injected.push(message),
        session: { id: "s1", header: { cwd: "/repo/a" } },
      };
      await fireCreated(ctx, agent);
      assert.equal(injected.length, 1);
      const first = injectedText(injected[0]);
      assert.match(first, /sig-a/u, "首次注入读的是 A 的桶");
      // 宿主先追加事件再派发（事件流是会话的唯一真相），假件按同序：先写进事件流。
      // 首次注入那条也在日志里（真实宿主里它由 inject 落进 inbox 事件流）。
      const change = {
        type: EVENT_WORKSPACE_ROOT_CHANGE,
        seq: 4,
        time: 2,
        data: { cwd: "/repo/b" },
      };
      ctx.sessionEvents = [ownMessageEvent(3, first), change];
      fireSessionEvent(ctx, { id: "s1" }, change);
      await flushAsync();
      assert.equal(injected.length, 2, "换目录后要按新桶重做一次");
      assert.match(injectedText(injected[1]), /sig-b/u, "重注的是 B 的桶");
      assert.ok(
        injectedText(injected[1]).startsWith(MESSAGES.zh.digestReplacesEarlier),
        "旧块说的是别的目录，要说明替换",
      );
    });

    it("compaction/end → 把被折进摘要的那份补回一次", async () => {
      const ctx = makeCtx();
      apply(ctx);
      await armedRule(ctx);
      const injected: unknown[] = [];
      await fireCreated(ctx, {
        inject: (message: unknown) => injected.push(message),
        session: { id: "s1", header: { cwd: GATE_PROJECT_CWD }, surface: { nodes: [] } },
      });
      const first = injectedText(injected[0]);
      // 压缩收尾事件：本包那条已折进摘要（日志有正文、seq 不在面上）。
      const end = { type: EVENT_COMPACTION_END, seq: 8, time: 3, data: { id: "c1" } };
      ctx.sessionEvents = [end, ownMessageEvent(5, first)];
      fireSessionEvent(ctx, { id: "s1" }, end);
      await flushAsync();
      assert.equal(injected.length, 2);
      assert.ok(injectedText(injected[1]).startsWith(MESSAGES.zh.digestReplacesEarlier));
    });

    it("session/event 的非触发类型、缺注册表、不在注册表 → 都不碰注入", async () => {
      // ① 别的类型：什么都不做。
      const ctx = makeCtx();
      apply(ctx);
      await armedRule(ctx);
      let calls = 0;
      const agent = {
        inject: () => {
          calls += 1;
        },
        session: { id: "s1", header: { cwd: GATE_PROJECT_CWD } },
      };
      ctx.liveAgents.set("s1", agent);
      fireSessionEvent(ctx, { id: "s1" }, { type: "assistant/message", seq: 2 });
      await flushAsync();
      assert.equal(calls, 0, "非触发类型不重注");
      // ② injectEnabled 关掉时，这段处理器整段不参与（只读标志，不读事件流）。
      const off = makeCtx({ value: { injectEnabled: false } });
      apply(off);
      const observe = vi.fn<() => Promise<unknown>>();
      off.services["sessionQuery"] = {
        ...(off.services["sessionQuery"] as object),
        observeSession: observe,
      };
      const change = { type: EVENT_WORKSPACE_ROOT_CHANGE, seq: 1, data: { cwd: "/repo/b" } };
      fireSessionEvent(off, { id: "s1" }, change);
      await flushAsync();
      assert.equal(observe.mock.calls.length, 0, "注入关掉时不读事件流");
      // ③ 会话身份缺失 / 空串：连注册表都不查（`inject` 只能落到确实的一场会话上）。
      const anonymous = makeCtx();
      apply(anonymous);
      await armedRule(anonymous);
      fireSessionEvent(anonymous, {}, change);
      fireSessionEvent(anonymous, { id: "" }, change);
      await flushAsync();
      // ④ 注册表里没有这场会话：处理器拿不到 Agent，静默返回。
      const gone = makeCtx();
      apply(gone);
      await armedRule(gone);
      fireSessionEvent(gone, { id: "nope" }, change);
      await flushAsync();
      // ⑤ 宿主没给 agents 服务：不炸、不注入。
      const bare = makeCtx();
      delete bare.services["agents"];
      apply(bare);
      await armedRule(bare);
      fireSessionEvent(bare, { id: "s1" }, change);
      await flushAsync();
    });

    it("没有 session id → 仍按 header 注入一次（没有对账读口）", async () => {
      const ctx = makeCtx();
      apply(ctx);
      await armedRule(ctx);
      const injected: unknown[] = [];
      await fireCreated(ctx, {
        inject: (message: unknown) => injected.push(message),
        session: { header: { cwd: GATE_PROJECT_CWD } },
      });
      assert.equal(injected.length, 1);
      assert.equal(ctx.observeCalls.length, 0, "没有会话身份就没有事件流可读");
    });

    it("事件流里的畸形载荷不参与对账（容错读法）", async () => {
      const ctx = makeCtx();
      apply(ctx);
      await armedRule(ctx);
      const injected: unknown[] = [];
      await fireCreated(ctx, {
        inject: (message: unknown) => injected.push(message),
        session: { id: "s1", header: { cwd: GATE_PROJECT_CWD }, surface: { nodes: [] } },
      });
      // 第二次 created 时事件流里只有畸形载荷：都认不出是本包那份，按"没有旧块"注入。
      ctx.sessionEvents = [
        // 空 cwd 的目录变更：不折叠（保住 header 的归因）。
        { type: EVENT_WORKSPACE_ROOT_CHANGE, seq: 1, time: 1, data: { cwd: "" } },
        // content 不是数组 → 认不出正文。
        {
          type: EVENT_USER_MESSAGE,
          seq: 2,
          time: 1,
          data: { source: { kind: LESSON_SOURCE_KIND_FIXTURE }, content: "不是数组" },
        },
        // 文本块类型不是 text → 拼出来是空串。
        {
          type: EVENT_USER_MESSAGE,
          seq: 3,
          time: 1,
          data: {
            source: { kind: LESSON_SOURCE_KIND_FIXTURE },
            content: [{ type: "image", text: "x" }],
          },
        },
        // 别家插件的消息 → 不是本包那份。
        {
          type: EVENT_USER_MESSAGE,
          seq: 4,
          time: 1,
          data: { source: { kind: "plugin:other" }, content: [{ type: "text", text: "他家的" }] },
        },
      ];
      await fireCreated(ctx, {
        inject: (message: unknown) => injected.push(message),
        session: { id: "s1", header: { cwd: GATE_PROJECT_CWD }, surface: { nodes: [] } },
      });
      assert.equal(injected.length, 2);
      const text = injectedText(injected[1]);
      assert.doesNotMatch(text, /替换先前/u);
      assert.match(text, /经验规则/u, "畸形载荷不该让注入整块失效");
    });

    it("header 没有 cwd、事件里也没有 → 归因留空，任何桶都不注入", async () => {
      const ctx = makeCtx();
      apply(ctx);
      await armedRule(ctx);
      const injected: unknown[] = [];
      await fireCreated(ctx, {
        inject: (message: unknown) => injected.push(message),
        session: { id: "s1", header: {} },
      });
      assert.equal(injected.length, 0, "没有目录就没有桶，已生效规则不属于任何项目");
    });

    it("同 tick 两个触发点 → 串行排队，跑完不留下悬挂的链", async () => {
      const ctx = makeCtx();
      apply(ctx);
      await armedRule(ctx);
      const injected: unknown[] = [];
      const agent = {
        inject: (message: unknown) => injected.push(message),
        session: { id: "s1", header: { cwd: GATE_PROJECT_CWD } },
      };
      ctx.liveAgents.set("s1", agent);
      const first = {
        type: EVENT_WORKSPACE_ROOT_CHANGE,
        seq: 1,
        time: 1,
        data: { cwd: GATE_PROJECT_CWD },
      };
      // 同一项目的第二次变更（换到没有 armed 规则的目录时注入本来就该是空的，
      // 那会把这条用例变成"零注入也算过"）。
      const second = {
        type: EVENT_WORKSPACE_ROOT_CHANGE,
        seq: 2,
        time: 2,
        data: { cwd: GATE_PROJECT_CWD },
      };
      ctx.sessionEvents = [first, second];
      // 两个触发点在同一 tick 各起一条链：后一条把前一条排在自己前面。
      fireSessionEvent(ctx, { id: "s1" }, first);
      fireSessionEvent(ctx, { id: "s1" }, second);
      await flushAsync();
      await flushAsync();
      // 假件的事件流在两条链之间不变，两次读到的都是"没有旧块" → 各注入一次（真实宿主里
      // 第二次读得到第一次追加的那条，于是会走"同内容跳过"或"追加替换"）。
      assert.equal(injected.length, 2);
      // 链结束时只删自己那一条：再来一个触发点仍能起链（没有被悬挂的 Promise 卡死）。
      fireSessionEvent(ctx, { id: "s1" }, second);
      await flushAsync();
      await flushAsync();
      assert.equal(injected.length, 3, "链跑完就被清掉，下一次触发照常执行");
    });

    it("多桶清算里有一桶写失败 → 只还原未落定那桶，重试不重复计已落定的", async () => {
      const ctx = makeCtx();
      apply(ctx);
      await armedRule(ctx, { cwd: "/repo/a", signature: "sig-a" });
      await armedRule(ctx, { cwd: "/repo/b", signature: "sig-b" });
      const svc = loopService(ctx);
      const projectA = deriveProject("/repo/a");
      const projectB = deriveProject("/repo/b");
      await fireCreated(ctx, {
        inject: () => {
          // 只关心台账
        },
        session: { id: "s1", header: { cwd: "/repo/a" } },
      });
      // 两个目录各报一次违规（都带本会话 id）→ 两个桶各记一笔。
      await svc.report({
        source: SOURCE_QUALITY_GATE,
        category: CATEGORY_GATE_FAILURE,
        cwd: "/repo/a",
        sessionId: "s1",
        signature: "sig-a",
        detail: "d",
      });
      await svc.report({
        source: SOURCE_QUALITY_GATE,
        category: CATEGORY_GATE_FAILURE,
        cwd: "/repo/b",
        sessionId: "s1",
        signature: "sig-b",
        detail: "d",
      });
      // 只让 B 那一桶写失败（A 真落定）。
      const settle = vi
        .spyOn(LessonStore.prototype, "sessionEnded")
        .mockImplementation(async (project) => project !== projectB);
      fireDisposed(ctx, { id: "s1" });
      await flushAsync();
      assert.deepEqual(
        settle.mock.calls.map((call) => call[0]),
        [projectA, projectB],
        "逐桶串行：A 落定，B 失败",
      );
      // 失败把整行还原（含未落定的 B）；重试时 A 已落定不再计，只重试 B。
      fireDisposed(ctx, { id: "s1" });
      await flushAsync();
      assert.deepEqual(
        settle.mock.calls.map((call) => call[0]),
        [projectA, projectB, projectB],
        "重试只对未落定的 B 再走一次，已落定的 A 不重复计 samples",
      );
    });

    it("已清算的会话不重建桶：再次 created 后收尾走 header 兜底", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const ended = vi.spyOn(LessonStore.prototype, "sessionEnded");
      await fireCreated(ctx, {
        inject: () => {
          // 不关心注入，只看台账
        },
        session: { id: "s1", header: { cwd: GATE_PROJECT_CWD } },
      });
      fireDisposed(ctx, { id: "s1" });
      await flushAsync();
      assert.equal(ended.mock.calls.length, 1, "首次清算按桶走一条");
      // 同一 id 再次 created：hasSettled 为真 → 不重建桶。
      await fireCreated(ctx, {
        inject: () => {
          // 同上
        },
        session: { id: "s1", header: { cwd: GATE_PROJECT_CWD } },
      });
      fireDisposed(ctx, { id: "s1" });
      await flushAsync();
      assert.equal(ended.mock.calls.length, 2, "已清算会话的第二次收尾走 header 兜底");
    });
  });

  describe("常驻段的替换/退役通知（本地化 + 换语言重注册）", () => {
    it("注册时就带上两枚本地化通知，locale 变更后先撤再注册", () => {
      const ctx = makeCtx();
      apply(ctx);
      const zh = ctx.section;
      assert.ok(zh, "常驻段未注册");
      assert.equal(zh.replacement, MESSAGES.zh.sectionReplacement);
      assert.equal(zh.retirement, MESSAGES.zh.sectionRetirement);
      assert.equal(ctx.sectionRegistrations, 1);
      // 换语言：宿主推 locale 失效 → 先 dispose 再 section，两枚通知重新捕获成英文。
      ctx.localeValue = { preference: "en" };
      fireSettingsUpdated(ctx, "locale");
      assert.equal(ctx.sectionRegistrations, 2, "换语言必须重注册一次");
      const en = ctx.section;
      assert.ok(en, "重注册后段应回到槽位");
      assert.equal(en.replacement, MESSAGES.en.sectionReplacement);
      assert.equal(en.retirement, MESSAGES.en.sectionRetirement);
      assert.doesNotMatch(en.replacement ?? "", /\p{Script=Han}/u);
      // 别的命名空间变更不重注册（段文本没变，重注册只会白造一次通知）。
      fireSettingsUpdated(ctx, "other-plugin");
      assert.equal(ctx.sectionRegistrations, 2);
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

    it("pass：开关关闭 / 无 armed 命中 / 无 sessionId 都不写入台账", async () => {
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
      // 两条都没留下台账：收尾只能走空集合后备
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
      // s0 先拿到 pass 记录下来：它排在插入序最前，正是溢出时要丢的那条
      svc.pass({
        category: CATEGORY_GATE_FAILURE,
        cwd: GATE_PROJECT_CWD,
        sessionId: "s0",
        signature: SIGNATURE_GATE_COMMAND,
      });
      for (let index = 1; index <= 200; index += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- 逐场会话建条目（容量断言要求全部登记完）
        await fireCreated(ctx, { session: { id: `s${index}`, header: { cwd: GATE_PROJECT_CWD } } });
      }
      const ended = vi.spyOn(LessonStore.prototype, "sessionEnded");
      // 容量修剪只丢内存里的 watch 条目；s0 的 pass 已经在 session_ledger 里。
      // 收尾清算必须从台账捡回它，而不是按“无台账”的空集合算——台账是持久事实源。
      fireDisposed(ctx, { id: "s0", header: { cwd: GATE_PROJECT_CWD } });
      assert.deepEqual(ended.mock.calls[0]?.[2], new Set([id]));
      // 末位的新会话还在表里：pass 记录下来照常清算
      svc.pass({
        category: CATEGORY_GATE_FAILURE,
        cwd: GATE_PROJECT_CWD,
        sessionId: "s200",
        signature: SIGNATURE_GATE_COMMAND,
      });
      fireDisposed(ctx, { id: "s200" });
      assert.deepEqual(ended.mock.calls[1]?.[2], new Set([id]));
    });

    it("已清算集合也按上限修剪：溢出的旧会话不再计入「重复边」", async () => {
      // 不修剪就是长驻进程里的无界增长；而修剪的一个可观测后果是：被丢出集合的会话
      // 再次 dispose 时会被当成"首个边"重新计 exposure——这是有界内存换来的已知取舍。
      const ctx = makeCtx();
      apply(ctx);
      await armedRule(ctx);
      const ended = vi.spyOn(LessonStore.prototype, "sessionEnded");
      // 灌满 200 个会话并各清算一次（首个边，计 exposure）
      for (let index = 0; index <= 200; index += 1) {
        fireDisposed(ctx, { id: `d${index}`, header: { cwd: GATE_PROJECT_CWD } });
      }
      const before = ended.mock.calls.length;
      // d0 已被挤出去 → 再来一次时被当成首个边（exposure=true）
      fireDisposed(ctx, { id: "d0", header: { cwd: GATE_PROJECT_CWD } });
      assert.equal(ended.mock.calls.at(-1)?.[4], true, "被挤出集合的会话重新按首个边处理");
      assert.equal(ended.mock.calls.length, before + 1);
      // 末位那个仍在集合里 → 重复边（exposure=false）
      fireDisposed(ctx, { id: "d200", header: { cwd: GATE_PROJECT_CWD } });
      assert.equal(ended.mock.calls.at(-1)?.[4], false, "集合内的会话重复边不计 exposure");
    });

    it("无台账且无 header → 按 default 项目清算（插件中途装载的后备）", () => {
      const ctx = makeCtx();
      apply(ctx);
      const ended = vi.spyOn(LessonStore.prototype, "sessionEnded");
      fireDisposed(ctx, { id: "ghost" });
      // 第五位是 exposure 开关：该会话的首个 dispose 边为 true，重复边为 false。第六位是
      // `onPersisted`：库在时清算把它交给 saveRules，两个计数与台账消费同事务提交（库缺席
      // 时才整位不发）。「无台账」指台账行缺失，库本身仍在该用例的装配里。
      const [call] = ended.mock.calls;
      assert.deepEqual(call?.slice(0, 5), ["default", new Set(), new Set(), "ghost", true]);
      assert.equal(typeof call[5], "function", "库在时必须带同事务落定钩子");
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

    it("条目装载失败（fiber.await 重抛）→ 迁移整条收手，不再去读规则库", async () => {
      const ctx = makeCtx({ rules: [fragmentRow("f1", "/repo/src/a.ts")] });
      // cordis 的 Fiber.await() 在装载失败时重抛（vendor/cordis/src/fiber.ts:698-710）：
      // 那种情况下本条目根本不会 ACTIVE，规则库也读不出来，迁移必须直接收手而不是
      // 拿着"读不懂"的读取接口继续跑（否则每次失败装载都多刷一条日志）。
      ctx.fiber.await = () => Promise.reject(new Error("装载失败"));
      const migrate = vi.spyOn(LessonStore.prototype, "migrateFragmentRules");
      apply(ctx);
      await flushAsync();
      await flushAsync();
      assert.equal(migrate.mock.calls.length, 0, "装载失败时一条迁移都不该起");
      assert.notEqual(ctx.provided["lessonLoop"], undefined, "服务照常供给");
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
      const service = ctx.get("lessonLoopRules") as {
        stats: () => {
          undeterminableCount: number;
          rules: { id: string; undeterminable: boolean; samples: number }[];
        };
      };
      const body = service.stats();
      assert.equal(body.undeterminableCount, 1);
      assert.equal(body.rules.find((rule) => rule.id === "rule-und")?.undeterminable, true);
      assert.equal(body.rules.find((rule) => rule.id === "rule-und")?.samples, 0);
    });

    it("rules GET 同样带 undeterminable；新升格的 armed 规则为 false", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const id = await armedRule(ctx);
      const body = (
        ctx.get("lessonLoopRules") as {
          rules: (request: Record<string, unknown>) => {
            rules: { id: string; undeterminable: boolean }[];
          };
        }
      ).rules({});
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

  // ── 双语：host 侧文案随官方 locale 偏好走，规则数据永不改写 ───────────────
  // 读的是官方 dsh-client-locale 拥有的 settings 命名空间 `locale`（假件里由
  // makeCtx({ locale }) 递值）；未注册即中文——上面 60 多条既有断言全走中文路径，
  // 它们本身就是「默认语言 = zh」的回归网。这里只补 en 分支与数据那一栏红线。
  describe("host 文案的语言偏好（locale.preference）", () => {
    /** 常驻段 + 命令注册入口（description / input.hint 在装载期求值一次）。 */
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

    it("en：命令的 description 与 input.hint 是英文（注册入口也吃偏好）", () => {
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

    it("en：/lessons-digest 关闭时的回显、失败回显与成功清单都是英文", async () => {
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
      await fireCreated(ctx, {
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
  // 真实宿主隔离实测：插件 apply 早于自己那条 fiber 变 ACTIVE，而 0.2.1-alpha.2 的 describe()
  // 只收 ACTIVE 条目（apply 那一刻只投出别的行，不含 lesson-loop）。这种"读不出形状"是
  // 装载次序的既定事实，不是数据坏了：把它报成 rejected，人就会去修根本没坏的数据；报成
  // 一行 warn，则是每次正常开机都多一条与故障无关的噪声（用户报的日志噪点正是这条）。
  // 真正的坏形状（行在投影里、rules 却不是数组）仍必须出声——两条在这里分开钉。
  describe("规则装载期降级说法（apply 早于条目 ACTIVE）", () => {
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

    it("旧 config.rules 是非数组 ⇒ 迁移端口读成 unusable 并点名，不猜也不清空", () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {
        // 断言在下方
      });
      const ctx = makeCtx({ rawRules: "not-an-array" });
      apply(ctx);
      assert.match(
        error.mock.calls.map(String).join("\n"),
        /rules namespace rejected/u,
        "原文读不懂，就是数据坏了，必须点名",
      );
      error.mockRestore();
    });
  });

  describe("配置行 hint 与 configSchema 对账（两处真值不许各自漂移）", () => {
    const NUMERIC_HINT_FIELDS = [
      "promoteThreshold",
      "demoteThreshold",
      "demoteMinSamples",
      "demoteRatio",
      "reviveThreshold",
      "decayDays",
      "maxStatementChars",
    ] as const;

    it("七个数值字段的 hint 写着 schema 的区间与默认（zh/en 同查，期望从 schema 当场读出）", () => {
      for (const field of NUMERIC_HINT_FIELDS) {
        const meta = plugin.Config.dict?.[field]?.meta;
        assert.ok(meta !== undefined, `configSchema 里该有 ${field} 这一位`);
        // meta 经 Dict<Schema> 索引出来是 any：先收 unknown 再逐位判形状，不整块解构
        const shape = meta as unknown as { min?: number; max?: number; default?: unknown };
        const { min, max, default: dfltValue } = shape;
        assert.equal(typeof dfltValue, "number", `${field} 必须有数值默认`);
        const dflt = String(dfltValue);
        const tables = [
          ["zh", UI_MESSAGES.zh, "默认"],
          ["en", UI_MESSAGES.en, "default"],
        ] as const;
        for (const [locale, table, defaultWord] of tables) {
          const hint = table[`${field}Hint`];
          assert.ok(
            hint.includes(`${String(min)}-${String(max)}`),
            `${locale} 的 ${field}Hint 缺区间 ${String(min)}-${String(max)}：${hint}`,
          );
          assert.ok(
            hint.includes(`${defaultWord} ${dflt}`),
            `${locale} 的 ${field}Hint 缺「${defaultWord} ${dflt}」：${hint}`,
          );
        }
      }
    });

    it("maxLessonsBytes 的 hint 写明 GiB 硬上限与 0 = 不设上限", () => {
      const meta = plugin.Config.dict?.["maxLessonsBytes"]?.meta;
      assert.ok(meta !== undefined);
      assert.equal(meta.default, 0);
      const gib = `${String((meta.max ?? 0) / 1024 ** 3)} GiB`;
      for (const hint of [UI_MESSAGES.zh.maxLessonsBytesHint, UI_MESSAGES.en.maxLessonsBytesHint]) {
        assert.ok(hint.includes(gib), `hint 缺硬上限 ${gib}：${hint}`);
        assert.ok(hint.includes(String(meta.default)), `hint 缺默认 0：${hint}`);
      }
    });
  });

  describe("部署值与退出清算静默", () => {
    it("行 config 覆盖 decayIntervalMs → 周期衰减按配置时长武装（不再写死 24h）", async () => {
      const ctx = makeCtx({ value: { decayIntervalMs: 60_000 } });
      apply(ctx);
      // 装载期那一轮先结算，之后才武装下一轮——间隔取自行 config 而不是写死的默认值。
      await flushAsync();
      assert.deepEqual(ctx.timerMs, [60_000], "衰减定时器是本包唯一的 timer.timeout 消费点");
    });

    it("两枚部署值不标 volatile ⇒ 设置表单仍是十三项", () => {
      const form = volatileFormOf(plugin.Config as unknown as SchemaNode);
      assert.equal(form?.length, 13, "部署值不进表单，投影字段集不变");
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
      await fireCreated(ctx, { session: { id: "s-w4", header: { cwd } } });
      // 换一枚"要跨一个宏任务才写完"的 sessionEnded：同步 disposer 会在拆纤当场把它丢下
      const settled: string[] = [];
      vi.spyOn(LessonStore.prototype, "sessionEnded").mockImplementation(async () => {
        await Promise.resolve();
        settled.push("s-w4");
        return true;
      });
      const pending = Promise.all(ctx.effects.map((dispose) => dispose()));
      assert.deepEqual(settled, [], "await 之前不许声称已经静默（defensive-patterns:19-21）");
      await pending;
      assert.deepEqual(settled, ["s-w4"], "退出清算把这条会话的度量写完了才交回控制权");
    });

    it("会话已结束后命中的违规不得重建台账条目（否则退出时多算一次 exposure）", async () => {
      // 审查点：`reportLesson` 在 `await store.report()` 之后补记 violationOf。若会话在这段
      // 期间已经结束、台账被清掉，旧实现用 `?? {}` 重建条目 —— 那个条目要等进程退出才清算，
      // 等于把一场已结束的会话又算一次 exposure。
      //
      // 这里不 mock 时序（`store.report` 本身是同步写到磁盘的，用假 await 制造窗口只会测出
      // 误判通过）：直接按真实事件顺序摆{"先结束会话，再让它收一条 armed 命中"}，
      // 然后断言退出清算不会看到这个会话的条目。
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      const cwd = GATE_PROJECT_CWD;
      const seeded = await svc.report({
        source: SOURCE_QUALITY_GATE,
        category: CATEGORY_GATE_FAILURE,
        cwd,
        signature: SIGNATURE_GATE_COMMAND,
        detail: "seed",
      });
      assert.equal(await svc.ruleAction(seeded.candidate!.id, "arm"), "persisted");

      const ended = vi.spyOn(LessonStore.prototype, "sessionEnded");
      // 先让会话有台账（正常 start），再结束掉它——此后台账里没有这条会话。
      await fireCreated(ctx, { session: { id: "s-race", header: { cwd } } });
      fireDisposed(ctx, { id: "s-race", header: { cwd } });
      const settledCount = ended.mock.calls.length;
      // 会话已经结束，这时来一条 armed 命中（带 sessionId 的那条）
      const hit = await svc.report({
        source: SOURCE_QUALITY_GATE,
        category: CATEGORY_GATE_FAILURE,
        cwd,
        sessionId: "s-race",
        signature: SIGNATURE_GATE_COMMAND,
        detail: "after-dispose",
      });
      assert.ok(hit.violationOf !== undefined, "前置：这次命中必须带 violationOf 才测到那段逻辑");
      // 退出清算：若条目被重建，这里会多出一条 sessionEnded 调用。
      await Promise.all(ctx.effects.map((dispose) => dispose()));
      const exited = ended.mock.calls.slice(settledCount).filter((call) => call[3] === "s-race");
      assert.equal(exited.length, 0, "已结束的会话不该因为一条迟到的命中而重新进台账");
    });

    it("armed 命中的告警日志：原始签名截到 64 字符（完整原文只进流水与证据）", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {
        // 断言在下方
      });
      // factgate-deny 的任意签名都折叠到类别级稳定键：先用一条路径签名建卡并升格，
      // 再用一条 80 字符的签名命中同一张 armed 卡（raw 段 = 原始签名，与折叠键不同）。
      const first = await svc.report({
        source: SOURCE_DANGER_GUARD,
        category: CATEGORY_FACTGATE_DENY,
        cwd: GATE_PROJECT_CWD,
        signature: "/repo/src/some-file.ts",
        detail: "raw-truncation-seed",
      });
      await svc.ruleAction(first.candidate!.id, "arm");
      const longSignature = "x".repeat(80);
      const hit = await svc.report({
        source: SOURCE_DANGER_GUARD,
        category: CATEGORY_FACTGATE_DENY,
        cwd: GATE_PROJECT_CWD,
        signature: longSignature,
        detail: "raw-truncation",
      });
      assert.ok(hit.violationOf !== undefined, "前置：命中 armed 规则");
      const line = String(warn.mock.calls.at(-1)?.[0]);
      assert.match(line, /armed rule violated:/u);
      assert.match(line, /raw=x{64}…/u, "raw 段截到 64 字符加省略号");
      assert.doesNotMatch(line, /x{65}/u, "原文第 65 个字符起不进日志");
      warn.mockRestore();
    });

    it("会话已结束后命中的 pass 不得重建台账条目（否则收尾多记一次 suppressed）", async () => {
      // 与上一条对称：`noteViolationForSettle` 与 `recordPass` 是两条写入口，判据必须同一份。
      // 若 pass 侧仍用 `?? {}` 重建条目，条目要留到进程退出才清算：那一轮
      // countExposure 为 false（已清算）而 passed 非空，于是给一条真实违反过的规则
      // 记一次 suppressed —— 分母多一个，方向正好与去重相反。
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      const id = await armedRule(ctx);
      const cwd = GATE_PROJECT_CWD;
      const sid = "s-pass-race";
      const ended = vi.spyOn(LessonStore.prototype, "sessionEnded");
      // 正常建台账 → 结束它，此后台账里没有这条会话，但它在已清算集合里。
      await fireCreated(ctx, { session: { id: sid, header: { cwd } } });
      fireDisposed(ctx, { id: sid, header: { cwd } });
      const settledCount = ended.mock.calls.length;
      // 迟到的 pass：它命中的是已 armed 的规则，旧实现会在这里重建条目。
      const receipt = svc.pass({
        category: CATEGORY_GATE_FAILURE,
        cwd,
        sessionId: sid,
        signature: SIGNATURE_GATE_COMMAND,
      });
      assert.ok(receipt.ok, "前置：这次 pass 必须走到记账那一段才测得到判据");
      await Promise.all(ctx.effects.map((dispose) => dispose()));
      const exited = ended.mock.calls.slice(settledCount).filter((call) => call[3] === sid);
      assert.equal(exited.length, 0, "已清算的会话不该因为一条迟到的 pass 而重新进台账");
      // 反面证据：suppressed 仍是 0（若条目被重建并清算，这里会变成 1）。读数走新连接：
      // 上面那轮卸载已经关掉本插件的连接。
      assert.equal(cardsOnDisk().find((rule) => rule.id === id)?.suppressed, 0);
    });

    it("会话仍在台账时，armed 命中要记进本会话的 violated（供收尾抑制 exposure）", async () => {
      // 与上一条互为反面：上一格钉"已结束不重建"，这一格钉"仍在时确实记进去"。
      // 记进去的可观测后果：该会话结束时 samples 不涨（违规会话不算暴露）。
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      const cwd = GATE_PROJECT_CWD;
      const seeded = await svc.report({
        source: SOURCE_QUALITY_GATE,
        category: CATEGORY_GATE_FAILURE,
        cwd,
        signature: SIGNATURE_GATE_COMMAND,
        detail: "seed",
      });
      assert.equal(await svc.ruleAction(seeded.candidate!.id, "arm"), "persisted");
      await fireCreated(ctx, { session: { id: "s-live", header: { cwd } } });
      // 会话仍在台账里时来一条 armed 命中
      const hit = await svc.report({
        source: SOURCE_QUALITY_GATE,
        category: CATEGORY_GATE_FAILURE,
        cwd,
        sessionId: "s-live",
        signature: SIGNATURE_GATE_COMMAND,
        detail: "while-live",
      });
      assert.ok(hit.violationOf !== undefined, "前置：这次命中必须带 violationOf");
      // 收尾清算：违规过的规则不记 exposure
      fireDisposed(ctx, { id: "s-live", header: { cwd } });
      await flushAsync();
      const samples = rulesOf(ctx).find((rule) => rule.id === hit.violationOf!.id)?.samples;
      assert.equal(samples, 0, "违规会话不该给这条规则计 exposure");
    });

    it("退出清算与事件路径共用 exposure 去重：已清算过的会话不再计 exposure", async () => {
      // 审查点：两个入口各判一次会让同一条会话被计两次 samples。
      const ctx = makeCtx();
      apply(ctx);
      await fireCreated(ctx, { session: { id: "s-dup", header: { cwd: GATE_PROJECT_CWD } } });
      const ended = vi.spyOn(LessonStore.prototype, "sessionEnded");
      // 事件路径先清算一次（首个边）
      fireDisposed(ctx, { id: "s-dup", header: { cwd: GATE_PROJECT_CWD } });
      assert.equal(ended.mock.calls[0]?.[4], true);
      // 已清算的会话再出现（resume）：台账不再预种（它注定不会再被清算），退出清算
      // 因此也不会为它再起一笔——去重收敛成"两个入口合计只清算一次"。
      await fireCreated(ctx, { session: { id: "s-dup", header: { cwd: GATE_PROJECT_CWD } } });
      await Promise.all(ctx.effects.map((dispose) => dispose()));
      assert.equal(
        ended.mock.calls.filter((call) => call[3] === "s-dup").length,
        1,
        "已清算会话不重建台账：两个入口合计只清算一次",
      );
    });

    it("清算没写到磁盘 → 回滚清算标记与台账条目，下一边带全量数据重试", async () => {
      const ctx = makeCtx();
      apply(ctx);
      const svc = loopService(ctx);
      const id = await armedRule(ctx);
      svc.pass({
        category: CATEGORY_GATE_FAILURE,
        cwd: GATE_PROJECT_CWD,
        sessionId: "s-r",
        signature: SIGNATURE_GATE_COMMAND,
      });
      const ended = vi.spyOn(LessonStore.prototype, "sessionEnded").mockResolvedValue(false);
      fireDisposed(ctx, { id: "s-r", header: { cwd: GATE_PROJECT_CWD } });
      await flushAsync();
      // 第一边没写到磁盘：标记与台账条目都还原了。
      fireDisposed(ctx, { id: "s-r", header: { cwd: GATE_PROJECT_CWD } });
      await flushAsync();
      const retryCall = ended.mock.calls[1]!;
      assert.deepEqual(retryCall[2], new Set([id]), "重试边带全量 pass 集");
      assert.equal(retryCall[4], true, "标记回滚后按首个边重试（exposure 不丢）");
      ended.mockRestore();
    });

    it("无预种台账的会话清算失败 → 只回滚清算标记，不凭空重建条目", async () => {
      // 与上一条对称：restoreOnFailure 在 watchEntry === undefined 时只 unsettle，
      // 不能为了"重试"重建一条没有来源的空台账。
      const ctx = makeCtx();
      apply(ctx);
      const ended = vi.spyOn(LessonStore.prototype, "sessionEnded").mockResolvedValue(false);
      // 没有 agent/created 预种：走 header 回填的兜底清算。
      fireDisposed(ctx, { id: "s-orphan", header: { cwd: GATE_PROJECT_CWD } });
      await flushAsync();
      fireDisposed(ctx, { id: "s-orphan", header: { cwd: GATE_PROJECT_CWD } });
      await flushAsync();
      assert.equal(ended.mock.calls[1]?.[4], true, "标记回滚后重试边按首个边清算");
      ended.mockRestore();
    });

    it("退出清算交回的是异步 disposer（形状钉：不靠宏任务赌一拍）", async () => {
      const ctx = makeCtx();
      apply(ctx);
      await fireCreated(ctx, { session: { id: "s-shape", header: { cwd: GATE_PROJECT_CWD } } });
      const results = ctx.effects.map((dispose) => dispose());
      assert.ok(
        results.some((value) => isThenable(value)),
        "至少一枚释放器必须是可 await 的：否则在飞的 provider 写会被拆纤截断",
      );
      await Promise.all(results);
    });
  });

  describe("旧字段缺席与库不可用", () => {
    it("老 patch 压根没有 rules 键：装载照常，规则读空、不跑迁移写", async () => {
      const ctx = makeCtx({ omitRawRules: true });
      apply(ctx);
      await flushAsync();
      const body = (
        ctx.get("lessonLoopRules") as { rules: (request: object) => { rules: [] } }
      ).rules({});
      assert.deepEqual(body.rules, []);
    });

    it("sqlite 打不开：规则端口判不可用，写动作被拒而不是崩", async () => {
      const open = vi.spyOn(LessonDb, "open").mockReturnValue(null);
      try {
        const ctx = makeCtx({ omitRawRules: true });
        apply(ctx);
        await flushAsync();
        const service = ctx.get("lessonLoopRules") as {
          rules: (request: object) => { rules: unknown[] };
          ruleAction: (request: { id: string; action: string }) => Promise<{ ok: boolean }>;
        };
        assert.deepEqual(service.rules({}).rules, []);
        const refused = await service.ruleAction({ id: "ghost", action: "archive" });
        assert.equal(refused.ok, false);
        // 有会话建过又结束时，台账补算会拿到 db===null：直接收手，不造暴露度。
        await fireCreated(ctx, { session: { id: "s-nodb", header: { cwd: GATE_PROJECT_CWD } } });
        fireDisposed(ctx, { id: "s-nodb", header: { cwd: GATE_PROJECT_CWD } });
        await flushAsync();
      } finally {
        open.mockRestore();
      }
    });

    it("ruleDetail 的页大小取自 evidencePageSize 现取引用", async () => {
      const ctx = makeCtx({ value: { evidencePageSize: 5 } });
      apply(ctx);
      await flushAsync();
      const id = await armedRule(ctx);
      const service = ctx.get("lessonLoopRules") as {
        ruleDetail: (request: { id: string }) => { ok: boolean; nextCursor: number | null };
      };
      assert.equal(service.ruleDetail({ id }).nextCursor, null, "空证据的下一页为空");
    });
  });
});
