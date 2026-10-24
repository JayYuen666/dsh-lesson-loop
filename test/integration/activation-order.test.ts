// 装载时序契约（真实 cordis + Loader）：**开机迁移必须发生在本条目 ACTIVE 之后**。
//
// 为什么值得一条独立集成测试：主机侧 `settings.describe()` 只投影 `entry.fiber.state === ACTIVE`
// 的条目（harness packages/settings/settings/src/index.ts:305-306），而插件 `apply()` 跑在
// 自己那条 fiber 变 ACTIVE **之前**（harness vendor/cordis/src/fiber.ts 的状态机：`_execute` 结算后才
// `_updateState`）。于是"在 apply 里同步读规则库"这条路径在真实宿主上拿到的是空投影 →
// 端口判 unusable（lib/rules-namespace.ts 的 load）→ `commit` 不写（lib/lesson-store.ts 的 commit）
// → 迁移**静默空转**，用户的历史碎片卡永远不归并。
//
// 现有单测（host.test.ts）与 bus-boot.test.ts 都盖不住它：那份 settings 假件恒投影本条目
// （test/rules-fake.ts 的 describe 分支），而这是真实宿主**不可能**出现的状态。所以本文件把假件的
// 投影面按 harness 的真实语义门控（只有 ACTIVE 才投），并把"装载期确实读到过空投影"
// 钉成反向对照——门控若失效（例如宿主改成投影 PENDING 条目），对照组立刻红。
//
// 夹具纪律与 bus-boot.test.ts 相同：装载对象是 host.ts 的逐字节副本（.tmp/activation/），
// 避免同一份文件既被 vitest 变换、又被 Node 原生 import（v8 覆盖记录按偏移合并，真实命中被冲成 0）。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdir, rm } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as flushAsync } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import { Loader } from "@deepseek-ai/cordis-plugin-loader";
import { deriveProject } from "../../lib/lesson-store.ts";
import { RULES_FIELD, SETTINGS_NAMESPACE } from "../../lib/rules-layout.ts";
import { makeSettingsProvider } from "../rules-fake.ts";
import type { SettingsProviderFake } from "../rules-fake.ts";

const PKG_ROOT = path.resolve(import.meta.dirname, "../..");
const FIXTURE_DIR = path.join(PKG_ROOT, ".tmp", "activation");
const FIXTURE_HOST = path.join(FIXTURE_DIR, "host.ts");

/** 条目 id = 设置命名空间（cordis.patch.yml 的裸 id）。 */
const ENTRY_ID = SETTINGS_NAMESPACE;

/** 路径型碎片（存量卡）：category 已登记稳定签名 ⇒ 迁移后必须并入类别级卡。 */
const FRAGMENT_CWD = "/repo";
const FRAGMENT_SIGNATURE = "/repo/src/a.ts";
const STABLE_SIGNATURE = "edit-before-factgate";

/** 存量行的最小形状（逐字段与 host.test.ts 的 fragmentRow 同源）。 */
function fragmentRow(id: string, signature: string, cwd: string): Record<string, unknown> {
  return {
    id,
    project: cwd,
    cwd,
    category: "factgate-deny",
    signature,
    statement: `编辑 ${signature} 前先取证`,
    status: "candidate",
    createdAt: 1,
    updatedAt: 1,
    occurrences: 2,
    sources: [],
    violation: 0,
    suppressed: 0,
    recurrences: 0,
    evidence: [],
    origin: "threshold",
  };
}

/** 一次 describe() 的观察记录：那一刻条目 fiber 的状态与投影出的行数。 */
interface DescribeSample {
  state: number | undefined;
  rows: number;
}

/**
 * 把假件的 describe() 按 harness 真实语义门控：只有本条目 ACTIVE 时才投影。
 *
 * @param provider - 底层假件
 * @param trace - 逐次调用的观察记录（反向对照用）
 * @param stateOf - 取条目 fiber 状态的探针（调用方持有 ctx）
 * @returns 门控后的 provider 面
 */
function gateDescribe(
  provider: SettingsProviderFake,
  trace: DescribeSample[],
  stateOf: () => number | undefined,
): SettingsProviderFake {
  const real = provider.describe;
  return {
    ...provider,
    describe: (): ReturnType<typeof real> => {
      const state = stateOf();
      const rows = state === 2 ? real() : [];
      trace.push({ state, rows: rows.length });
      return rows;
    },
  };
}

