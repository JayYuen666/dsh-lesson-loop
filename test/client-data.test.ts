// client 半的**数据面**契约测试：stats 拉取、rule-action 提交、原子保存、输入纠偏、
// 未知状态可见性。client-card.test.ts 把 react 两个钩子换成常量桩，只读
// 文本面，onClick/onChange 从不触发，状态迁移（open/touched/busy/error）一条都没跑过。
//
// 这里换一个**有状态**的最小钩子运行时（仍是 vi.mock("react")，createElement 用真实现）：
// useState 按 hook 次序存槽、setter 触发同组件重渲，useEffect 按 deps 变化重跑。于是
// 「展开即拉取 → 回包落进卡片」「保存被拒 → 草稿仍在且出错误条」这些链路真的跑起来。
// 不挂 DOM（本包没有 jsdom 依赖）：树是 createElement 产物，函数组件按渲染顺序展开成宿主
// 元素，再按 props 找控件、直调它们的回调。
/// <reference types="node" />
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import type { ReactNode } from "react";
import { LlcCard, NumberInputRow } from "../src/client-entry.ts";
import type { CardSnapshot, RuleCardView } from "../src/client-entry.ts";
import { UI_MESSAGES } from "../src/ui-messages.ts";
import type { Translate } from "../src/ui-messages.ts";
import type { RulesReader } from "../src/rules-reader.ts";

type Props = Record<string, unknown>;

/** 有状态钩子运行时：槽位按 hook 次序分配（React 的规则），setter 触发重渲。
 *  ⚠ setter 身份必须**跨渲染稳定**（React 的保证）：卡片把 setStats/setStatsError 放进
 *  useEffect 的 deps，每次渲染换一枚新闭包会让 effect 每轮重跑 → 拉取→setState→重渲
 *  无限自激（这条链真挂过：worker 被 SIGABRT 杀掉）。 */
const runtime = vi.hoisted(() => {
  const box = {
    /** 每个 hook 序号一个槽（useState 的值与 setter / useEffect 的 deps 与 cleanup）。 */
    values: [] as unknown[],
    /** useRef 的槽与 useState 分开存：ref 槽里是恒定的盒对象，不会与任何 useState
     *  的值形态（字符串/数字）撞在同一个序号上。 */
    refs: [] as ({ current: unknown } | undefined)[],
    setters: [] as (((next: unknown) => void) | undefined)[],
    deps: [] as (readonly unknown[] | undefined)[],
    cleanups: [] as ((() => void) | undefined)[],
    cursor: 0,
    renders: 0,
    rerender: undefined as (() => void) | undefined,
  };
  return { box };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { box } = runtime;
  const useState = <State>(
    initial: State | (() => State),
  ): [State, (next: State | ((prev: State) => State)) => void] => {
    const index = box.cursor;
    box.cursor += 1;
    if (!(index in box.values)) {
      box.values[index] = typeof initial === "function" ? (initial as () => State)() : initial;
      box.setters[index] = (next: unknown): void => {
        const previous = box.values[index] as State;
        box.values[index] =
          typeof next === "function" ? (next as (prev: State) => State)(previous) : next;
        box.rerender?.();
      };
    }
    return [
      box.values[index] as State,
      box.setters[index] as (next: State | ((prev: State) => State)) => void,
    ];
  };
  const useEffect = (effect: () => (() => void) | undefined, deps?: readonly unknown[]): void => {
    const index = box.cursor;
    box.cursor += 1;
    const prev = box.deps[index];
    const stable =
      prev !== undefined &&
      deps !== undefined &&
      prev.length === deps.length &&
      prev.every((item, at) => Object.is(item, deps[at]));
    if (stable) {
      return;
    }
    box.deps[index] = deps === undefined ? undefined : [...deps];
    const cleanup = box.cleanups[index];
    if (cleanup !== undefined) {
      cleanup();
    }
    box.cleanups[index] = effect();
  };
  const useRef = <RefValue>(initial: RefValue): { current: RefValue } => {
    const index = box.cursor;
    box.cursor += 1;
    if (!(index in box.refs)) {
      box.refs[index] = { current: initial };
    }
    return box.refs[index] as { current: RefValue };
  };
  const patched = { ...actual, useState, useEffect, useRef };
  return { ...patched, default: patched };
});

