// lib/rules-remote.ts —— 设置卡「规则评审」的**宿主读面**（官方 Typert Remote）。
//
// 为什么是 Remote：卡片跑在浏览器里，而规则库、事件流水与人工动作都在宿主进程。设置面
// 没有「宿主执行动作」的口子（`ctx.settings` 只有 configure/describe/update/replace/
// mutate），唯一的官方通道就是 Typert Remote —— 官方 `permission-presets` 正是这么把
// 进程级目录交给客户端 UI 的。
//
// 为什么手写 descriptor 而不跑生成器：官方网关在源模式（SRC）下从**方法签名**推出参数名，
// 参数与结果都用 `{ mode: "src-json" }` 编解码；这两样都不需要生成器的 `typeSymbol` /
// `create()` 产物。本服务四个方法都是「一元、JSON 出参」，手写客户端 descriptor 比引入
// 一条构建期代码生成链（外加生成物随包发布）便宜得多。
//
// ⚠ 值导入面：`TypertRemoteService` 是个**类**（要 `extends`），没有 type-only 的造法，
// 因此它落 `peerDependencies`（`dependencies` 是禁区，由 test/publish-manifest.test.ts
// 钉着），产物里保持**裸说明符**（build-host.mjs 的外部化名单读 dependencies ∪
// peerDependencies）。
//
// 安全边界不再靠 HTTP 面那两道锁（CSRF 令牌 + 信任闸门）：这条读面只经官方网关暴露给
// **本 profile 的客户端**，网关自己承担来源校验与鉴权。方法体里的入参白名单（六个动作）
// 与「id 不在库里就回 404」原样保留——它们护的是动作本身，与传输方式无关。

import type { Context } from "@deepseek-ai/cordis";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { errorText } from "@jayyuen66/dsh-plugin-shared/lib/errors";

import type { LessonStore, RuleCard } from "./lesson-store.ts";
import { fill } from "./messages.ts";
import type { LessonLoopMessages } from "./messages.ts";
import { RULES_REMOTE_NAMESPACE } from "./rules-shape.ts";
import type {
  LessonView,
  LessonsReply,
  LessonsRequest,
  ReadRefused,
  RuleActionName,
  RuleActionReply,
  RuleActionRequest,
  RulesReply,
  RulesRequest,
  RuleView,
} from "./rules-shape.ts";

/**
 * 人工动作白名单：`Record<RuleActionName, true>` 由类型联合派生——`RuleActionName`
 * 新增/改名成员而这里漏改，会在编译期红，而不是运行期把合法动作静默判成 400。
 * 与卡片按钮、`LessonStore.ruleAction` 的取值域同集。
 */
const ALLOWED_ACTIONS: ReadonlySet<string> = new Set(
  Object.keys({
    arm: true,
    reject: true,
    demote: true,
    archive: true,
    edit: true,
    revive: true,
  } satisfies Record<RuleActionName, true>),
);

/** 三个读方法各自的名字：既是日志里的方法名，也是拒读文案的键选择器。 */
type ReadMethodName = "stats" | "rules" | "lessons";

/**
 * 读方法 → 消息表键。写成一张受类型约束的表而不是三段 if：新增读方法时漏登记是
 * **编译期**错误（键集由 `satisfies` 钉住），不会静默复用别的文案。
 */
const READ_REFUSAL_KEYS = {
  stats: "errStatsUnavailable",
  rules: "errRulesUnavailable",
  lessons: "errLessonsUnavailable",
} as const satisfies Record<ReadMethodName, keyof LessonLoopMessages>;

/**
 * 读失败的统一出口：日志记原文（只有它含可排查的细节），回执只给本地化文案。
 *
 * `which` 同时是日志里的方法名与消息表的键选择器——三者写成一张表而不是三段
 * if，新增读方法时漏加分支会是**类型错误**（键集由 `Record<ReadMethodName, …>`
 * 约束），而不是静默落到某一枚文案上。
 *
 * 写成模块级函数而不是私有方法：服务原型上每个自有方法都必须带 `@Remote` 标记
 * （remoteMethods 的对质用例钉着），私有工具方法会在那条断言里表现为"漏标方法"，
 * 而放宽那条断言等于把真正漏标的新方法一起放过。
 */
function refuseRead(
  messages: LessonLoopMessages,
  which: ReadMethodName,
  error: unknown,
): ReadRefused {
  console.error(`[lesson-loop] ${which} request failed: ${errorText(error)}`);
  return { ok: false, error: messages[READ_REFUSAL_KEYS[which]], status: 500 };
}

function isRuleAction(value: unknown): value is RuleActionName {
  return typeof value === "string" && ALLOWED_ACTIONS.has(value);
}

