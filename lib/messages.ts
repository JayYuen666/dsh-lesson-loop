// lib/messages.ts —— host 半文案字典（中英双语）。
//
// 只管 host 半：规则评审卡的 UI 文案走官方 @deepseek-ai/dsh-client-locale 类型化那两条
// 重载（client 侧 `ctx.locale.register(ns, dicts)` 一次交齐两语 + `bind`/`t`，见
// src/client-entry.ts）。
// host 侧没有官方 i18n 面，注入给模型的常驻段/规则摘要帧与命令回显只能自带字典；
// 语言取官方 settings 的 `locale.preference`（shared 的 resolveLocalePreference），未注册即中文。
//
// 键集一致由 tsc 保证：zh / en 两份都标注同一个 Messages 类型，少键多键都在编译期红。
//
// **已落库的规则卡正文不在本表里**：设置段 `lesson-loop` 的 `rules` 里那些 `statement`
// （人工改写过的、蒸馏出来的、旧版本起草出来的）是一份用户数据，落盘后还要注入回模型，
// 跟着界面语言切换会把已生效规则改写成另一种语言——本表从不碰它们。
// 但**起草新卡的那批模板是本包自己产出的文案**：`lib/lesson-store.ts` 的 draftStatement
// 在运行时按分类起草 `statement` 正文，正文随即回注给模型，故与常驻段/注入帧同属
// 「注入给模型的文案」，必须双语（收在本表的 statement* 段）。用户的 locale 是 en 时，
// 新起草的规则卡正文没有理由是中文。模板里的 signature 与 category 取值域仍是**数据**
// （同 digest.ts 的处理：键名与枚举面留在原文件，只把说明文字进字典）。
// console.* 的日志文案也不在此列——那是给排障的人看的，不随界面语言切换。
import type { MessagesCatalog } from "@jayyuen666/dsh-plugin-shared/lib/locale";

/** 字典模板的插值参数（数值由调用点现算，字典只收整行模板）。 */
export type MessageParams = Readonly<Record<string, string | number>>;

/** 本包 host 侧产出的全部人读文案。 */
export interface LessonLoopMessages {
  // ── 常驻 systemPrompt 段 ────────────────────────────────────────────────
  /** 闭环存在感段全文（项目无关，注入模型）。 */
  readonly sectionText: string;

  // ── 会话开始注入的 armed 规则摘要帧（agent.inject）─────────────────────
  /** 摘要帧抬头。 */
  readonly digestHeading: string;
  /** 摘要帧的单条规则行（{index} {statement} {day} {metrics}）。 */
  readonly digestRuleLine: string;
  /** armed 后的度量尾巴（{violation} {suppressed} {samples}）。 */
  readonly armedMetrics: string;
  /** armed 但有暴露无触发时的尾巴（{samples}）。 */
  readonly armedNoTrigger: string;

  // ── 规则状态标签与摘要行（describeRule）────────────────────────────────
  readonly statusCandidate: string;
  readonly statusArmed: string;
  readonly statusDemoted: string;
  readonly statusRejected: string;
  readonly statusArchived: string;
  /** 规则摘要行（{label} {statement} {category} {signature} {occurrences} {metrics}）。 */
  readonly ruleSummary: string;
  /** 摘要行里 armed 才有的度量尾巴（{violation} {suppressed} {samples}）。 */
  readonly ruleSummaryArmed: string;

