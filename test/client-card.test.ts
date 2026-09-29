// 卡片文案契约（双语）。
//
// 装配面（apply：注册两语字典 / bind / 槽位 payload 带 t / 回收）用宿主假件直验；文案面
// 分两层：模块级纯函数（ruleMetaLines / saveBarStatus / buildConfigRows …）逐条钉串，
// 再由「整卡渲染」一节把外壳与五种状态的规则卡各渲染一遍，钉住两语的真实文本面。
//
// 为什么不挂 DOM：本包 devDependencies 里没有 jsdom / @testing-library（样板包 ctx-observe
// 有，本包没引也不该为测试新增依赖）。而卡片全部节点都是 createElement 产物（纯对象），
// 把 react 的两个钩子换成常量桩后函数组件就能就地调用，整棵树直接走读文本——渲染路径、
// 组件嵌套与真实浏览器里一致，只是不驱动状态迁移。样式 effect 用到的 document 走
// vi.stubGlobal。
/// <reference types="node" />
import { describe, it, afterEach, vi } from "vitest";
import type { ConfigFormSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";
import type { Context } from "@deepseek-ai/cordis";
import type { BuiltInLocaleId } from "@deepseek-ai/dsh-client-locale/client";
import type { LocaleDictOf } from "@deepseek-ai/dsh-client-ui-slots";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import {
  apply,
  buildConfigRows,
  cardDescriptionText,
  diffTouched,
  inject,
  LlcCard,
  retiredToggleText,
  RuleItem,
  ruleMetaLines,
  saveBarStatus,
  sectionHeadingText,
} from "../src/client-entry.ts";
import type { RuleCardView } from "../src/client-entry.ts";
import { UI_MESSAGES } from "../src/ui-messages.ts";
import type { LocaleNs, Translate, UiMessages } from "../src/ui-messages.ts";
// 卡片槽位 key 的单源桩件：bundle 包名直接读 ~/.dsh/profiles/web/package.json。
import { profileBundleName } from "./profile-bundle.ts";

// 只桩掉两个钩子（createElement 用真实实现）：见文件头的「为什么不挂 DOM」。
// 字符串说明符：react 替身桩无法用动态形态表达（@types/react 是 `export =`，
// 工厂返回类型要求带 `default` 位而类型面上没有），详见 memory-insight-card/test/insight-card.test.ts 同处注释。
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const patched = {
    ...actual,
    // 常量桩：初始值即渲染值（本测试只读文本面，不驱动状态迁移）。
    useState: (initial: unknown): [unknown, (next: unknown) => void] => [
      initial,
      (): undefined => undefined,
    ],
    useEffect: (): undefined => undefined,
  };
  // default 位不可省：`src/client-entry.ts` 用 default import 取 React，
  // 只铺命名导出会让它在运行时拿到 undefined。
  return { ...patched, default: patched };
});

const NS = "lesson-loop";

/** cordis.patch.yml 里的裸条目 id —— 0.1.7 的 settings 命名空间就是它（宿主读的是
 *  `entry.options.id`，见 installed dsh-settings/lib/index.js 的 `ns: entry.options.id`）。
 *  client 半向 `configForms.get(entryId)` 要的就是这个 id：读文件而不是抄常量，抄两处
 *  就会漂移（host.test.ts 的 patchEntryId 同款读法，那里钉 host 侧，这里钉卡片侧）。 */
function patchEntryId(): string {
  const yml = readFileSync(fileURLToPath(new URL("../cordis.patch.yml", import.meta.url)), "utf8");
  // 取那行 `- id: <裸条目 id>` 的值。不用捕获组：本文件的 lint 语境里
  // `groups["id"]` 被 dot-notation 规则拒（host.test.ts 的同名 helper 走它自己的
  // tsconfig 语境，不受这条约束），而强制命名组的那条规则又会拦匿名组，两头堵；
  // 前缀替换 + trim 同时绕开两者，判据不变（整行形状不对就当没有）。
  const line = yml.split("\n").find((item) => /^\s*-\s+id:\s*\S+\s*$/u.test(item));
  const id = line?.replace(/^\s*-\s+id:\s*/u, "").trim();
  assert.ok(typeof id === "string" && id !== "", "cordis.patch.yml 里没有裸 `- id:` 条目");
  return id;
}

/** 官方 locale 的 `{name}` 插值（宿主同语义）：测试里自己实现，不引宿主内部实现。 */
function fillTemplate(text: string, params: Record<string, unknown>): string {
  return text.replaceAll(/\{(?<key>\w+)\}/gu, (_all: string, key: string) => {
    const value = params[key];
    if (typeof value === "number") {
      return String(value);
    }
    return typeof value === "string" ? value : "";
  });
}