/** 本文件用到的极简根 ctx 面（与 host-contract.test.ts 同一写法：cordis 的类按名义比，
 *  替身只能按用到的那几位投影，构造处一次 `as unknown as`）。 */
interface TestEntry {
  id: string;
  fiber?: { state?: number; dispose?: () => unknown };
}

interface TestCtx {
  plugin: (plugin: unknown) => Promise<unknown>;
  loader: {
    create: (options: { id: string; name: string; config?: unknown }) => Promise<string>;
    await: () => Promise<void>;
    entries: () => Iterable<TestEntry>;
  };
  fiber?: { dispose: () => unknown };
}

describe("装载时序：开机迁移只在本条目 ACTIVE 之后读规则库", () => {
  let scratch: string;
  let origDshHome: string | undefined;
  let live: TestCtx | undefined;

  beforeAll(async () => {
    await mkdir(path.join(FIXTURE_DIR, "lib"), { recursive: true });
    await cp(path.join(PKG_ROOT, "host.ts"), FIXTURE_HOST);
    await cp(path.join(PKG_ROOT, "lib"), path.join(FIXTURE_DIR, "lib"), { recursive: true });
  });

  beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "lesson-activation-"));
    origDshHome = process.env["DSH_HOME"];
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

  it("存量碎片被归并、project 键被归一（apply 期读到空投影这一点也钉住）", async () => {
    const provider = makeSettingsProvider({
      [ENTRY_ID]: {
        [RULES_FIELD]: [
          fragmentRow("frag-1", FRAGMENT_SIGNATURE, FRAGMENT_CWD),
          fragmentRow("frag-2", `${FRAGMENT_CWD}/src/b.ts`, FRAGMENT_CWD),
        ],
      },
    });
    const trace: DescribeSample[] = [];
    const ctx = new Context() as unknown as TestCtx;
    const entryState = (): number | undefined => {
      const entry = [...ctx.loader.entries()].find((row) => row.id === ENTRY_ID);
      return entry?.fiber?.state;
    };
    const settings = gateDescribe(provider, trace, entryState);

    await ctx.plugin({
      name: "deps",
      apply(child: { provide: (name: string, value: unknown) => void }) {
        child.provide("settings", settings);
      },
    });
    await ctx.plugin(Loader);
    live = ctx;
    await ctx.loader.create({ id: ENTRY_ID, name: pathToFileURL(FIXTURE_HOST).href });
    await ctx.loader.await().catch(() => null);
    // 迁移链是 apply 里 fire-and-forget 的异步链，多排几个宏任务边界让它跑完。
    await flushAsync(0);
    await flushAsync(0);
    await flushAsync(0);

    // 门控保真度：这一层假件必须真的复刻 harness 判据（非 ACTIVE 投不出本条目），
    // 否则上面的时序断言只是自证。合成状态直验，不依赖插件的行为。
    const notActive = gateDescribe(provider, [], () => 1);
    expect(notActive.describe(), "门控可信：条目非 ACTIVE 时 describe() 必须投空").toStrictEqual(
      [],
    );
    const active = gateDescribe(provider, [], () => 2);
    expect(active.describe(), "门控可信：ACTIVE 时照常投影").toHaveLength(1);

    // 时序断言：插件对规则库的每一次读都必须发生在本条目 ACTIVE 之后
    // （修复前第一条就是 PENDING 期读，这里会红）。
    expect(trace.length, "迁移至少读过一次规则库").toBeGreaterThan(0);
    expect(
      trace.filter((sample) => sample.state !== 2),
      "装载期（PENDING）读规则库 = 静默空转，不许再有",
    ).toStrictEqual([]);

    const rows = provider.peek(ENTRY_ID)?.[RULES_FIELD] as Record<string, unknown>[];
    const signatures = rows.map((row) => row["signature"]);
    expect(signatures, "两条路径型碎片必须折成一张类别级稳定卡").toStrictEqual([STABLE_SIGNATURE]);
    expect(rows[0]?.["occurrences"], "归并累加观察次数").toBe(4);
    expect(
      rows.every((row) => row["project"] === deriveProject(FRAGMENT_CWD)),
      "存量卡的 project 键必须归一到 deriveProject(cwd)",
    ).toBe(true);
  });
});