/** 服务真正用到的那几位（`Pick` 掉私有字段后测试替身才能结构化满足它）。 */
export type RulesStore = Pick<
  LessonStore,
  "rules" | "recentLessons" | "ruleAction" | "isUndeterminable"
>;

/** events 流水读面的条数口径：缺省/≤0 取默认条数，显式请求封顶——事件流水只追加不
 *  修剪，"缺省 = 全量"会让一次调用把整份流水（含每条工具输出全文）序列化过网关，
 *  载荷随使用时长线性增长；而这枚读面挂在公开命名空间上，第三方客户端按默认参数
 *  调用就该拿到有界的载荷。存储侧的零截断承诺不受影响（ lesson-jsonl 层不截断）。 */
const LESSONS_DEFAULT_LIMIT = 50;
const LESSONS_MAX_LIMIT = 500;
/** 单条流水 detail 的下发上限（字符）：detail 是门禁输出/拒绝理由原文，可能含路径、
 *  命令串等敏感面，下发前定长截断；与规则卡证据的 detail 上限同量级。 */
const MAX_LESSON_DETAIL_CHARS = 400;

/** 规则评审读面的全部依赖。 */
export interface LessonRulesDeps {
  store: RulesStore;
  /** 管理面快照；`stats()` 把刚读到的规则卡交回来复用（同一次轮询不读两遍规则库）。 */
  stats: (rules: RuleCard[]) => Record<string, unknown>;
  /** 现取一份文案（语言随官方 locale 偏好，改语言不必重载插件）。 */
  messagesOf: () => LessonLoopMessages;
}

/**
 * 规则卡的读面投影：去证据 + 派生的「不可判定」态。
 *
 * 为什么不把 evidence 发出去：证据是全文（一条教训的 detail 可含整段工具输出），而卡片
 * 只渲染状态与计数——原样序列化等于每次轮询把整份证据库传给浏览器再丢掉。
 * 不可判定是「该不该由人处理」的判据（既不自动降级也不自动归档），必须带出去让人看到。
 */
function ruleViewOf(store: RulesStore, rule: RuleCard): RuleView {
  const { evidence: _evidence, ...rest } = rule;
  return { ...rest, undeterminable: store.isUndeterminable(rule) };
}

/**
 * 编译期钉子：RuleView 逐枚重述只防"改名/删字段"，而 ruleViewOf 用 rest 摊开——TS 对
 * spread 属性**不做**多余属性检查，RuleCard 将来新增的任何字段（体积大或含敏感面的
 * 尤其危险）会被 `...rest` 静默带上网线。断言"除刻意剔除的 evidence 外，RuleCard 的
 * 键集 ⊆ RuleView 的键集"；失败时本类型是 never，下一行的赋值当场编译红——新增字段
 * 必须先在 rules-shape.ts 的 RuleView 里显式表态（投影或显式排除）。
 */
type UnviewedCardKeys = Exclude<keyof RuleCard, keyof RuleView | "evidence">;
export const noUnviewedCardKeys: [UnviewedCardKeys] extends [never] ? true : never = true;

/**
 * 规则列表的 project 过滤：缺省 = 全量。
 * 入参来自网线（源模式已按签名解出），仍按 unknown 面收——类型说的是网关的承诺，
 * 交付由守卫负责。
 */
function projectOf(request: unknown): string | undefined {
  const raw = isRecord(request) ? request["project"] : undefined;
  return typeof raw === "string" ? raw : undefined;
}

/**
 * lessons 的 limit 归一：≤ 0 / 非数 / 缺省一律取默认条数，显式请求封顶在
 * {@link LESSONS_MAX_LIMIT}。旧 HTTP 面的 `Number(...)` 那套字符串解析随 query 一起消失；
 * 这里只认数字，因为 descriptor 的 strict codec 已经在客户端把非数字挡在网线之前。
 */
function limitOf(request: unknown): number {
  const raw = isRecord(request) ? request["limit"] : undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return LESSONS_DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(raw), LESSONS_MAX_LIMIT);
}

/**
 * 流水记录的**读面投影**：detail 定长截断、不外借原始 evidence（它带着工具输出原文，
 * 与规则卡的 evidence 同一条剔除理由）。投影逐字段写而不是展开——`LessonRecord`
 * 将来新增的敏感字段不会因为 `...rest` 静默上网线。
 */
function lessonViewOf(record: {
  ts: number;
  source: string;
  category: string;
  project: string;
  cwd?: string;
  sessionId?: string;
  turn?: number;
  signature: string;
  detail: string;
}): LessonView {
  return {
    ts: record.ts,
    source: record.source,
    category: record.category,
    project: record.project,
    ...(record.cwd === undefined ? {} : { cwd: record.cwd }),
    ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
    ...(record.turn === undefined ? {} : { turn: record.turn }),
    signature: record.signature,
    detail:
      record.detail.length > MAX_LESSON_DETAIL_CHARS
        ? `${record.detail.slice(0, MAX_LESSON_DETAIL_CHARS)}…`
        : record.detail,
  };
}