/**
 * 官方 locale 的取值语义（测试侧复刻）：本包字典命中即用，未命中回落**键名本身**
 * （官方 `LocaleRuntime.lookup` 在 active 语言与 fallback 链都 miss 后的行为）。
 * 表按 `Record<string, string>` 承载而不是 `UiMessages`：merge 进 `LocaleNamespaceMap`
 * 之后官方 `TranslateNS<NS>` 的键域是「本包键 ∪ `common` 命名空间键」（官方
 * `LocaleKeysOf`，installed `dsh-client-ui-slots/lib/types/index.d.ts:59`），按 `UiMessages`
 * 索引那条并集在编译期就红，而运行时真相是回落。展开成字面量是为了拿到隐式索引签名
 * （`UiMessages` 是 interface，本身给不出）。
 * ⚠ 本包改成官方 `Translate` 时实测到的红字就是这个形状：
 * `Element implicitly has an 'any' type because expression of type
 *  'LocaleKeysOf<"lesson-loop">' can't be used to index type 'UiMessages'.
 *   Property 'back' does not exist on type 'UiMessages'`
 * ——`back` 属于官方 `common` 词表，说明原先手抄的 `(key: keyof UiMessages, …) => string`
 * 比官方面**窄**：卡面上的 `t` 其实受理那枚并集，只是本包字典不认领其中的 common 键。
 */
function localeText(
  dict: Record<string, string>,
  key: string,
  params: Record<string, unknown>,
): string {
  return fillTemplate(dict[key] ?? key, params);
}

const zhTable: Record<string, string> = { ...UI_MESSAGES.zh };
const enTable: Record<string, string> = { ...UI_MESSAGES.en };

/** 中文 translator：断言里的中文串因此与 i18n 迁移前完全一致。 */
const tZh: Translate = (key, params) => localeText(zhTable, key, params ?? {});
/** 英文 translator：切语言 = 换 translator（卡片走同一条渲染路径）。 */
const tEn: Translate = (key, params) => localeText(enTable, key, params ?? {});

/** 模板里的 {占位符} 名字集合（本包 lib 目标无 toSorted，无序比较走 Set）。 */
function placeholders(template: string): Set<string> {
  return new Set(template.split(/[{}]/u).filter((piece) => /^\w+$/u.test(piece)));
}

/** 汉字检测：en 路径的"不残留中文"断言用（`\p{Script=Han}` 不含全角标点）。 */
const HAN = /\p{Script=Han}/u;

/**
 * 蒸馏建卡的 `origin` 取值（夹具数据位，不是被测常量）：卡片按它多渲染一行"来自
 * /lessons-digest"，zh / en / 整卡渲染三处各给一张这种卡。
 */
const DIGEST_ORIGIN = "lessons-digest";

function rule(over: Partial<RuleCardView> = {}): RuleCardView {
  return {
    id: "rule-1",
    project: "proj-6b906b9c",
    category: "gate-failure",
    signature: "pnpm check",
    // statement 是规则库里的用户数据：两语下都必须逐字出现。
    statement: "结束回合前先本地运行 pnpm check 自检",
    status: "candidate",
    createdAt: 1_700_000_000_000,
    occurrences: 3,
    violation: 1,
    suppressed: 7,
    samples: 40,
    undeterminable: false,
    origin: "threshold",
    ...over,
  };
}

/** buildConfigRows 产物里渲染点真正吃进去的三个字段。 */
interface RowView {
  field: string;
  label: string;
  hint: string;
}

/** 写入回调的哑目的：配置行只要渲染出文案，本测试不驱动保存。 */
function ignoreWrite(field: string, value: unknown): void {
  void field;
  void value;
}

/** 配置行取值：不挂载，直接读 createElement 产物的 props（行组件是纯 props 消费者）。 */
function configRows(translator: Translate): RowView[] {
  const nodes = buildConfigRows({
    t: translator,
    writable: true,
    eff: (): unknown => undefined,
    setField: (field: string, value: unknown): void => {
      ignoreWrite(field, value);
    },
    clearField: (field: string): void => {
      ignoreWrite(field, undefined);
    },
  }) as unknown as { props: RowView }[];
  return nodes.map((node) => {
    const { field, label, hint } = node.props;
    return { field, label, hint };
  });
}