/** 一次挂载：draw 重跑组件（state setter 会就地触发），expand 把函数组件展开成宿主元素。 */
interface Mounted {
  tree: () => ReactNode;
  text: () => string;
  settle: () => Promise<void>;
}

/** 树节点的 props：本卡用到的几枚键逐个列出（收窄成具体接口，故 `props.onClick` 这类
 *  点访问在 TS 的 noPropertyAccessFromIndexSignature 下也合法；键名带连字符的 `data-field`
 *  按中括号读）。 */
interface NodeProps {
  children?: unknown;
  className?: unknown;
  "data-field"?: unknown;
  value?: unknown;
  disabled?: unknown;
  onClick?: unknown;
  onChange?: unknown;
  onBlur?: unknown;
}

/** 对象（非 null、非数组）判据 → 节点 props 的类型收窄（不做断言：谓词函数即可）。 */
function isNodeProps(value: unknown): value is NodeProps {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 读一个 unknown 上的成员（树是 createElement 产物，按 unknown 面读）。 */
function fieldOf(value: unknown, key: string): unknown {
  return isNodeProps(value) ? Reflect.get(value, key) : undefined;
}

/** 节点的 props（非对象一律 undefined）。 */
function propsOf(node: unknown): NodeProps | undefined {
  const props = fieldOf(node, "props");
  return isNodeProps(props) ? props : undefined;
}

/** 断言取到的项非空并交出它。
 *  TS 的 noUncheckedIndexedAccess 给数组下标 `T | undefined`，而 lint 的类型模型当它是 `T`
 *  ——把判空收进这枚泛型守卫，两边都不用改口径。 */
function expectItem<Item>(value: Item | undefined, message: string): Item {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

/** 把 `createElement(ToggleRow, …)` 这类元素替换成它自己的输出，递归往下。
 *
 *  不这么做树里只剩宿主元素（"div"），子组件（配置行、规则卡）的文本与控件一个都取不到，
 *  而它们恰恰是本层要验的。展开顺序 = React 的渲染顺序（深度优先），故 hook 槽位次序与
 *  真实渲染一致。 */
function expand(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((child: unknown) => expand(child));
  }
  if (typeof node !== "object" || node === null) {
    return node;
  }
  const type: unknown = Reflect.get(node, "type");
  if (typeof type === "function") {
    return expand(Reflect.apply(type, undefined, [fieldOf(node, "props")]));
  }
  const props = propsOf(node);
  return { type, props: { ...props, children: expand(props?.children) } };
}

/** 渲染树的文本面（树已展开成宿主元素，只吃字符串与数字子节点）。 */
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child: unknown) => textOf(child)).join("");
  }
  return textOf(propsOf(node)?.children);
}

/** 收集树里所有节点的 props（逐层走 children）。 */
function allProps(node: unknown): NodeProps[] {
  const out: NodeProps[] = [];
  const walk = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const child of current) {
        walk(child);
      }
      return;
    }
    const props = propsOf(current);
    if (props === undefined) {
      return;
    }
    out.push(props);
    walk(props.children);
  };
  walk(node);
  return out;
}

/** 按 `data-field` 找控件（卡片与配置行的稳定锚点）。 */
function controlOf(tree: unknown, field: string): NodeProps {
  const found = allProps(tree).filter((props) => props["data-field"] === field);
  assert.equal(found.length, 1, `卡面上 ${field} 控件该有且只有一个`);
  return expectItem(found[0], `卡面上找不到 ${field} 控件`);
}

