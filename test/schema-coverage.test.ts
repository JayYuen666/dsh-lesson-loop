// test/schema-coverage.ts 的**解析器**自身要有判据：它是九仓共用门禁（复制式分发），
// 解析漏一个字段等于那个设置项永远不上卡、也永远不会被点名（假绿）；解析截断则相反，
// 会把不存在的字段报成"未暴露"。这里直接喂 source 文本，不依赖本仓 host.ts。
/// <reference types="node" />
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { hostSchemaFields, schemaCoverageProblems } from "./schema-coverage.ts";

describe("host schema 解析器（卡片覆盖门禁的读数面）", () => {
  it("值的写法不限于 `Schema.`：引用另一枚 schema 常量的字段照样要解析出来", () => {
    const src = `const configSchema = Schema.object({
  enabled: Schema.boolean().default(true).volatile(),
  rules: RulesFieldSchema,
  port: OtherSchema,
});`;
    assert.deepEqual(hostSchemaFields(src), ["enabled", "rules", "port"]);
  });

  it("值里的字符串含右括号不会把块截断（截断后其后的字段全部丢失 = 假绿）", () => {
    const src = `const configSchema = Schema.object({
  a: Schema.string(),
  b: Schema.string().default("x)y"),
  c: Schema.number(),
  d: Schema.number(),
});`;
    assert.deepEqual(hostSchemaFields(src), ["a", "b", "c", "d"]);
  });

  it("默认值里的行注释与块注释不参与取键", () => {
    const src = `const configSchema = Schema.object({
  // note: 这是注释里的假字段
  a: Schema.number(),
  /* other: 也是假的 */
  b: Schema.number(),
});`;
    assert.deepEqual(hostSchemaFields(src), ["a", "b"]);
  });

  it("嵌套对象的内部键不算顶层字段（按块内基准缩进取键）", () => {
    const src = `const configSchema = Schema.object({
  outer: Schema.object({
    inner: Schema.number(),
  }),
  tail: Schema.number(),
});`;
    assert.deepEqual(hostSchemaFields(src), ["outer", "tail"]);
  });

  it("文件头注释里出现 Schema.object 示例不会把解析锚到注释上", () => {
    const src = `/**
 * 注册形态示例：settings.register(ns, Schema.object({ example: 1 }), base)
 */
const configSchema = Schema.object({
  enabled: Schema.boolean(),
  port: Schema.natural(),
});`;
    assert.deepEqual(hostSchemaFields(src), ["enabled", "port"]);
  });

  it('单行对象写法照样解析（不能靠"字段必须缩进"这种前提）', () => {
    const src = `const configSchema = Schema.object({ enabled: Schema.boolean(), port: Schema.natural() });`;
    assert.deepEqual(hostSchemaFields(src), ["enabled", "port"]);
  });

  it("找不到 Schema.object 时交回空数组（调用方据此报「解析失败」而不是静默通过）", () => {
    assert.deepEqual(hostSchemaFields("const x = 1;"), []);
  });
});

/** 探针 host.ts：两个字段，卡片只绑一个时另一个必须被点名。 */
const PROBE_HOST = `export const Config = Schema.object({
  alpha: Schema.boolean().default(true),
  gamma: Schema.boolean().default(true),
});`;

/**
 * 造一个临时包目录（`package.json` + `host.ts` + `src/card.tsx`），返回其绝对路径。
 *
 * `schemaCoverageProblems` 按「test 文件所在目录的上一级」定包根，所以调用方要给它
 * `<dir>/test/probe.test.ts` 这样一个 URL——目录不必真存在，它只拿来做 `path.dirname`。
 */
function makePkg(cardSource: string, hostSource: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "scov-"));
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@probe/pkg" }));
  writeFileSync(path.join(dir, "host.ts"), hostSource);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "card.tsx"), cardSource);
  return dir;
}

/** 对一个临时包跑一次覆盖率判据（路径字符串形态：`schemaCoverageProblems` 收 `string`）。 */
function problemsIn(dir: string): string[] {
  return schemaCoverageProblems(`${pathToFileURL(dir).href}/test/probe.test.ts`);
}

describe("卡片绑定扫描（boundFieldsIn 的两种字段写法）", () => {
  // 这几条走 schemaCoverageProblems 的完整面（自建临时包目录），因为它们钉的正是
  // 「源码写法 → 门禁读数」这一段——直接喂 boundFieldsIn 拿不到那个缺口暴露出来时的
  // 症状（假失败：字段明明上了卡却报未暴露）。
  it('field="x" 的 JSX 属性写法也算绑定（.tsx 卡片的主要写法）', () => {
    const dir = makePkg(
      `export function Card(props) {
  return (
    <div>
      <ToggleRow field="alpha" label="A" />
      <ToggleRow field="gamma" label="G" />
    </div>
  );
}`,
      PROBE_HOST,
    );
    try {
      assert.deepEqual(problemsIn(dir), [], "两种写法都该被认出，不该有未暴露字段");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('field: "x" 的对象属性写法同样算绑定（createElement / 对象字面量）', () => {
    const dir = makePkg(
      `export function Card(props) {
  return createElement("div", null, [
    createElement(ToggleRow, { field: "alpha", label: "A" }),
    createElement(ToggleRow, { field: "gamma", label: "G" }),
  ]);
}`,
      PROBE_HOST,
    );
    try {
      assert.deepEqual(problemsIn(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("两种写法混用也不漏（同一份源码里各写一半）", () => {
    const dir = makePkg(
      `export function Card(props) {
  return (
    <div>
      <ToggleRow field="gamma" label="G" />
      {createElement(ToggleRow, { field: "alpha", label: "A" })}
    </div>
  );
}`,
      PROBE_HOST,
    );
    try {
      assert.deepEqual(problemsIn(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("真没绑上的字段仍要点名（放宽写法不等于放宽判据）", () => {
    const dir = makePkg(
      `export function Card(props) {
  return <ToggleRow field="alpha" label="A" />;
}`,
      PROBE_HOST,
    );
    try {
      const problems = problemsIn(dir);
      assert.equal(problems.length, 1);
      // 只看「未暴露：…」那一行：报错正文随后还会列出 host 字段全集（alpha 也在里面），
      // 拿整段去断言会把"字段全集"误读成"未暴露清单"。
      const missingLine = (problems[0] ?? "").split("\n")[0] ?? "";
      assert.match(missingLine, /gamma/u, "gamma 没上卡，必须被点名");
      assert.doesNotMatch(missingLine, /alpha/u, "alpha 已绑定，不该进未暴露清单");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