const CONFIG_FIELDS = [
  "enabled",
  "reportEnabled",
  "injectEnabled",
  "sectionEnabled",
  "promoteThreshold",
  "demoteThreshold",
  "demoteMinSamples",
  "demoteRatio",
  "reviveThreshold",
  "decayDays",
  "maxLessonsBytes",
];

describe("配置行文案（settings 命名空间 lesson-loop 的运行时配置面）", () => {
  it("11 个设置字段各有 label/hint，且取自字典（中文与迁移前逐字一致）", () => {
    const rows = configRows(tZh);
    assert.deepEqual(
      rows.map((item) => item.field),
      CONFIG_FIELDS,
    );
    assert.equal(rows[0]?.label, "启用闭环");
    assert.equal(rows[4]?.label, "候选升格门槛（次）");
    assert.match(rows[0]?.hint ?? "", /\/lessons-digest/u);
    // 落盘串钉在**真实流水路径**上：host 写的是 cache/lesson-loop/events.jsonl
    // （host.ts:909-910），旧串 metrics/lessons.jsonl 那个文件根本不存在。
    assert.match(rows[1]?.hint ?? "", /cache\/lesson-loop\/events\.jsonl/u);
    for (const item of rows) {
      assert.notEqual(item.label, "");
      assert.notEqual(item.hint, "");
    }
  });

  it("en 翻译器：同一批字段整行换英文，不残留中文", () => {
    const rows = configRows(tEn);
    assert.deepEqual(
      rows.map((item) => item.field),
      CONFIG_FIELDS,
    );
    assert.equal(rows[0]?.label, "Enable the loop");
    // 同一件事的英文侧：换语言不许把路径换掉。
    assert.match(rows[1]?.hint ?? "", /cache\/lesson-loop\/events\.jsonl/u);
    // 保险丝钉的是**流水文件当前那个名字**：host 写的是 cache/lesson-loop/events.jsonl
    // （host.ts:909-910 `lessonsFile: cacheFile("events.jsonl")`），旧的
    // metrics/lessons.jsonl 已不存在，串还写着它就是卡面在承诺一段没人写的数据。
    // 精确等号（不是 includes）＝字典一改这里就红，逼着两处一起对齐。
    assert.equal(rows[10]?.label, "events.jsonl disk fuse (bytes)");
    for (const item of rows) {
      assert.doesNotMatch(item.label, HAN, `${item.field} 标题混进中文`);
      assert.doesNotMatch(item.hint, HAN, `${item.field} 说明混进中文`);
    }
  });
});

