// build-client 冒烟：rolldown 打包产物含 ModuleLoader 外壳与卡片注册。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildClient } from "../build-client.mjs";
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
      `configForms.get() 的入参必须仍是裸条目 id ${entryId}（0.1.7 里它就是 settings 命名空间），不得顺手换成 bundle 包名`,
    );
  });

  it("生成 UMD 外壳（id=包名）并包含卡片代码", async () => {
    const out = await buildClient();
    assert.match(out, /window\.__ModuleLoader__\.load\(/u);
    assert.ok(out.includes(`id: '${PKG_NAME}'`));
    assert.match(out, /factory: \(require\)/u);
    // 卡片代码被打进去（React createElement 与端点路径）
    assert.match(out, /plugins\.bundle\.config/u);
    assert.match(out, /_dsh\/lesson-loop\/stats/u);
  });
});

// 卡片字段覆盖门禁（复制式 helper，同 client-freshness.ts 的分发口径）：helper 只交回
// **问题清单**、不登记用例（vitest/require-hook 不收 hook 外的 setup，隔层断言
// vitest/expect-expect 也看不见），故断言写在本文件的用例体内。
// 本包 11 项 volatile 设置字段全部有卡面控件（buildConfigRows 的 ToggleRow/NumberInputRow
// 行，field props 写字面量），只两项非 volatile 部署值声明豁免；helper 会反向校验
// 豁免项确实未绑定，所以豁免表不能用来藏本该上卡的东西。
// ⚠ 门禁看不见 `rules`：host.ts 那一位写的是 `rules: RulesFieldSchema`（引用而不是
// `Schema.` 内联式），正则不认；它的写入面在规则卡（webServer 动作 + lib/rules-namespace.ts
// 的 RULES_FIELD），不由这张表管。
describe("卡片字段覆盖 host schema（test/schema-coverage.ts）", () => {
  it("除两项部署值外，host 设置字段全部绑定到卡面控件", () => {
    assert.deepEqual(
      schemaCoverageProblems(import.meta.url, {
        allowUnbound: [
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
        ],
      }),
      [],
    );
  });
});
