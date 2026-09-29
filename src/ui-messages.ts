// src/ui-messages.ts —— 规则评审卡 UI 文案字典（中英双语）。
//
// 键集一致由 tsc 保证：zh / en 两份都标注同一个 UiMessages 接口，少键多键在编译期红。
// 注册与取值走官方 @deepseek-ai/dsh-client-locale 的**类型化**那两条重载：
// `ctx.locale.register(ns, dicts)`（两语一次交齐）+ `ctx.locale.bind(ns)`，语言切换由宿主
// 驱动、无需重载页面（见 client-entry.ts 的 apply）。本包命名空间已 merge 进官方
// `LocaleNamespaceMap`（下面那条 `declare module`），故键集与 `t` 的函数面都由官方
// 表达式交出。
// 插值不放进字典（官方字典是扁平字符串表）：带变量的整行由调用点用固定模板 + 本表片段拼。
//
// **这里只有卡片自己的文案**：规则卡的 `statement` / `category` / `signature` / `project`
// 与端点回传的 error 串都是数据（规则库——`lesson-loop` 命名空间里那枚 `.volatile()` 的
// `rules` 字段——里的用户数据、host 侧回执），
// 卡片照原样显示，绝不查表、也绝不因界面语言改写。
import type { TranslateNS as OfficialTranslateNS } from "@deepseek-ai/dsh-client-ui-slots";
import type { MessagesCatalog } from "@jayyuen666/dsh-plugin-shared/lib/locale";

/** 本包设置卡产出的全部界面文案。 */
export interface UiMessages {
  /** 卡片标题（设置页插件列表里的那一行）。 */
  readonly cardTitle: string;
  /** 卡片副标题：一句话说明本包做什么 + 实时计数。 */
  readonly cardDescription: string;
  /** 作用域只读（非 loopback 页面）时的状态条文本。 */
  readonly statusReadOnly: string;
  /** 有未保存改动时的状态条文本。 */
  readonly statusDirty: string;
  /** 无未保存改动时的状态条文本。 */
  readonly statusClean: string;
  /** 保存按钮（空闲态）。 */
  readonly save: string;
  /** 保存按钮（写入中）。 */
  readonly saving: string;
  /** 撤销按钮。 */
  readonly revert: string;
  /** 保存失败前缀（后接错误摘要）。 */
  readonly saveFailed: string;
  /** stats 端点回非 ok 且没带 error 时的兜底。 */
  readonly statsUnavailable: string;
  /** 规则动作失败且端点没带 error 时的兜底。 */
  readonly actionFailed: string;

  // ── 运行时配置行（settings 命名空间 `lesson-loop` 的开关与阈值）────────
  readonly enabledLabel: string;
  readonly enabledHint: string;
  readonly reportEnabledLabel: string;
  readonly reportEnabledHint: string;
  readonly injectEnabledLabel: string;
  readonly injectEnabledHint: string;
  readonly sectionEnabledLabel: string;
  readonly sectionEnabledHint: string;
  readonly promoteThresholdLabel: string;
  readonly promoteThresholdHint: string;
  readonly demoteThresholdLabel: string;
  readonly demoteThresholdHint: string;
  readonly demoteMinSamplesLabel: string;
  readonly demoteMinSamplesHint: string;
  readonly demoteRatioLabel: string;
  readonly demoteRatioHint: string;
  readonly reviveThresholdLabel: string;
  readonly reviveThresholdHint: string;
  readonly decayDaysLabel: string;
  readonly decayDaysHint: string;
  readonly maxLessonsBytesLabel: string;
  readonly maxLessonsBytesHint: string;

  // ── 规则评审区 ────────────────────────────────────────────────────────
  /** 分节标题模板（{title} + {count}，中/英的全角半角括号由字典自己定）。 */
  readonly sectionHeading: string;
  readonly sectionCandidates: string;
  readonly sectionDemoted: string;
  readonly sectionArmed: string;
  readonly sectionRetired: string;
  /** 展开「已拒绝/归档」的按钮。 */
  readonly showRetired: string;
  /** 分组为空时的占位。 */
  readonly emptyGroup: string;
  /** 观察次数 + 建卡日期（{count} {day}）。 */
  readonly metaObservations: string;
  /** armed 的三计数（{violation} {suppressed} {samples}）。 */
  readonly metaArmed: string;
  /** armed 够久却零复发零遵守：机器无从裁定，交人处理。 */
  readonly metaUndeterminable: string;
  /** rejected 后又出现的计数（{count}）。 */
  readonly metaRevive: string;
  /** 该卡由 /lessons-digest 蒸馏而来。 */
  readonly metaFromDigest: string;

