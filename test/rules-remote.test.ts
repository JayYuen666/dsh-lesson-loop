// 规则读面（Typert Remote）的宿主侧直测：注册、四个方法的成功/拒绝分支，以及客户端
// descriptor 与宿主 `@Remote` 标记的对质。端到端卡片链路在 test/client-data.test.ts。
import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol";

import { installRulesRemote, LessonRulesService } from "../lib/rules-remote.ts";
import type { LessonRulesDeps, RulesStore } from "../lib/rules-remote.ts";
import { RULES_REMOTE_NAMESPACE } from "../lib/rules-shape.ts";
import { MESSAGES } from "../lib/messages.ts";
import { RULES_DESCRIPTORS } from "../src/rules-reader.ts";

type Outcome = "persisted" | "not-found" | "persist-failed" | "throw";

function depsOf(outcome: Outcome = "persisted"): LessonRulesDeps {
  const rules = [
    { id: "rule-1", project: "p1", status: "armed", evidence: [] },
    { id: "rule-2", project: "p2", status: "candidate", evidence: [] },
  ] as never[];
  const store: RulesStore = {
    rules: () => rules,
    recentLessons: (project?: string, limit?: number) => {
      const rows: { project: string }[] = [{ project: "p1" }, { project: "p2" }];
      const filtered = project === undefined ? rows : rows.filter((row) => row.project === project);
      return (limit !== undefined && limit > 0 ? filtered.slice(0, limit) : filtered) as never;
    },
    isUndeterminable: () => true,
    ruleAction: async () => {
      if (outcome === "throw") {
        throw new Error("boom");
      }
      return outcome;
    },
  };
  return {
    store,
    stats: () => ({ undeterminableCount: 1 }),
    messagesOf: () => MESSAGES.zh,
  };
}

function serviceOf(deps: LessonRulesDeps): LessonRulesService {
  const ctx = new Context();
  assert.equal(installRulesRemote(ctx, deps), true);
  const service: unknown = ctx.get(RULES_REMOTE_NAMESPACE);
  assert.ok(service instanceof LessonRulesService);
  return service;
}

describe("规则读面（官方 Typert Remote 源模式）", () => {
  it("装进真 Context：四个方法都带 @Remote 标记，客户端 descriptor 逐项对质", () => {
    const service = serviceOf(depsOf());
    const markers = remoteMethods(service)
      .map((marker) => marker.method)
      .toSorted();
    assert.deepEqual(markers, ["lessons", "ruleAction", "rules", "stats"]);
    assert.deepEqual(RULES_DESCRIPTORS.map((descriptor) => descriptor.method).toSorted(), markers);
    for (const descriptor of RULES_DESCRIPTORS) {
      assert.equal(descriptor.service, RULES_REMOTE_NAMESPACE);
      assert.equal(descriptor.namespace, RULES_REMOTE_NAMESPACE);
      assert.equal(descriptor.invocation.kind, "direct");
      assert.equal(descriptor.result.mode, "src-json");
    }
  });

  it("注册口缺席时返回 false（可选读面，不让 apply 下线）", () => {
    assert.equal(installRulesRemote({} as never, depsOf()), false);
  });

  it("stats 交回计数与去掉 evidence 的规则投影", () => {
    const service = serviceOf(depsOf());
    const body = service.stats();
    assert.equal(body["ok"], true);
    assert.equal(body["undeterminableCount"], 1);
    const rows = body["rules"] as { id: string; undeterminable: boolean }[];
    assert.equal(rows.length, 2);
    assert.equal(
      rows.every((row) => row.undeterminable),
      true,
    );
    assert.equal("evidence" in (rows[0] as object), false);
  });

  it("rules 按 project 过滤；缺省与非记录请求都按全量", () => {
    const service = serviceOf(depsOf());
    assert.deepEqual(
      service.rules({ project: "p1" }).rules.map((rule) => rule.id),
      ["rule-1"],
    );
    assert.equal(service.rules({}).rules.length, 2);
    assert.equal(service.rules(null as never).rules.length, 2);
  });

  it("lessons 的 project/limit 过滤与缺省全量", () => {
    const service = serviceOf(depsOf());
    assert.equal(service.lessons({ project: "p1" }).count, 1);
    assert.equal(service.lessons({ limit: 1 }).count, 1);
    assert.equal(service.lessons({ limit: -1 }).count, 2, "≤ 0 与缺省同义：全量");
    assert.equal(service.lessons(null as never).count, 2);
    assert.equal(service.lessons({ limit: Number.NaN }).count, 2);
  });

  it("ruleAction：缺字段/未知动作 → 400，找不到 → 404，落盘失败 → 500", async () => {
    const missing = await serviceOf(depsOf()).ruleAction({ id: "", action: "arm" });
    assert.deepEqual([missing.ok, missing.ok ? 0 : missing.status], [false, 400]);
    const unknown = await serviceOf(depsOf()).ruleAction({ id: "r", action: "boom" });
    assert.deepEqual([unknown.ok, unknown.ok ? 0 : unknown.status], [false, 400]);
    const notFound = await serviceOf(depsOf("not-found")).ruleAction({ id: "r", action: "arm" });
    assert.deepEqual([notFound.ok, notFound.ok ? 0 : notFound.status], [false, 404]);
    const failed = await serviceOf(depsOf("persist-failed")).ruleAction({
      id: "r",
      action: "arm",
    });
    assert.deepEqual([failed.ok, failed.ok ? 0 : failed.status], [false, 500]);
    // 卡片直接显示 error 串：落库失败那档回消息表里的本地化文案，
    // 不是 report() 回执上的内部判等码
    assert.equal(failed.ok ? "" : failed.error, MESSAGES.zh.errRulePersistFailed);
  });

  it("注册口探过但构造期注册抛错 → 记日志返回 false（不让 apply 当场炸）", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {
      // 断言在下方
    });
    const ctx = {
      reflect: {
        provide: () => {
          throw new Error("命名空间已注册");
        },
      },
    };
    assert.equal(installRulesRemote(ctx as never, depsOf()), false);
    assert.match(String(error.mock.calls[0]?.[0]), /registration failed: 命名空间已注册/u);
    error.mockRestore();
  });

  it("畸形入参走保守分支：非记录请求、非串字段、非记录 ctx", async () => {
    const service = serviceOf(depsOf());
    const noRecord = await service.ruleAction(null as never);
    assert.equal(noRecord.ok, false);
    const wrongTypes = await service.ruleAction({ id: 1, action: 2, statement: 3 } as never);
    assert.equal(wrongTypes.ok, false);
    assert.equal(installRulesRemote(null as never, depsOf()), false);
  });

  it("ruleAction：成功回执带 id/action；存储抛错时兜成 500 并留日志", async () => {
    const done = await serviceOf(depsOf()).ruleAction({ id: "r", action: "arm", statement: "改" });
    assert.deepEqual(done, { ok: true, id: "r", action: "arm" });
    const error = vi.spyOn(console, "error").mockImplementation(() => {
      // 断言只看被调用
    });
    try {
      const thrown = await serviceOf(depsOf("throw")).ruleAction({ id: "r", action: "arm" });
      assert.deepEqual([thrown.ok, thrown.ok ? 0 : thrown.status], [false, 500]);
      assert.equal(error.mock.calls.length, 1);
    } finally {
      error.mockRestore();
    }
  });
});