  // ── 新起草规则卡的正文模板（draftStatement，起草即回注给模型）───────────
  // 模板里的 `{signature}` 是本包自己嵌的占位（数据原文），路径/命令原样落进去。
  // feedback-digest 分类不在这里：它的 signature 就是模型产出的正文，属数据，原样透传。
  /** factgate-deny 折叠到类别级稳定签名后的通用正文（无占位）。 */
  readonly statementFactgateStable: string;
  /** factgate-deny 的 rejected 汇总容器正文（{signature}）。 */
  readonly statementFactgateRejected: string;
  /** factgate-deny 未折叠（表外类别同形态）签名的正文（{signature}）。 */
  readonly statementFactgatePath: string;
  /** dangerous-bash 正文（{signature} 是危险 shell 形态）。 */
  readonly statementDangerousBash: string;
  /** secret-path 折叠到类别级稳定签名后的通用正文（无占位）。 */
  readonly statementSecretPathStable: string;
  /** secret-path 未折叠签名的正文（{signature} 是具体凭据路径）。 */
  readonly statementSecretPathTarget: string;
  /** gate-failure 正文（{signature} 是门禁命令）。 */
  readonly statementGateFailure: string;
  /** transient-failure 正文（{signature} 是失败的命令/服务名）。 */
  readonly statementTransientFailure: string;
  /** max-tokens 正文（无占位）。 */
  readonly statementMaxTokens: string;
  /** unfinished-turn 正文（无占位）。 */
  readonly statementUnfinishedTurn: string;
  /** 未登记分类的兜底正文（{signature}）。 */
  readonly statementGeneric: string;

  // ── /lessons-digest：进模型的蒸馏提示 ─────────────────────────────────
  /** 蒸馏 system 提示（输出契约的 JSON 行由 digest.ts 拼在本表片段之间）。 */
  readonly digestSystemRole: string;
  readonly digestSystemShape: string;
  /**
   * 输出契约行里两处 `<>` 占位的**说明文字**（模型读的人话）。
   * 键名与 category 取值域那一串枚举是**数据**，留在 lib/digest.ts 里不翻译——
   * 它是 `lesson-loop` 段里 rules 的归类键面，跟着界面语言改一次就等于改一次存储契约。
   */
  readonly digestSystemShapeSignature: string;
  readonly digestSystemShapeStatement: string;
  readonly digestSystemRules: string;
  /** 「本会话人工差评」分节标题。 */
  readonly digestSectionFeedback: string;
  /** 「该项目历史教训」分节标题。 */
  readonly digestSectionBackground: string;
  /** 「用户附加说明」分节标题。 */
  readonly digestSectionExtra: string;
  /** 本会话没有差评时的占位行。 */
  readonly digestNoFeedback: string;
  /** 消息差评条目的范围标记。 */
  readonly digestScopeMessage: string;
  /** 会话备注条目的范围标记。 */
  readonly digestScopeSession: string;
  /** 差评条目的分类后缀（{category}）。 */
  readonly digestCategorySuffix: string;
  /** 该项目无历史教训时的背景占位。 */
  readonly lessonsNoHistory: string;

  // ── /lessons-digest：命令回显 ─────────────────────────────────────────
  readonly digestCommandDescription: string;
  readonly digestInputHint: string;
  readonly digestRejectedDisabled: string;
  readonly digestRejectedNoSession: string;
  readonly digestRejectedNoLlm: string;
  /** 分析完但没归纳出新规则（{count} = 差评条数）。 */
  readonly digestNoNewRules: string;
  /** 蒸馏成功回执（{count} 条数、{lines} 已拼好的条目清单）。 */
  readonly digestCreated: string;
  /** 回执里的单条候选规则行（{index} {category} {statement}）。 */
  readonly digestCreatedLine: string;
  /** 蒸馏抛错回显（{reason} = 错误摘要）。 */
  readonly digestFailed: string;

  // ── 蒸馏管线自身的失败原因（经命令回显给人看）─────────────────────────
  readonly errNoModelSelection: string;
  readonly errMissingFinishChunk: string;
  /** 非 stop 收尾（{kind} 结束原因、{failure} 失败摘要前缀）。 */
  readonly errIncompleteFinish: string;
  readonly errEmptyDigest: string;

  // ── 端点里回显给人的 error（卡片直接显示这些串）────────────────────────
  readonly errInvalidJsonBody: string;
  readonly errIdAndActionRequired: string;
  /** 白名单外的动作（{action} 原样回显，便于定位是谁发的）。 */
  readonly errUnknownAction: string;
  readonly errRuleNotFound: string;
  readonly errRuleActionFailed: string;
}

/**
 * host 半的整行模板插值：`{name}` 取参数，取不到的占位符**原样留着**
 * （少传一个参数是编程错误，不该让文案里凭空多出空白；官方 client locale 同语义）。
 * @param template - 字典里的整行模板。
 * @param params - 占位符对应的值。
 * @returns 插值完成的文本。
 */