/**
 * 设置卡「规则评审」的四个读/写方法。
 *
 * ⚠ 服务在**构造时**注册（cordis `Service` 的契约：`ctx.reflect.provide`，随所属 fiber
 * 卸载自动撤），所以调用方拿实例没有任何用处——装入口 `installRulesRemote` 说明了这一点。
 * 读面不依赖任何可选宿主服务：store 与快照取用口都由 apply 交进来，故它跟着 apply 无条件
 * 上线（旧 HTTP 面要等 webServer 到位的那个 inject 子 fiber 一并删除）。
 */
export class LessonRulesService extends TypertRemoteService {
  private readonly deps: LessonRulesDeps;

  public constructor(ctx: Context, deps: LessonRulesDeps) {
    super(ctx, RULES_REMOTE_NAMESPACE);
    this.deps = deps;
  }

  /** 卡片轮询的入口：计数 + 配置摘要 + 全量规则投影（证据已去掉）。
   *
   *  失败折成 `{ ok: false, error }` 而不是抛（理由同 {@link ReadRefused}）：这三个读
   *  方法各摸一个 I/O 面，抛出去只会让网关把它折成一句英文内部错误贴到卡片上。 */
  public stats(): Record<string, unknown> {
    try {
      const rules = this.deps.store.rules();
      return {
        // ok 写在展开之后：stats 快照对返回键没有约束，快照哪天带上 ok:false/error，
        // 一次正常轮询就会被卡片判成失败——成功码不许被展开覆盖。
        ...this.deps.stats(rules),
        rules: rules.map((rule) => ruleViewOf(this.deps.store, rule)),
        ok: true,
      };
    } catch (error) {
      // 摊成对象字面量而不是直接返回 ReadRefused：本方法的返回类型是开放式记录
      // `Record<string, unknown>`，而 interface 没有隐式索引签名，直接返回会 TS2322。
      const refused = refuseRead(this.deps.messagesOf(), "stats", error) satisfies ReadRefused;
      return { ...refused };
    }
  }

  /** 规则列表：project 缺省给全量，给定即按卡片自存的 project 过滤。 */
  public rules(request: RulesRequest): RulesReply {
    try {
      const project = projectOf(request);
      const all = this.deps.store.rules();
      const rules = (
        project === undefined ? all : all.filter((rule) => rule.project === project)
      ).map((rule) => ruleViewOf(this.deps.store, rule));
      return { ok: true, rules };
    } catch (error) {
      return refuseRead(this.deps.messagesOf(), "rules", error);
    }
  }

  /** 事件流水只读投影（detail 截断、不外借原始 evidence），零写面；条数有默认值与
   *  上限（见 limitOf），detail 是门禁输出/命令串一类的敏感面，不设界等于把整份流水
   *  一次性序列化给浏览器。 */
  public lessons(request: LessonsRequest): LessonsReply {
    try {
      const lessons = this.deps.store.recentLessons(projectOf(request), limitOf(request));
      const views = lessons.map((lesson) => lessonViewOf(lesson));
      return { ok: true, count: views.length, lessons: views };
    } catch (error) {
      return refuseRead(this.deps.messagesOf(), "lessons", error);
    }
  }