/** 挂一个函数组件并拿到渲染树与重渲后的取树口。 */
function mount(component: (props: never) => ReactNode, props: Props): Mounted {
  let current: ReactNode = null;
  const draw = (): void => {
    runtime.box.renders += 1;
    // 渲染次数上限：effect↔setState 自激时立刻红，而不是把 worker 拖到 OOM（见运行时注释）。
    if (runtime.box.renders > 200) {
      throw new Error("render loop: 200 renders without settling — effect/setter identity drifted");
    }
    runtime.box.cursor = 0;
    current = expand(component(props as never)) as ReactNode;
  };
  runtime.box.rerender = draw;
  draw();
  return {
    tree: () => current,
    text: () => textOf(current),
    // 一次宏任务边界：把 fetch/回包链上的微任务排干（setState 会就地重渲）。
    settle: async (): Promise<void> => {
      await delay(0);
    },
  };
}

/** 清空 hook 槽与渲染计数（上一条用例的槽位不能漏进下一条）。 */
function resetHooks(): void {
  runtime.box.values = [];
  runtime.box.setters = [];
  runtime.box.deps = [];
  runtime.box.cleanups = [];
  runtime.box.cursor = 0;
  runtime.box.renders = 0;
  runtime.box.rerender = undefined;
}

/** 中文 translator（与 client-card.test.ts 同源字典；模板占位符用命名组替换）。 */
const tZh: Translate = (key, params) => {
  const template = (UI_MESSAGES.zh as Record<string, string>)[key as string] ?? key;
  return template.replaceAll(/\{(?<name>\w+)\}/gu, (whole: string, name: string) => {
    const value: unknown = params?.[name];
    return typeof value === "string" || typeof value === "number" ? String(value) : whole;
  });
};

/** 规则正文夹具（多处断言引用同一串：单点定义，改一处即全库生效）。 */
const STATEMENT_GATE_CHECK = "结束回合前先本地运行 pnpm check 自检";

/** 树里已渲染的规则卡张数（RuleItem 的宿主元素锚点）。 */
const cardCountOf = (tree: unknown): number =>
  allProps(tree).filter((props) => props.className === "llc-rule").length;

/** 「加载更多」按钮：按插值后的整行文案找（{count} 是剩余条数）。 */
const moreButtonsOf = (tree: unknown, count: number): NodeProps[] =>
  allProps(tree).filter(
    (props) =>
      typeof props.onClick === "function" && textOf(props.children) === tZh("loadMore", { count }),
  );

/** 卡片副标题那一行（llc-desc 节点的文本）。 */
const descOf = (tree: unknown): string => {
  const desc = allProps(tree).find((props) => props.className === "llc-desc");
  assert.ok(desc !== undefined, "卡面必须有副标题");
  return textOf(desc.children);
};

/** 一条 stats 规则行（字段与 host 的 RuleView 投影同形）。 */
function ruleRow(over: Partial<RuleCardView> = {}): RuleCardView {
  return {
    id: "rule-1",
    project: "proj-6b906b9c",
    category: "gate-failure",
    signature: "pnpm check",
    statement: STATEMENT_GATE_CHECK,
    status: "armed",
    statusText: "armed",
    createdAt: 1_700_000_000_000,
    occurrences: 3,
    violation: 1,
    suppressed: 7,
    samples: 4,
    undeterminable: false,
    origin: "threshold",
    ...over,
  };
}

/** 一次 stats 回包的形状（卡片按它的逐字段投影读）。 */
function statsBody(over: Props = {}): Props {
  return {
    ok: true,
    rules: [ruleRow()],
    lessonsCount: 5,
    ...over,
  };
}

/** Response 替身：只给卡片真正用到的 json()（读不出一屏对象时让它抛错，演服务侧回了非 JSON 的那一臂）。 */
interface JsonResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function jsonResponse(body: unknown, status = 200): JsonResponse {
  return {
    ok: status < 400,
    status,
    json: async () => body,
  };
}

