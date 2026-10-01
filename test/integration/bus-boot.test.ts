// 真实 Loader 组合测试（P8/#27 定性）：判定「quality-gate 的门禁失败上报，到底能不能
// 落到 lesson-loop 的事件流水与规则库」。
//
// 形态照抄 session-rescue/test/integration/loader-boot.test.ts：
// - lesson-loop 的 host 半边由真实的 cordis + cordis-plugin-loader（本包 devDependencies
//   里的那对，与 dsh 自带同版本：4.0.3 / 1.0.3；写死安装位置的话独立仓 CI 整条红）走
//   Node 原生 import 载入（源码态 .ts 副本 + 发布态 .js 产物各测一次，见下方 fixture 注释）；
// - 宿主服务 settings 用「真实现 0.1.7 语义」的假件（makeSettingsProvider：describe() 给
//   value/user/revision + provider 层 update() 带 CAS 与 SettingsConflictError + configure()），
//   其余宿主服务（timer/webServer/commands/…）一律缺席——它们都是 lesson-loop 的可选读，
//   缺失只让对应 effect 走 noDisposer，不影响 report 这条主链。
//   ⚠ 开关（enabled/reportEnabled/…）不再经这份假件：0.1.7 移除了 settings.register，
//   插件读的是 cordis 按条目 Config 解析出来的 volatile 引用，所以翻开关走
//   `entry.update({ config })`（见 setEntryConfig），正是真宿主设置卡写口的下游一步。
// 保持「非产品服务全 mock、插件本体全真实」的 dsh 测试纪律。
//
// 装载对象是 host 的**逐字节副本**（连同 ./lib 相对依赖一起放进 .tmp/pkg/）：同一份文件若既被
// vitest 变换载入（host.test.ts 里 import ../host.ts）、又被 cordis loader 走 Node 原生 import
// 载入，v8 会把两份实例的覆盖记录按偏移合并，真实命中被冲成 0（host.ts 与它 import 的 lib/*.ts
// 全部受影响），四阈值 100 下恒红。副本落在 .tmp/（不在 coverage.include，也只在测试期间存在），
// 故 lint/fmt/tsc 都看不见它。
//
// 发布态产物用 buildHost()（build-host.mjs 导出的纯函数）在内存里现建，不读磁盘上那份 gitignored
// host.js：真装机跑的是 publishConfig.exports 指向的产物（依赖被内联/残留 ./x.ts/默认导出丢失等
// 构建回归，源码态测试盖不住），这条链路正是 #27「沙箱里没落盘」最可能在生产形态下暴露的那一面。

import { afterEach, afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as flushAsync } from "node:timers/promises";

import { buildHost } from "../../build-host.mjs";
import { RULES_FIELD, SETTINGS_NAMESPACE } from "../../lib/rules-layout.ts";
import { makeSettingsProvider } from "../rules-fake.ts";
import type { SettingsProviderFake } from "../rules-fake.ts";

const CORDIS_ENTRY = createRequire(import.meta.url).resolve("@deepseek-ai/cordis");
const LOADER_ENTRY = createRequire(import.meta.url).resolve("@deepseek-ai/cordis-plugin-loader");
const PKG_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const HOST_TS = path.join(PKG_ROOT, "host.ts");

const FIXTURE_DIR = path.join(PKG_ROOT, ".tmp");
const FIXTURE_PKG = path.join(FIXTURE_DIR, "pkg");
const FIXTURE_HOST = path.join(FIXTURE_PKG, "host.ts");
const FIXTURE_HOST_JS = path.join(FIXTURE_PKG, "host.js");

/** 设置命名空间 = 条目 id = host.ts 的 PLUGIN_NAME（0.1.7：注册是隐式的）。 */
const SWITCH_NS = "lesson-loop";
/** cacheFile("events.jsonl") 的展开式：dshHomePath("cache", "lesson-loop", name)。 */
const EVENTS_REL = path.join("cache", SWITCH_NS, "events.jsonl");

// quality-gate 上报的形状三件套（本文件自己照抄它的字段构造，见 gateFailurePayload 注记）：
// 建载荷与读回事件流水/条目段两头都用这几枚，都是测试侧字面量，不指生产常量。
/** 上报来源（quality-gate 的生产者名）。 */
const SOURCE_QUALITY_GATE = "quality-gate";
/** `problem.kind === "code-failure"` 映射到的教训分类。 */
const CATEGORY_GATE_FAILURE = "gate-failure";
/** `gate.command.join(" ")` 的展开式：事件流水里存的原始签名。 */
const SIGNATURE_GATE_COMMAND = "pnpm check";

