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

/** 人工动作的取值域（宿主白名单；白名单本身在 lib/rules-remote.ts）。 */
export type RuleActionName = "arm" | "reject" | "demote" | "archive" | "edit" | "revive";

/** 规则状态在卡片契约里的取值域。 */
export type RuleStatusView = "candidate" | "armed" | "demoted" | "rejected" | "archived";

/** 规则来源。 */
export type RuleOriginView = "threshold" | "lessons-digest" | "manual";

/**
 * 一条规则卡的读面投影：证据正文**不在**线上（每条 detail 是整段工具输出，而卡片在轮询），
 * 另加派生态 `undeterminable`（armed 够久却零复发零遵守，机器无从裁定，等人处理）。
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

/** 事件流水的过滤入参；`limit` ≤ 0 / 缺省 = 全量（内容零截断）。 */
export interface LessonsRequest {
  readonly project?: string;
  readonly limit?: number;
}

/** 人工动作的入参。 */
export interface RuleActionRequest {
  readonly id: string;
  readonly action: string;
  readonly statement?: string;
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

export interface RuleActionDone {
  readonly ok: true;
  readonly id: string;
  readonly action: string;
}

/** 拒绝回执：`status` 保留旧 HTTP 面的语义码（400/404/500），卡片只读 `error`。 */
export interface RuleActionRefused {
  readonly ok: false;
  readonly error: string;
  readonly status: number;
}

export type RuleActionReply = RuleActionDone | RuleActionRefused;
