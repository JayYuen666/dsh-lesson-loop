// test/schema-coverage.ts 的**解析器**自身要有判据：它是九仓共用门禁（复制式分发），
// 解析漏一个字段等于那个设置项永远不上卡、也永远不会被点名（假绿）；解析截断则相反，
// 会把不存在的字段报成"未暴露"。这里直接喂 source 文本，不依赖本仓 host.ts。
/// <reference types="node" />
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { hostSchemaFields } from "./schema-coverage.ts";

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

  it("找不到 Schema.object 时交回空数组（调用方据此报「解析失败」而不是静默通过）", () => {
    assert.deepEqual(hostSchemaFields("const x = 1;"), []);
  });
});
