// prompt：lesson-loop 的两处模型可见文案。
//   1. 常驻 systemPrompt 段（静态、项目无关）——"时刻提醒"的存在感来源；
//   2. 会话开始注入的 armed 规则摘要（agent/created → agent.inject，项目精确
//      归因；全文注入，不设 token 上限——用户拍板）。
//
// 两处文案的**语言由调用点注入**（入参 `messages`，见 lib/messages.ts）：本文件是纯函数，
// 不读设置、不知道当前语言——host 半按官方 locale 偏好取一份消息表递进来。
// 规则卡的 `statement` 因此原样透传：那是规则库里的用户数据，绝不随界面语言改写。
//
// 注入帧的不可信文本一律经 fenceUntrusted 定界（见该函数注释）：教训正文来自
// 工具错误原文/模型输出/人工备注，裸拼进编号列表或 Markdown 分节里就能伪造条目。

import type { RuleCard, RuleStatus } from "./lesson-store.ts";
import { fill } from "./messages.ts";
import type { LessonLoopMessages } from "./messages.ts";

/** systemPrompt 常驻段（order 1560：zvec-grep routing 1550 之后，紧贴工具规则面）。 */
export const SECTION_NAME = "lesson-loop";
export const SECTION_ORDER = 1560;

/**
 * 本插件的身份串——**全包唯一定义**：host.ts 从这里导入（服务名 / 开关命名空间
 * `lesson-loop` / cache 子目录 / 注入消息 id 前缀都用它），不再自带第二份。
 * 上方 SECTION_NAME 是同一插件的另一面（systemPrompt 段的命名），值相同但语义
 * 独立，两条各有测试钉住（test/prompt.test.ts、test/host.test.ts）。
 * client 半的 `src/client-entry.ts` 另有一份 `NS`：那是独立打包的另一半，吃不到 host lib。
 */
export const PLUGIN_NAME = "lesson-loop";

/**
 * 本插件注入消息的 producer-owned source.kind——**全包唯一定义**：host 的 armed
 * 规则摘要注入（agent.inject）与 lib/digest.ts 的蒸馏请求帧都从这里导入。此前两侧
 * 各写一遍同值常量（同一生产者两份身份声明），改一处漏一处就会让"注入时写的 kind"
 * 与"读回时比的 kind"分家。
 *
 * 0.1.7 的 V4 准入拒收退役包装 `{ kind: 'plugin', plugin }`（session-format-v3-to-v4
 * 的 message-sources.ts 对每个声明的持久消息位抛 "format v4 message requires a
 * producer-owned source kind"；agent.inject 经 inbox 落 `agent/inbox/spliced`，正是
 * 被拒的持久位），而迁移表给未知插件名统一加 `plugin:` 前缀（sources.ts
 * producerKind），故本插件已迁移的历史行读回也是这个串。`form` 属于本插件自己的
 * 元数据，迁移只改写身份字段，它原样保留。
 */
export const LESSON_SOURCE_KIND = `plugin:${PLUGIN_NAME}`;

/** 本插件注入消息的 source 载荷：`kind` 就此等于上面那枚常量，`form` 是本插件自有的
 *  上下文语义位（`instructions` = 模型要遵守的指令；官方 `ContextForm` 的取值）。 */
interface LessonMessageSource {
  readonly kind: typeof LESSON_SOURCE_KIND;
  readonly form?: string;
}

/**
 * 把本插件的 producer kind 声明进官方 `MessageSourceMap`。
 * 官方那张表是 **merge-extensible** 的：`MessageSource = MessageSourceMap[keyof MessageSourceMap]`
 * （installed @deepseek-ai/dsh-llm/lib/types/message.d.ts:96-111 与 :122），注释原话
 * "each producer declares its own `kind` in its own module; there is no shared catch-all
 * `plugin` kind"，宿主自带插件就是这么写的（installed
 * @deepseek-ai/dsh-agent-instructions/lib/types/state.d.ts:25-29 把 `'agent-instructions'`
 * merge 进同一张表）。本包不声明，官方 `Agent["inject"](message: UserMessage)` 的载荷类型
 * 就收不下本包的注入（实测 TS2322：`Type '"plugin:lesson-loop"' is not assignable to type
 * '"model" | "model-selection" | "system-prompt" | "tool" | "user"'`），而手抄一份
 * "inject 收 unknown" 的镜像正是本仓要消灭的东西。
 * 契约：这里写死的键必须始终等于 `plugin:${PLUGIN_NAME}`。TS 的 `declare module` 不收计算键，
 * 类型层面钉不住，故由 test/prompt.test.ts 的断言在跑测时钉（`assert.equal(LESSON_SOURCE_KIND,
 * "plugin:lesson-loop")` 与 `` assert.equal(LESSON_SOURCE_KIND, `plugin:${PLUGIN_NAME}`) ``），
 * 漂了即红。此前这里还有一条 `const LESSON_SOURCE_KIND_KEY: "plugin:lesson-loop" = …` 的编译期
 * 等式，但它零消费者（fallow 判 unused-export 报出），而那条断言已被测试覆盖同一件事，故删。
 */
declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "plugin:lesson-loop": LessonMessageSource;
  }
}

/** 常驻段正文（取自消息表；关闭时段文本由 host 侧返空串）。 */
export function renderSectionText(messages: LessonLoopMessages): string {
  return messages.sectionText;
}

/**
 * 不可信正文的引用标记：每行行前置一个帧本身永不使用的字符。
 *
 * 定界的可证性就来自这一点——帧的结构符（`[lesson-loop]` 抬头、`1.` 编号行、
 * `##` 分节、`-` 背景条目）都在行首，而经 fenceUntrusted 的正文行一律以引用标记
 * 开头，故「行首结构符」只能由帧自己产生；正文再夹带结构符会连同其自带的引用
 * 一起被改写（见 STRUCTURAL_LEAD），最坏是双标记行，永远撞不上单标记的帧行。
 */
const QUOTE_MARK = "│ ";

/** 行首结构符：编号（1. / 1）/ 1、）、分隔线、标题、标签、列表与引用符。 */
const STRUCTURAL_LEAD =
  /^[│\s]*(?:\d{1,9}[.)、]|-{3,}|\*{3,}|_{3,}|={3,}|#{1,6}|\[lesson-loop\]|[-*+>](?=[ \t]))/iu;

/** 改写行首结构符：整段用全角方括号包住（只增不减，绝不截断正文）。 */
function defuseLead(line: string): string {
  return line.replace(STRUCTURAL_LEAD, (matched: string): string => `【${matched}】`);
}

/**
 * 把不可信文本嵌入注入帧/蒸馏提示前的定界改写（零截断：只做前缀与包括号，
 * 原文字符一个不丢）。逐行加引用标记 + 改写行首结构符，双向保证嵌入内容
 * 伪造不出新的编号条目、分节标题或分隔线。
 */
export function fenceUntrusted(text: string): string {
  return text
    .split("\n")
    .map((line) => `${QUOTE_MARK}${defuseLead(line)}`)
    .join("\n");
}

/** 状态标签：RuleStatus 全集（规则库读取已把漂移状态归一，故无需兜底）。 */
function statusLabel(messages: LessonLoopMessages, status: RuleStatus): string {
  const labels: Record<RuleStatus, string> = {
    armed: messages.statusArmed,
    candidate: messages.statusCandidate,
    demoted: messages.statusDemoted,
    rejected: messages.statusRejected,
    archived: messages.statusArchived,
  };
  return labels[status];
}

/**
 * armed 规则的度量尾巴：三个计数器语义不同——复发/被遵守是"测到过"的真实证据，
 * 暴露只是"在场"。从没被测到（复发与被遵守皆零）时明说"尚无证据"，而不是伪造百分比。
 * 双零（连暴露都没有）不拼任何尾巴。无 armed 摘要以外的调用者，故不导出。
 */
function armedMetric(messages: LessonLoopMessages, rule: RuleCard): string {
  if (rule.violation + rule.suppressed > 0) {
    return fill(messages.armedMetrics, {
      violation: rule.violation,
      suppressed: rule.suppressed,
      samples: rule.samples,
    });
  }
  if (rule.samples > 0) {
    return fill(messages.armedNoTrigger, { samples: rule.samples });
  }
  return "";
}

/** 会话开始注入的 armed 规则摘要。无 armed 规则返回 null（零噪音，不注入空块）。 */
export function renderRulesDigest(
  rules: readonly RuleCard[],
  project: string,
  messages: LessonLoopMessages,
): string | null {
  const armed = rules
    .filter((rule) => rule.status === "armed" && rule.project === project)
    .toSorted((left, right) => (left.armedAt ?? 0) - (right.armedAt ?? 0));
  if (armed.length === 0) {
    return null;
  }
  const lines: string[] = [messages.digestHeading];
  for (const [index, rule] of armed.entries()) {
    const armedDay =
      rule.armedAt === undefined ? "?" : new Date(rule.armedAt).toISOString().slice(0, 10);
    // statement 是模型蒸馏/人工改写正文（不可信），逐行定界后才进编号帧。
    lines.push(
      fill(messages.digestRuleLine, {
        index: index + 1,
        statement: fenceUntrusted(rule.statement),
        day: armedDay,
        metrics: armedMetric(messages, rule),
      }),
    );
  }
  return lines.join("\n");
}

/** 卡片/端点用的规则摘要行（含状态标签；全文，不截断）。 */
export function describeRule(rule: RuleCard, messages: LessonLoopMessages): string {
  const metrics =
    rule.status === "armed"
      ? fill(messages.ruleSummaryArmed, {
          violation: rule.violation,
          suppressed: rule.suppressed,
          samples: rule.samples,
        })
      : "";
  return fill(messages.ruleSummary, {
    label: statusLabel(messages, rule.status),
    statement: rule.statement,
    category: rule.category,
    signature: rule.signature,
    occurrences: rule.occurrences,
    metrics,
  });
}
