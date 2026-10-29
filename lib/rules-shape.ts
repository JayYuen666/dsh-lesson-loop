// lib/rules-shape.ts —— 规则评审读面（Typert Remote）两侧共用的**线上形状**。
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
 * codec typeSymbol）从这里取，字面量只有这一份——改名/fork 时漏改一处只会表现为
 * 「贡献挂不上、数据面永远读不到」，单靠门禁抓不住。
 */
export const RULES_BUNDLE_PACKAGE = "@jayyuen66/dsh-lesson-loop";

/** 人工动作的取值域（宿主白名单；白名单本身在 lib/rules-remote.ts）。 */
export type RuleActionName = "arm" | "reject" | "demote" | "archive" | "edit" | "revive";

/** 规则状态在卡片契约里的取值域。 */
export type RuleStatusView = "candidate" | "armed" | "demoted" | "rejected" | "archived";

/** 规则来源。 */
export type RuleOriginView = "threshold" | "lessons-digest" | "manual";

/**
 * 一条规则卡的读面投影：证据正文**不在**线上（每条 detail 是整段工具输出，而卡片在轮询），
 * 另加派生态 `undeterminable`——armed 后从没有过一次遵守（suppressed === 0），且要么
 * 已挂满 decayDays、要么复发已达门槛（lib/decay-policy.ts 的裁决）；只在
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

/** 一条事件流水的只读投影（零写面）。 */
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
  readonly evidence?: Readonly<Record<string, unknown>>;
}

/** 规则列表的过滤入参；wire 字段名与宿主方法参数名同源（源码模式下网关按签名取参数名）。 */
export interface RulesRequest {
  readonly project?: string;
}

/** 事件流水的过滤入参：`limit` 缺省 / ≤ 0 取默认条数、非零值封顶——事件流水只追加
 *  不修剪，"缺省 = 全量"等于把整份流水（含每条工具输出的全文）挂在公开命名空间上，
 *  载荷随使用时长线性增长。detail 在下发前按读面常量截断（存储侧仍是零截断全量）。 */
export interface LessonsRequest {
  readonly project?: string;
  readonly limit?: number;
}

/**
 * 人工动作的入参。`action` 刻意收 `string` 而不是 {@link RuleActionName}：请求侧保留
 * 「可发送任意串、由宿主白名单拒回 400 并翻译文案」的语义（src/rules-reader.ts 的
 * codec 同样按 string 解析）——拼错的动作名要在**回执**里显形，而不是在客户端编译期
 * 消失成类型错误。白名单的编译期约束住在 lib/rules-remote.ts 的动作表上。
 */
export interface RuleActionRequest {
  readonly id: string;
  readonly action: string;
  readonly statement?: string;
}

/**
 * 读方法（stats / rules / lessons）的**失败**回执。
 *
 * 为什么读面也要一条 error 通道：这三个方法各自摸磁盘（`recentLessons` 走 readJsonl）
 * 或摸设置面，抛出去会被网关折成 `gateway/internal: <原文>`——卡片把英文内部错误原样
 * 贴给用户，而这句本该是本包的话（`ruleAction` 的注释早就点名要避免这一形态，读面
 * 此前漏了）。折成回执而不是抛，判据与写面一致。
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
  /** 回显的动作名：宿主白名单校验通过后才返回，必落 {@link RuleActionName} 取值域。 */
  readonly action: RuleActionName;
}

/** 拒绝回执：`status` 保留旧 HTTP 面的语义码（400/404/500），卡片只读 `error`。
 *  字面量联合把新增/改写状态码钉在编译期。
 *  这里刻意不写"ruleAction 有几处拒绝返回"：那是个会随分支增删漂移的计数，写死在注释里
 *  就必然说谎（这张表建时写的是"五处"，加过 statement-too-long 与 catch 之后实际已不是）。 */
export interface RuleActionRefused {
  readonly ok: false;
  readonly error: string;
  readonly status: 400 | 404 | 500;
}

export type RuleActionReply = RuleActionDone | RuleActionRefused;