/** 夹具自己的分支标签（不是路由）：数据面两个方法各一枚。 */
const STATS_CALL = "stats";
const ACTION_CALL = "rule-action";

/** 一次夹具调用的记账（标签 + 适配器自己的 init 形状）。生产代码走 `RulesReader`，不经 fetch；
 *  这里的标签只是本文件内的分支判据，不是任何路由。 */
interface FetchCall {
  url: string;
  init?: { method?: string; headers?: Record<string, string>; body?: string } | undefined;
}

/** 夹具替身：记下每次调用，按标签分别答复（stats 与 rule-action 常要不同回包）。 */
function fetchStubOf(reply: (url: string) => Promise<unknown>): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fake = async (url: string, init?: FetchCall["init"]): Promise<unknown> => {
    calls.push({ url, init });
    return reply(url);
  };
  return { fetch: fake as unknown as typeof fetch, calls };
}

/** 卡片固定输入：useCard 读一张可控快照（revision 是 save 的 CAS 栅栏）。 */
/**
 * 测试适配器：把既有的 fetch 替身接到 `RulesReader` 的四枚方法上。URL 与 init 都是夹具内部的
 * 记账形状——生产代码调的是读面方法，不经 fetch，所以断言不拿这些字符串当被验对象。
 */
function readerFromFetch(): RulesReader {
  return {
    stats: async () => {
      const res = await fetch(STATS_CALL);
      return (await res.json()) as Record<string, unknown>;
    },
    rules: async () => ({ ok: true, rules: [] }),
    lessons: async () => ({ ok: true, count: 0, lessons: [] }),
    ruleAction: async (id, action, statement) => {
      const res = await fetch(ACTION_CALL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, action, ...(statement === undefined ? {} : { statement }) }),
      });
      return (await res.json()) as never;
    },
  };
}

function cardProps(
  snapshot: CardSnapshot,
  mutate: (ops: readonly unknown[], revision?: number) => Promise<boolean>,
): Props {
  return {
    t: tZh,
    useCard: (selector: (snap: CardSnapshot) => unknown): unknown => selector(snapshot),
    mutate,
    rulesRemote: readerFromFetch(),
    initialOpen: true,
  };
}

const READY: CardSnapshot = {
  status: "ready",
  writable: true,
  value: { enabled: true },
  revision: 7,
};

/** 保存的受理位记录（模块级：不随用例重建）。 */
interface MutateCall {
  ops: readonly unknown[];
  revision: number | undefined;
}

