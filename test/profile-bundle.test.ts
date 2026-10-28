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

  it("const 字面量：标识符含 `$` 不被当正则锚点；空白与单引号形态都认；拼接不算字面量", () => {
    assert.equal(constLiteral('const $slotKey = "pkg-name";', "$slotKey"), "pkg-name");
    assert.equal(constLiteral("const  NS  =  'lesson-loop' ;", "NS"), "lesson-loop");
    assert.throws(() => constLiteral('const other = "x";', "missing"), /找不到 const missing/u);
    // 拼接：`const X = "a" + "b"` 不是一条可读常量，静默取 "a" 等于拿假值去比对
    assert.throws(() => constLiteral('const X = "a" + "b";', "X"), /找不到 const X/u);
  });

  it("slot key 提取：只认 register 对象里的 key:，标识符内嵌与嵌套对象里的 key: 不抓", () => {
    const bundle =
      'ctx.slots.register({\n\tname: "plugins.bundle.config",\n\tkey: BUNDLE_PKG,\n\tinject: () => ({ inner: "v" })\n}, Card);\nconst BUNDLE_PKG = "pkg-name";';
    // 标识符分支：去产物里查 const 声明取值
    assert.equal(registeredSlotKey(bundle), "pkg-name");
    // 标识符内嵌（slotkey:/monkey: 这类以 key: 结尾的小写词）不命中 key: 判据
    const embedded =
      'ctx.slots.register({\n\tname: "plugins.bundle.config",\n\tslotkey: "wrong",\n\tmonkey: "wronger",\n\tkey: "right",\n\tinject: () => ({})\n}, Card)';
    assert.equal(registeredSlotKey(embedded), "right");
    // 窗口外（register 对象闭合之后）的 key: 不抓
    const outside =
      'ctx.slots.register({\n\tname: "plugins.bundle.config",\n\tkey: "inside",\n\tinject: () => ({})\n}, Card);\nconst item = { key: "outside" };';
    assert.equal(registeredSlotKey(outside), "inside");
    // key 排在 inject 之后、且 inject 的内层对象也有 key：按深度只认顶层那一条
    const lateKey =
      'ctx.slots.register({\n\tname: "plugins.bundle.config",\n\tinject: () => ({ nested: { key: "inner" } }),\n\tkey: "outer"\n}, Card)';
    assert.equal(registeredSlotKey(lateKey), "outer");
    assert.throws(() => registeredSlotKey("没有注册"), /没有 plugins.bundle.config 的注册/u);
  });

  it("configForms.get 入参：全量收集断言同值；括号深度取全；实参先 trim", () => {
    assert.equal(
      configFormsEntryId('const scope = ctx.configForms.get(NS); const NS = "lesson-loop";'),
      "lesson-loop",
    );
    assert.equal(configFormsEntryId('const a = ctx.configForms.get( "plain" );'), "plain");
    // 嵌套括号：实参按深度取全；既非字面量也非标识符的实参（调用表达式）响亮失败，
    // 报错点名完整实参——漂移针不许拿解析不动的实参继续跑。
    assert.throws(
      () => configFormsEntryId("const a = ctx.configForms.get(resolve(ns));"),
      /实参不是字面量或标识符（resolve\(ns\)）/u,
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
