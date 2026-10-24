// test/setup-logs.ts 的门禁**自身**要有判据：它是 setupFile，跑在每个测试文件里，
// 拦错了会让所有用例莫名其妙变红，漏拦了则日志契约形同不存在。这里直接喂 audit()
// 已构造的账本，两个方向各验一次。
/// <reference types="node" />
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { audit } from "./setup-logs.ts";
import type { LogRecord } from "./setup-logs.ts";

/** 与 spyLevel 同口径把一枚实参折成一行。 */
function flatten(arg: unknown): string {
  return String(arg).replaceAll(/\s+/gu, " ");
}

/** 一枚账本条目：`text` 只拼首参、`full` 拼全部实参。 */
function entry(args: readonly unknown[]): LogRecord {
  const [first, ...rest] = args;
  return {
    level: "error",
    text: flatten(first),
    full: args.map((arg) => flatten(arg)).join(" "),
    extra: rest,
  };
}

describe("日志账本门禁本身", () => {
  it("前缀与正文分参的日志照样被认领（只看首参会把 `[lesson-loop]` + 正文判成未认领）", () => {
    const verdict = audit([entry(["[lesson-loop]", "stats request failed:"])]);
    assert.deepEqual(verdict.unclaimed, [], "正文在次参里也算认领");
    assert.deepEqual(verdict.strangers, []);
  });

  it("普通对象/Map/Set 当首参不算「别家插件日志」", () => {
    const values: readonly [string, unknown][] = [
      ["{}", {}],
      ["Map", new Map()],
      ["Set", new Set()],
    ];
    for (const [name, value] of values) {
      const verdict = audit([entry([value])]);
      assert.deepEqual(verdict.strangers, [], `String(${name}) 不是插件标签，不该判成装配范围错了`);
    }
  });

  it("真别家标签仍然判红（放宽标签判据没有把这条门禁放掉）", () => {
    const verdict = audit([entry(["[other-plugin] something happened"])]);
    assert.equal(verdict.strangers.length, 1, "带别家 `[小写包名]` 标签的仍要报");
  });

  it("本包日志对不上任何模板片段仍判未认领（认领面放宽到全部实参也没把这条放掉）", () => {
    const verdict = audit([entry(["[lesson-loop] 这句是临时拼的，源码里没有对应模板"])]);
    assert.equal(verdict.unclaimed.length, 1, "没模板片段的仍要报");
  });
});