describe("client 数据面：stats 拉取与回包呈现", () => {
  beforeEach(resetHooks);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("展开即拉 stats：规则与计数落进卡片（用户数据逐字出现，不被翻译）", async () => {
    const stub = fetchStubOf(async () => jsonResponse(statsBody()));
    vi.stubGlobal("fetch", stub.fetch);
    const card = mount(
      LlcCard as never,
      cardProps(READY, async () => true),
    );
    await card.settle();

    assert.equal(stub.calls.length, 1, "展开时拉一次 stats");
    const text = card.text();
    assert.ok(
      text.includes("结束回合前先本地运行 pnpm check 自检"),
      "规则正文是用户数据，原样渲染",
    );
    assert.equal(text.includes(UI_MESSAGES.zh.statsUnavailable), false, "回包正常时不出错误条");
    assert.ok(text.includes("proj-6b906b9c"), "项目桶随规则行渲染");
  });

  it("读面抛错（例如命名空间没挂上）→ 本地化兜底，不把内部错误原文贴给用户", async () => {
    const parseError = new Error("gateway/internal: namespace not mounted");
    vi.stubGlobal(
      "fetch",
      fetchStubOf(async () => {
        throw parseError;
      }).fetch,
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {
      // 断言在下方
    });
    const card = mount(
      LlcCard as never,
      cardProps(READY, async () => true),
    );
    await card.settle();

    const text = card.text();
    assert.ok(text.includes(UI_MESSAGES.zh.statsUnavailable), "错误条要说本卡的话");
    assert.equal(text.includes("Unexpected token"), false, "解析异常原文不许进 UI");
    assert.match(
      error.mock.calls.map(String).join("\n"),
      /stats request failed/u,
      "原文只进日志，供排查",
    );
    error.mockRestore();
  });

  it("防御路径：stats 载荷带 ok:false 时出错误条（当前宿主恒回 ok:true，这条守着换实现）", async () => {
    vi.stubGlobal(
      "fetch",
      fetchStubOf(async () => jsonResponse({ ok: false, error: "rules-not-persisted" })).fetch,
    );
    const card = mount(
      LlcCard as never,
      cardProps(READY, async () => true),
    );
    await card.settle();
    assert.ok(card.text().includes("rules-not-persisted"), "服务侧 error 原样呈现");
  });

  it("规则卡渲染 signature：判「管的是哪条命令/路径」的那枚数据不再丢", async () => {
    vi.stubGlobal(
      "fetch",
      fetchStubOf(async () =>
        jsonResponse(statsBody({ rules: [{ ...ruleRow(), signature: "git commit --no-verify" }] })),
      ).fetch,
    );
    const card = mount(
      LlcCard as never,
      cardProps(READY, async () => true),
    );
    await card.settle();
    const text = card.text();
    assert.ok(text.includes("git commit --no-verify"), "签名是数据，原样显示");
    assert.ok(text.includes(STATEMENT_GATE_CHECK), "正文与签名各占一行");
  });

  it("signature 为空串时不出一条空行（不渲染空节点）", async () => {
    vi.stubGlobal(
      "fetch",
      fetchStubOf(async () => jsonResponse(statsBody({ rules: [{ ...ruleRow(), signature: "" }] })))
        .fetch,
    );
    const card = mount(
      LlcCard as never,
      cardProps(READY, async () => true),
    );
    await card.settle();
    assert.deepEqual(
      allProps(card.tree()).filter((props) => props.className === "llc-rule-sig"),
      [],
      "空签名不占位",
    );
  });
});

describe("client 数据面：数值字段的同一容忍度", () => {
  beforeEach(resetHooks);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("非空数字字符串读得进：lessonsCount 与规则行的 occurrences 同一口径", async () => {
    vi.stubGlobal(
      "fetch",
      fetchStubOf(async () =>
        jsonResponse(statsBody({ lessonsCount: "7", rules: [{ ...ruleRow(), occurrences: "3" }] })),
      ).fetch,
    );
    const card = mount(
      LlcCard as never,
      cardProps(READY, async () => true),
    );
    await card.settle();
    assert.ok(descOf(card.tree()).includes("7"), "副标题的总数收数字字符串");
    assert.ok(card.text().includes("观察 3 次"), "规则行的计数也收数字字符串");
  });

  it("空白串不是 0：lessonsCount 留占位符，不虚报 0 条教训", async () => {
    vi.stubGlobal(
      "fetch",
      fetchStubOf(async () => jsonResponse(statsBody({ lessonsCount: "  " }))).fetch,
    );
    const card = mount(
      LlcCard as never,
      cardProps(READY, async () => true),
    );
    await card.settle();
    assert.ok(
      descOf(card.tree()).includes("…"),
      '空白串按漂移处理（Number("  ") 是 0，收下就等于虚报「0 条教训」）',
    );
  });
});