// 动态导入 .mjs/.js 对 TS 为 any，先收窄到用到的最小面再取成员（避免 no-unsafe-*）。
const CordisMod = (await import(CORDIS_ENTRY)) as { Context: unknown };
const LoaderMod = (await import(LOADER_ENTRY)) as { default: unknown };

/** 本测试用到的极简根 ctx 面（vendor/cordis reflect：get/provide/effect/on 都 mixin 进每层 ctx）。 */
interface TestEntry {
  id: string;
  fiber: unknown;
  /** loader 的条目写口：真宿主里设置卡的 mutate 经 configEditor.edit 最终落到这里。 */
  update: (options: Record<string, unknown>) => Promise<void>;
}

interface TestCtx {
  plugin: (plugin: unknown) => Promise<unknown>;
  get: (name: string) => unknown;
  loader: {
    create: (options: { id: string; name: string; config?: unknown }) => Promise<string>;
    await: () => Promise<void>;
    entries: () => Iterable<TestEntry>;
  };
  fiber?: { dispose: () => Promise<void> };
}

const CordisContext = CordisMod.Context as new () => TestCtx;
const Loader: unknown = LoaderMod.default;

/** lesson-loop 服务 report 面的最小投影（只断言用到的字段）。 */
interface ReportReceiptView {
  ok: boolean;
  reason?: string;
  ready?: boolean;
}
interface BusService {
  report: (input: BusReportInput) => Promise<ReportReceiptView>;
}
/** report 入参形状（对齐 host.ts 的 service.report 契约）。 */
interface BusReportInput {
  source: string;
  category: string;
  cwd?: string;
  sessionId?: string;
  turn?: number;
  signature: string;
  detail: string;
  evidence?: Record<string, unknown>;
}

interface Mount {
  ctx: TestCtx;
  provider: SettingsProviderFake;
  eventsPath: string;
}

/**
 * 照抄 quality-gate/host.ts 的 reportProblemToBus 字段构造上报载荷：
 * category 由 problem.kind 决定、signature = gate.command.join(" ")、evidence = {root, command, kind}。
 * 这里是「同一形状」而不是复用它的代码——被测边界是 lesson-loop 总线，quality-gate 的注入分支不在本测试内。
 */
function gateFailurePayload(turn: number): BusReportInput {
  const gate = { root: "/repo", command: ["pnpm", "check"] };
  const problem = {
    kind: "code-failure",
    text: "exit=1\nsrc/index.ts(3,1): error TS2322: Type 'string' is not assignable to 'number'",
  };
  return {
    source: SOURCE_QUALITY_GATE,
    category: problem.kind === "code-failure" ? CATEGORY_GATE_FAILURE : "gate-not-run",
    cwd: gate.root,
    sessionId: "session-gate-1",
    turn,
    signature: gate.command.join(" "),
    detail: problem.text,
    evidence: { root: gate.root, command: gate.command, kind: problem.kind },
  };
}

/**
 * 挂载一份真实 Loader 组合的会话。settings 用真实现 0.1.7 语义的假件（describe 给
 * value/user/revision + update 带 CAS + configure 收页面策略）；DSH_HOME 由调用方指向临时
 * 目录，让 cacheFile 落在临时 cache 下。
 * hostEntry 决定装载哪一份 host（默认源码态副本；发布态产物见对应用例）。
 */
async function mount(hostEntry: string = FIXTURE_HOST): Promise<Mount> {
  const provider = makeSettingsProvider();
  const settings = {
    ...provider,
    // 页面策略登记（本包自带卡片，声明别让宿主再生成自动页）。
    configure: () => () => {
      // 测试假件：策略登记无收尾资源
    },
  };
  const dependencies = {
    name: "lesson-loop-test-deps",
    apply(ctx: { provide: (name: string, value: unknown) => void }) {
      ctx.provide("settings", settings);
    },
  };

  const ctx = new CordisContext();
  await ctx.plugin(dependencies);
  await ctx.plugin(Loader);
  await ctx.loader.create({ id: SWITCH_NS, name: hostEntry });
  await ctx.loader.await();
  // 装载期一次性迁移是 apply 里 `void (async …)()` 的 fire-and-forget 纯微任务链（见 host.ts）。
  // 空规则库上它本就是 no-op（write:false 不写不推进 revision），但一个宏任务边界即把它彻底排干，
  // 保证首条 report 的 commit 不与迁移交错——断言因此只反映 report 自身的效果。
  await flushAsync(0);
  return {
    ctx,
    provider,
    eventsPath: path.join(process.env["DSH_HOME"] ?? "", EVENTS_REL),
  };
}

