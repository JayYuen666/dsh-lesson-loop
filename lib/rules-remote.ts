// lib/rules-remote.ts —— 设置卡「规则评审」的**宿主读取接口**（官方 Typert Remote）。
//
// 为什么是 Remote：卡片跑在浏览器里，而规则库、事件流水与人工动作都在宿主进程。设置面
// 没有「宿主执行动作」的口子（`ctx.settings` 只有 configure/describe/update/replace/
// mutate），唯一的官方通道就是 Typert Remote —— 官方 `permission-presets` 正是这么把
// 进程级目录交给客户端 UI 的。
//
// 为什么手写 descriptor 而不跑生成器：官方网关在源模式（SRC）下从**方法签名**推出参数名，
// 参数与结果都用 `{ mode: "src-json" }` 编解码；这两样都不需要生成器的 `typeSymbol` /
// `create()` 产物。本服务每个方法都是「一元、JSON 出参」，手写客户端 descriptor 比引入
// 一条构建期代码生成链（外加生成物随包发布）便宜得多。
//
// ⚠ 值导入：`TypertRemoteService` 是个**类**（要 `extends`），没有 type-only 的造法，
// 因此它落 `peerDependencies`（`dependencies` 是禁区，由 test/publish-manifest.test.ts
// 钉着），产物里保持**裸说明符**（build-host.mjs 的外部化名单读 dependencies ∪
// peerDependencies）。
//
// 安全边界不再靠 HTTP 接口那两道校验（CSRF 令牌 + 来源信任检查）：这条读取接口只经官方网关暴露给
// **本 profile 的客户端**，网关自己承担来源校验与鉴权。方法体里的入参白名单（见 ALLOWED_ACTIONS 的动作表）
// 与「id 不在库里就回 404」原样保留——它们护的是动作本身，与传输方式无关。

import type { Context } from "@deepseek-ai/cordis";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { errorText } from "@jayyuen66/dsh-plugin-shared/lib/errors";
import { markRemote } from "@jayyuen66/dsh-plugin-shared/lib/remote-marker";

import type { LessonStore, RuleCard } from "./lesson-store.ts";
import { fill } from "./messages.ts";
import type { LessonLoopMessages } from "./messages.ts";
import {
  EVIDENCE_PAGE_SIZE_DEFAULT,
  EVIDENCE_PAGE_SIZE_MAX,
  EVIDENCE_PAGE_SIZE_MIN,
  RULES_REMOTE_NAMESPACE,
} from "./rules-shape.ts";
import type {
  LessonView,
  LessonsReply,
  LessonsRequest,
  ReadRefused,
  RuleActionName,
  RuleActionReply,
  RuleActionRequest,
  RuleDetailReplyOrFailure,
  RuleDetailRequest,
  RuleEvidenceView,
  RulesReply,
  RulesRequest,
  RuleView,
} from "./rules-shape.ts";

/**
 * 人工动作白名单：`Record<RuleActionName, true>` 由类型联合派生——`RuleActionName`
 * 新增/改名成员而这里漏改，会在编译期红，而不是运行期把合法动作静默判成 400。
 *
 * `delete` 单独补一枚：它属于**规则读取接口**（设置卡）的动作域，不属于宿主对外服务
 * `LessonLoopService.ruleAction` 的六枚——那个契约是兄弟插件的调用面，硬删除不该由
 * 任何拿到服务的插件发起（见 lib/rules-shape.ts 的 RuleRemoteActionName）。
 */
const ALLOWED_ACTIONS: ReadonlySet<string> = new Set(
  Object.keys({
    arm: true,
    reject: true,
    demote: true,
    archive: true,
    edit: true,
    revive: true,
    delete: true,
  } satisfies Record<RuleActionName | "delete", true>),
);

/** 证据时间线的默认每页条数。**唯一来源在 lib/rules-shape.ts**（host 的 config schema
 *  与这里的 clamp 都自它取），本文件不再写第二个字面量。 */
export const DEFAULT_RULE_DETAIL_PAGE_SIZE = EVIDENCE_PAGE_SIZE_DEFAULT;

/** 把设置项夹到合法区间：非数（含 undefined）回落默认，越界**夹取**（0 → 5、500 → 100），
 *  小数取整。
 *
 *  旧注释写的是"未交或越界回落默认"，与实现不符：越界是夹取。写成回落的话，用户把
 *  `evidencePageSize` 调到 500 会被静默改回 20，而卡片上完全看不出来——注释误导会让人
 *  以为这个函数有两档行为，实际只有"非数"那一档才回落。 */
export function clampPageSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_RULE_DETAIL_PAGE_SIZE;
  }
  return Math.min(EVIDENCE_PAGE_SIZE_MAX, Math.max(EVIDENCE_PAGE_SIZE_MIN, Math.trunc(value)));
}