  // ── 人工动作按钮 ──────────────────────────────────────────────────────
  readonly btnDemote: string;
  readonly btnArchive: string;
  readonly btnArmConfirm: string;
  readonly btnArmConfirmEditing: string;
  readonly btnReject: string;
  readonly btnDismiss: string;
  readonly btnRevive: string;

  /** 卡片底部：怎么蒸馏新规则。 */
  readonly digestHint: string;
}

/**
 * 本包的文案命名空间 merge 进官方的 `LocaleNamespaceMap`（installed
 * `dsh-client-ui-slots/lib/types/index.d.ts:23-30`「Dictionary owners extend via declaration
 * merging (exactly like SlotMap)」）。这不是可选的美化：不 merge 时 `ctx.locale.bind(NS)`
 * 只能落到官方那条**未类型化**重载（installed
 * `dsh-client-locale/lib/types/client/index.d.ts:226`），返回 `Translate<string>`，而卡片
 * 要的是键集收窄的 `t`，于是本地只好自己声明一个官方给不出的函数形状。
 * 把键收窄的 `t` 投影回官方服务面 `LocaleRuntime['bind']`（那条未类型化重载跟着进目标
 * 类型）时，本包程序里实测到的红字：
 *   TS2322 Type '(ns: string) => Translate' is not assignable to type
 *     '{ <N extends Extract<keyof LocaleNamespaceMap, string>>(ns: N): TranslateNS<N>;
 *        (ns: string): Translate; }'.
 *     … Type 'string' is not assignable to type 'LocaleKeysOf<"lesson-loop">'.
 * 即：**没有任何单一实现能同时满足官方那两条重载**，所以 ClientCtx.locale 只能投影
 * 类型化那一条。merge 之后键集由官方 `TranslateNS<NS>` 表达，`t("拼错的键")` 在编译期红，
 * register 也走官方类型化那条（同文件 :199，字典参数 `Record<BuiltInLocaleId,
 * LocaleDictOf<N>>`）。
 * ⚠ 表键必须是字面量（interface 键位不接受计算属性），故下面的等式常量把它与
 * client-entry.ts 的 `NS` 钉在编译期：两边哪天分叉，那一位就红。
 * ⚠ `UiMessages` 仍是 `interface`（lint 的 `consistent-type-definitions` 禁 `type` 对象
 * 字面量），这不妨碍走有限键映射：`LocaleDictOf<N>` 展开成 `Record<本包键, string>` 这一
 * **有限**映射，而不是官方的扁平 `LocaleDict = Record<string, string>`（interface 拿不到
 * 隐式索引签名，实测 `Index signature for type 'string' is missing in type 'UiMessages'`
 * 只在往扁平那条上塞时出现）。于是「少一门语言」「多一个键」都在编译期红。
 */
declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    /** 本包规则评审卡的全部界面文案键（= client-entry.ts 的 `NS`）。 */
    "lesson-loop": keyof UiMessages;
  }
}

/** 编译期契约：merge 里写死的命名空间键（`Translate` 用它取 `TranslateNS`）与卡片注册
 *  用的 `NS` 必须是同一个串——改任何一处都要动这一行才会红。 */
const LOCALE_NS_KEY = "lesson-loop" as const;

/**
 * 本源只以**类型**形态对外流通：`client-entry.ts` 的 `const NS: LocaleNs = "lesson-loop"` 把条目
 * id 钉在本源上（分叉即编译期红），而产物漂移针仍要按字面量形状从 bundle 里抓 `NS`，所以那里
 * 保留字面量、只加类型标注——值导出不必存在（用例侧同理：要断言运行时那串就写字面量）。
 */
export type LocaleNs = typeof LOCALE_NS_KEY;

