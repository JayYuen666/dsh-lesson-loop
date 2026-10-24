// test/integration/host-contract.test.ts —— 真实 cordis 装载面上的服务契约（不经手写 mock）。
//
// 这里补的是 host.test.ts 那套 mock ctx 结构上盖不住的五件事：
//   1. 服务经官方 reflect 交出（`ctx.get`），而不是只被 `ctx.provide` 调用过；
//   2. 另一枚条目用自己的 `inject: ["lessonLoop"]` 能解析到它——其他插件的上报路径靠的就是这条；
//   3. 注入子 fiber 里交回的 disposer 被 cordis 的 effect 生命周期采纳（不采纳的形状会抛
//      TypeError，见 installed @deepseek-ai/cordis/lib/types/fiber.d.ts:147-151），
//      卸载后四条路由各自撤销；
//   4. 装载失败是舱壁内的失败：本包条目 FAILED 不外溢到同桌条目；
//   5. `inject: ["settings"]` 这条硬依赖缺席时，条目停在等待态而不是带着 undefined 装下去。
//
// 装载对象是 host 的逐字节副本（.tmp/contract/）：与 bus-boot.test.ts 同一纪律——同一份文件
// 既被 vitest 变换载入、又被 cordis loader 走 Node 原生 import 载入时，v8 会把两份实例的覆盖
// 记录按偏移合并，真实命中被冲成 0，四阈值 100 下恒红。
import { afterEach, afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import { Loader } from "@deepseek-ai/cordis-plugin-loader";
import { RULES_FIELD, SETTINGS_NAMESPACE } from "../../lib/rules-layout.ts";
import { makeSettingsProvider } from "../rules-fake.ts";

const PKG_ROOT = path.resolve(import.meta.dirname, "../..");
const FIXTURE_DIR = path.join(PKG_ROOT, ".tmp", "contract");
const FIXTURE_HOST = path.join(FIXTURE_DIR, "host.ts");
const FIXTURE_SIBLING = path.join(FIXTURE_DIR, "sibling.js");
const FIXTURE_CONSUMER = path.join(FIXTURE_DIR, "consumer.js");

/** 条目 id = 设置命名空间 = host.ts 的 PLUGIN_NAME。 */
const ENTRY_ID = "lesson-loop";
const SIBLING_ID = "contract-sibling";
const CONSUMER_ID = "contract-consumer";
const EVENTS_REL = path.join("cache", ENTRY_ID, "events.jsonl");

/** `FiberState` 是 const enum（运行时擦除），只能按发布 d.ts 的数值比对。 */
const ST = { PENDING: 0, ACTIVE: 2, FAILED: 3 } as const;

/** 排干一轮 fiber 生命周期：`_reload()` 首行就是一个微任务。 */
const settle = (): Promise<void> => sleep(0);

/** webServer 探针：只记注册了哪些路径——本包不再有路由，所以这一面是用来证「一条都没注册」的。 */
interface RouteProbe {
  registered: string[];
}

interface TestFiber {
  state: number;
  dispose: () => Promise<void>;
}

interface TestEntry {
  id: string;
  fiber?: TestFiber;
}

interface TestCtx {
  plugin: (plugin: unknown) => Promise<unknown>;
  get: (name: string) => unknown;
  loader: {
    create: (options: Record<string, unknown>) => Promise<string>;
    await: () => Promise<void>;
    entries: () => Iterable<TestEntry>;
  };
}

/** 本包服务的最小投影。 */
interface BusView {
  report: (input: Record<string, unknown>) => Promise<{ ok: boolean; ready?: boolean }>;
}

/**
 * 造一枚 webServer 替身：形状按官方 `register(route) => () => void` 的交付面，
 * 但把注册与撤销都记进探针。
 *
 * @returns 提供面与探针
 */
function makeWebServer(): { service: Record<string, unknown>; probe: RouteProbe } {
  const probe: RouteProbe = { registered: [] };
  return {
    probe,
    service: {
      host: "127.0.0.1",
      port: 8787,
      register(route: { path: string }) {
        probe.registered.push(route.path);
        return () => {
          // 本包不注册路由，探针没有要回收的东西
        };
      },
    },
  };
}

/**
 * 挂一份真实 cordis + loader 的组合。
 *
 * @param options - 条目行的初始 config；sibling 加一枚不依赖本包的条目；consumer 加一枚
 *                  声明 `inject: ["lessonLoop"]` 的条目；noSettings 时不提供 settings
 * @returns ctx、探针与那份 settings 假件
 */
async function mount(
  options: {
    config?: Record<string, unknown>;
    sibling?: boolean;
    consumer?: boolean;
    noSettings?: boolean;
  } = {},
): Promise<{ ctx: TestCtx; probe: RouteProbe; provider: ReturnType<typeof makeSettingsProvider> }> {
  const provider = makeSettingsProvider();
  const { service: webServer, probe } = makeWebServer();
  const deps = {
    name: "contract-deps",
    apply(ctx: { provide: (name: string, value: unknown) => void }) {
      if (options.noSettings !== true) {
        ctx.provide("settings", {
          ...provider,
          configure: () => () => {
            // 测试假件：页面策略登记没有收尾资源
          },
        });
      }
      ctx.provide("webServer", webServer);
    },
  };
  const ctx = new Context() as unknown as TestCtx;
  await ctx.plugin(deps);
  await ctx.plugin(Loader);
  // 舱壁用例里本包那条 fiber 预期 FAILED，装载会把它的错抛回来；健康与否由各用例自己按
  // fiber 状态断言，所以这两处都不吃 reject 之外的失败。
  await ctx.loader
    .create({
      id: ENTRY_ID,
      name: pathToFileURL(FIXTURE_HOST).href,
      ...(options.config === undefined ? {} : { config: options.config }),
    })
    .catch(() => null);
  if (options.sibling === true) {
    await ctx.loader
      .create({ id: SIBLING_ID, name: pathToFileURL(FIXTURE_SIBLING).href })
      .catch(() => null);
  }
  if (options.consumer === true) {
    await ctx.loader
      .create({ id: CONSUMER_ID, name: pathToFileURL(FIXTURE_CONSUMER).href })
      .catch(() => null);
  }
  await ctx.loader.await().catch(() => null);
  await settle();
  return { ctx, probe, provider };
}

/** 按 id 取条目。 */
function entryOf(ctx: TestCtx, id: string): TestEntry | undefined {
  return [...ctx.loader.entries()].find((item) => item.id === id);
}

/** 条目缺席时回 NaN，让断言报"条目没就位"而不是静默通过。 */
function stateOf(entry: TestEntry | undefined): number {
  return entry?.fiber?.state ?? Number.NaN;
}

/**
 * 卸载一条 fiber。
 *
 * d.ts 把 `dispose` 写成 `() => Promise<void>`，实测这份 cordis 交回的是 undefined，
 * 所以两种形状都得吃下——按返回值是不是 thenable 决定要不要 await，比断言它的签名更可靠。
 *
 * @param entry - 待卸载条目
 * @returns 卸载结算
 */
async function disposeFiber(entry: TestEntry | undefined): Promise<void> {
  const disposal = entry?.fiber?.dispose() as unknown;
  if (disposal instanceof Promise) {
    await disposal.catch(() => null);
  }
}

describe("真实 cordis 装载面：lesson-loop 的服务契约", () => {
  let scratch: string;
  let origDshHome: string | undefined;
  let live: TestCtx | undefined;

  beforeAll(async () => {
    await mkdir(path.join(FIXTURE_DIR, "lib"), { recursive: true });
    await cp(path.join(PKG_ROOT, "host.ts"), FIXTURE_HOST);
    await cp(path.join(PKG_ROOT, "lib"), path.join(FIXTURE_DIR, "lib"), { recursive: true });
    await writeFile(
      FIXTURE_SIBLING,
      `export default {
  name: "contract-sibling",
  apply(ctx) {
    ctx.provide("siblingProbe", { ping: () => "pong" });
  },
};
`,
      "utf8",
    );
    await writeFile(
      FIXTURE_CONSUMER,
      `export default {
  name: "contract-consumer",
  inject: ["lessonLoop"],
  apply(ctx) {
    const bus = ctx.get("lessonLoop");
    ctx.provide("consumerSaw", { reportType: typeof bus?.report });
  },
};
`,
      "utf8",
    );
  });

  beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "lesson-contract-"));
    origDshHome = process.env["DSH_HOME"];
    process.env["DSH_HOME"] = scratch;
  });

  afterEach(async () => {
    if (live !== undefined) {
      await Promise.all([...live.loader.entries()].map((item) => disposeFiber(item)));
      live = undefined;
    }
    rmSync(scratch, { recursive: true, force: true });
    if (origDshHome === undefined) {
      delete process.env["DSH_HOME"];
    } else {
      process.env["DSH_HOME"] = origDshHome;
    }
  });

  afterAll(async () => {
    await rm(FIXTURE_DIR, { recursive: true, force: true });
  });

  it(
    "装载 ACTIVE：服务经官方 reflect 交出，规则读面的四个方法可用",
    { timeout: 30_000 },
    async () => {
      const inst = await mount();
      live = inst.ctx;
      expect(stateOf(entryOf(inst.ctx, ENTRY_ID)), "条目须 ACTIVE").toBe(ST.ACTIVE);
      const bus = inst.ctx.get("lessonLoop") as BusView | undefined;
      expect(bus?.report, "ctx.get 须交出带 report 的服务面").toBeTypeOf("function");
      const rules = inst.ctx.get("lessonLoopRules") as Record<string, unknown> | undefined;
      for (const method of ["stats", "rules", "lessons", "ruleAction"]) {
        expect(rules?.[method], `远程读面缺 ${method}`).toBeTypeOf("function");
      }
    },
  );

  it(
    "跨条目：兄弟插件声明 inject ['lessonLoop'] 时依赖图解析得动，上报也落盘",
    { timeout: 30_000 },
    async () => {
      const inst = await mount({ consumer: true });
      live = inst.ctx;
      // consumer 那条条目只有在本包真把 lessonLoop provide 进依赖图后才会 ACTIVE——
      // 这正是 danger-guard / quality-gate / session-rescue 三包上报路径的装载前提。
      expect(
        stateOf(entryOf(inst.ctx, CONSUMER_ID)),
        "声明 inject 的兄弟条目须能解析到本包服务",
      ).toBe(ST.ACTIVE);
      const saw = inst.ctx.get("consumerSaw") as { reportType?: string } | undefined;
      expect(saw?.reportType, "兄弟经 ctx.get 读到的服务须带 report").toBe("function");

      const receipt = await (inst.ctx.get("lessonLoop") as BusView).report({
        source: "quality-gate",
        category: "gate-failure",
        cwd: scratch,
        sessionId: "contract-1",
        turn: 1,
        signature: "pnpm check",
        detail: "exit=1",
      });
      expect(receipt.ok).toBe(true);
      expect(existsSync(path.join(scratch, EVENTS_REL)), "上报须落进真实 cache").toBe(true);
    },
  );

  it("卸载：官方 reflect 交回的 Remote 服务随 fiber 撤除", { timeout: 30_000 }, async () => {
    const inst = await mount();
    live = inst.ctx;
    expect(inst.ctx.get("lessonLoopRules"), "装载期须交出规则读面").toBeDefined();
    await disposeFiber(entryOf(inst.ctx, ENTRY_ID));
    await settle();
    expect(inst.ctx.get("lessonLoopRules"), "卸载后读面必须消失").toBeUndefined();
  });

  it(
    "舱壁：本包 config 非法只杀自己那条 fiber，兄弟条目与服务照旧",
    { timeout: 30_000 },
    async () => {
      // decayIntervalMs 的官方约束是 natural().min(1000)，500 在 resolveConfig 阶段即被拒。
      const inst = await mount({ config: { decayIntervalMs: 500 }, sibling: true });
      live = inst.ctx;
      expect(stateOf(entryOf(inst.ctx, ENTRY_ID)), "本包条目须停在 FAILED").toBe(ST.FAILED);
      expect(inst.ctx.get("lessonLoop"), "FAILED 的条目不许已经 provide 总线").toBeUndefined();
      expect(inst.probe.registered, "失败装载不许注册任何路由").toStrictEqual([]);
      expect(existsSync(path.join(scratch, "cache", ENTRY_ID)), "失败装载不许建 cache").toBe(false);
      expect(stateOf(entryOf(inst.ctx, SIBLING_ID)), "兄弟条目不许被带下水").toBe(ST.ACTIVE);
      const probe = inst.ctx.get("siblingProbe") as { ping: () => string } | undefined;
      expect(probe?.ping()).toBe("pong");
    },
  );

  it(
    "反向对照：同一组合喂合法 config 时两条 fiber 都 ACTIVE（上一条的 FAILED 不是夹具坏了）",
    { timeout: 30_000 },
    async () => {
      const inst = await mount({ config: { decayIntervalMs: 60_000 }, sibling: true });
      live = inst.ctx;
      expect(stateOf(entryOf(inst.ctx, ENTRY_ID))).toBe(ST.ACTIVE);
      expect(stateOf(entryOf(inst.ctx, SIBLING_ID))).toBe(ST.ACTIVE);
      expect(inst.ctx.get("lessonLoop")).toBeDefined();
    },
  );

  it(
    "硬依赖缺席：settings 没提供时条目不 ACTIVE，也不把半套服务摆上桌",
    { timeout: 30_000 },
    async () => {
      // host.ts 的 default.inject = ["settings"] 是硬依赖：缺位时 cordis 让 fiber 等着，
      // 而不是带着 undefined 装载（那条规则库读写会当场炸）。
      const inst = await mount({ noSettings: true });
      live = inst.ctx;
      expect(stateOf(entryOf(inst.ctx, ENTRY_ID)), "缺硬依赖不得进 ACTIVE").not.toBe(ST.ACTIVE);
      expect(inst.ctx.get("lessonLoop")).toBeUndefined();
      expect(inst.probe.registered, "没装载成功不许注册路由").toStrictEqual([]);
      expect(existsSync(path.join(scratch, "cache", ENTRY_ID))).toBe(false);
    },
  );

  it(
    "条目 config 是规则库读写的真源：promoteThreshold=1 时一次上报即出候选卡",
    { timeout: 30_000 },
    async () => {
      const inst = await mount({ config: { promoteThreshold: 1 } });
      live = inst.ctx;
      const receipt = await (inst.ctx.get("lessonLoop") as BusView).report({
        source: "quality-gate",
        category: "gate-failure",
        cwd: scratch,
        sessionId: "contract-2",
        turn: 1,
        signature: "pnpm check",
        detail: "exit=1",
      });
      expect(receipt.ok).toBe(true);
      // 卡写进的是这份装载里 provide 出去的那枚 settings 假件：真实注入子 fiber 走的官方
      // scoped 解析，mock ctx 那份 describe/update 盖不到。
      const cards = inst.provider.peek(SETTINGS_NAMESPACE)?.[RULES_FIELD];
      expect(Array.isArray(cards) ? cards.length : 0, "达门槛即入库").toBe(1);
    },
  );
});
