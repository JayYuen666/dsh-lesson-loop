// lesson-loop client 半：自进化环设置卡（配置开关 + 规则评审台）。
// 参照 ctx-observe / session-rescue 的卡片模式：keyed plugins.bundle.config 槽，
// React 由模块系统提供（rolldown external），只用 createElement。
// 数据面：GET /_dsh/lesson-loop/stats 下发 csrf + 全量规则；POST rule-action
// 回填 csrf（session-rescue 同款同源守卫）。
//
// 界面文案全部取自 src/ui-messages.ts（中英双语），经官方 @deepseek-ai/dsh-client-locale
// 类型化那两条重载（`ctx.locale.register(ns, dicts)` 一次交齐两语 + `bind(ns)`）拿到
// translator，再以 `t` prop 下发给各渲染点（见 apply）。规则卡的 statement/category/
// signature/project 与端点回传的 error 都是**数据**（规则库里的用户数据、host 回执），
// 一律原样显示，不查表、不翻译。

import { createElement, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { BuiltInLocaleId } from "@deepseek-ai/dsh-client-locale/client";
import type { LocaleDictOf } from "@deepseek-ai/dsh-client-ui-slots";
import type { SlotRegistry } from "@deepseek-ai/dsh-client-ui-renderer/client";
import type { ConfigForm, ConfigFormSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";
// 槽位契约的所有权在属主包：`plugins.bundle.config` 由 plugin-manager 通过
// `declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap }` 交出
// （installed `dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:95-104`，
// 文件头明写「A registrant merges this contract with `import type` and registers through
// `ctx.slots`; it never imports this package at runtime」）。本包原先没把那份 merge 载入
// program：槽位名只是 `ClientCtx.slots` 手抄签名里的一枚 `string`，拼错 key 编译期不红，
// 而宿主按 bundle 包名逐字相等匹配（证据链见下面 BUNDLE_PKG），症状是**整张卡不渲染**。
// 这里取 `ConfigPageForm` 是**一举两得**：既是把官方 merge 载入 program 的入口（TS 顺着
// `./client` 的再导出走到 slot-contract.ts），也是本卡渲染视模型两个状态位的真源
// （见下面 CardSnapshot）。lint 的 `require-module-specifiers` 禁空 import specifier，
// 正合本意——载入官方契约就该同时*用上*它。
import type { ConfigPageForm } from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import { UI_MESSAGES } from "./ui-messages.ts";
import type { LocaleNs, Translate } from "./ui-messages.ts";
import { fieldOf, isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

/** 本包 `NS` 的第三重身份：官方 locale 的命名空间（前两重 = loader 条目 id 与 settings
 *  命名空间 = `configForms.get(NS)` 的入参，见下面那段「两个不同的标识」）。这一重必须
 *  等于 src/ui-messages.ts 里 merge 进 `LocaleNamespaceMap` 的那枚键：两边分叉时下面
 *  `LocaleCatalog` 的 `LocaleDictOf<typeof NS>` 在编译期就红（不在官方表里的串不满足该类型
 *  的 `N extends keyof LocaleNamespaceMap & string` 约束），不需要运行时比对。 */
const NS: LocaleNs = "lesson-loop";

// ⚠ 两个**不同**的标识，别混用（混用过的形状：卡片打不开 / 保存写进别的条目）：
//  - `NS` = loader 条目 id = settings 命名空间 = `configForms.get(NS)` 的入参，
//    真源是本包 cordis.patch.yml 的裸 `- id:`（宿主读 `entry.options.id`）。
//  - 下面这个常量 = 本包在 profile 里那条 bundle 的**包名**，只当槽位 key 用。
// `plugins.bundle.config` 是按 bundle 包名 keyed 的槽位：宿主把注册项的 key 与
// bundle 包名精确相等匹配后才渲染（installed
// dsh-client-ui-plugin-manager/lib/client.js:1821 的
// `renderSlot("plugins.bundle.config", { view: "page" }, { entryKey: pkg.name })` →
// dsh-client-ui-renderer/lib/client.js:1154 的 `e.options.key === opts?.entryKey`；
// 同文件 :2698 的 `configured: ledger.bundles.has(openPkg.name)` 读的就是这批 key），
// 契约文本 installed dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:96-100
// （"keyed by the bundle's package name"），首方先例
// dsh-experimental-client-ui-voice-input/lib/client.js:5659-5661。
// 写成裸条目 id（`lesson-loop`）时 ledger 里没有这个键 → 插件页永不出卡。
// 包名真源：`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`；
// test/profile-bundle.ts 把真源读进测试，test/build-client.test.ts 的漂移针据此钉。
const BUNDLE_PKG = "@jayyuen66/dsh-lesson-loop";

const STATS_PATH = "/_dsh/lesson-loop/stats";
const RULE_ACTION_PATH = "/_dsh/lesson-loop/rule-action";
// SVG path 的 `d` 属性是固定方法名，改用变量作计算键以绕过短名检查
const PATH_KEY = "d";

/** 规则卡状态白名单：与 host lib/lesson-store 的 RULE_STATUSES 同集合。 */
const RULE_STATUSES: ReadonlySet<string> = new Set([
  "candidate",
  "armed",
  "demoted",
  "rejected",
  "archived",
]);

type RuleCardStatus = RuleCardView["status"];

function isRuleStatus(value: unknown): value is RuleCardStatus {
  return typeof value === "string" && RULE_STATUSES.has(value);
}

/** 字符串字段归一：非字符串（服务端字段漂移）退兜底，不整张卡丢弃。 */
function strField(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** 数值字段读取：只认 number 与数字字符串两种形态，其余视为漂移。 */
function numericOf(value: unknown): number | undefined {
  let result: number | undefined;
  if (typeof value === "number" || typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      result = parsed;
    }
  }
  return result;
}

/** 必填数值字段归一：漂移退兜底（卡片按数字渲染计数，undefined 会渲染成空白）。 */
function numField(value: unknown, fallback: number): number {
  const parsed = numericOf(value);
  return parsed ?? fallback;
}

/**
 * 规则卡逐字段归一（/stats 投影）。旧实现查 id+status 就断言整张卡，服务端
 * 新增或改名字段会让下游按 string/number 用的字段拿到 undefined。
 * 只有 id 是硬要求（动作按钮按 id 回填），其余补默认；status 漂移归 archived
 * （与 host 读取同一取向：归到"退役"分组里等人处理，不当活跃规则渲染）。
 */
function normalizeRuleCardView(value: unknown): RuleCardView | null {
  const id = fieldOf(value, "id");
  if (typeof id !== "string" || id === "") {
    return null;
  }
  const statusRaw = fieldOf(value, "status");
  const card: RuleCardView = {
    id,
    project: strField(fieldOf(value, "project"), "default"),
    category: strField(fieldOf(value, "category"), "unknown"),
    signature: strField(fieldOf(value, "signature"), ""),
    statement: strField(fieldOf(value, "statement"), ""),
    status: isRuleStatus(statusRaw) ? statusRaw : "archived",
    createdAt: numField(fieldOf(value, "createdAt"), 0),
    occurrences: numField(fieldOf(value, "occurrences"), 0),
    violation: numField(fieldOf(value, "violation"), 0),
    suppressed: numField(fieldOf(value, "suppressed"), 0),
    samples: numField(fieldOf(value, "samples"), 0),
    undeterminable: fieldOf(value, "undeterminable") === true,
    origin: strField(fieldOf(value, "origin"), ""),
  };
  const recurrences = numericOf(fieldOf(value, "recurrences"));
  if (recurrences !== undefined) {
    card.recurrences = recurrences;
  }
  return card;
}

/** 未知数组：非数组退空表（不经 any 扩散，逐元素仍是 unknown）。 */
function unknownArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 规则列表投影：整字段不是数组时不给卡片（undefined 与空列表语义不同）。 */
function rulesField(value: unknown): RuleCardView[] | undefined {
  let result: RuleCardView[] | undefined;
  if (Array.isArray(value)) {
    const rules: RuleCardView[] = [];
    for (const item of unknownArray(value)) {
      const card = normalizeRuleCardView(item);
      if (card !== null) {
        rules.push(card);
      }
    }
    result = rules;
  }
  return result;
}

/** /stats 载荷投影：逐字段守卫，坏形状成员缺省。 */
function parseStatsValue(parsed: unknown): StatsPayload {
  if (!isRecord(parsed)) {
    return {};
  }
  const { ok, csrf, rules, lessonsCount, error } = parsed;
  const ruleViews = rulesField(rules);
  return {
    ...(ok === true ? { ok: true } : {}),
    ...(typeof csrf === "string" ? { csrf } : {}),
    ...(ruleViews === undefined ? {} : { rules: ruleViews }),
    ...(typeof lessonsCount === "number" ? { lessonsCount } : {}),
    ...(typeof error === "string" ? { error } : {}),
  };
}

/** POST 回执投影：只需 ok/error。 */
function parseActionResultValue(parsed: unknown): { ok?: boolean; error?: string } {
  if (!isRecord(parsed)) {
    return {};
  }
  const { ok, error } = parsed;
  return {
    ...(ok === true ? { ok: true } : {}),
    ...(typeof error === "string" ? { error } : {}),
  };
}

/**
 * 规则卡动作按钮那一行的 class —— armed / candidate|demoted / rejected|archived 三种
 * 状态各渲染一行，同一枚 class 三次落到 `className` 上（样式定义见下面 CARD_CSS 的
 * `.llc-actions` 那条）。
 */
const ACTIONS_ROW_CLASS = "llc-actions";

const CARD_CSS = [
  ".llc-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}",
  ".llc-card:hover{border-color:var(--dsw-alias-label-dimmed)}",
  ".llc-card-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}",
  ".llc-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}",
  ".llc-head{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}",
  ".llc-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}",
  ".llc-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}",
  ".llc-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}",
  ".llc-chevron-open{transform:rotate(180deg)}",
  ".llc-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:8px 0 12px}",
  ".llc-row{display:flex;flex-direction:row;justify-content:space-between;align-items:center;gap:12px;padding:9px 0}",
  ".llc-label{font-size:13px;color:var(--dsw-alias-label-primary,inherit)}",
  ".llc-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f99);line-height:1.5;margin-top:2px}",
  ".llc-switch{appearance:none;position:relative;width:34px;height:20px;border-radius:10px;background:var(--dsw-alias-fill-primary,#d8dbe2);transition:background .16s;cursor:pointer;border:0;flex:none}",
  '.llc-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-layer-1,#fff);transition:left .16s}',
  ".llc-switch-on{background:var(--dsw-alias-brand-primary,#e07856)}",
  ".llc-switch-on::after{left:16px}",
  ".llc-switch:disabled{cursor:not-allowed;opacity:.6}",
  ".llc-section{margin:10px 0 4px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#5c626e)}",
  ".llc-rule{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;margin:6px 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary,inherit)}",
  ".llc-rule-meta{color:var(--dsw-alias-label-tertiary,#8a8f99);margin-top:4px}",
  ".llc-statement{white-space:pre-wrap;word-break:break-word}",
  ".llc-actions{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}",
  ".llc-btn{appearance:none;font:inherit;font-size:12px;cursor:pointer;border-radius:6px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit)}",
  ".llc-btn-primary{background:var(--dsw-alias-brand-primary,#e07856);border-color:var(--dsw-alias-brand-primary,#e07856);color:var(--dsw-alias-label-primary-foreground,#fff)}",
  ".llc-input{width:100%;box-sizing:border-box;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l2,transparent);border-radius:8px;padding:6px 8px;margin-top:6px}",
  ".llc-empty{color:var(--dsw-alias-label-tertiary,#8a8f99);font-size:12px;padding:6px 0}",
  ".llc-err{color:#c4483f;font-size:12px;padding:6px 0;white-space:pre-wrap}",
  ".llc-num{width:96px;box-sizing:border-box;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l2,transparent);border-radius:8px;padding:6px 8px;text-align:center}",
  ".llc-savebar{display:flex;gap:8px;align-items:center;padding:10px 0 2px;border-top:1px dashed var(--dsw-alias-border-l2);margin-top:6px;flex-wrap:wrap}",
  ".llc-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#e07856);outline-offset:1px}",
  ".llc-btn:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed)}",
  ".llc-btn:disabled{opacity:.5;cursor:not-allowed}",
  ".llc-dirty{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f99)}",
  ".llc-saveerr{font-size:12px;color:#c4483f}",
].join("\n");

// ── 端点数据类型 ─────────────────────────────────────────────────────────

export interface RuleCardView {
  id: string;
  project: string;
  category: string;
  signature: string;
  statement: string;
  status: "candidate" | "armed" | "demoted" | "rejected" | "archived";
  createdAt: number;
  occurrences: number;
  violation: number;
  /** observed clean hits：规则场景被触发且被遵守的会话数（复发率分母的"清白"项）。 */
  suppressed: number;
  /** 暴露度：armed 后在场且未违规的会话数（非正确性度量，不进复发率分母）。 */
  samples: number;
  /** 派生态：armed 够久却零复发零遵守，机器无从裁定，等人停用/归档。 */
  undeterminable: boolean;
  /** rejected 后同签名再次出现的次数（后续新增字段）。 */
  recurrences?: number;
  origin: string;
}

interface StatsPayload {
  ok?: boolean;
  csrf?: string;
  rules?: RuleCardView[];
  lessonsCount?: number;
  error?: string;
}

/**
 * 0.1.7 的客户端配置面：一个条目（= profile 条目 id，本包 `lesson-loop`）的共享表单。
 * 契约源：installed
 * `dsh-client-ui-settings/lib/types/client/config-form-types.d.ts` 的 `ConfigForm<T>`
 * （`getSnapshot:38` / `subscribe:44` / `set:65` / `unset:73`；`mutate:55` 本卡不用），
 * 快照三面 `status:12` / `value:14` / `writable:29` 见同文件 `ConfigFormSnapshot:6-32`——
 * 与旧 `settingsScope` 的读面同名，故卡片侧的降级逻辑（cardStore 的逐字段守卫、
 * status/writable 双条件）原样可用。
 * ⚠ 旧 `ctx.settingsScope.bind({ namespace })` 连同 `settingsScope` 服务已被宿主移除
 * （installed 全树零命中），入口换成 `ctx.configForms.get(entryId)`（installed
 * `.../client/config-form.d.ts:142`，服务本身由同文件 :94-98 的 Context 增强交出）。
 * ⚠ 消费契约里**没有** `dispose`：`get()` 交回的是 provider 自己持有的那张共享表单
 * （同文件 :138-142 "The entry's form, owned by this provider"，实例按 entryId 缓存在
 * provider 的 forms 表里，随 provider 的 fiber 一起回收），消费者无权销毁它。
 */
export type EntryForm = ConfigForm<Record<string, unknown>>;

/** 官方 `LocaleRuntime.register` 类型化重载的字典参数，取在本包命名空间上：
 * `Record<BuiltInLocaleId, LocaleDictOf<'lesson-loop'>>`——两语（官方 `BuiltInLocaleId`）
 * 必须齐、每语的键集必须等于 `UiMessages`，都由官方表达式给出（少一门语言、少一个键、
 * 多一个键都在编译期红）。 */
export type LocaleCatalog = Record<BuiltInLocaleId, LocaleDictOf<typeof NS>>;

/** 本卡自己的渲染视模型（官方 `ConfigFormSnapshot` 的有用子集 + 兜底值）。
 *  `status`/`writable` 两位不再手写联合：它们取自属主包交给配置页的那份官方状态
 *  （`ConfigPageForm['state']`，installed `dsh-client-ui-plugin-manager/lib/types/client/
 *  slot-contract.d.ts:150-155`，其类型就是官方 `ConfigFormSnapshot<Record<string, unknown>>`
 *  的再投影）。宿主把 status 的取值域或 writable 的必选性一改，这里当场红。
 *  两者都满足才允许写，故保持**必选**，不用可选位假装它们会缺（writable 是独立于 status
 *  的「Host 文档是否接受写入」位，memory 模式永假）；`value` 是本卡的兜底收窄（官方
 *  `value: T | undefined` → 首个快照受理前落成空对象供渲染）。 */
export interface CardSnapshot extends Pick<ConfigPageForm["state"], "status" | "writable"> {
  value: Record<string, unknown>;
}

// ── 请求工具 ─────────────────────────────────────────────────────────────

async function fetchStats(): Promise<StatsPayload> {
  const res = await fetch(STATS_PATH, { headers: { accept: "application/json" } });
  const parsed: unknown = await res.json();
  return parseStatsValue(parsed);
}

async function postAction(
  csrf: string,
  id: string,
  action: string,
  statement?: string,
): Promise<{ ok?: boolean; error?: string }> {
  const res = await fetch(RULE_ACTION_PATH, {
    method: "POST",
    headers: { "content-type": "application/json", "x-lesson-csrf": csrf },
    body: JSON.stringify({ id, action, ...(statement === undefined ? {} : { statement }) }),
  });
  const parsed: unknown = await res.json();
  return parseActionResultValue(parsed);
}

// ── 小组件 ───────────────────────────────────────────────────────────────

export interface ToggleRowProps {
  label: string;
  hint: string;
  /** 稳定锚点（schema 门禁/测试按字段定位控件）。 */
  field: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}

function ToggleRow(props: ToggleRowProps): ReactNode {
  return createElement(
    "div",
    { className: "llc-row" },
    createElement(
      "div",
      null,
      createElement("div", { className: "llc-label" }, props.label),
      createElement("div", { className: "llc-hint" }, props.hint),
    ),
    createElement("button", {
      type: "button",
      className: `llc-switch${props.checked ? " llc-switch-on" : ""}`,
      role: "switch",
      "aria-checked": props.checked,
      "data-field": props.field,
      disabled: props.disabled === true,
      onClick: props.onToggle,
    }),
  );
}

const fmtDay = (ts: number | undefined): string =>
  typeof ts === "number" && ts > 0 ? new Date(ts).toISOString().slice(0, 10) : "?";

/**
 * 单条规则卡的元信息行。首段是纯数据（分类 · 项目桶），其余是包自己的文案：
 * 提成模块级函数既避开 createElement 的四层嵌套（unicorn/max-nested-calls），
 * 也让两语走同一条拼装路径——切换语言只是换 translator。
 */
export function ruleMetaLines(t: Translate, rule: RuleCardView): string[] {
  const lines = [
    `${rule.category} · ${rule.project}`,
    t("metaObservations", { count: rule.occurrences, day: fmtDay(rule.createdAt) }),
  ];
  if (rule.status === "armed") {
    lines.push(
      t("metaArmed", {
        violation: rule.violation,
        suppressed: rule.suppressed,
        samples: rule.samples,
      }),
    );
    if (rule.undeterminable) {
      lines.push(t("metaUndeterminable"));
    }
  }
  if (rule.status === "rejected" && typeof rule.recurrences === "number" && rule.recurrences > 0) {
    lines.push(t("metaRevive", { count: rule.recurrences }));
  }
  if (rule.origin === "lessons-digest") {
    lines.push(t("metaFromDigest"));
  }
  return lines;
}

export interface RuleItemProps {
  t: Translate;
  rule: RuleCardView;
  csrf: string;
  busy: boolean;
  onDone: (ok: boolean, message?: string) => void;
  setBusy: (nextBusy: boolean) => void;
}

/** 一条规则卡上五枚动作按钮的文案（取法见 RuleItem 里那行「先取成变量」的注记）。 */
interface RuleActionLabels {
  demote: string;
  archive: string;
  reject: string;
  revive: string;
  confirm: string;
}

/** 三种状态的规则卡共用的动作行输入：状态位与草稿在 RuleItem 里，动作口是它的 `act`。 */
interface RuleActionsProps {
  busy: boolean;
  editing: boolean;
  draft: string;
  labels: RuleActionLabels;
  act: (action: string, statement?: string) => Promise<void>;
  setEditing: (next: boolean) => void;
  setDraft: (next: string) => void;
}

/** armed 卡的动作行：降级与归档（它已在生效，没有"确认升格"那一步）。 */
function armedActionsRow(deps: RuleActionsProps): ReactNode {
  const { busy, labels, act } = deps;
  return createElement(
    "div",
    { className: ACTIONS_ROW_CLASS },
    createElement(
      "button",
      {
        className: "llc-btn",
        disabled: busy,
        onClick: () => {
          void act("demote");
        },
      },
      labels.demote,
    ),
    createElement(
      "button",
      {
        className: "llc-btn",
        disabled: busy,
        onClick: () => {
          void act("archive");
        },
      },
      labels.archive,
    ),
  );
}

/** candidate / demoted 卡的动作行：确认升格（未进编辑态时先开草稿框）+ 驳回 + 归档。 */
function candidateActionsRow(deps: RuleActionsProps): ReactNode {
  const { busy, editing, draft, labels, act, setEditing } = deps;
  return createElement(
    "div",
    { className: ACTIONS_ROW_CLASS },
    createElement(
      "button",
      {
        className: "llc-btn llc-btn-primary",
        disabled: busy,
        onClick: () => {
          if (editing) {
            void act("arm", draft);
          } else {
            setEditing(true);
          }
        },
      },
      labels.confirm,
    ),
    createElement(
      "button",
      {
        className: "llc-btn",
        disabled: busy,
        onClick: () => {
          void act("reject");
        },
      },
      labels.reject,
    ),
    createElement(
      "button",
      {
        className: "llc-btn",
        disabled: busy,
        onClick: () => {
          void act("archive");
        },
      },
      labels.archive,
    ),
  );
}

/** rejected / archived 卡的动作行：只有一条"转回候选重审"。 */
function retiredActionsRow(deps: RuleActionsProps): ReactNode {
  const { busy, labels, act } = deps;
  return createElement(
    "div",
    { className: ACTIONS_ROW_CLASS },
    createElement(
      "button",
      {
        className: "llc-btn",
        disabled: busy,
        onClick: () => {
          void act("revive");
        },
      },
      labels.revive,
    ),
  );
}

/** 升格前的 statement 改写框：只在编辑态出现，草稿初值由 RuleItem 的 state 给。 */
function statementEditorRow(deps: RuleActionsProps): ReactNode {
  const { draft, setDraft } = deps;
  return createElement("textarea", {
    className: "llc-input",
    rows: 3,
    value: draft,
    onChange: (event: { target: { value: string } }) => {
      setDraft(event.target.value);
    },
  });
}

/** 单条规则卡：状态着色 + 动作按钮（arm 带 statement 改写框）。 */
function RuleItem(props: RuleItemProps): ReactNode {
  const { t, rule } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(rule.statement);
  const act = async (action: string, statement?: string): Promise<void> => {
    props.setBusy(true);
    try {
      const result = await postAction(props.csrf, rule.id, action, statement);
      props.setBusy(false);
      props.onDone(
        result.ok === true,
        result.ok === true ? undefined : (result.error ?? t("actionFailed")),
      );
    } catch (error) {
      props.setBusy(false);
      props.onDone(false, String(error instanceof Error ? error.message : error));
    }
  };
  const meta = ruleMetaLines(t, rule).join(" · ");
  // 按钮文案先取成变量：嵌进多层 createElement 里再调 t() 会超 max-nested-calls 上限。
  const labels: RuleActionLabels = {
    demote: t("btnDemote"),
    archive: t("btnArchive"),
    reject: rule.status === "demoted" ? t("btnReject") : t("btnDismiss"),
    revive: t("btnRevive"),
    confirm: t(editing ? "btnArmConfirmEditing" : "btnArmConfirm"),
  };
  const actions: RuleActionsProps = {
    busy: props.busy,
    editing,
    draft,
    labels,
    act,
    setEditing,
    setDraft,
  };
  return createElement(
    "li",
    { className: "llc-rule" },
    createElement("div", { className: "llc-statement" }, rule.statement),
    createElement("div", { className: "llc-rule-meta" }, meta),
    rule.status === "armed" ? armedActionsRow(actions) : null,
    rule.status === "candidate" || rule.status === "demoted" ? candidateActionsRow(actions) : null,
    rule.status === "rejected" || rule.status === "archived" ? retiredActionsRow(actions) : null,
    editing && (rule.status === "candidate" || rule.status === "demoted")
      ? statementEditorRow(actions)
      : null,
  );
}

// ── 主卡片 ───────────────────────────────────────────────────────────────

export interface LlcCardProps {
  /** 取文案（官方 ctx.locale.bind 的结果，见 apply）。 */
  t: Translate;
  useCard: <State>(selector: (snap: CardSnapshot) => State) => State;
  /**
   * 单字段写入 / 清除（直通 0.1.7 的 `ConfigForm.set` / `unset`，见
   * config-form-types.d.ts:65 / :73）。两个 promise 都**只有传输失败才 reject**，
   * 宿主拒绝或跳过写入回 `false`——本卡沿用 0.1.6 的判定点：只把 reject 当失败呈现
   * （见 save 的 catch），受理位不消费。被拒的那一项因此表现为"快照仍是旧值 +
   * 草稿被清空"，而不是错误条；要改成看受理位是一次独立的取舍，不在迁移范围内做。
   */
  set: (field: string, value: unknown) => Promise<boolean>;
  unset: (field: string) => Promise<boolean>;
  initialOpen?: boolean;
}

/** touched 层与快照的差异字段（值语义比较；undefined 与缺失等价）。 */
export function diffTouched(
  touched: Record<string, unknown>,
  value: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  for (const key of Object.keys(touched)) {
    if (JSON.stringify(touched[key] ?? null) !== JSON.stringify(value[key] ?? null)) {
      out.push(key);
    }
  }
  return out;
}

/** 保存条的状态文本（三态各一条；提成模块级函数以免嵌进 createElement）。 */
export function saveBarStatus(t: Translate, state: { dirty: boolean; writable: boolean }): string {
  if (!state.writable) {
    return t("statusReadOnly");
  }
  return state.dirty ? t("statusDirty") : t("statusClean");
}

function SaveBar(props: {
  t: Translate;
  dirty: boolean;
  writable: boolean;
  busy: boolean;
  error: string | null;
  onSave: () => void;
  onDiscard: () => void;
}): ReactNode {
  const { t } = props;
  const dis = !props.writable || props.busy;
  const statusText = saveBarStatus(t, props);
  const saveLabel = t("save");
  const savingLabel = t("saving");
  const revertLabel = t("revert");
  // 空串在 React 里是合法子节点：无错误时不能把 t("…") 的空串塞进第三参。
  const statusNode =
    props.error === null
      ? createElement("span", { className: "llc-dirty" }, statusText)
      : createElement("span", { className: "llc-saveerr" }, props.error);
  return createElement(
    "div",
    { className: "llc-savebar" },
    createElement(
      "button",
      {
        type: "button",
        className: "llc-btn llc-btn-primary",
        "data-field": "save",
        disabled: dis || !props.dirty,
        onClick: props.onSave,
      },
      props.busy ? savingLabel : saveLabel,
    ),
    createElement(
      "button",
      {
        type: "button",
        className: "llc-btn",
        "data-field": "discard",
        disabled: dis || !props.dirty,
        onClick: props.onDiscard,
      },
      revertLabel,
    ),
    statusNode,
  );
}

export interface NumberInputRowProps {
  label: string;
  hint: string;
  field: string;
  value: unknown;
  onChange: (field: string, value: unknown) => void;
  onEmpty: (field: string) => void;
  disabled?: boolean;
  min?: number;
  max?: number;
}

/** 数字输入行：settings 数字字段 ↔ UI 字符串（ctx-observe 同款契约）。 */
function NumberInputRow(props: NumberInputRowProps): ReactNode {
  const num =
    typeof props.value === "number" && Number.isFinite(props.value) ? String(props.value) : "";
  const [text, setText] = useState(num);
  // 外部快照变化（别处改了设置）→ 回写输入框，避免陈旧显示。
  useEffect(() => {
    setText(num);
  }, [num]);
  const onEntry = (event: { target: { value: string } }): void => {
    const next = event.target.value;
    setText(next);
    if (next === "") {
      props.onEmpty(props.field);
      return;
    }
    const parsed = Number(next);
    if (!Number.isFinite(parsed)) {
      return;
    }
    const lower = props.min ?? -Infinity;
    const upper = props.max ?? Infinity;
    if (parsed >= lower && parsed <= upper) {
      props.onChange(props.field, parsed);
    }
  };
  return createElement(
    "div",
    { className: "llc-row" },
    createElement(
      "div",
      null,
      createElement("div", { className: "llc-label" }, props.label),
      createElement("div", { className: "llc-hint" }, props.hint),
      createElement("input", {
        type: "number",
        className: "llc-num",
        "data-field": props.field,
        value: text,
        disabled: props.disabled === true,
        onChange: onEntry,
      }),
    ),
  );
}

/**
 * 配置行区块（开关 + 阈值输入），从 LlcCard 抽出控制函数体（max-lines）。
 * 文案取自本包字典（`<字段>Label` / `<字段>Hint`）：加一个设置字段就得在两语里各补
 * 一条，漏一条在 tsc 阶段即红——键名写死成字面量而不是拼字符串，正是为了这一点。
 * 设置字段名同样走 `field: "<字面量>"` props（ToggleRowProps.field 注释里那条
 * 「schema 门禁/测试按字段定位控件」的稳定锚点）：test/schema-coverage.ts 的卡片覆盖
 * 门禁就是按这个写法认绑定的，把键名塞进变量再传进去等于让门禁看不见这一行。
 */
function buildConfigRows(deps: {
  t: Translate;
  writable: boolean;
  eff: (field: string) => unknown;
  setField: (field: string, value: unknown) => void;
  clearField: (field: string) => void;
}): ReactNode[] {
  const { t, writable, eff, setField, clearField } = deps;
  const toggle = (row: { field: string; label: string; hint: string }): ReactNode =>
    createElement(ToggleRow, {
      label: row.label,
      hint: row.hint,
      field: row.field,
      checked: eff(row.field) !== false,
      disabled: !writable,
      onToggle: () => {
        setField(row.field, eff(row.field) === false);
      },
    });
  const num = (row: {
    field: string;
    label: string;
    hint: string;
    min: number;
    max: number;
  }): ReactNode =>
    createElement(NumberInputRow, {
      label: row.label,
      hint: row.hint,
      field: row.field,
      value: eff(row.field),
      disabled: !writable,
      onChange: setField,
      onEmpty: clearField,
      min: row.min,
      max: row.max,
    });
  return [
    toggle({ field: "enabled", label: t("enabledLabel"), hint: t("enabledHint") }),
    toggle({
      field: "reportEnabled",
      label: t("reportEnabledLabel"),
      hint: t("reportEnabledHint"),
    }),
    toggle({
      field: "injectEnabled",
      label: t("injectEnabledLabel"),
      hint: t("injectEnabledHint"),
    }),
    toggle({
      field: "sectionEnabled",
      label: t("sectionEnabledLabel"),
      hint: t("sectionEnabledHint"),
    }),
    num({
      field: "promoteThreshold",
      label: t("promoteThresholdLabel"),
      hint: t("promoteThresholdHint"),
      min: 1,
      max: 20,
    }),
    num({
      field: "demoteThreshold",
      label: t("demoteThresholdLabel"),
      hint: t("demoteThresholdHint"),
      min: 1,
      max: 50,
    }),
    num({
      field: "demoteMinSamples",
      label: t("demoteMinSamplesLabel"),
      hint: t("demoteMinSamplesHint"),
      min: 1,
      max: 100,
    }),
    num({
      field: "demoteRatio",
      label: t("demoteRatioLabel"),
      hint: t("demoteRatioHint"),
      min: 0.05,
      max: 1,
    }),
    num({
      field: "reviveThreshold",
      label: t("reviveThresholdLabel"),
      hint: t("reviveThresholdHint"),
      min: 1,
      max: 20,
    }),
    num({
      field: "decayDays",
      label: t("decayDaysLabel"),
      hint: t("decayDaysHint"),
      min: 1,
      max: 365,
    }),
    num({
      field: "maxLessonsBytes",
      label: t("maxLessonsBytesLabel"),
      hint: t("maxLessonsBytesHint"),
      min: 0,
      max: 1_073_741_824,
    }),
  ];
}

/** 分节标题：标题本身由调用点从字典取好，这里只拼计数（中/英括号形态在字典里）。 */
export function sectionHeadingText(t: Translate, title: string, count: number): string {
  return t("sectionHeading", { title, count });
}

/** 「已拒绝/归档」按钮：折叠态显示分组标题 + 条数，展开态显示"收起"。 */
export function retiredToggleText(t: Translate, showAll: boolean, count: number): string {
  return showAll ? t("showRetired") : sectionHeadingText(t, t("sectionRetired"), count);
}

/** 卡片副标题（含实时计数；lessonsCount 未到达时显式占位，不虚报 0）。 */
function cardDescriptionText(
  t: Translate,
  counts: { candidates: number; armed: number; lessons: number | undefined },
): string {
  return t("cardDescription", {
    candidates: counts.candidates,
    armed: counts.armed,
    lessons: counts.lessons ?? "…",
  });
}

/** 四种状态的分组：卡片按组渲染，一次过滤读完整个规则列表。 */
interface RuleGroups {
  candidates: RuleCardView[];
  armed: RuleCardView[];
  demoted: RuleCardView[];
  retired: RuleCardView[];
}

/** 卡片各区块共用的渲染输入：状态位 + 写口 + 动作回调，一次组装、按引用往下传。
 *  区块函数都是普通函数而不是组件（不引入新的 React 节点），树形与拆出前逐字节一致。 */
interface CardView {
  t: Translate;
  open: boolean;
  writable: boolean;
  statsError: string | null;
  saveError: string | null;
  busy: boolean;
  dirty: boolean;
  /** /stats 下发的写操作令牌；未到达时是空串（与拆出前同一兜底）。 */
  csrf: string;
  ruleBusy: boolean;
  showAll: boolean;
  groups: RuleGroups;
  /** 未到达时保持 undefined，由副标题显式占位。 */
  lessonsCount: number | undefined;
  eff: (field: string) => unknown;
  setField: (field: string, value: unknown) => void;
  clearField: (field: string) => void;
  onDone: (ok: boolean, message?: string) => void;
  setRuleBusy: (nextBusy: boolean) => void;
  setShowAll: (next: boolean) => void;
  onSave: () => void;
  onDiscard: () => void;
  onToggle: () => void;
}

/** 按 status 分四组（顺序与拆出前一致：候选 → armed → 降级 → 已拒绝/归档）。 */
function groupRules(rules: RuleCardView[]): RuleGroups {
  return {
    candidates: rules.filter((row) => row.status === "candidate"),
    armed: rules.filter((row) => row.status === "armed"),
    demoted: rules.filter((row) => row.status === "demoted"),
    retired: rules.filter((row) => row.status === "rejected" || row.status === "archived"),
  };
}

/** 折叠箭头：`d` 属性走计算键（PATH_KEY）以避开短名检查。 */
function renderChevron(open: boolean): ReactNode {
  return createElement(
    "svg",
    {
      width: 14,
      height: 14,
      viewBox: "0 0 14 14",
      "aria-hidden": true,
      className: `llc-chevron${open ? " llc-chevron-open" : ""}`,
    },
    createElement("path", {
      [PATH_KEY]: "M3 5l4 4 4-4",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.5,
      strokeLinecap: "round",
      strokeLinejoin: "round",
    }),
  );
}

/** 一个评审分节：标题带计数，空组显式占位，非空逐条出 RuleItem。 */
function renderRuleSection(view: CardView, title: string, list: RuleCardView[]): ReactNode {
  const { t } = view;
  const heading = createElement(
    "div",
    { className: "llc-section" },
    sectionHeadingText(t, title, list.length),
  );
  const emptyLabel = t("emptyGroup");
  const body =
    list.length === 0
      ? createElement("div", { className: "llc-empty" }, emptyLabel)
      : createElement(
          "ul",
          { style: { listStyle: "none", margin: "0", padding: "0" } },
          list.map((row) =>
            createElement(RuleItem, {
              key: row.id,
              t,
              rule: row,
              csrf: view.csrf,
              busy: view.ruleBusy,
              onDone: view.onDone,
              setBusy: view.setRuleBusy,
            }),
          ),
        );
  return createElement("div", null, heading, body);
}

/** 卡片头：标题 + 实时计数副标题 + 折叠箭头。 */
function renderCardHeader(view: CardView): ReactNode {
  const { t, open } = view;
  const headTitle = t("cardTitle");
  const headDesc = cardDescriptionText(t, {
    candidates: view.groups.candidates.length,
    armed: view.groups.armed.length,
    lessons: view.lessonsCount,
  });
  return createElement(
    "button",
    { type: "button", className: "llc-header", "aria-expanded": open, onClick: view.onToggle },
    createElement(
      "div",
      { className: "llc-head" },
      createElement("div", { className: "llc-name" }, headTitle),
      createElement("div", { className: "llc-desc" }, headDesc),
    ),
    renderChevron(open),
  );
}

/** 「已拒绝/归档」区块：折叠态只有一条按钮，展开态才出分节。 */
function renderRetiredBlock(view: CardView): ReactNode {
  const { t, showAll } = view;
  const { retired } = view.groups;
  const retiredTitle = t("sectionRetired");
  const retiredLabel = retiredToggleText(t, showAll, retired.length);
  return retired.length > 0
    ? createElement(
        "div",
        null,
        createElement(
          "button",
          {
            className: "llc-btn",
            onClick: () => {
              view.setShowAll(!showAll);
            },
          },
          retiredLabel,
        ),
        showAll ? renderRuleSection(view, retiredTitle, retired) : null,
      )
    : null;
}

/** 展开态的卡片体：错误条 + 配置行 + 保存条 + 三个评审分节 + 「已拒绝/归档」+ 蒸馏提示。 */
function renderCardBody(view: CardView): ReactNode {
  const { t } = view;
  const retiredToggle = renderRetiredBlock(view);
  const hintLabel = t("digestHint");
  const candidatesTitle = t("sectionCandidates");
  const demotedTitle = t("sectionDemoted");
  const armedTitle = t("sectionArmed");
  return createElement(
    "ul",
    { className: "llc-body" },
    view.statsError === null
      ? null
      : createElement("div", { className: "llc-err" }, view.statsError),
    ...buildConfigRows({
      t,
      writable: view.writable,
      eff: view.eff,
      setField: view.setField,
      clearField: view.clearField,
    }),
    createElement(SaveBar, {
      t,
      dirty: view.dirty,
      writable: view.writable,
      busy: view.busy,
      error: view.saveError,
      onSave: view.onSave,
      onDiscard: view.onDiscard,
    }),
    renderRuleSection(view, candidatesTitle, view.groups.candidates),
    renderRuleSection(view, demotedTitle, view.groups.demoted),
    renderRuleSection(view, armedTitle, view.groups.armed),
    retiredToggle,
    createElement("div", { className: "llc-hint", style: { marginTop: "8px" } }, hintLabel),
  );
}

/** /stats 回执的落地口：换 stats 还是写错误条，两处状态位一次判完。 */
interface StatsSink {
  t: Translate;
  setStats: (next: StatsPayload) => void;
  setStatsError: (next: string | null) => void;
}

/** ok 才换 stats；否则只写错误条，旧数据留在屏上（轮询失败不该把卡片清空）。 */
function settleStats(result: StatsPayload, sink: StatsSink): void {
  const { t, setStats, setStatsError } = sink;
  if (result.ok === true) {
    setStats(result);
    setStatsError(null);
  } else {
    setStatsError(result.error ?? t("statsUnavailable"));
  }
}

/** 拉取统计并落进 sink。模块层函数：effect 与 save/onDone 共用，组件里不为此引入任何 React hook。 */
async function reloadStats(sink: StatsSink): Promise<void> {
  try {
    settleStats(await fetchStats(), sink);
  } catch (error) {
    sink.setStatsError(String(error instanceof Error ? error.message : error));
  }
}

/** 差异字段逐个写回共享表单：undefined 走 unset（= 恢复默认），其余走 set。 */
async function writeTouchedFields(
  props: Pick<LlcCardProps, "set" | "unset">,
  touched: Record<string, unknown>,
  keys: readonly string[],
): Promise<unknown[]> {
  return Promise.all(
    keys.map((key) => {
      const fieldValue = touched[key];
      return fieldValue === undefined ? props.unset(key) : props.set(key, fieldValue);
    }),
  );
}

function LlcCard(props: LlcCardProps): ReactNode {
  const { t } = props;
  const [open, setOpen] = useState(props.initialOpen === true);
  const snap = props.useCard((snapshot) => snapshot);
  // 快照的非空与 `value` 的空对象兜底都由 cardStore.getSnapshot() 负责（那才是真正的宿主
  // 边界：官方 ConfigForm.value 在首个快照受理前是 undefined）。到卡片这一层类型已是
  // CardSnapshot，此处再 `?.` / `?? {}` 就只是重复兜底。
  const { value } = snap;
  const writable = snap.status === "ready" && snap.writable;
  // 保存条状态：touched = 用户动过的字段（undefined = 恢复默认/unset）
  const [touched, setTouched] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const eff = (field: string): unknown => (field in touched ? touched[field] : value[field]);
  const dirty = diffTouched(touched, value).length > 0;
  const setField = (field: string, nextValue: unknown): void => {
    setTouched((entry) => ({ ...entry, [field]: nextValue }));
  };
  const clearField = (field: string): void => {
    setTouched((entry) => ({ ...entry, [field]: undefined }));
  };
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [ruleBusy, setRuleBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);

  // 展开即拉取。卡片组件保持「零直接 React hook」的形态（测试架直调组件函数读
  // createElement 产物，不存在 dispatcher），拉取逻辑提为模块层 reloadStats(sink)，
  // effect 与 save/onDone 直接调它——组件里既无 hook 也无不稳定闭包，exhaustive-deps
  // 的依赖全落在挂载期稳定位上，行为与旧实现一致：只在 open 翻转时拉一次。
  useEffect(() => {
    if (!open) {
      return;
    }
    void reloadStats({ t, setStats, setStatsError });
  }, [open, setStats, setStatsError, t]);

  const save = async (): Promise<void> => {
    const keys = diffTouched(touched, value);
    if (keys.length === 0) {
      return;
    }
    setBusy(true);
    setSaveError(null);
    try {
      await writeTouchedFields(props, touched, keys);
      setBusy(false);
      setTouched({});
      void reloadStats({ t, setStats, setStatsError });
    } catch (error) {
      setBusy(false);
      setSaveError(`${t("saveFailed")}${String(error instanceof Error ? error.message : error)}`);
      console.error("[lesson-loop] save failed:", error);
    }
  };
  const discard = (): void => {
    setTouched({});
    setSaveError(null);
  };

  const onDone = (ok: boolean, message?: string): void => {
    if (ok) {
      void reloadStats({ t, setStats, setStatsError });
    } else {
      setStatsError(message ?? t("actionFailed"));
    }
  };

  const toggleOpen = (): void => {
    setOpen(!open);
  };
  const view: CardView = {
    t,
    open,
    writable,
    statsError,
    saveError,
    busy,
    dirty,
    csrf: stats?.csrf ?? "",
    ruleBusy,
    showAll,
    groups: groupRules(stats?.rules ?? []),
    lessonsCount: stats?.lessonsCount,
    eff,
    setField,
    clearField,
    onDone,
    setRuleBusy,
    setShowAll,
    onSave: () => {
      void save();
    },
    onDiscard: discard,
    onToggle: toggleOpen,
  };
  return createElement(
    "li",
    { className: `llc-card${open ? " llc-card-open" : ""}` },
    renderCardHeader(view),
    open ? renderCardBody(view) : null,
  );
}

/**
 * 本卡用到的 ctx 面：三位里两位直接投影官方服务面，不再手抄签名。
 *
 * - `effect`：cordis 官方效应面（installed `@deepseek-ai/cordis/lib/types/fiber.d.ts:8`
 *   的 `interface Context extends Pick<Fiber, 'effect'>`，:157/:159 两个重载）。原先手抄的
 *   `(factory, label?) => void` 把「效应 disposer 可以 await」这条真实契约藏掉了。
 * - `slots`：官方 `SlotRegistry`（renderer 把它增强进 cordis `Context`）的**方法面投影**。
 *   取 `Pick` 而不是 `Context["slots"]` 整个类型：`SlotRegistry` 是带 private 字段的 cordis
 *   `Service` 类（installed `dsh-client-ui-renderer/lib/types/client/registry.d.ts:46`），
 *   TS 对它做名义比较，测试桩件无法满足。`register` 逐字复用 `SlotCore['register']`
 *   （`registry.d.ts:85`，两个重载），`inject` 是 `registry.d.ts:111` 的「按槽位声明
 *   生命周期装 effect」那一位（disposer 随 collapse 重跑工厂的语义就写在 :100）。合并进
 *   `SlotMap` 的槽位键在这里是**编译期受检**的：`inject`/`register` 的 key 参数域就是
 *   `keyof SlotMap & string`，而 `plugins.bundle.config` 那一枚由文件头那条 `import type`
 *   从属主包载入。
 *   ⚠ 与手抄版的差异全在类型面，本卡行为不变，但值得记下：
 *    ① 官方 `inject` 回一枚 idempotent disposer（手抄版是 `void`）；
 *    ② 官方工厂的返回面是 `SlotInjectionEffect`（`registry.d.ts:44`，那个联合没从 dts
 *      导出：`(() => void) | Iterable<() => void, void, void>`），**没有** `undefined`
 *      那一支——手抄版允许「工厂什么都不回收」，从今天起编译期就红；本卡交回的正是一枚
 *      `unregister`，形状不变；
 *    ③ `register` 的第二实参在官方是**受检的组件面**（`SlotCore['register']` 把组件 props
 *      对上 owner + inject + 标准席位合成出的 `ComposedProps`，dts 明写 "checked at this
 *      call site"），手抄版是 `view: unknown` = 什么都不查。
 * - `configForms`：只投影用到的 `get`。官方 `ConfigForms.get` 是泛型
 *   （`<T>(entryId) => ConfigForm<T>`，installed `config-form.d.ts:142`），且
 *   `ConfigForms` 同样是 Service 类 → 既不能整类型用，也不能把 `Pick` 交给桩件；这里把
 *   `T` 钉在本卡唯一取的那张表单上，返回面仍是官方 `ConfigForm`。
 * - `locale`：官方 `@deepseek-ai/dsh-client-locale` 的 client 面（`LocaleRuntime`，
 *   installed `lib/types/client/index.d.ts`）在本卡实际用到的那两条**类型化**重载上的
 *   投影，取在本包命名空间 `typeof NS` 上（`NS` 已 merge 进 `LocaleNamespaceMap`，见
 *   ui-messages.ts）：
 *   - `register`：官方 :199 那条，字典参数就是上面的 `LocaleCatalog`，两语必须一次交齐。
 *     ⚠ 不走官方 :209 那条未类型化的三参重载（`dict: LocaleDict = Record<string, string>`）：
 *     `UiMessages` 按 lint 的 `consistent-type-definitions` 必须是 `interface`，而
 *     interface 拿不到隐式索引签名，实测
 *     `Index signature for type 'string' is missing in type 'UiMessages'`。
 *   - `bind`：官方 :219 那条，结果即本包的 `Translate`（= `TranslateNS<'lesson-loop'>`）。
 *     ⚠ 不写成 `LocaleRuntime['bind']`：那会把官方**未类型化**的重载（:226，返回
 *     `Translate<string>`）一起带进目标类型，任何单一实现都满足不了两条（实测
 *     `Type 'string' is not assignable to type 'LocaleKeysOf<"lesson-loop">'`）。
 *     顺带白拿一条漂移保护：`NS` 与 merge 的命名空间键分叉时，`LocaleCatalog` 那一位先红。
 */
export interface ClientCtx {
  effect: Context["effect"];
  slots: Pick<SlotRegistry, "inject" | "register">;
  /** 0.1.7 的配置表单服务（installed
   *  `dsh-client-ui-settings/lib/types/client/config-form.d.ts:94-98` 交出
   *  `Context.configForms`，`get:142` 按 profile 条目 id 取那张共享表单）：取代已随宿主
   *  移除的 `settingsScope`（installed 全树零命中，继续注入它 = 整条 client 入口挂不上）。
   *  注入只需 `configForms` 本身——写侧的 `remote.settings` 由 provider 自己的 fiber 承担
   *  （同文件 :113-118 明写「letting a shared form write through the caller's context
   *  would make every caller declare `remote.settings`」，故此处不必声明）。 */
  configForms: {
    /** 只用 get 这一位，按方法面投影：官方 `ConfigForms` 是带 private 字段的 Service
     *  类，TS 名义比较下测试桩件无法满足。返回类型绑官方 `ConfigForm<...>`，快照字段
     *  改名/换类型即在本地编译失败。 */
    get: (entryId: string) => ConfigForm<Record<string, unknown>>;
  };
  locale: {
    register: (ns: typeof NS, dicts: LocaleCatalog) => () => void;
    bind: (ns: typeof NS) => Translate;
  };
}

function cardStore(scope: EntryForm): {
  getSnapshot: () => CardSnapshot;
  subscribe: (listener: () => void) => () => void;
} {
  // 缓存必须 per-scope（闭包内）：模块全局会在多 scope 交错 getSnapshot 时互相
  // 冲 memo，导致 useSyncExternalStore 每次拿到新引用 → 无限重渲染。
  let cachedSnap: ConfigFormSnapshot<Record<string, unknown>> | null = null;
  let cachedView: CardSnapshot | null = null;
  const EMPTY_SNAPSHOT: CardSnapshot = { status: "loading", writable: false, value: {} };
  return {
    getSnapshot() {
      const snap = scope.getSnapshot();
      if (snap !== cachedSnap) {
        cachedSnap = snap;
        cachedView = {
          status: snap.status,
          writable: snap.writable,
          // 官方 value 在首个快照受理前是 undefined，这里落到空对象供渲染。
          value: snap.value ?? {},
        };
      }
      return cachedView ?? EMPTY_SNAPSHOT;
    },
    subscribe(listener) {
      return scope.subscribe(listener);
    },
  };
}

const inject = ["slots", "configForms", "locale"];

function apply(ctx: ClientCtx): void {
  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.id = "lesson-loop-card-css";
    tag.textContent = CARD_CSS;
    document.head.append(tag);
    return () => {
      tag.remove();
    };
  }, "lesson-loop-card: styles");
  // 本包的共享表单：条目 id == cordis.patch.yml 里的裸 id `lesson-loop`（0.1.7 起
  // settings 命名空间即条目 id，注册是隐式的，插件侧不再有 register 那一步），与 host
  // 半 `Config` 投影出的那段同源，故直接复用 NS。
  const scope = ctx.configForms.get(NS);
  const store = cardStore(scope);
  // 卡片文案交给官方 locale：把本包两语字典**一次性**交给官方那条类型化 register 重载
  // （`Record<BuiltInLocaleId, LocaleDictOf<NS>>`，缺一门语言即编译期红；disposer 随
  // effect 回收），再 bind 出稳定的取文案函数交给卡片。语言切换由宿主驱动 slot 重渲染，
  // 无需重载页面。
  // ⚠ 这与旧的「zh / en 各调一次 register、闭包里收两个 disposer」是**同一条代码路径**：
  // installed `dsh-client-locale/lib/client.js:1379-1406` 的 `register(ns, localeOrDicts,
  // dict)` 在第二参不是字符串时走 `Object.entries(localeOrDicts)`，逐语校验标签与重复后
  // 写进同一张 `dicts.get(ns)` 表，返回的**一枚** disposer 把这批 locale 全删掉。故注册项
  // 数与回收范围都不变，只是一枚效应承载（旧写法要自己拼两个 disposer）。
  ctx.effect(() => ctx.locale.register(NS, UI_MESSAGES), "lesson-loop-card: locale dictionaries");
  const t = ctx.locale.bind(NS);
  ctx.slots.inject("plugins.bundle.config", () => {
    const unregister = ctx.slots.register(
      {
        // 0.1.6：settings.plugin.item 已删除；plugins.bundle.config 按 bundle 包名 keyed
        // （key 用 BUNDLE_PKG，**不是** NS——NS 只喂 configForms.get()，见文件头）。
        name: "plugins.bundle.config",
        key: BUNDLE_PKG,
        inject: () => ({
          t,
          hooks: { card: store },
          // 直通表单的写口：卡片 save() 自己 await + catch（传输失败才 reject，见 LlcCardProps）。
          set: (field: string, value: unknown) => scope.set(field, value),
          unset: (field: string) => scope.unset(field),
        }),
      },
      LlcCard,
    );
    // disposer 只 unregister()，**不 dispose 表单**：0.1.7 的 `configForms.get(entryId)`
    // 交回的是 provider 自己持有的那张共享表单（installed config-form.d.ts:138-142
    // "The entry's form, owned by this provider"），消费契约 `ConfigForm`
    // （config-form-types.d.ts:36-74）里根本没有 dispose。slot collapse 会调用本 disposer
    // 并在再次声明时**重跑工厂**（installed dsh-client-ui-renderer/lib/types/client/
    // registry.d.ts:100 "Collapse disposes the effect and a later declaration runs it
    // again"）——表单共享且长活，所以重跑后写入依然落盘；旧 `settingsScope` 那种「离开
    // 插件页一次之后 scope 永久 disposed、每次保存被静默丢弃」的坑（0.1.6 的 fiber 级
    // dispose）随该服务一起消失。
    return unregister;
  });
}

export {
  inject,
  apply,
  LlcCard,
  ToggleRow,
  NumberInputRow,
  RuleItem,
  SaveBar,
  cardStore,
  cardDescriptionText,
  buildConfigRows,
};
