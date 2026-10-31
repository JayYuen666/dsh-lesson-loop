// build-client 冒烟：rolldown 打包产物含 ModuleLoader 外壳与卡片注册。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildClient,
  clientExternals,
  declaredClientExternals,
  singleEntryChunk,
} from "../build-client.mjs";
import { clientFreshnessEvidence } from "./client-freshness.ts";
import { bundleSlotKeyFacts } from "./profile-bundle.ts";
import { schemaCoverageProblems } from "./schema-coverage.ts";

// 模块表 id 必须等于包名（dsh 的 client-modules 只扫裸包名条目并按包名建键）：
// 断言两侧同源，验的是「构建器取了 package.json 的 name」，改名不再需要改测试。
const PKG_NAME = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as unknown as {
    name: string;
  }
).name;

describe("buildClient", () => {
  it(`${PKG_NAME}: client.js 与最新构建逐字节一致（改 src 后必须 node build-client.mjs）`, async () => {
    const { pkgName, pkgDir, onDisk, built } = await clientFreshnessEvidence(import.meta.url);
    assert.equal(
      onDisk,
      built,
      onDisk === built
        ? "fresh"
        : `[${pkgName}] client.js 已过期：src/client-entry.ts（或其依赖）变更后未重建。请运行：cd ${pkgDir} && node build-client.mjs`,
    );
  });

  // 漂移针：槽位 key = profile 的 bundle 包名，configForms 入参 = patch 裸条目 id。
  it("漂移针：槽位 key = profile 的 bundle 包名，configForms 入参 = patch 裸条目 id", async () => {
    const { bundle, entryId, slotKey, formsEntryId } = await bundleSlotKeyFacts();
    assert.notEqual(
      bundle,
      entryId,
      "bundle 包名与裸条目 id 相同 → 这两个标识无从区分，漂移针失效，需人工确认宿主派发键",
    );
    assert.equal(
      slotKey,
      bundle,
      `plugins.bundle.config 的 key 必须是 bundle 包名 ${bundle}（宿主按包名派发），写成裸条目 id ${entryId} 就是永不出卡`,
    );
    assert.equal(
      formsEntryId,
      entryId,
      `configForms.get() 的入参必须仍是裸条目 id ${entryId}（0.2.1-alpha.2 里它就是 settings 命名空间），不得顺手换成 bundle 包名`,
    );
  });

  it("生成 UMD 外壳（id=包名）并包含卡片代码", async () => {
    const out = await buildClient();
    assert.match(out, /window\.__ModuleLoader__\.load\(/u);
    assert.ok(out.includes(`  id: ${JSON.stringify(PKG_NAME)},`));
    assert.match(out, /factory: \(require\)/u);
    // 卡片代码被打进去（React createElement 与端点路径）
    assert.match(out, /plugins\.bundle\.config/u);
    assert.match(out, /lessonLoopRules/u);
  });

  // external 清单 = 官方 client bundle 的**隐式基座**（外壳预置的冻结模块表）。真源两份：
  // @deepseek-ai/dsh-client-web 的 `src/platform.ts`（`PLATFORM_MODULES` 十一枚 +
  // `PRELOADED_CLIENT_EXTERNALS` 空表），与官方 client 构建器
  // `packages/client/tsdown.client.ts` 的 `clientExternals()`——算的是「基座 ∪ 本包
  // dsh.client.external」，注释明写 "The shell baseline is implicit for every dynamic bundle"。
  // 这枚针是**抄写核对**：官方基座加一枚，或本包开始声明 external 时，这里先红，逼人回去看真源。
  it("external = 官方 PLATFORM_MODULES 基座（不再只写 react）", () => {
    assert.deepEqual(clientExternals(), [
      "react",
      "react/jsx-runtime",
      "react-dom",
      "react-dom/client",
      "@deepseek-ai/cordis",
      "zod",
      "@tanstack/react-virtual",
      "@deepseek-ai/dsh-client-store",
      "@deepseek-ai/dsh-client-ui-slots",
      "@deepseek-ai/dsh-client-ui-primitives",
      "@deepseek-ai/dsh-client-ui-dockkit",
    ]);
  });

  it("external 清单没有重复项（基座 ∪ 本包声明，按名字唯一）", () => {
    // 上一条钉的是"清单内容"，这一条钉"清单唯一"：两者是不同的事。rolldown 对重复
    // external 是幂等的（同一枚写两次不改变产物），所以内容针与产物针都抓不到重复——
    // 而清单一旦声明了基座里已有的模块（最典型是 react），重复就会静默出现。这里
    // 独立断言一遍，让"清单唯一"是本文件自己的口径而不是构建器的副作用。
    const externals = clientExternals();
    assert.deepEqual(
      externals,
      [...new Set(externals)],
      "external 清单必须按名字唯一：重复项会让这份清单读起来比实际契约长",
    );
  });

  it("本包 manifest 未声明 dsh.client.external（官方口径：缺省 = 只有基座）", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { dsh?: { client?: { external?: unknown } } };
    assert.equal(
      manifest.dsh?.client?.external,
      undefined,
      "一旦声明，构建器会把它并进 external——届时上一条针与本断言都要按新清单改",
    );
  });

  it("基座里的 react 仍走模块表：bundle 只 require，不内联一份 React 副本", async () => {
    const out = await buildClient();
    assert.match(out, /require\(["']react["']\)/u, "react 必须保持外部引用（身份唯一）");
  });
});

// 卡片字段覆盖门禁（复制式 helper，同 client-freshness.ts 的分发口径）：helper 只交回
// **问题清单**、不登记用例（vitest/require-hook 不收 hook 外的 setup，隔层断言
// vitest/expect-expect 也看不见），故断言写在本文件的用例体内。
// 本包 11 项 volatile 设置字段全部有卡面控件（buildLoopSection/buildPromotionSection/
// buildCapacitySection 里共享 ToggleField/NumberField 的 field props 写字面量），非 volatile
// 部署值与规则库对象声明豁免；helper 会反向校验豁免项确实未绑定，所以豁免表不能用来藏
// 本该上卡的东西。
//
// `rules` 是**整片规则库对象**而非一个可填的行式值：它的读面走 Typert remote 的
// `lessonLoopRules` 命名空间，写面是 lib/rules-namespace.ts 里以计算键
// `{ [RULES_FIELD]: … }` 调 surface.update，界面上由规则卡（renderRuleSection）按
// 状态分组呈现。它没有、也不该有一个设置字段控件，故在此显式豁免。
describe("卡片字段覆盖 host schema（test/schema-coverage.ts）", () => {
  it("除三项部署值外，host 设置字段全部绑定到卡面控件", () => {
    assert.deepEqual(
      schemaCoverageProblems(import.meta.url, {
        allowUnbound: [
          {
            field: "rules",
            reason:
              "整片规则库对象（不是行式设置值）：读面走 Typert remote 的 lessonLoopRules 命名空间，写面是 lib/rules-namespace.ts 的计算键写入，界面由规则卡按状态分组渲染，没有也不该有设置字段控件",
          },
          {
            field: "digestTimeoutMs",
            reason:
              "W4 非 volatile 部署值：一次蒸馏的墙钟，宿主只投影 volatile 字段 ⇒ 结构上没有卡位，只经 profile 行 config 调整（host.ts:530-534）",
          },
          {
            field: "decayIntervalMs",
            reason:
              "W4 非 volatile 部署值：周期衰减的武装间隔，装载期读一次随重启生效，不标 volatile 即不进设置卡（host.ts:535）",
          },
          {
            field: "maxInjectedRules",
            reason:
              "W4 非 volatile 部署值：会话开始注入几条 armed 规则的上限（0 = 不设上限）。它是部署旋钮而不是用户随时翻的开关，与 digestTimeoutMs 同类，同样只经 profile 行 config 调整。",
          },
        ],
      }),
      [],
    );
  });
});

/** 输出守卫测试用的最小 chunk 正文。 */
const CHUNK_CODE = "export {};";
/** 输出守卫测试用的产物文件名。 */
const ARTIFACT_FILE = "artifact.js";

/**
 * 造一个最小输出项；判据只看 type/fileName/isEntry/code。
 * @param type - rolldown 输出项类型
 * @param fileName - 产物文件名
 * @param extra - 该类型需要的其余字段
 * @returns 可交给 singleEntryChunk 的输出项
 */
function outputItem(
  type: "chunk" | "asset",
  fileName: string,
  extra: { isEntry?: boolean; code?: string } = {},
): { type: "chunk" | "asset"; fileName: string; isEntry?: boolean; code?: string } {
  return { type, fileName, ...extra };
}

describe("单文件产物的输出守卫", () => {
  it("拒绝多个 chunk：单文件产物不能静默丢掉第二个", () => {
    const output = [
      outputItem("chunk", ARTIFACT_FILE, { isEntry: true, code: CHUNK_CODE }),
      outputItem("chunk", "chunk-abc.js", { isEntry: false, code: CHUNK_CODE }),
    ];
    assert.throws(() => singleEntryChunk(output, "entry.ts"), /2 项输出/u);
  });

  it("拒绝 asset：单文件产物没有落盘 asset 的位置", () => {
    const output = [
      outputItem("chunk", ARTIFACT_FILE, { isEntry: true, code: CHUNK_CODE }),
      outputItem("asset", "x.css"),
    ];
    assert.throws(() => singleEntryChunk(output, "entry.ts"), /2 项输出/u);
  });

  it("拒绝非 entry 的单个 chunk", () => {
    const output = [outputItem("chunk", "chunk-abc.js", { isEntry: false, code: CHUNK_CODE })];
    assert.throws(() => singleEntryChunk(output, "entry.ts"), /entry chunk/u);
  });

  it("接受唯一的 entry chunk", () => {
    const output = [outputItem("chunk", ARTIFACT_FILE, { isEntry: true, code: CHUNK_CODE })];
    const chunk = singleEntryChunk(output, "entry.ts");
    assert.equal(chunk.code, CHUNK_CODE);
  });
});

describe("declaredClientExternals()", () => {
  it("声明段原样收：不裁剪首尾空白、不排序、不合并重复", () => {
    assert.deepEqual(
      declaredClientExternals({ dsh: { client: { external: [" zod ", "react-dom", "zod"] } } }),
      [" zod ", "react-dom", "zod"],
    );
  });

  it("未声明时返回空清单（只有基座）", () => {
    assert.deepEqual(declaredClientExternals({}), []);
  });

  it("dsh 不是对象时响亮失败", () => {
    assert.throws(() => declaredClientExternals({ dsh: "x" }), /dsh 必须是对象，实际是 string/u);
  });

  it("dsh.client 不是对象时响亮失败", () => {
    assert.throws(
      () => declaredClientExternals({ dsh: { client: ["react"] } }),
      /dsh\.client 必须是对象，实际是 数组/u,
    );
  });

  it("external 不是数组时响亮失败", () => {
    assert.throws(
      () => declaredClientExternals({ dsh: { client: { external: "react" } } }),
      /dsh\.client\.external 必须是字符串数组/u,
    );
  });
});