describe("规则评审区文案", () => {
  it("armed 卡的度量行、不可判定提示与来源标记（中文）", () => {
    const lines = ruleMetaLines(tZh, rule({ status: "armed" }));
    assert.equal(lines[0], "gate-failure · proj-6b906b9c", "首段是纯数据（分类 · 项目桶）");
    assert.equal(lines[1], "观察 3 次 · 2023-11-14");
    assert.equal(lines[2], "复发 1 / 遵守 7 / 暴露 40");
    assert.equal(lines.length, 3, "未标不可判定时不该多出第四条");
    assert.equal(
      ruleMetaLines(tZh, rule({ status: "armed", undeterminable: true }))[3],
      UI_MESSAGES.zh.metaUndeterminable,
    );
    assert.equal(
      ruleMetaLines(tZh, rule({ status: "rejected", recurrences: 2 }))[2],
      "拒绝后又出现 2 次（达阈值自动回候选）",
    );
    assert.equal(ruleMetaLines(tZh, rule({ origin: DIGEST_ORIGIN }))[2], "来自 /lessons-digest");
  });

  it("en：同一张卡整段换英文，规则数据（分类/桶键）逐字不改", () => {
    const lines = ruleMetaLines(tEn, rule({ status: "armed", undeterminable: true }));
    assert.equal(lines[0], "gate-failure · proj-6b906b9c");
    assert.equal(lines[1], "3 observations · 2023-11-14");
    assert.equal(lines[2], "1 violations / 7 followed / 40 exposed");
    assert.equal(lines[3], UI_MESSAGES.en.metaUndeterminable);
    for (const line of lines) {
      assert.doesNotMatch(line, HAN, "评审行的骨架文案不该混进中文");
    }
    assert.equal(
      ruleMetaLines(tEn, rule({ status: "rejected", recurrences: 2 }))[2],
      "Reappeared 2 time(s) after rejection (returns to candidates at the threshold)",
    );
    assert.equal(ruleMetaLines(tEn, rule({ origin: DIGEST_ORIGIN }))[2], "from /lessons-digest");
  });

  it("分节标题与「已拒绝/归档」按钮：中/英各按自己的括号形态", () => {
    assert.equal(sectionHeadingText(tZh, "降级待审", 2), "降级待审（2）");
    assert.equal(
      sectionHeadingText(tEn, "Demoted, awaiting review", 2),
      "Demoted, awaiting review (2)",
    );
    assert.equal(retiredToggleText(tZh, false, 3), "已拒绝/归档（3）");
    assert.equal(retiredToggleText(tZh, true, 3), "收起已拒绝/归档");
    assert.equal(retiredToggleText(tEn, false, 3), "Rejected / archived (3)");
    assert.equal(retiredToggleText(tEn, true, 3), "Hide rejected / archived");
  });

  it("卡片副标题：计数进模板；教训数未到达时是占位而不是 0", () => {
    assert.equal(
      cardDescriptionText(tZh, { candidates: 2, armed: 1, lessons: undefined }),
      "教训总线 + 规则评审（候选 2 · 生效 1 · 教训 … 条）",
    );
    assert.equal(
      cardDescriptionText(tEn, { candidates: 2, armed: 1, lessons: 9 }),
      "Lesson bus + rule review (2 candidates · 1 armed · 9 lessons)",
    );
  });

  it("保存条三态：只读 / 有改动 / 无改动（两语）", () => {
    assert.equal(saveBarStatus(tZh, { dirty: false, writable: true }), "无未保存的修改");
    assert.equal(
      saveBarStatus(tZh, { dirty: true, writable: true }),
      "有未保存的修改，点「保存」生效",
    );
    assert.equal(saveBarStatus(tZh, { dirty: true, writable: false }), "当前作用域只读");
    assert.equal(saveBarStatus(tEn, { dirty: false, writable: true }), "No unsaved changes");
    assert.equal(
      saveBarStatus(tEn, { dirty: true, writable: true }),
      "Unsaved changes — press Save to apply",
    );
    assert.equal(saveBarStatus(tEn, { dirty: true, writable: false }), "This scope is read-only");
  });

  it("touched 与快照的差异判定与语言无关（undefined 与缺失等价）", () => {
    assert.deepEqual(diffTouched({ decayDays: undefined }, {}), []);
    assert.deepEqual(diffTouched({ decayDays: undefined }, { decayDays: 5 }), ["decayDays"]);
    assert.deepEqual(diffTouched({ decayDays: 30 }, { decayDays: 30 }), []);
  });
});

// ── 整卡渲染（两语）：钩子打桩后走 createElement 产物，直读文本面 ──────────────
/** 对象守卫（遍历渲染树用；src 里的同名工具未导出）。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 渲染树取字段：字面量键走变量参数（dot-notation 与索引签名点访问互斥，src 同款处理）。
 */
function pickFrom(record: Record<string, unknown>, key: string): unknown {
  return record[key];
}

/**
 * 渲染节点 → 文本面：字符串/数字子节点收下，数组逐个走，**函数组件就地调用**
 * （react 钩子已是常量桩），DOM 元素递归 props.children。
 */
function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child: unknown): string => textOf(child)).join(" ");
  }
  const record = asRecord(node);
  if (record === null) {
    return "";
  }
  const props = asRecord(pickFrom(record, "props"));
  if (props === null) {
    return "";
  }
  const component = pickFrom(record, "type");
  if (typeof component === "function") {
    return textOf((component as (input: unknown) => unknown)(props));
  }
  return textOf(pickFrom(props, "children"));
}

/** 写入回调的哑目的（本测试不驱动保存）。0.1.7 的 `ConfigForm.set/unset` 回**受理位**
 *  （true=宿主接受；installed config-form-types.d.ts:62/:70），卡片目前不消费它
 *  （只有 reject 才算失败，见 src/client-entry.ts 的 LlcCardProps），故假件回 true。 */
const noWrite = async (): Promise<boolean> => true;
const noOp = (): void => {
  void 0;
};
/** useCard 假件：ready + writable 的快照原样递进 selector。 */
const useReadyCard = ((selector: (snap: unknown) => unknown): unknown =>
  selector({ status: "ready", writable: true, value: {} })) as never;

/** 整张设置卡（展开态）的文本面：标题 + 11 条配置行 + 保存条 + 四个评审分节。 */
function cardText(translator: Translate): string {
  return textOf(
    createElement(LlcCard, {
      t: translator,
      useCard: useReadyCard,
      set: noWrite,
      unset: noWrite,
      initialOpen: true,
    }),
  );
}

