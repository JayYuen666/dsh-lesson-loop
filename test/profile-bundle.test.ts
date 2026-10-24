// profile-bundle 守卫用例：喂合成夹具，钉住各解析守卫本身（真实产物那条路由
// build-client.test.ts 经 bundleSlotKeyFacts 走）。守卫若退化回坏形状（带引号不剥、
// 注释不剥、多命中不拒、`$` 不转义、窗口不收、非字符串静默滤掉），这里先红。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  assertBundleListOf,
  configFormsEntryId,
  constLiteral,
  entryIdFromPatchYml,
  registeredSlotKey,
} from "./profile-bundle.ts";

describe("profile-bundle 解析守卫", () => {
  it("patch 条目 id：剥引号与行尾注释；多条不同值直接红（挑第一条会读错行）", () => {
    assert.equal(entryIdFromPatchYml('- insert:\n    - id: "quoted-id"'), "quoted-id");
    assert.equal(entryIdFromPatchYml("- id: bare-id  # 行尾注释"), "bare-id");
    assert.equal(entryIdFromPatchYml("- id: 'single-quoted' # x"), "single-quoted");
    assert.equal(entryIdFromPatchYml("- id: plain\nother: line"), "plain");
    assert.throws(() => entryIdFromPatchYml("- id: a\n    - id: b"), /多条不同的 - id:/u);
    assert.throws(() => entryIdFromPatchYml("no id line here"), /没有 `- id:` 条目/u);
  });

  it("bundle 清单：非字符串条目即红（静默滤掉会把清单损坏伪装成没装这个包）", () => {
    assert.deepEqual(assertBundleListOf(["a", "b"], "清单"), ["a", "b"]);
    assert.throws(() => assertBundleListOf(["a", { name: "x" }], "清单"), /非字符串条目/u);
    assert.throws(() => assertBundleListOf("not-an-array", "清单"), /不是数组/u);
  });

  it("const 字面量：标识符含 `$` 不被当正则锚点；空白与单引号形态都认", () => {
    assert.equal(constLiteral('const $slotKey = "pkg-name";', "$slotKey"), "pkg-name");
    assert.equal(constLiteral("const  NS  =  'lesson-loop' ;", "NS"), "lesson-loop");
    assert.throws(() => constLiteral('const other = "x";', "missing"), /找不到 const missing/u);
  });

  it("slot key 提取：只认 register 对象窗口内的 key:，标识符内嵌与窗口外的 key: 不抓", () => {
    const bundle =
      'ctx.slots.register({\n\tname: "plugins.bundle.config",\n\tkey: BUNDLE_PKG,\n\tinject: () => ({ inner: "v" })\n}, Card);\nconst BUNDLE_PKG = "pkg-name";';
    // 标识符分支：去产物里查 const 声明取值
    assert.equal(registeredSlotKey(bundle), "pkg-name");
    // 标识符内嵌（slotkey:/monkey: 这类以 key: 结尾的小写词）不命中 key: 判据
    const embedded =
      'name: "plugins.bundle.config",\n\tslotkey: "wrong",\n\tmonkey: "wronger",\n\tkey: "right",\n\tinject: () => ({})\n})';
    assert.equal(registeredSlotKey(embedded), "right");
    // 窗口外（register 对象闭合之后）的 key: 不抓
    const outside =
      'name: "plugins.bundle.config",\n\tkey: "inside",\n\tinject: () => ({})\n});\nconst item = { key: "outside" };';
    assert.equal(registeredSlotKey(outside), "inside");
    assert.throws(() => registeredSlotKey("没有注册"), /没有 plugins.bundle.config 的注册/u);
  });

  it("configForms.get 入参：全量收集断言同值；括号深度取全；实参先 trim", () => {
    assert.equal(
      configFormsEntryId('const scope = ctx.configForms.get(NS); const NS = "lesson-loop";'),
      "lesson-loop",
    );
    assert.equal(configFormsEntryId('const a = ctx.configForms.get( "plain" );'), "plain");
    // 嵌套括号：实参按深度取全（旧实现截到第一个右括号，报错信息里的实参只剩半截）
    assert.throws(
      () =>
        configFormsEntryId("const a = ctx.configForms.get(resolve(ns)); const resolve = (x) => x;"),
      /找不到 const resolve\(ns\) = /u,
      "报错点名完整实参，而不是被截断的那半截",
    );
    // 多处调用各不相同 → 直接红（只取第一处会把断言对到无关的那处上）
    assert.throws(
      () => configFormsEntryId('ctx.configForms.get("a"); ctx.configForms.get("b");'),
      /多处不同的 configForms/u,
    );
    assert.throws(() => configFormsEntryId("没有调用"), /没有 ctx.configForms.get/u);
  });
});