describe("client 数据面：rule-action 提交（入参与回执）", () => {
  beforeEach(resetHooks);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("动作按钮按规则 id 提交 `{ id, action }`；回执 ok:false 时显示服务侧文案", async () => {
    const stub = fetchStubOf(async (url) =>
      url === ACTION_CALL
        ? jsonResponse({ ok: false, error: "rule library refused the write" })
        : jsonResponse(statsBody()),
    );
    vi.stubGlobal("fetch", stub.fetch);
    const card = mount(
      LlcCard as never,
      cardProps(READY, async () => true),
    );
    await card.settle();

    // armed 卡的动作行里那枚"停用待审"按钮（按文案定位：按钮节点上带 onClick）。
    const actionText = UI_MESSAGES.zh.btnDemote;
    const buttons = allProps(card.tree()).filter(
      (props) => typeof props.onClick === "function" && textOf(props.children) === actionText,
    );
    assert.equal(buttons.length, 1, "armed 卡该有且只有一枚停用按钮");
    const button = expectItem(buttons[0], "停用按钮已就位");
    (button.onClick as () => void)();
    await card.settle();

    // 只核「动作带着什么出去」这一件事：URL 与方法名是适配器自己写的，断言它们等于检夹具。
    const postCall = expectItem(
      stub.calls.find((call) => call.url === ACTION_CALL),
      "动作要经 ruleAction 这一枚方法出去",
    );
    const init = expectItem(postCall.init, "写面调用必须带 init");
    assert.deepEqual(JSON.parse(String(init.body)), { id: "rule-1", action: "demote" });
    assert.ok(card.text().includes("rule library refused the write"), "回执 error 显示给用户");
  });
});

describe("client 数据面：保存是一次原子提交", () => {
  beforeEach(resetHooks);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("两个字段改动合成一次 mutate（ops 按改动顺序、带读到的 revision）；受理位为 true 时清草稿", async () => {
    vi.stubGlobal("fetch", fetchStubOf(async () => jsonResponse(statsBody())).fetch);
    const calls: MutateCall[] = [];
    const card = mount(
      LlcCard as never,
      cardProps(READY, async (ops, revision) => {
        calls.push({ ops, revision });
        return true;
      }),
    );
    await card.settle();

    // 动两个字段：开关 enabled 关掉 + 数字字段 promoteThreshold 改成 9。
    (controlOf(card.tree(), "enabled").onClick as () => void)();
    const numberInput = controlOf(card.tree(), "promoteThreshold");
    (numberInput.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "9" },
    });

    const saveButton = controlOf(card.tree(), "save");
    assert.equal(saveButton.disabled, false, "有草稿时保存按钮可用");
    (saveButton.onClick as () => void)();
    await card.settle();

    assert.equal(calls.length, 1, "一次原子提交：不许拆成多次独立写");
    assert.deepEqual(calls[0]?.ops, [
      { op: "set", path: ["enabled"], value: false },
      { op: "set", path: ["promoteThreshold"], value: 9 },
    ]);
    assert.equal(calls[0]?.revision, 7, "CAS 栅栏用快照里读到的 revision");
    assert.ok(
      card.text().includes(UI_MESSAGES.zh.statusClean),
      "受理成功后草稿清空（状态条回到干净态）",
    );
  });

  it("受理位为 false → 报错且**草稿保留**（旧实现无条件清草稿，用户以为已保存）", async () => {
    vi.stubGlobal("fetch", fetchStubOf(async () => jsonResponse(statsBody())).fetch);
    const card = mount(
      LlcCard as never,
      cardProps(READY, async () => false),
    );
    await card.settle();

    (controlOf(card.tree(), "enabled").onClick as () => void)();
    (controlOf(card.tree(), "save").onClick as () => void)();
    await card.settle();

    const text = card.text();
    assert.ok(text.includes(UI_MESSAGES.zh.saveRejected), "被拒要有错误条");
    assert.equal(
      text.includes(UI_MESSAGES.zh.statusClean),
      false,
      "草稿没落盘，状态条不许回到干净态",
    );
    assert.equal(controlOf(card.tree(), "save").disabled, false, "仍可重试");
  });

  it("保存在途时配置行一起冻结（否则在途改动落不进本次提交，却会被受理后的清草稿抹掉）", async () => {
    vi.stubGlobal("fetch", fetchStubOf(async () => jsonResponse(statsBody())).fetch);
    // 闸门借 node:events 的 once 挂在 signal 上（promise/avoid-new：不手搓 Promise）。
    const gate = new AbortController();
    const card = mount(
      LlcCard as never,
      cardProps(READY, async () => {
        await once(gate.signal, "abort");
        return true;
      }),
    );
    await card.settle();

    (controlOf(card.tree(), "enabled").onClick as () => void)();
    (controlOf(card.tree(), "save").onClick as () => void)();
    await card.settle();

    assert.equal(controlOf(card.tree(), "enabled").disabled, true, "在途时开关不许可编辑");
    assert.equal(
      controlOf(card.tree(), "promoteThreshold").disabled,
      true,
      "在途时数字输入不许可编辑",
    );
    gate.abort();
    await card.settle();
    assert.equal(controlOf(card.tree(), "enabled").disabled, false, "受理后恢复可编辑");
  });

  it("受理后只清本次提交的键：在途窗口里改的新草稿不许被抹成「已保存」", async () => {
    vi.stubGlobal("fetch", fetchStubOf(async () => jsonResponse(statsBody())).fetch);
    // 闸门借 node:events 的 once 挂在 signal 上（promise/avoid-new：不手搓 Promise）。
    const gate = new AbortController();
    const card = mount(
      LlcCard as never,
      cardProps(READY, async () => {
        await once(gate.signal, "abort");
        return true;
      }),
    );
    await card.settle();

    // 提交 enabled（进入在途），随后直接驱动数字控件改 promoteThreshold。
    (controlOf(card.tree(), "enabled").onClick as () => void)();
    (controlOf(card.tree(), "save").onClick as () => void)();
    await card.settle();
    // 直接调 onChange 绕过 disabled：这里要验的是"提交集合与清草稿集合必须一致"，
    // DOM 面的冻结由上面那条用例覆盖。
    (
      controlOf(card.tree(), "promoteThreshold").onChange as (event: {
        target: { value: string };
      }) => void
    )({
      target: { value: "9" },
    });
    gate.abort();
    await card.settle();

    assert.equal(
      controlOf(card.tree(), "promoteThreshold").value,
      "9",
      "没进本次提交的草稿必须留着",
    );
    assert.equal(
      card.text().includes(UI_MESSAGES.zh.statusClean),
      false,
      "还有未提交草稿时不许显示干净态",
    );
  });
});

