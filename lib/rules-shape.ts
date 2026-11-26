// lib/rules-shape.ts —— 规则评审读取接口（Typert Remote）两侧共用的**线上形状**。
//
// 为什么单列：宿主服务与客户端读取器分属两个产物（host.js / client.js），各自内联一份
// lib/。形状放在这个零依赖叶子上，两边引的是同一份声明；写成 `import type` 后对任一
// 产物的字节数贡献都是零。叶子必须**零导入**：客户端类型程序不加载 node 类型
// （tsconfig.client.json 的 `types: []`），一旦从 lib/lesson-store.ts 借类型，整条
// node:fs 依赖链就会被拖进来。
//
// 字段为什么逐枚重述而不 `Omit<RuleCard, "evidence">`：宿主侧 `ruleViewOf` 把 `RuleCard`
// 摊进这些字段时，改名/删字段会在编译期红；若写成 `Record<string, unknown>`，卡片契约
// 与规则库之间就没有任何东西钉着。

/** 宿主服务键 = 客户端线上命名空间（两侧共用的唯一来源）。 */
export const RULES_REMOTE_NAMESPACE = "lessonLoopRules";

/**
 * 本包 bundle 的包名：`$mount` 的 `package` 位与 `plugins.bundle.config` 的槽位 key 都必须
 * 与宿主 bundle 包名**逐字相等**（key 写成条目 id 时插件页永不出卡），descriptor 的 id
 * 前缀也用它。两个 src（client-entry 的 $mount 槽位 / rules-reader 的 descriptor 与
 * codec typeSymbol）从这里取，**源码侧**字面量只有这一份。
 * 但"只有这一份"止于 TypeScript：同一个包名还硬编码在配置与 CI 面——package.json 的
 * name、cordis.patch.yml 的条目 id、.github/workflows/ci.yml 的包名过滤。那几处没法从
 * TS 常量生成，改名/fork 时必须一起手改；漏改只会表现为「贡献挂不上、数据那一栏永远读不到」
 * 或 CI 静默少跑，单靠任何门禁都抓不住。
 */
export const RULES_BUNDLE_PACKAGE = "@jayyuen66/dsh-lesson-loop";

/** 人工动作的取值域（宿主侧的白名单校验；名单本身定义在 lib/rules-remote.ts）。
 *
 *  **六枚，不含 `delete`**：这一位同时是宿主对外服务 `LessonLoopService.ruleAction` 的
 *  动作域（host.ts 的 `RuleActionKind`），把 `delete` 写进来等于让任何拿到该服务的
 *  兄弟插件都能硬删规则卡。彻底删除只经设置卡这条路，见 {@link RuleRemoteActionName}。 */
export type RuleActionName = "arm" | "reject" | "demote" | "archive" | "edit" | "revive";

/** 规则读取接口（Typert Remote，设置卡专用）接受的动作域 = 六枚 + `delete`。
 *
 *  硬删除是不可恢复的（证据一并消失），只留给人工在卡片上两段式确认，不进宿主服务契约。 */
export type RuleRemoteActionName = RuleActionName | "delete";

/** 证据时间线的一页（`ruleDetail` 的载荷）。`nextCursor === null` = 没有更多。 */
export interface RuleDetailReply {
  readonly ok: true;
  readonly id: string;
  readonly evidence: readonly RuleEvidenceView[];
  readonly nextCursor: number | null;
}

/** 证据的单条投影：与 `RuleEvidence` 同形（detail 全量，卡片自己折叠展示）。
 *
 *  字段名必须与 `lib/lesson-store.ts` 的 `RuleEvidence` 逐字相同：`ruleDetail` 把这个
 *  数组原样透传下去，写成 `rawSignature` 编译期照样通过（结构可赋值），但线上那份载荷
 *  永远是 `signature`，按本类型读的消费方恒得 undefined。 */
export interface RuleEvidenceView {
  readonly ts: number;
  readonly source: string;
  readonly detail: string;
  /** 折叠成稳定键之前的原始签名；只在确实发生过折叠时才有值。 */
  readonly signature?: string;
}

/** 证据时间线默认每页条数。
 *
 *  host 的 `config.evidencePageSize` schema（`.min()/.max()/.default()`）与 rules-remote
 *  的 clamp 都从这里取。20/5/100 曾经在三处各写一遍、注释自称同源实则各自独立——调了
 *  区间漏改一处，服务端就会把设置卡允许的值悄悄夹回旧区间。 */
export const EVIDENCE_PAGE_SIZE_DEFAULT = 20;
/** 页大小合法下限（host schema 与规则服务 clamp 共用）。 */
export const EVIDENCE_PAGE_SIZE_MIN = 5;
/** 页大小合法上限（host schema 与规则服务 clamp 共用）。 */
export const EVIDENCE_PAGE_SIZE_MAX = 100;

/** 证据分页入参：`cursor` 是已取到的条数（0/缺省 = 最新一页）。 */
export interface RuleDetailRequest {
  readonly id: string;
  readonly cursor?: number;
}

/** 证据分页的失败回执（400 = 参数不合法或缺 id、404 = 规则不存在、500 = 读面出错）。 */
export interface RuleDetailFailure {
  readonly ok: false;
  readonly error: string;
  readonly status: 400 | 404 | 500;
}

/** 证据分页的完整回执：成功给一页证据，失败给本地化文案。
 *
 *  **客户端必须按这两支读**：宿主的 400/404/500 是**以数据形式**返回的（本包的成功回执
 *  自带 `ok: true`），网关层不会把它折成 rejected——把 `ruleDetail` 的返回类型写成
 *  `RuleDetailReply` 会让失败回执以"成功"resolve，`reply.evidence` 得 undefined，
 *  卡片首屏 `setDetail(undefined)`、加载更多时展开时渲染期抛错。 */