/** 单条规则卡（含动作按钮）的文本面。 */
function ruleText(translator: Translate, row: RuleCardView): string {
  return textOf(
    createElement(RuleItem, {
      t: translator,
      rule: row,
      csrf: "csrf-fake",
      busy: false,
      onDone: noOp,
      setBusy: noOp,
    }),
  );
}

/** 卡片外壳真正吃进去的字典键（这些串必须出现在渲染文本里）。 */
const SHELL_KEYS = [
  "cardTitle",
  "digestHint",
  "sectionCandidates",
  "sectionDemoted",
  "sectionArmed",
  "emptyGroup",
  "save",
  "revert",
  "statusClean",
] as const;

describe("整卡渲染（两语，直读 createElement 产物）", () => {
  it("zh：外壳把标题/11 条配置行/四段评审标题/保存条/蒸馏提示全渲染出来", () => {
    const text = cardText(tZh);
    for (const key of SHELL_KEYS) {
      assert.ok(text.includes(UI_MESSAGES.zh[key]), `${key} 该出现在中文卡面上`);
    }
    for (const row of configRows(tZh)) {
      assert.ok(text.includes(row.label), `${row.field} 的标题没进卡面`);
      assert.ok(text.includes(row.hint), `${row.field} 的说明没进卡面`);
    }
    assert.equal(text.includes(UI_MESSAGES.en.cardTitle), false, "中文卡面不该混进英文标题");
  });

  it("en：同一张卡整面换英文，一个汉字都不剩", () => {
    const text = cardText(tEn);
    for (const key of SHELL_KEYS) {
      assert.ok(text.includes(UI_MESSAGES.en[key]), `${key} 该出现在英文卡面上`);
    }
    for (const row of configRows(tEn)) {
      assert.ok(text.includes(row.label), `${row.field} 的英文标题没进卡面`);
      assert.ok(text.includes(row.hint), `${row.field} 的英文说明没进卡面`);
    }
    assert.doesNotMatch(text, HAN, "英文卡面残留中文＝有串没走字典");
  });

  it("en：动作按钮是英文，规则正文（规则库里的用户数据）逐字保留", () => {
    const row = rule({ status: "candidate", origin: DIGEST_ORIGIN });
    const text = ruleText(tEn, row);
    for (const label of [
      UI_MESSAGES.en.btnArmConfirm,
      UI_MESSAGES.en.btnDismiss,
      UI_MESSAGES.en.btnArchive,
      UI_MESSAGES.en.metaFromDigest,
    ]) {
      assert.ok(text.includes(label), `按钮/来源行该是英文：${label}`);
    }
    assert.ok(text.includes(row.statement), "规则正文是用户数据，绝不翻译");
    assert.ok(!text.includes(UI_MESSAGES.zh.btnArchive), "按钮文案不许漏回中文");
    assert.ok(!text.includes(UI_MESSAGES.zh.metaArmed), "度量行骨架不许漏回中文");
    assert.equal(text.includes(UI_MESSAGES.en.metaArmed), false, "candidate 卡没有 armed 度量行");
  });

  it("两语：五种状态的按钮组各自成套（同一渲染路径，只是 translator 不同）", () => {
    const cases: { status: RuleCardView["status"]; en: string[]; zh: string[] }[] = [
      {
        status: "armed",
        en: [UI_MESSAGES.en.btnDemote, UI_MESSAGES.en.btnArchive],
        zh: [UI_MESSAGES.zh.btnDemote, UI_MESSAGES.zh.btnArchive],
      },
      {
        status: "demoted",
        en: [UI_MESSAGES.en.btnArmConfirm, UI_MESSAGES.en.btnReject],
        zh: [UI_MESSAGES.zh.btnArmConfirm, UI_MESSAGES.zh.btnReject],
      },
      {
        status: "rejected",
        en: [UI_MESSAGES.en.btnRevive],
        zh: [UI_MESSAGES.zh.btnRevive],
      },
      {
        status: "archived",
        en: [UI_MESSAGES.en.btnRevive],
        zh: [UI_MESSAGES.zh.btnRevive],
      },
    ];
    for (const item of cases) {
      const row = rule({ status: item.status });
      const en = ruleText(tEn, row);
      for (const label of item.en) {
        assert.ok(en.includes(label), `${item.status} 的英文卡缺 ${label}`);
      }
      const zh = ruleText(tZh, row);
      for (const label of item.zh) {
        assert.ok(zh.includes(label), `${item.status} 的中文卡缺 ${label}`);
      }
      // 数据面两语一致：分类 · 项目桶 · 签名计数都在，规则正文一字不改
      assert.ok(en.includes(row.statement));
      assert.ok(zh.includes(row.statement));
    }
  });
});