describe("client 数据面：数字输入与未知状态", () => {
  beforeEach(resetHooks);

  it("越界输入失焦回退到模型值（受控值不许与模型长期分叉）", () => {
    const changes: unknown[] = [];
    const row = mount(NumberInputRow as never, {
      label: "复发率红线",
      hint: "0.05–1",
      field: "demoteRatio",
      value: 0.5,
      min: 0.05,
      max: 1,
      onChange: (_field: string, value: unknown) => {
        changes.push(value);
      },
      onEmpty: () => {
        // 本用例不测空值分支
      },
    });
    const entry = controlOf(row.tree(), "demoteRatio");
    (entry.onChange as (event: { target: { value: string } }) => void)({ target: { value: "10" } });
    assert.deepEqual(changes, [], "越界值不提交");
    // 失焦要取**重渲之后**的那份 props：closure 里的 text 才是当前草稿（"10"）。
    const afterEntry = controlOf(row.tree(), "demoteRatio");
    assert.equal(afterEntry.value, "10", "输入中途不回改（否则没法连续打字）");
    (afterEntry.onBlur as () => void)();
    assert.equal(controlOf(row.tree(), "demoteRatio").value, "0.5", "越界草稿被纠回模型值");
  });

  it("未知状态：与候选同组可见、原文显形、不给动作按钮", async () => {
    // 走**线上形态**（status 串不在白名单里）：验的正是 normalizeRuleCardView 的兜底口径，
    // 而不是手搓一个本地 `unknown` 值自证。
    vi.stubGlobal(
      "fetch",
      fetchStubOf(async () =>
        jsonResponse(statsBody({ rules: [{ ...ruleRow(), id: "rule-x", status: "paused" }] })),
      ).fetch,
    );
    const card = mount(
      LlcCard as never,
      cardProps(READY, async () => true),
    );
    await card.settle();
    const text = card.text();
    assert.ok(text.includes("paused"), "原始状态串必须显形");
    assert.ok(
      text.includes(UI_MESSAGES.zh.metaStatusUnknown.replace("{status}", "paused")),
      "提示本卡未识别该状态",
    );
    assert.equal(text.includes(UI_MESSAGES.zh.btnDemote), false, "未知状态不给动作按钮");
    assert.equal(text.includes(UI_MESSAGES.zh.btnArmConfirm), false);
    // 候选组默认展开：未知状态的卡因此看得见（旧实现归归档组，默认折叠 = 用户看不到）。
    const headings = allProps(card.tree())
      .filter((props) => props.className === "llc-section")
      .map((props) => textOf(props.children));
    assert.ok(
      headings.some((line) => line.includes(UI_MESSAGES.zh.sectionCandidates.slice(0, 4))),
      "未知状态落在候选分节里",
    );
  });
});