/** 每个读方法的名字：既是日志里的方法名，也是拒读文案的键选择器。 */
type ReadMethodName = "stats" | "rules" | "lessons" | "detail";

/**
 * 读方法 → 消息表键。写成一张受类型约束的表而不是三段 if：新增读方法时漏登记是
 * **编译期**错误（键集由 `satisfies` 钉住），不会静默复用别的文案。
 *
 * `detail` 有自己的一句：它失败时最常见的原因是"库读不懂"（规则库整片解析失败），
 * 与"规则列表这一次没读到"是两件事，共用一句会让卡片把用户指向他没在看的那个面。
 */
const READ_REFUSAL_KEYS = {
  stats: "errStatsUnavailable",
  rules: "errRulesUnavailable",
  lessons: "errLessonsUnavailable",
  detail: "errRuleDetailUnavailable",
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

/** 现取页大小：每次请求都重读设置（改完下一轮翻页即生效，不重启）。写成模块函数而不是
 *  服务方法——原型上的每个自有方法都要带 `@Remote` 标记（方法表对质用例钉着）。 */
function pageSizeOf(deps: LessonRulesDeps): number {
  return clampPageSize(deps.pageSize?.());
}

function isRuleAction(value: unknown): value is RuleActionName {
  return typeof value === "string" && ALLOWED_ACTIONS.has(value);
}

/** 服务真正用到的那几位（`Pick` 掉私有字段后测试替身才能结构化满足它）。 */
export type RulesStore = Pick<
  LessonStore,
  "rules" | "rulesReadable" | "recentLessons" | "ruleAction" | "ruleDetail" | "isUndeterminable"
>;

/** events 流水读取接口的条数规则：缺省/≤0 取默认条数，显式请求封顶——事件流水只追加不
 *  修剪，"缺省 = 全量"会让一次调用把整份流水（含每条工具输出全文）序列化过网关，
 *  载荷随使用时长线性增长；而这枚读取接口挂在公开命名空间上，第三方客户端按默认参数
 *  调用就该拿到有界的载荷。存储侧的零截断承诺不受影响（ lesson-jsonl 层不截断）。 */
const LESSONS_DEFAULT_LIMIT = 50;
const LESSONS_MAX_LIMIT = 500;
/** 单条流水 detail 的下发上限（字符）：detail 是门禁输出/拒绝理由原文，可能含路径、
 *  命令串等敏感内容，下发前定长截断；与规则卡证据的 detail 上限同量级。 */
const MAX_LESSON_DETAIL_CHARS = 400;

/** 证据一页下发正文的字符总预算。
 *
 *  为什么除了页大小还要有字节预算：页大小只管条数，一条证据的 detail 可以是整段工具输出
 *  （SQLite 写路径**不**做 capEvidence，库里确实可能有超长正文），一页 100 条上限拦不住
 *  体积。超出预算时这一页提前收口，`nextCursor` 指到真正发出去的下一条，翻页继续。 */
const MAX_EVIDENCE_PAGE_CHARS = 20_000;
/** 单条证据 detail 的下发上限：与写侧（lib/rules-layout.ts 的 capEvidence）同量级，
 *  避免"库里存量超长正文原样上网线"。 */
const MAX_EVIDENCE_DETAIL_CHARS = 400;

/** 截到 `limit` 个码点（代理对不被切开）：超出时补省略号。
 *  不用 `[...text]` / `Array.from(text)`：展开字符串在 `typescript/no-misused-spread` 眼里是
 *  误用，`Array.from` 又被 `unicorn/prefer-spread` 劝回展开——两条规则对着咬。`for...of`
 *  对字符串同样是按码点迭代，一处都不得罪，也把"截多少"写得更直白。 */
function capChars(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  let sliced = "";
  let taken = 0;
  for (const unit of text) {
    if (taken >= limit) {
      break;
    }
    sliced += unit;
    taken += 1;
  }
  return `${sliced}…`;
}

/** cursor 的合法形状：非负整数。写成模块函数而不是服务方法——原型上的每个自有方法
 *  都必须带 `@Remote` 标记（remoteMethods 的对质用例钉着）。 */
function isUsableCursor(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** 一页证据的投影结果：`consumed` 是真正发出去的条数（相对本页起点），
 *  `truncated` 表示有条目因为字节预算没发出去。 */
interface EvidencePageProjection {
  readonly evidence: readonly RuleEvidenceView[];
  readonly consumed: number;
  readonly truncated: boolean;
}

/**
 * 证据页的读取侧投影：单条 detail 定长截断 + 整页字符预算。
 *
 * 为什么两样都要：写侧 capEvidence 只服务旧 settings-CAS 路径（见 lib/rules-layout.ts），
 * SQLite 写路径是 `JSON.stringify(card)` 直接落库，库里确实可能有超长 detail；只限条数时
 * 一页 100 条仍可能是数 MB，而卡片一次只渲染一屏。预算用尽即收口，`consumed` 交回给
 * 调用方做下一轮的 cursor——不吞条、不静默丢证据。
 */
function projectEvidencePage(evidence: readonly RuleEvidenceView[]): EvidencePageProjection {
  const out: RuleEvidenceView[] = [];
  let used = 0;
  for (const entry of evidence) {
    const detail = capChars(entry.detail, MAX_EVIDENCE_DETAIL_CHARS);
    if (out.length > 0 && used + detail.length > MAX_EVIDENCE_PAGE_CHARS) {
      return { evidence: out, consumed: out.length, truncated: true };
    }
    used += detail.length;
    out.push(detail === entry.detail ? entry : { ...entry, detail });
  }
  return { evidence: out, consumed: out.length, truncated: false };
}

/** 规则评审读取接口的全部依赖。 */
export interface LessonRulesDeps {
  store: RulesStore;
  /** 管理界面快照；`stats()` 把刚读到的规则卡交回来复用（同一次轮询不读两遍规则库）。 */
  stats: (rules: RuleCard[]) => Record<string, unknown>;
  /** 现取一份文案（语言随官方 locale 偏好，改语言不必重载插件）。 */
  messagesOf: () => LessonLoopMessages;
  /** 证据页大小（设置项 `evidencePageSize` 的现取引用；缺省 20）。 */
  pageSize?: () => number;
}

/**
 * 规则卡的读取接口投影：去证据 + 派生的「不可判定」态。
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
 * spread 属性**不做**多余属性检查，RuleCard 将来新增的任何字段（体积大或含敏感内容的
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
 * {@link LESSONS_MAX_LIMIT}。旧 HTTP 接口的 `Number(...)` 那套字符串解析随 query 一起消失；
 * 这里只认数字，因为 descriptor 的 strict codec 已经在客户端把非数字挡在网线之前。
 */
function limitOf(request: unknown): number {
  const raw = isRecord(request) ? request["limit"] : undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return LESSONS_DEFAULT_LIMIT;
  }
  // floor 之后可能是 0（例如合法请求 limit: 0.5）：store 把 limit <= 0 当全量，
  // 那会让小数请求绕过有界载荷防线，所以归一后的下限是 1。
  return Math.max(1, Math.min(Math.floor(raw), LESSONS_MAX_LIMIT));
}

/**
 * 流水记录的**读取接口投影**：detail 定长截断、不外借原始 evidence（它带着工具输出原文，
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
 * 设置卡「规则评审」的读/写方法组。
 *
 * ⚠ 服务在**构造时**注册（cordis `Service` 的契约：`ctx.reflect.provide`，随所属 fiber
 * 卸载自动撤），所以调用方拿实例没有任何用处——装入口 `installRulesRemote` 说明了这一点。
 * 读取接口不依赖任何可选宿主服务：store 与快照取用入口都由 apply 交进来，故它跟着 apply 无条件
 * 上线（旧 HTTP 接口要等 webServer 到位的那个 inject 子 fiber 一并删除）。
 */
export class LessonRulesService extends TypertRemoteService {
  private readonly deps: LessonRulesDeps;

  public constructor(ctx: Context, deps: LessonRulesDeps) {
    super(ctx, RULES_REMOTE_NAMESPACE);
    this.deps = deps;
  }

  /** 卡片轮询的入口：计数 + 配置摘要 + 全量规则投影（证据已去掉）。
   *
   *  失败折成 `{ ok: false, error }` 而不是抛（理由同 {@link ReadRefused}）：这些读
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

  /** 事件流水只读投影（detail 截断、不外借原始 evidence），零写入；条数有默认值与
   *  上限（见 limitOf），detail 是门禁输出/命令串一类的敏感内容，不设界等于把整份流水
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
   * 单卡证据时间线（分页）：`cursor` 是"已拿到的条数"，0/缺省从最新一条开始。
   * 证据不在 `rules()` 的投影里（见 ruleViewOf），这条方法是它唯一的读取口；页大小
   * 取设置项 `evidencePageSize`（默认 20、夹在 5–100）——detail 是整段工具输出的常见
   * 载体，按页取才不至于一次性过网线。
   *
   * **cursor 是偏移量，不是稳定游标**：新证据只追加到尾部（`toReversed()` 之后即页首），
   * 翻页期间若有新的违规/遵守落进同一张卡，已发出的偏移会整体后移一格——用户看到的是重复
   * 一条或漏掉一条。这里刻意不改成 keyset：证据行没有跨页稳定的自然键（`ts` 可重复），而
   * 卡片翻页是一次点击内的短窗口，代价低于另建一套 (ts, seq) 键。判读时记住这条局限：
   * 一次取完（cursor 缺省）不受影响，只有连续翻页才可能漂。
   *
   * 三种失败必须分开（旧实现把它们折成同一句"找不到该规则"）：
   * - 缺 id / id 不是串 → 400（请求本身不成立，重试无用）；
   * - cursor 不是非负整数 → 400（旧实现静默归 0，用户看到的是"莫名回到第一页"）；
   * - 库读不懂（`store.rulesReadable()` 为 false，`rules()` 已折成空数组）→ 500 而不是
   *   404——把读面坏掉说成"规则不存在"，用户会去别处找一张其实还在库里的卡。
   */
  public ruleDetail(request: RuleDetailRequest): RuleDetailReplyOrFailure {
    const messages = this.deps.messagesOf();
    // 非对象先单独收口：写成 `isRecord(request) ? request.id : undefined` 会让下面取 cursor
    // 时再判一次同一个条件，而那一支在 id 已经返回 400 之后永远到不了——那是条不可达分支，
    // 覆盖率闸门会一直红，读代码的人也会以为"非对象但带 cursor"这种请求真存在。
    if (!isRecord(request)) {
      return { ok: false, error: messages.errRuleIdRequired, status: 400 };
    }
    const { cursor: cursorRaw, id } = request;
    if (typeof id !== "string" || id === "") {
      return { ok: false, error: messages.errRuleIdRequired, status: 400 };
    }
    if (cursorRaw !== undefined && !isUsableCursor(cursorRaw)) {
      return { ok: false, error: messages.errRuleCursorInvalid, status: 400 };
    }
    try {
      const page = this.deps.store.ruleDetail(id, cursorRaw ?? 0, pageSizeOf(this.deps));
      if (page === null) {
        // 读面不可信时 `rules()` 退空数组，`ruleDetail` 因此也交 null：这一支是"读不到"，
        // 不是"没有"，必须与真不存在分开。
        return this.deps.store.rulesReadable()
          ? { ok: false, error: messages.errRuleNotFound, status: 404 }
          : { ok: false, error: messages.errRuleDetailUnavailable, status: 500 };
      }
      const projected = projectEvidencePage(page.evidence);
      return {
        ok: true,
        id,
        evidence: projected.evidence,
        nextCursor: projected.truncated ? (cursorRaw ?? 0) + projected.consumed : page.nextCursor,
      };
    } catch (error) {
      return refuseRead(messages, "detail", error);
    }
  }

  /**
   * 人工动作：入参白名单 → 落库并按结果定语义码。
   *
   * 失败一律折成 `{ ok: false, status }` 而不是抛：网关的异常分支只交出
   * `gateway/internal` 那句英文，卡片会把它原样贴给用户；这里保留旧 HTTP 接口那批
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
      if (outcome === "invalid-status") {
        // 彻底删除只对已归档/已拒绝的卡开放：库未动，回 400 并点名原因。
        return { ok: false, error: messages.errRuleDeleteNotAllowed, status: 400 };
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

// 标记实现收口在 shared 的 ./lib/remote-marker（0.2.5 起）：本仓不再维护一份程序化
// 装饰器副本，调用形状与官方 @Remote 逐位等价（TC39 形状说明见该模块）。
markRemote(LessonRulesService.prototype, "stats");
markRemote(LessonRulesService.prototype, "rules");
markRemote(LessonRulesService.prototype, "lessons");
markRemote(LessonRulesService.prototype, "ruleAction");
markRemote(LessonRulesService.prototype, "ruleDetail");

/**
 * 把读取接口装到这个上下文上（构造即注册，见类文档；host 侧唯一该调的口）。
 *
 * 为什么是一枚函数而不是让调用方直接 `new`：这枚 `new` 的**全部意义在构造期的注册副作用**
 * 上——实例由 cordis 的 fiber 持有（`Service` 基类把 `reflect.provide` 的 disposer 挂给
 * fiber），调用方拿到它没有任何用处。
 *
 * 注册口先探一次（`ctx.reflect.provide`）：替身/畸形上下文未必给，少了它只该少掉卡片
 * 这一栏，绝不该让 apply 当场炸掉。本服务没有自己的收尾资源——卸载由 Service 基类登记的
 * 反射这一步的 disposer 负责，不另挂 effect。
 *
 * @param ctx - 宿主上下文
 * @param deps - 规则读取接口的全部依赖（见 LessonRulesDeps）
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