export type RuleDetailReplyOrFailure = RuleDetailReply | RuleDetailFailure;

/** 规则状态在卡片契约里的取值域。 */
export type RuleStatusView = "candidate" | "armed" | "demoted" | "rejected" | "archived";

/** 规则来源。 */
export type RuleOriginView = "threshold" | "lessons-digest" | "manual";

/**
 * 一条规则卡的读取接口投影：证据正文**不在**线上（每条 detail 是整段工具输出，而卡片在轮询），
 * 另加派生态 `undeterminable`——armed 后从没有过一次遵守（suppressed === 0），且要么
 * 已挂满 decayDays、要么复发已达阈值（lib/decay-policy.ts 的裁决）；只在
 * `status === "armed"` 的卡上可能为 true，出现即交人工停用或归档。
 */
export interface RuleView {
  readonly id: string;
  readonly project: string;
  readonly cwd?: string;
  readonly category: string;
  readonly signature: string;
  readonly statement: string;
  readonly status: RuleStatusView;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly armedAt?: number;
  readonly occurrences: number;
  readonly sources: readonly string[];
  readonly violation: number;
  readonly suppressed: number;
  readonly samples: number;
  readonly recurrences: number;
  readonly lastSeenAt?: number;
  readonly lastViolationAt?: number;
  readonly lastSuppressedAt?: number;
  readonly origin: RuleOriginView;
  readonly undeterminable: boolean;
}

/** 一条事件流水的只读投影（零写入）。 */
export interface LessonView {
  readonly ts: number;
  readonly source: string;
  readonly category: string;
  readonly project: string;
  readonly cwd?: string;
  readonly sessionId?: string;
  readonly turn?: number;
  readonly signature: string;
  readonly detail: string;
  // 刻意没有 evidence：读取接口投影（lib/rules-remote.ts 的 lessonViewOf）逐字段写、不外借
  // 原始证据——那里面是整段工具输出。曾经在这里声明过一个可选的 evidence，但没有任何
  // 投影会填它，于是类型上"读取接口带证据"是个假承诺（消费方写 lesson.evidence 编译通过、
  // 运行时恒 undefined）。
}

/** 规则列表的过滤入参；wire 字段名与宿主方法参数名同源（源码模式下网关按签名取参数名）。 */
export interface RulesRequest {
  readonly project?: string;
}

/** 事件流水的过滤入参：`limit` 缺省 / 非正 / 非有限数取默认值 `LESSONS_DEFAULT_LIMIT`
 *  （= 50，见 lib/rules-remote.ts 的 limitOf），正值向下取整后封顶 `LESSONS_MAX_LIMIT`
 *  （= 500）。为什么不给"缺省 = 全量"：事件流水只追加不修剪，全量等于把整份流水（含每条
 *  工具输出的全文）挂在公开命名空间上，载荷随使用时长线性增长。detail 在下发前按读取接口常量
 *  截断（存储侧仍是零截断全量）。 */
export interface LessonsRequest {
  readonly project?: string;
  readonly limit?: number;
}

/**
 * 人工动作的入参。`action` 刻意收 `string` 而不是 {@link RuleActionName}：请求侧保留
 * 「可发送任意串、由宿主白名单拒回 400 并翻译文案」的语义（src/rules-reader.ts 的
 * codec 同样按 string 解析）——拼错的动作名要在**回执**里显形，而不是在客户端编译期
 * 消失成类型错误。白名单的编译期约束由 lib/rules-remote.ts 的 ALLOWED_ACTIONS 动作表给出。
 */
export interface RuleActionRequest {
  readonly id: string;
  readonly action: string;
  readonly statement?: string;
}

/**
 * 读方法（stats / rules / lessons）的**失败**回执。
 *
 * 为什么读取接口也要一条 error 通道：这三个方法各自摸磁盘（`recentLessons` 走 readJsonl）
 * 或摸设置面，抛出去会被网关折成 `gateway/internal: <原文>`——卡片把英文内部错误原样
 * 贴给用户，而这句本该是本包的话（`ruleAction` 的注释早就点名要避免这一形态，读取接口
 * 此前漏了）。折成回执而不是抛，判据与写入一致。
 *
 * `status` 恒 500：读失败是「这次没读到」，不是请求错，重试有意义。
 */
export interface ReadRefused {
  readonly ok: false;
  readonly error: string;
  readonly status: 500;
}

export interface RulesResult {
  readonly ok: true;
  readonly rules: readonly RuleView[];
}

export interface LessonsResult {
  readonly ok: true;
  readonly count: number;
  readonly lessons: readonly LessonView[];
}

/** 读方法的完整回执：成功给数据，失败给本地化文案（见 {@link ReadRefused}）。 */
export type RulesReply = RulesResult | ReadRefused;
export type LessonsReply = LessonsResult | ReadRefused;

export interface RuleActionDone {
  readonly ok: true;
  readonly id: string;
  /** 回显的动作名：宿主白名单校验通过后才返回，必落 {@link RuleRemoteActionName} 取值域
   *  （含设置卡专用的 `delete`）。 */
  readonly action: RuleRemoteActionName;
}

/** 拒绝回执：`status` 保留旧 HTTP 接口的语义码（400/404/500），卡片只读 `error`。
 *  字面量联合把新增/改写状态码钉在编译期。
 *  这里刻意不写"ruleAction 有几处拒绝返回"：那是个会随分支增删漂移的计数，写死在注释里
 *  就必然说谎（这张表建时写的是"五处"，加过 statement-too-long 与 catch 之后实际已不是）。 */
export interface RuleActionRefused {
  readonly ok: false;
  readonly error: string;
  readonly status: 400 | 404 | 500;
}

export type RuleActionReply = RuleActionDone | RuleActionRefused;