// ── apply 接线（官方 locale 注册 + 槽位 payload 下发 t）───────────────────
/** slots.register 注入给卡片的 payload（渲染点真正吃进去的东西）。 */
interface CardPayload {
  t: Translate;
  hooks: { card: { getSnapshot: () => unknown; subscribe: () => () => void } };
  /** 直通 0.1.7 `ConfigForm` 的写口：`Promise<boolean>` = 受理位（installed
   *  config-form-types.d.ts:65 / :73），只有传输失败才 reject。 */
  set: (field: string, value: unknown) => Promise<boolean>;
  unset: (field: string) => Promise<boolean>;
}

interface FakeStyleTag {
  id: string;
  textContent: string;
  remove: () => void;
}

describe("apply 接线：两语字典注册与 translator 下发", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("register 两语 → bind 出 t → 槽位 payload 带 t；清理回收样式/locale/slot（表单是共享的，卡片不动它）", () => {
    const appended: FakeStyleTag[] = [];
    const removed: FakeStyleTag[] = [];
    const styleTag: FakeStyleTag = {
      id: "",
      textContent: "",
      remove: () => {
        removed.push(styleTag);
      },
    };
    vi.stubGlobal("document", {
      createElement: (): FakeStyleTag => styleTag,
      head: {
        append: (tag: FakeStyleTag): void => {
          appended.push(tag);
        },
      },
    });
    /** apply 期间注册进官方 locale 的字典（命名空间 + 语言 + 该语字典），供双语断言。
     *  官方 `register` 的类型化重载**一次交齐两语**（installed
     *  `dsh-client-locale/lib/types/client/index.d.ts:199`），桩件按语言摊平成逐语记录，
     *  好让下面的断言与旧的「两语各注册一次」逐字同形。字典面直接绑官方
     *  `LocaleDictOf<本包命名空间>`：本包少一个键、多一个键都先在桩件这里编译失败。 */
    const registered: {
      ns: string;
      localeId: string;
      dict: LocaleDictOf<LocaleNs>;
    }[] = [];
    const localeRows: [string, string][] = [];
    const boundNs: string[] = [];
    /** apply 向 `configForms.get()` 要过哪些条目 id（0.1.7：条目 id == 命名空间）。 */
    const formEntryIds: string[] = [];
    const slotNames: string[] = [];
    const disposed: string[] = [];
    let payload: CardPayload | null = null;
    let view: unknown = null;
    const scope = {
      // 官方 `ConfigFormSnapshot` 七位全必选（value/revision 只在「首个快照尚未受理」
      // 时为 undefined），照官方形状给，不再自造三位小快照。
      getSnapshot: (): ConfigFormSnapshot<Record<string, unknown>> => ({
        status: "ready",
        value: { enabled: true },
        base: {},
        user: { enabled: true },
        revision: 3,
        writable: true,
        mode: "host",
      }),
      subscribe: (): (() => void) => (): undefined => undefined,
      set: async (): Promise<boolean> => true,
      unset: async (): Promise<boolean> => true,
      // 官方 ConfigForm 的第五位（路径级原子写入）：本卡不走它，但类型面要求在位。
      mutate: async (): Promise<boolean> => true,
      // 假件**留着** dispose 这根绊线：0.1.7 的消费契约 `ConfigForm`
      // （installed config-form-types.d.ts:36-74）里没有 dispose，卡片一旦去销毁
      // provider 持有的那张共享表单，下面 disposed 的精确全等清单就会多出 "scope"。
      dispose: (): void => {
        disposed.push("scope");
      },
    };
    /**
     * 假件按 `apply` 的入参面构造：`effect` / `slots` 在 ClientCtx 里已是**官方**服务投影
     * （cordis `Context["effect"]` 与 `Pick<SlotRegistry, "inject" | "register">`），所以
     * 生产侧签名一漂移就红在编译期，而不是跑到一半才崩。两处不得已的显式标注：
     *  - `effect`：官方是**两**个重载（同步 `Disposable<Promise<void>>` 与可 await 的
     *    `AsyncDisposable<Promise<void>>`，后者还是 PromiseLike），单个箭头签名同时满足
     *    不了两边（实测 TS2345：`Type 'SyncEffect<any>' is not assignable to type
     *    '(() => void) | undefined'`，因为官方那一支还允许 `Iterable<Disposable>`），故
     *    一次性投影到官方面：假件只回收同步 disposer，那个返回面没人消费；
     *  - `register`：官方是**双重载**（`inject?: undefined` 与 `inject: (…) => I`），
     *    重载目标推不出上下文参数类型（TS7006），故按 `unknown` 收、在桩内一次性投影回
     *    本卡实际传的那一重载。
     */
    const ctx: Parameters<typeof apply>[0] = {
      effect: ((factory: () => (() => void) | undefined): void => {
        const teardown = factory();
        teardown?.();
      }) as Context["effect"],
      slots: {
        // 官方 `SlotRegistry.inject(key, callback)`：key 的取值域就是合并后的 `SlotMap`，
        // 本卡的 `plugins.bundle.config` 能出现在这里靠的是 src 侧载入的属主包 merge；
        // 返回的是一枚 idempotent disposer（旧手抄面写 `void`，把这一步藏掉了）。
        // 参数名不叫 `callback`（那会撞 eslint `callback-return` / `prefer-await-to-callbacks`）。
        inject: (key, install) => {
          slotNames.push(key);
          // 官方 `SlotInjectionEffect` = 一枚 disposer 或一组 disposer（这里是前者）。
          const teardown = install();
          if (typeof teardown === "function") {
            teardown();
          }
          return (): void => void 0;
        },
        register: (options: unknown, component: unknown): (() => void) => {
          const desc = options as {
            name: string;
            key?: string;
            inject: () => Record<string, unknown>;
          };
          // key 必须是 **bundle 包名**（宿主按包名派发 plugins.bundle.config，真源读
          // profile 清单，见 test/profile-bundle.ts）；这里刻意不写 NS —— `key === NS`
          // 是同义反复，NS 改成什么都会跟着绿，正是本缺陷当初漏网的形状。
          assert.equal(desc.key, profileBundleName(), "卡片按 bundle 包名 keyed");
          assert.notEqual(desc.key, NS, "key 写成裸条目 id = 插件页永不出卡");
          payload = desc.inject() as unknown as CardPayload;
          view = component;
          return (): void => {
            disposed.push("slot");
          };
        },
      },
      configForms: {
        get: (entryId: string): typeof scope => {
          formEntryIds.push(entryId);
          return scope;
        },
      },
      locale: {
        // 官方**类型化**那条 register：两语一次交齐、回**一枚** disposer。旧写法是逐语
        // 三参 + 两个 disposer，宿主侧走的正是同一个 `Object.entries(dicts)` 分支
        // （installed dsh-client-locale/lib/client.js:1379-1406），故这里按语言摊平记录、
        // 把那枚 disposer 逐项展开，下面的断言逐字不改。
        register: (ns, dicts: Record<BuiltInLocaleId, LocaleDictOf<LocaleNs>>): (() => void) => {
          for (const [localeId, dict] of Object.entries(dicts)) {
            registered.push({ ns, localeId, dict });
            localeRows.push([ns, localeId]);
          }
          return (): void => {
            for (const localeId of Object.keys(dicts)) {
              disposed.push(`locale:${localeId}`);
            }
          };
        },
        bind: (ns): Translate => {
          boundNs.push(ns);
          return tZh;
        },
      },
    };
    apply(ctx);

    // 卡片要的是**本条目那张**共享表单，且只取一次（0.1.7 没有 register 声明 ns 这一步：
    // 命名空间 = profile 条目 id）。取错 id 的形状是「卡片能打开、保存却写进别的条目」，
    // 故两侧都钉：卡片侧的常量 NS 与包体里的条目 id 必须同源。
    assert.deepEqual(formEntryIds, [NS], "设置卡仍绑自己那一段（条目 id == 命名空间）");
    assert.equal(NS, patchEntryId(), "卡片绑的段与 cordis.patch.yml 的条目 id 不一致");
    assert.deepEqual(
      localeRows,
      [
        [NS, "zh"],
        [NS, "en"],
      ],
      "两语字典都注册到官方 locale",
    );
    assert.equal(registered[0]?.dict.cardTitle, UI_MESSAGES.zh.cardTitle);
    assert.equal(registered[1]?.dict.cardTitle, UI_MESSAGES.en.cardTitle);
    assert.deepEqual(boundNs, [NS], "bind 取本包命名空间的 translator");
    assert.deepEqual(slotNames, ["plugins.bundle.config"]);
    assert.equal(typeof view, "function", "卡片组件注册进槽位");
    const injected = payload as unknown as CardPayload;
    assert.equal(injected.t, tZh, "translator 经 slots.register 的 payload 下发");
    assert.equal(typeof injected.hooks.card.getSnapshot, "function", "卡片 store 随 payload 下发");
    assert.equal(typeof injected.set, "function");
    assert.equal(typeof injected.unset, "function");
    // 下发的 translator 直接吃官方字典：同一渲染点换成 tEn 就是整卡换语言
    assert.equal(injected.t("cardTitle"), UI_MESSAGES.zh.cardTitle);
    // 回收顺序即 apply 的注册顺序：样式 → locale 两语 → 槽位。槽位的 disposer 只注销，
    // **不再** dispose 表单——0.1.7 的 `configForms.get(entryId)` 交回的是 provider 持有的
    // 共享表单（installed config-form.d.ts:138-142，实例按 entryId 缓存在 provider 的
    // forms 表里），消费契约 `ConfigForm`（config-form-types.d.ts:36-74）里根本没有
    // dispose；slot collapse 会跑本 disposer 再重跑工厂（installed
    // dsh-client-ui-renderer/lib/types/client/registry.d.ts:100），卡片自己销毁表单 =
    // 重挂之后写入永久静默丢弃（0.1.6 那个坑）。假件上的 dispose 绊线仍在：清单里
    // 出现 "scope" 即红。
    assert.deepEqual(
      disposed,
      ["locale:zh", "locale:en", "slot"],
      "清理逐项回收，一项不落，也不许多回收那张共享表单",
    );
    assert.equal(appended.length, 1, "样式已注入");
    assert.equal(removed.length, 1, "样式 disposer 已把它移除");
  });

  it("inject 声明含 locale 与 configForms（宿主据此把官方能力注进 client 半）", () => {
    assert.ok(inject.includes("locale"), "缺了 locale 宿主就不会注入该能力");
    assert.ok(inject.includes("slots"));
    // configForms 取代 0.1.6 的 settingsScope（该服务在 installed 0.1.7 全树零命中，
    // 继续注入它 = 整条 client 入口挂不上）：契约源 installed
    // dsh-client-ui-settings/lib/types/client/config-form.d.ts:94-98（Context 增强）
    // 与 :142（get(entryId)）。
    assert.ok(inject.includes("configForms"), "缺了 configForms 卡片拿不到写口，保存整条静默失败");
    // 精确全等清单（不只是包含判定）：多一项 = 白要宿主能力，少一项 = apply 里读到 undefined。
    assert.deepEqual(inject, ["slots", "configForms", "locale"]);
  });
});