export function fill(template: string, params: MessageParams): string {
  return template.replaceAll(/\{(?<name>\w+)\}/gu, (matched: string, name: string): string => {
    const value = params[name];
    return value === undefined ? matched : String(value);
  });
}

export const MESSAGES: MessagesCatalog<LessonLoopMessages> = {
  zh: {
    sectionText: [
      "## lesson-loop 自进化环",
      "本环境运行教训闭环：危险操作拦截、门禁失败、异常续跑、人工差评等事件会自动沉淀为项目教训，达到阈值的教训蒸馏为候选规则，经用户在设置卡确认后成为经验规则（armed），并在会话开始注入。",
      "- 被守卫拒绝时：按拒绝信息补齐证据后重试，不要换措辞绕过；拒绝本身是可学习信号。",
      '- 会话开始若注入了"经验规则"，视为高优先级约束，执行中主动遵守。',
      "- 用户可用 /lessons-digest 把本会话人工差评即时蒸馏为教训。",
    ].join("\n"),

    digestHeading:
      "[lesson-loop] 本项目经验规则（人工确认生效；执行中请主动遵守，违反会被度量统计）：",
    digestRuleLine: "{index}. {statement}（{day} 生效{metrics}）",
    armedMetrics: "，armed 后复发 {violation} 次 / 被遵守 {suppressed} 次 / 暴露 {samples} 次",
    armedNoTrigger: "，armed 后在场 {samples} 次会话但未触发（尚无可判定证据）",

    statusCandidate: "待确认",
    statusArmed: "生效中",
    statusDemoted: "已降级待人审",
    statusRejected: "已拒绝",
    statusArchived: "已归档",
    ruleSummary:
      "[{label}]{statement}（{category} · {signature} · 观察 {occurrences} 次{metrics}）",
    ruleSummaryArmed: " · 复发 {violation} / 被遵守 {suppressed} / 暴露 {samples}",

    statementFactgateStable:
      "编辑文件之前，必须先成功 read 该文件，并做项目级引用检索（grep/glob/zg_search 覆盖引用面）确认改动波及面（调用方/依赖方/测试），再动手。",
    statementFactgateRejected:
      "已拒绝的历史路径碎片归档汇总（{signature}）：编辑文件前先取证的要求由上方生效规则承载；本条仅保留拒绝记录与证据，不注入、不度量。",
    statementFactgatePath:
      "编辑 {signature} 之前，必须先成功 read 该文件，并做项目级引用检索（grep/glob/zg_search 覆盖引用面），按证据档位补齐 test/e2e/docs 层探查后再动手。",
    statementDangerousBash:
      "避免使用危险 shell 形态（{signature}）。需要同类操作时先向用户说明风险或改用安全替代（如去掉 --no-verify、先确认再删除、用包管理器替代 curl|sh）。",
    statementSecretPathStable:
      "不要编辑密钥/凭据类文件（.env、*.key、token 配置等）；确需变更时先征得用户明确同意，并最小化接触面。",
    statementSecretPathTarget:
      "不要编辑密钥/凭据类文件（{signature}）；确需变更时先征得用户明确同意，并最小化接触面。",
    statementGateFailure:
      '结束回合前先本地运行 {signature} 自检并修完再收口；该门禁在此项目已多次失败，不要假设"应该能过"。',
    statementTransientFailure:
      "{signature} 出现过瞬时失败（限流/服务端/超时）。遇到同类失败保持冷静等待自动续跑，不要丢弃已有进度重做。",
    statementMaxTokens: "长输出任务主动分段交付，避免单回合输出撞 max-tokens 上限被截断。",
    statementUnfinishedTurn:
      "回合结束前把任务清单收口：完成一项勾一项，不要带着未闭合的待办结束回合。",
    statementGeneric: "避免重复以下问题：{signature}（详见证据）。",

    digestSystemRole:
      "你是工程质量教练。输入是一次会话的人工差评与该项目的历史教训，请把差评归纳为可执行的候选规则。",
    digestSystemShape: "输出严格为 JSON 数组，不要输出任何其他文字。数组每项形如：",
    digestSystemShapeSignature: "同类问题的稳定短键，如命令/路径/场景名",
    digestSystemShapeStatement: "规则正文：具体、可执行、可判定，说明该怎么做而不是只说不要做",
    digestSystemRules:
      '要求：每条规则必须是"下次怎么避免"的可执行指令；差评之间同因合并；没有差评信号时输出 []；不编造差评里没有的事实。',
    digestSectionFeedback: "## 本会话人工差评",
    digestSectionBackground: "## 该项目历史教训（背景，防止重复提出已存在的规则）",
    digestSectionExtra: "## 用户附加说明",
    digestNoFeedback: "（无）",
    digestScopeMessage: "【消息差评】",
    digestScopeSession: "【会话备注】",
    digestCategorySuffix: "（分类 {category}）",
    lessonsNoHistory: "（本项目暂无历史教训记录）",

    digestCommandDescription: "把本会话人工差评与近期教训蒸馏为候选规则（lesson-loop，人工触发）",
    digestInputHint: "[附加说明]",
    digestRejectedDisabled: "lesson-loop 的总开关或上报开关处于关闭状态，未执行蒸馏。",
    digestRejectedNoSession: "/lessons-digest 需要在会话内执行（找不到当前会话）。",
    digestRejectedNoLlm: "llm 服务不可用，无法蒸馏。",
    digestNoNewRules: "差评 {count} 条已分析，未归纳出新规则（可能已存在或信号不足）。",
    digestCreated: "已蒸馏 {count} 条候选规则（待你在设置卡确认后生效）：\n{lines}",
    digestCreatedLine: "{index}. [{category}] {statement}",
    digestFailed: "蒸馏失败：{reason}",

    errNoModelSelection: "当前无可用模型选择（agentDefaultModel）",
    errMissingFinishChunk: "模型返回流缺少 finish 块",
    errIncompleteFinish: "模型整理未正常完成（{kind}{failure}）",
    errEmptyDigest: "模型整理结果为空",

    errInvalidJsonBody: "请求体不是合法 JSON",
    errIdAndActionRequired: "缺少 id 或 action",
    errUnknownAction: "未知操作：{action}",
    errRuleNotFound: "找不到该规则",
    errRuleActionFailed: "规则操作失败",
  },
  en: {
    sectionText: [
      "## lesson-loop self-evolution loop",
      "This environment runs a lesson loop: guard denials, gate failures, abnormal resumptions and human negative feedback are recorded as project lessons, lessons reaching the threshold are distilled into candidate rules, and a rule becomes an armed rule only after the user confirms it in the settings card — armed rules are injected at the start of each session.",
      "- When a guard denies you: supply the missing evidence as the denial says, then retry. Do not rephrase your way around it; the denial itself is a learnable signal.",
      "- If a session starts with injected experience rules, treat them as high-priority constraints and follow them while working.",
      "- The user can run /lessons-digest to distill this session's negative feedback into lessons.",
    ].join("\n"),

    digestHeading:
      "[lesson-loop] Experience rules for this project (human-confirmed; follow them while working — violations are measured):",
    digestRuleLine: "{index}. {statement} (armed on {day}{metrics})",
    armedMetrics:
      ", {violation} violations / {suppressed} followed / {samples} exposed since arming",
    armedNoTrigger:
      ", present in {samples} sessions since arming but never triggered (no evidence to judge yet)",

    statusCandidate: "pending review",
    statusArmed: "armed",
    statusDemoted: "demoted, needs review",
    statusRejected: "rejected",
    statusArchived: "archived",
    ruleSummary:
      "[{label}]{statement} ({category} · {signature} · {occurrences} observations{metrics})",
    ruleSummaryArmed: " · {violation} violations / {suppressed} followed / {samples} exposed",

    statementFactgateStable:
      "Before editing a file, read it successfully first and run a project-wide reference search (grep/glob/zg_search over the referencing surface) to confirm the blast radius — call sites, dependents, tests — before touching anything.",
    statementFactgateRejected:
      "Archived summary of the rejected historical path fragments ({signature}): the requirement to gather evidence before editing is carried by the armed rule above; this entry only keeps the rejection record and the evidence — it is never injected and never measured.",
    statementFactgatePath:
      "Before editing {signature}, read that file successfully first and run a project-wide reference search (grep/glob/zg_search over the referencing surface); close the test/e2e/docs evidence tiers before making the change.",
    statementDangerousBash:
      "Avoid dangerous shell shapes ({signature}). When the same operation is really needed, explain the risk to the user first or switch to a safe alternative (drop --no-verify, confirm before deleting, use a package manager instead of curl|sh).",
    statementSecretPathStable:
      "Do not edit secret/credential files (.env, *.key, token configs and the like); when a change is genuinely required, get the user's explicit consent first and keep the touched surface minimal.",
    statementSecretPathTarget:
      "Do not edit secret/credential files ({signature}); when a change is genuinely required, get the user's explicit consent first and keep the touched surface minimal.",
    statementGateFailure:
      'Before ending the turn, run {signature} locally and fix everything it reports; this gate has failed repeatedly in this project, so never assume "it should pass".',
    statementTransientFailure:
      "{signature} has failed transiently before (rate limit / server side / timeout). When the same kind of failure shows up, stay calm and wait for the automatic resumption — do not discard the progress you already have.",
    statementMaxTokens:
      "Deliver long output tasks in segments on purpose, so a single turn never hits the max-tokens ceiling and gets truncated.",
    statementUnfinishedTurn:
      "Close out the task list before ending the turn: tick an item as soon as it is done, and never end a turn with unresolved to-dos.",
    statementGeneric: "Do not repeat the following problem: {signature} (see the evidence).",

    digestSystemRole:
      "You are an engineering-quality coach. The input is the human negative feedback from one session plus this project's historical lessons; distil the feedback into actionable candidate rules.",
    digestSystemShape: "Output strictly a JSON array and nothing else. Each item has this shape:",
    digestSystemShapeSignature:
      "a stable short key for the same kind of problem, e.g. command/path/scenario name",
    digestSystemShapeStatement:
      "the rule statement: concrete, actionable, decidable — say what to do, not merely what not to do",
    digestSystemRules:
      "Requirements: every rule must be an actionable instruction on how to avoid the problem next time; merge feedback sharing one cause; output [] when there is no negative-feedback signal; never invent facts absent from the feedback.",
    digestSectionFeedback: "## Human negative feedback in this session",
    digestSectionBackground:
      "## Historical lessons of this project (background, do not re-propose existing rules)",
    digestSectionExtra: "## User's additional note",
    digestNoFeedback: "(none)",
    digestScopeMessage: "[message feedback]",
    digestScopeSession: "[session note]",
    digestCategorySuffix: " (category {category})",
    lessonsNoHistory: "(no lesson records for this project yet)",

    digestCommandDescription:
      "Distil this session's human negative feedback and recent lessons into candidate rules (lesson-loop, manually triggered)",
    digestInputHint: "[additional note]",
    digestRejectedDisabled:
      "lesson-loop's master switch or report switch is off — distillation was not run.",
    digestRejectedNoSession:
      "/lessons-digest must run inside a session (no current session found).",
    digestRejectedNoLlm: "The llm service is unavailable — distillation is impossible.",
    digestNoNewRules:
      "{count} negative feedback item(s) analysed; no new rule was distilled (it may already exist or the signal is too weak).",
    digestCreated:
      "{count} candidate rule(s) distilled (they take effect once you confirm them in the settings card):\n{lines}",
    digestCreatedLine: "{index}. [{category}] {statement}",
    digestFailed: "Distillation failed: {reason}",

    errNoModelSelection: "No model selection is available (agentDefaultModel)",
    errMissingFinishChunk: "The model stream is missing its finish chunk",
    errIncompleteFinish: "The model digest did not finish normally ({kind}{failure})",
    errEmptyDigest: "The model digest result is empty",

    errInvalidJsonBody: "invalid json body",
    errIdAndActionRequired: "id and action required",
    errUnknownAction: "unknown action: {action}",
    errRuleNotFound: "rule not found",
    errRuleActionFailed: "rule action failed",
  },
};