/**
 * 卡片取文案的函数形状：官方 `TranslateNS<N>`（installed `dsh-client-ui-slots/lib/types/
 * index.d.ts:67` `= Translate<LocaleKeysOf<N>>`，而 `Translate<K> = (key: K, params?) =>
 * string`，同文件 :45）——键集就是上面 merge 的 `keyof UiMessages`（外加官方 `common`
 * 命名空间的共享词表：`LocaleKeysOf` 的查找链在本包 miss 之后会 consult 它），函数面完全
 * 归官方，本地不再声明。
 */
export type Translate = OfficialTranslateNS<typeof LOCALE_NS_KEY>;

export const UI_MESSAGES: MessagesCatalog<UiMessages> = {
  zh: {
    cardTitle: "lesson-loop 自进化环",
    cardDescription: "教训总线 + 规则评审（候选 {candidates} · 生效 {armed} · 教训 {lessons} 条）",
    statusReadOnly: "当前作用域只读",
    statusDirty: "有未保存的修改，点「保存」生效",
    statusClean: "无未保存的修改",
    save: "保存",
    saving: "保存中…",
    revert: "撤销",
    saveFailed: "保存失败：",
    statsUnavailable: "stats 不可用",
    actionFailed: "操作失败",

    enabledLabel: "启用闭环",
    enabledHint: "关闭后上报被丢弃、不注入、常驻段与 /lessons-digest 一并停用",
    reportEnabledLabel: "教训落盘",
    reportEnabledHint:
      "danger-guard / quality-gate / session-rescue 的失败事件写入 cache/lesson-loop/events.jsonl 并归并规则卡",
    injectEnabledLabel: "会话开始注入规则",
    injectEnabledHint: "agent/session-start 按项目注入 armed 规则全文（agent.inject，不唤醒）",
    sectionEnabledLabel: "常驻系统提示段",
    sectionEnabledHint: "systemPrompt 固定段：告知模型闭环存在与守卫拒绝的正确应对",
    promoteThresholdLabel: "候选升格门槛（次）",
    promoteThresholdHint: "同 (项目,分类,签名) 教训达此次数 → 候选卡标记待确认（1-20，默认 3）",
    demoteThresholdLabel: "复发降级门槛（次）",
    demoteThresholdHint: "armed 后复发达此次数且复发率达标 → 自动降级待人审（1-50，默认 3）",
    demoteMinSamplesLabel: "降级最小证据样本（个）",
    demoteMinSamplesHint:
      "降级判定所需的最小真实证据数 violation+suppressed（暴露 samples 不计入；1-100，默认 5；不足不降级）",
    demoteRatioLabel: "降级复发率",
    demoteRatioHint:
      "violation/(violation+suppressed) ≥ 此值 且真实证据足 → 自动降级（0.05-1，默认 0.5）",
    reviveThresholdLabel: "拒绝后复活门槛（次）",
    reviveThresholdHint:
      "rejected 规则同签名再次出现在此次数 → 自动转回候选待人工重审（1-20，默认 3）",
    decayDaysLabel: "不可判定阈值（天）",
    decayDaysHint:
      "armed 超此天数却既无复发也无一次遵守（从没被测到）→ 卡片标记「不可判定」交人工停用/归档（不再自动归档）（1-365，默认 30）",
    maxLessonsBytesLabel: "events.jsonl 磁盘保险丝（字节）",
    maxLessonsBytesHint: "0 = 不设上限（默认，内容零截断）；仅在磁盘需要保护时设置",

    sectionHeading: "{title}（{count}）",
    sectionCandidates: "待确认候选（人工升格）",
    sectionDemoted: "降级待审",
    sectionArmed: "生效中的规则（复发/遵守/暴露 实时度量；不可判定者请人工处理）",
    sectionRetired: "已拒绝/归档",
    showRetired: "收起已拒绝/归档",
    emptyGroup: "暂无",
    metaObservations: "观察 {count} 次 · {day}",
    metaArmed: "复发 {violation} / 遵守 {suppressed} / 暴露 {samples}",
    metaUndeterminable: "不可判定：armed 至今既无复发也无一次遵守，机器无从裁定，请人工停用或归档",
    metaRevive: "拒绝后又出现 {count} 次（达阈值自动回候选）",
    metaFromDigest: "来自 /lessons-digest",

    btnDemote: "停用待审",
    btnArchive: "归档",
    btnArmConfirm: "确认生效",
    btnArmConfirmEditing: "确认生效（使用下方文本）",
    btnReject: "拒绝",
    btnDismiss: "不采纳",
    btnRevive: "重新候选",

    digestHint: "蒸馏新规则：会话内运行 /lessons-digest（把本会话人工差评归纳为候选规则）。",
  },
  en: {
    cardTitle: "lesson-loop self-evolution loop",
    cardDescription:
      "Lesson bus + rule review ({candidates} candidates · {armed} armed · {lessons} lessons)",
    statusReadOnly: "This scope is read-only",
    statusDirty: "Unsaved changes — press Save to apply",
    statusClean: "No unsaved changes",
    save: "Save",
    saving: "Saving…",
    revert: "Revert",
    saveFailed: "save failed: ",
    statsUnavailable: "stats unavailable",
    actionFailed: "action failed",

    enabledLabel: "Enable the loop",
    enabledHint:
      "When off: reports are dropped, nothing is injected, the standing prompt section and /lessons-digest are both disabled",
    reportEnabledLabel: "Persist lessons",
    reportEnabledHint:
      "Failure events from danger-guard / quality-gate / session-rescue are written into cache/lesson-loop/events.jsonl and merged into rule cards",
    injectEnabledLabel: "Inject rules at session start",
    injectEnabledHint:
      "agent/session-start injects full armed rules per project (agent.inject, without waking the driver)",
    sectionEnabledLabel: "Standing system prompt section",
    sectionEnabledHint:
      "Fixed systemPrompt section: tells the model the loop exists and how to react to guard denials",
    promoteThresholdLabel: "Promotion threshold (times)",
    promoteThresholdHint:
      "Lessons with the same (project, category, signature) reaching this count mark the candidate card as pending review (1-20, default 3)",
    demoteThresholdLabel: "Demotion threshold (times)",
    demoteThresholdHint:
      "After arming, this many violations plus a qualifying recurrence rate demotes the rule for human review (1-50, default 3)",
    demoteMinSamplesLabel: "Minimum evidence samples for demotion",
    demoteMinSamplesHint:
      "Smallest amount of real evidence violation+suppressed required to demote (exposure samples never count; 1-100, default 5; below it never demote)",
    demoteRatioLabel: "Demotion recurrence ratio",
    demoteRatioHint:
      "violation/(violation+suppressed) ≥ this value with enough real evidence demotes automatically (0.05-1, default 0.5)",
    reviveThresholdLabel: "Revive threshold after rejection (times)",
    reviveThresholdHint:
      "A rejected rule whose signature reappears this many times goes back to candidates for human re-review (1-20, default 3)",
    decayDaysLabel: "Undeterminable threshold (days)",
    decayDaysHint:
      "Armed longer than this with neither a violation nor a single follow-through marks the card as undeterminable for a human to disable/archive (no more silent archiving) (1-365, default 30)",
    maxLessonsBytesLabel: "events.jsonl disk fuse (bytes)",
    maxLessonsBytesHint:
      "0 = no cap (default, content never truncated); set only to protect the disk",

    sectionHeading: "{title} ({count})",
    sectionCandidates: "Pending candidates (human promotion)",
    sectionDemoted: "Demoted, awaiting review",
    sectionArmed:
      "Armed rules (live violation/followed/exposure metrics; handle undeterminable ones by hand)",
    sectionRetired: "Rejected / archived",
    showRetired: "Hide rejected / archived",
    emptyGroup: "none",
    metaObservations: "{count} observations · {day}",
    metaArmed: "{violation} violations / {suppressed} followed / {samples} exposed",
    metaUndeterminable:
      "Undeterminable: armed this long with neither a violation nor a single follow-through — no way for the machine to judge, please disable or archive it",
    metaRevive:
      "Reappeared {count} time(s) after rejection (returns to candidates at the threshold)",
    metaFromDigest: "from /lessons-digest",

    btnDemote: "Demote for review",
    btnArchive: "Archive",
    btnArmConfirm: "Confirm and arm",
    btnArmConfirmEditing: "Confirm and arm (text below)",
    btnReject: "Reject",
    btnDismiss: "Dismiss",
    btnRevive: "Back to candidates",

    digestHint:
      "To distil new rules: run /lessons-digest inside a session (it turns this session's negative feedback into candidate rules).",
  },
};