/**
 * 翻开关 = 改条目行的 config（0.1.7：设置卡的 mutate 经 configEditor.edit 走的正是这一步）。
 * 装的这份 loader（1.0.3）在 config 变化时重挂载条目，所以调用方之后要重新 ctx.get 取服务。
 */
async function setEntryConfig(inst: Mount, config: Record<string, unknown>): Promise<void> {
  const entry = [...inst.ctx.loader.entries()].find((item) => item.id === SWITCH_NS);
  expect(entry, "lesson-loop 条目须已在 loader 就位（翻开关要走条目写口）").toBeDefined();
  await entry?.update({ config });
  await flushAsync(0);
}

/** 读事件流水（cache/lesson-loop/events.jsonl）：逐行 JSON.parse，跳过空行。 */
function loadEvents(file: string): Record<string, unknown>[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** 从 settings 假件里取真正落进 `lesson-loop` 条目段的卡（读的是文档原文，不是解析值）。 */
function persistedRuleCards(provider: SettingsProviderFake): Record<string, unknown>[] {
  const section = provider.peek(SETTINGS_NAMESPACE);
  const rules = section?.[RULES_FIELD];
  return Array.isArray(rules) ? (rules as Record<string, unknown>[]) : [];
}

describe("真实 Loader 装载 lesson-loop host：quality-gate 门禁失败上报的落盘判定", () => {
  let live: TestCtx | undefined;
  let scratch: string;
  let origDshHome: string | undefined;

  // 夹具的建/拆：本文件只有这一个顶层 describe，故放在它体内即覆盖全部用例，
  // 时序与原先的顶层注册一致（模块求值 → beforeAll → 用例 → afterAll）。
  beforeAll(async () => {
    await mkdir(path.join(FIXTURE_PKG, "lib"), { recursive: true });
    await cp(HOST_TS, FIXTURE_HOST);
    await cp(path.join(PKG_ROOT, "lib"), path.join(FIXTURE_PKG, "lib"), { recursive: true });
    await writeFile(FIXTURE_HOST_JS, await buildHost(), "utf8");
  });

  beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "lesson-bus-"));
    origDshHome = process.env["DSH_HOME"];
    // DSH_HOME 指到临时目录：cacheFile 现读 process.env（dshHomePath 每次调用解析，不缓存），
    // 故每个用例各自一份干净的 cache，负向用例能证明「真的没落任何文件」。
    process.env["DSH_HOME"] = scratch;
  });

  afterEach(async () => {
    await live?.fiber?.dispose();
    live = undefined;
    if (origDshHome === undefined) {
      delete process.env["DSH_HOME"];
    } else {
      process.env["DSH_HOME"] = origDshHome;
    }
    rmSync(scratch, { recursive: true, force: true });
  });

  afterAll(async () => {
    await rm(FIXTURE_DIR, { recursive: true, force: true });
  });

  it(
    "源码态副本：服务可见 + 门禁失败落 events.jsonl + 达 promoteThreshold 写入规则卡",
    { timeout: 30_000 },
    async () => {
      const inst = await mount();
      live = inst.ctx;

      // 装载证明：条目确实经 Loader 激活（fiber 就位，apply 未抛）。
      const entry = [...inst.ctx.loader.entries()].find((item) => item.id === SWITCH_NS);
      expect(entry?.fiber, "lesson-loop 条目须经真实 Loader 激活").toBeDefined();

      // 断言②：服务确实可见——这正是沙箱里没证据的那个点。
      const raw = inst.ctx.get("lessonLoop");
      expect(raw, "真实 Loader 下 ctx.get('lessonLoop') 必须非 undefined").toBeDefined();
      const bus = raw as BusService;

      // 断言①：单条上报落事件流水，逐字段对（source/category/signature）。
      const first = await bus.report(gateFailurePayload(7));
      expect(first.ok, "单次上报回执 ok:true").toBe(true);
      expect(existsSync(inst.eventsPath), "cache/lesson-loop/events.jsonl 应落盘").toBe(true);
      const rows = loadEvents(inst.eventsPath);
      const hit = rows.find((row) => row["source"] === SOURCE_QUALITY_GATE);
      expect(hit, "events.jsonl 应含这条上报").toBeDefined();
      expect(hit?.["category"]).toBe(CATEGORY_GATE_FAILURE);
      expect(hit?.["signature"], "事件流水存的是 reportProblemToBus 的原始签名").toBe(
        SIGNATURE_GATE_COMMAND,
      );
      expect(hit?.["sessionId"]).toBe("session-gate-1");
      expect(hit?.["turn"]).toBe(7);
      expect(hit?.["detail"]).toContain("TS2322");
      expect(hit?.["project"]).toBeTypeOf("string");

      // 断言③：反复上报达 promoteThreshold（默认 3）→ 规则卡写进条目段的 rules，回执 ok:true。
      const second = await bus.report(gateFailurePayload(8));
      expect(second.ok).toBe(true);
      expect(second.ready, "occurrences=2 < 3 → 未达门槛，不催审").not.toBe(true);
      const third = await bus.report(gateFailurePayload(9));
      expect(third.ok, "第三次上报回执 ok:true").toBe(true);
      expect(third.ready, "occurrences=3 达阈值 → 候选卡 ready").toBe(true);

      const card = persistedRuleCards(inst.provider).find(
        (item) =>
          item["signature"] === SIGNATURE_GATE_COMMAND &&
          item["category"] === CATEGORY_GATE_FAILURE,
      );
      expect(card, "条目段 lesson-loop 的 rules 里应真的写进了这张候选卡").toBeDefined();
      expect(card?.["status"]).toBe("candidate");
      expect(card?.["occurrences"]).toBe(3);
      expect(
        loadEvents(inst.eventsPath).filter((row) => row["source"] === SOURCE_QUALITY_GATE),
      ).toHaveLength(3);
    },
  );

  it(
    "发布态产物 host.js：同一链路同样落盘（装机真跑的就是这一份）",
    { timeout: 30_000 },
    async () => {
      const inst = await mount(FIXTURE_HOST_JS);
      live = inst.ctx;

      const entry = [...inst.ctx.loader.entries()].find((item) => item.id === SWITCH_NS);
      expect(entry?.fiber, "发布产物 lesson-loop 条目须经真实 Loader 激活").toBeDefined();

      const raw = inst.ctx.get("lessonLoop");
      expect(raw, "发布产物同样 provide 出 lessonLoop 服务").toBeDefined();
      const bus = raw as BusService;

      // 顺序上报三次（CAS 写本质是"一次写一等"，不能并发——与源码态用例同一理由）。
      const first = await bus.report(gateFailurePayload(1));
      const second = await bus.report(gateFailurePayload(2));
      const third = await bus.report(gateFailurePayload(3));
      expect(first.ok && second.ok && third.ok, "三次上报回执均 ok:true").toBe(true);
      expect(third.ready, "occurrences=3 达阈值 → ready").toBe(true);
      expect(existsSync(inst.eventsPath)).toBe(true);
      expect(
        loadEvents(inst.eventsPath).filter((row) => row["source"] === SOURCE_QUALITY_GATE),
      ).toHaveLength(3);
      const card = persistedRuleCards(inst.provider).find(
        (item) => item["signature"] === SIGNATURE_GATE_COMMAND,
      );
      expect(card, "发布产物同样把卡片写进条目段 lesson-loop 的 rules").toBeDefined();
      expect(card?.["occurrences"]).toBe(3);
    },
  );

  it(
    "反向用例：reportEnabled=false → 回执 disabled 且不落任何文件（总线自己关着的正常态）",
    { timeout: 30_000 },
    async () => {
      const inst = await mount();
      live = inst.ctx;
      const bus = inst.ctx.get("lessonLoop") as BusService;
      expect(bus, "总线关着前服务仍是可见的（区别‘服务缺位’与‘服务自关’）").toBeDefined();

      // 0.1.7：开关只能来自条目行的 config（插件侧已无 settings.register，卡片写的也是这一层）。
      // 经 loader 的条目写口翻它 = 真宿主里设置卡 mutate 的下游那一步；这份 loader 会重挂载
      // 条目（1.0.3 还没有 volatile 就地提交那条路），故服务要重新 ctx.get——旧句柄背后的
      // 引用随旧 fiber 一起作废，拿着它读到的还是翻转前的值。
      await setEntryConfig(inst, { reportEnabled: false });
      const after = inst.ctx.get("lessonLoop") as BusService;
      const receipt = await after.report(gateFailurePayload(1));
      expect(receipt).toStrictEqual({ ok: false, reason: "disabled" });
      expect(existsSync(inst.eventsPath), "关闭态不许创建 events.jsonl").toBe(false);
    },
  );
});