  /**
   * 人工动作：入参白名单 → 落库并按结果定语义码。
   *
   * 失败一律折成 `{ ok: false, status }` 而不是抛：网关的异常分支只交出
   * `gateway/internal` 那句英文，卡片会把它原样贴给用户；这里保留旧 HTTP 面那批
   * 已翻译的回显。`persist-failed` 必须报 500 —— 这一次改动没进规则库，库里还是旧状态，
   * 回 200 等于假装升格已生效。
   */
  public async ruleAction(request: RuleActionRequest): Promise<RuleActionReply> {
    const messages = this.deps.messagesOf();
    const id = isRecord(request) && typeof request.id === "string" ? request.id : "";
    const action = isRecord(request) && typeof request.action === "string" ? request.action : "";
    const statementRaw = isRecord(request) ? request.statement : undefined;
    const statement = typeof statementRaw === "string" ? statementRaw : undefined;
    if (id === "" || action === "") {
      return { ok: false, error: messages.errIdAndActionRequired, status: 400 };
    }
    if (!isRuleAction(action)) {
      return { ok: false, error: fill(messages.errUnknownAction, { action }), status: 400 };
    }
    try {
      const outcome = await this.deps.store.ruleAction(id, action, statement);
      if (outcome === "not-found") {
        return { ok: false, error: messages.errRuleNotFound, status: 404 };
      }
      if (outcome === "invalid-statement") {
        // arm/edit 带空正文被库拒了：库未动。回 400 而不是 200——卡片显示"成功"
        // 而正文/状态一格未动，是"装作生效"的那类谎报。
        return { ok: false, error: messages.errStatementRequired, status: 400 };
      }
      if (outcome === "statement-too-long") {
        // armed 正文整段注入提示词：超限时库同样没动，回 400 并点名可调的设置项。
        return { ok: false, error: messages.errStatementTooLong, status: 400 };
      }
      if (outcome === "persist-failed") {
        // 回显走消息表（卡片直接显示 error 串）：PERSIST_FAILED 是 report() 回执的内部
        // 判等码，不是给人读的文案——把它原样贴给用户，用户看到的是一句没有出处的话。
        return { ok: false, error: messages.errRulePersistFailed, status: 500 };
      }
      // "unchanged"（edit 与现文相同）请求的终态本就成立，按成功回执——卡片刷新后
      // 看到的正文与用户提交的一致。
      return { ok: true, id, action };
    } catch (error) {
      // 兜住每一处抛错：漏到网关只会让卡片显示一句英文的内部错误，而这句是本包的话。
      console.error(`[lesson-loop] rule-action handler failed: ${errorText(error)}`);
      return { ok: false, error: messages.errRuleActionFailed, status: 500 };
    }
  }
}

/**
 * 标准装饰器的**程序化调用**：`@Remote` 的全部作用就是往类原型写一枚描述符，而标准装饰器
 * 语法需要一条 tsc 降级管线（本仓的测试/构建解析器都不降级它）。这里直接按 TC39 的
 * `ClassMethodDecoratorContext` 形状调同一个 decorator 函数，把标记落到真正的原型上。
 */
function markRemote(prototype: LessonRulesService, methodName: string): void {
  // 官方 `Remote` 的运行时只读 name/private/static 与 addInitializer（TC39 的 access/metadata
  // 它一概不读），故这里只给这四位；`Reflect.apply` 让装饰器工厂保持未类型化的调用面。
  const context = {
    kind: "method",
    name: methodName,
    static: false,
    private: false,
    addInitializer: (initializer: (this: unknown) => void): void => {
      // 初始器只做 `Object.getPrototypeOf(this)` 后落标记；用原型造一枚替身实例即可。
      Reflect.apply(initializer, Object.create(prototype), []);
    },
  };
  // oxlint-disable-next-line eslint/new-cap -- `Remote(…)` 是装饰器工厂，不是大写开头的构造调用
  const decorate = Remote(methodName);
  Reflect.apply(decorate, undefined, [Reflect.get(prototype, methodName), context]);
}

markRemote(LessonRulesService.prototype, "stats");
markRemote(LessonRulesService.prototype, "rules");
markRemote(LessonRulesService.prototype, "lessons");
markRemote(LessonRulesService.prototype, "ruleAction");

/**
 * 把读面装到这个上下文上（构造即注册，见类文档；host 侧唯一该调的口）。
 *
 * 为什么是一枚函数而不是让调用方直接 `new`：这枚 `new` 的**全部意义在构造期的注册副作用**
 * 上——实例由 cordis 的 fiber 持有（`Service` 基类把 `reflect.provide` 的 disposer 挂给
 * fiber），调用方拿到它没有任何用处。
 *
 * 注册口先探一次（`ctx.reflect.provide`）：替身/畸形上下文未必给，少了它只该少掉卡片
 * 这一栏，绝不该让 apply 当场炸掉。本服务没有自己的收尾资源——卸载由 Service 基类登记的
 * 反射面 disposer 负责，不另挂 effect。
 *
 * @param ctx - 宿主上下文
 * @param deps - 规则读面的全部依赖（见 LessonRulesDeps）
 * @returns 装上了没有（调用方不需要它——返回它只是让这条路可断言）
 */
export function installRulesRemote(ctx: Context, deps: LessonRulesDeps): boolean {
  if (!isRecord(ctx)) {
    return false;
  }
  const { reflect } = ctx;
  if (!isRecord(reflect) || typeof reflect.provide !== "function") {
    return false;
  }
  try {
    // oxlint-disable-next-line eslint/no-new -- 见函数文档：构造即注册，返回值无意义
    new LessonRulesService(ctx, deps);
  } catch (error) {
    // 构造期注册（super(ctx, namespace) 的 reflect.provide / provide 内部校验）仍可能
    // 抛错（命名空间重复注册一类）：只该少掉卡片这一栏，绝不让 apply 当场炸掉；
    // 静默缺席难定位，留一条日志。
    console.error(`[lesson-loop] rules review service registration failed: ${errorText(error)}`);
    return false;
  }
  return true;
}