describe("client 数据面：分组懒渲染（每组一页 + 加载更多）", () => {
  beforeEach(resetHooks);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("25 条 armed：默认只画一页（20），标题计数照全量，点按钮再放 5 条", async () => {
    const rules = Array.from({ length: 25 }, (_unused, index) =>
      ruleRow({ id: `rule-${index}`, signature: `sig-${index}` }),
    );
    vi.stubGlobal("fetch", fetchStubOf(async () => jsonResponse(statsBody({ rules }))).fetch);
    const card = mount(
      LlcCard as never,
      cardProps(READY, async () => true),
    );
    await card.settle();

    assert.equal(
      cardCountOf(card.tree()),
      20,
      "默认只画每页前 20 条（大规则库不再一次渲染上千张卡）",
    );
    const headings = allProps(card.tree())
      .filter((props) => props.className === "llc-section")
      .map((props) => textOf(props.children));
    assert.ok(
      headings.some((line) => line.includes("25")),
      "分节标题的计数照全量：懒渲染只改渲染，不改数据口径",
    );
    const [more] = moreButtonsOf(card.tree(), 5);
    const moreButton = expectItem(more, "剩余条数写在「加载更多」按钮上");
    (moreButton.onClick as () => void)();
    assert.equal(cardCountOf(card.tree()), 25, "再放一页后 25 条全在");
    assert.deepEqual(moreButtonsOf(card.tree(), 0), [], "没有剩余就不出按钮");
  });

  it("组间各自计数：展开候选组不放 armed 组的那一页", async () => {
    const rules = [
      ...Array.from({ length: 21 }, (_unused, index) =>
        ruleRow({ id: `cand-${index}`, status: "candidate", statusText: "candidate" }),
      ),
      ...Array.from({ length: 21 }, (_unused, index) => ruleRow({ id: `armed-${index}` })),
    ];
    vi.stubGlobal("fetch", fetchStubOf(async () => jsonResponse(statsBody({ rules }))).fetch);
    const card = mount(
      LlcCard as never,
      cardProps(READY, async () => true),
    );
    await card.settle();

    assert.equal(cardCountOf(card.tree()), 40, "两组各画一页");
    const buttons = moreButtonsOf(card.tree(), 1);
    assert.equal(buttons.length, 2, "两组各有一枚按钮（各剩 1 条）");
    // 渲染顺序是候选 → 降级 → armed，第一枚按钮属于候选组
    (expectItem(buttons[0], "候选组的按钮已就位").onClick as () => void)();
    assert.equal(cardCountOf(card.tree()), 41, "只放候选组那一页：21 + armed 的 20");
    assert.equal(
      moreButtonsOf(card.tree(), 1).length,
      1,
      "候选组按钮消失，armed 组的还在（组间互不影响）",
    );
  });
});