// ── i18n：字典自身的两语完整性（卡片渲染点全部由这些键驱动）──────────────
/** 动态键收窄成本包字典键（Object.keys 出来的是 string）。 */
function keyOf(name: string): keyof UiMessages {
  return name as keyof UiMessages;
}

describe("卡片字典双语完整性", () => {
  const zhKeys = Object.keys(UI_MESSAGES.zh);
  const enKeys = Object.keys(UI_MESSAGES.en);

  it("两语键集一致且值非空（tsc 已保证形状，这里连值一起钉）", () => {
    assert.equal(zhKeys.length, enKeys.length);
    for (const key of zhKeys) {
      assert.ok(enKeys.includes(key), `en 缺键 ${key}`);
      assert.notEqual(UI_MESSAGES.zh[keyOf(key)].trim(), "");
      assert.notEqual(UI_MESSAGES.en[keyOf(key)].trim(), "");
    }
  });

  it("en 字典整表不残留中文（切英文不是一半中文一半英文）", () => {
    for (const key of enKeys) {
      assert.doesNotMatch(UI_MESSAGES.en[keyOf(key)], HAN, `${key} 的英文串里混进了中文`);
    }
  });

  it("两语模板的 {占位符} 集合一致（翻译不会漏掉插值）", () => {
    const templated = zhKeys.filter((key) => placeholders(UI_MESSAGES.zh[keyOf(key)]).size > 0);
    assert.ok(templated.length >= 5, "带插值的键不该只有寥寥几条");
    for (const key of templated) {
      const zhSet = placeholders(UI_MESSAGES.zh[keyOf(key)]);
      const enSet = placeholders(UI_MESSAGES.en[keyOf(key)]);
      assert.equal(zhSet.size, enSet.size, `${key} 占位符数量不一致`);
      for (const name of zhSet) {
        assert.ok(enSet.has(name), `${key} 缺占位符 ${name}`);
      }
    }
  });
});
