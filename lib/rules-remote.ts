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

import { PERSIST_FAILED } from "./lesson-store.ts";
import type { LessonStore, RuleCard } from "./lesson-store.ts";
import { fill } from "./messages.ts";
import type { LessonLoopMessages } from "./messages.ts";
import { RULES_REMOTE_NAMESPACE } from "./rules-shape.ts";
import type {
  LessonsRequest,
  LessonsResult,
  RuleActionName,
  RuleActionReply,
  RuleActionRequest,
  RulesRequest,
  RulesResult,
  RuleView,
} from "./rules-shape.ts";

/** 人工动作白名单：与卡片按钮、`LessonStore.ruleAction` 的取值域同集。 */
const ALLOWED_ACTIONS: ReadonlySet<string> = new Set([
  "arm",
  "reject",
  "demote",
  "archive",
  "edit",
  "revive",
]);

function isRuleAction(value: unknown): value is RuleActionName {
  return typeof value === "string" && ALLOWED_ACTIONS.has(value);
}

/** 服务真正用到的那几位（`Pick` 掉私有字段后测试替身才能结构化满足它）。 */
export type RulesStore = Pick<
  LessonStore,
  "rules" | "recentLessons" | "ruleAction" | "isUndeterminable"
>;

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
 * 规则列表的 project 过滤：缺省 = 全量。
 * 入参来自网线（源模式已按签名解出），仍按 unknown 面收——类型说的是网关的承诺，
 * 交付由守卫负责。
 */
function projectOf(request: unknown): string | undefined {
  const raw = isRecord(request) ? request["project"] : undefined;
  return typeof raw === "string" ? raw : undefined;
}

/**
 * lessons 的 limit 归一：≤ 0 / 非数 / 缺省一律 0（= 全量，内容零截断）。
 * 旧 HTTP 面的 `Number(...)` 那套字符串解析随 query 一起消失；这里只认数字，
 * 因为 descriptor 的 strict codec 已经在客户端把非数字挡在网线之前。
 */
function limitOf(request: unknown): number {
  const raw = isRecord(request) ? request["limit"] : undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  return Math.floor(raw);
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

  /** 卡片轮询的入口：计数 + 配置摘要 + 全量规则投影（证据已去掉）。 */
  public stats(): Record<string, unknown> {
    const rules = this.deps.store.rules();
    return {
      ok: true,
      ...this.deps.stats(rules),
      rules: rules.map((rule) => ruleViewOf(this.deps.store, rule)),
    };
  }

  /** 规则列表：project 缺省给全量，给定即按卡片自存的 project 过滤。 */
  public rules(request: RulesRequest): RulesResult {
    const project = projectOf(request);
    const all = this.deps.store.rules();
    const rules = (
      project === undefined ? all : all.filter((rule) => rule.project === project)
    ).map((rule) => ruleViewOf(this.deps.store, rule));
    return { ok: true, rules };
  }

  /** 事件流水只读投影，零写面。 */
  public lessons(request: LessonsRequest): LessonsResult {
    const lessons = this.deps.store.recentLessons(projectOf(request), limitOf(request));
    return { ok: true, count: lessons.length, lessons };
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
      if (outcome === "persist-failed") {
        // PERSIST_FAILED 是回执码不是文案——它与 report() 的 receipt.reason 同一个值，
        // 翻译它会让调用方的判等作用失效。
        return { ok: false, error: PERSIST_FAILED, status: 500 };
      }
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
  // oxlint-disable-next-line eslint/no-new -- 见函数文档：构造即注册，返回值无意义
  new LessonRulesService(ctx, deps);
  return true;
}
