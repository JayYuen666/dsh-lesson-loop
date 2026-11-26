// 规则读取接口（Typert Remote）的宿主侧直测：注册、四个方法的成功/拒绝分支，以及客户端
// descriptor 与宿主 `@Remote` 标记的对质。端到端卡片链路在 test/client-data.test.ts。
import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol";

import {
  clampPageSize,
  DEFAULT_RULE_DETAIL_PAGE_SIZE,
  installRulesRemote,
  LessonRulesService,
} from "../lib/rules-remote.ts";
import type { LessonRulesDeps, RulesStore } from "../lib/rules-remote.ts";
import { RULES_REMOTE_NAMESPACE } from "../lib/rules-shape.ts";
import type { LessonsReply, LessonsResult, RulesReply, RulesResult } from "../lib/rules-shape.ts";
import { MESSAGES } from "../lib/messages.ts";
import { loggedText } from "./setup-logs.ts";
import { RULES_DESCRIPTORS } from "../src/rules-reader.ts";

const EVIDENCE_SOURCE = "quality-gate" as const;

type Outcome =
  | "persisted"
  | "not-found"
  | "persist-failed"
  | "throw"
  | "invalid-statement"
  | "statement-too-long"
  | "unchanged"
  | "invalid-status";

function depsOf(outcome: Outcome = "persisted"): LessonRulesDeps {
  const rules = [
    { id: "rule-1", project: "p1", status: "armed", evidence: [] },
    { id: "rule-2", project: "p2", status: "candidate", evidence: [] },
  ] as never[];
  const store: RulesStore = {
    rules: () => rules,
    rulesReadable: () => true,
    ruleDetail: () => ({ evidence: [], nextCursor: null }),
    recentLessons: (project?: string, limit?: number) => {
      const rows: {
        project: string;
        detail: string;
        cwd?: string;
        sessionId?: string;
        turn?: number;
      }[] = [
        // 首条 detail 超过读取接口的 400 字上限：lessons 投影要把它截断；可选字段齐全
        // （cwd/sessionId/turn 的投影分支也要走到）。
        { project: "p1", detail: "d".repeat(500), cwd: "/repo", sessionId: "s1", turn: 3 },
        { project: "p2", detail: "短" },
      ];
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

/**
 * 读回执行成功那一支：断言 `ok: true` 后交出载荷。
 *
 * 读方法现在会返回 `{ ok: false, error }`（见 lib/rules-shape.ts 的 ReadRefused），
 * 所以每条成功路径的用例都得先过这道闸——这同时把"该成功却回了失败"变成一条带
 * 文案的断言失败，而不是 `undefined.rules` 那种 TypeError。
 */
function okRules(reply: RulesReply): RulesResult["rules"] {
  assert.equal(reply.ok, true, reply.ok ? "" : reply.error);
  return reply.rules;
}

function okLessons(reply: LessonsReply): LessonsResult {
  assert.equal(reply.ok, true, reply.ok ? "" : reply.error);
  return reply;
}

/** 模拟 I/O 层直接抛错：读方法的 catch 分支必须把它折成回执，不许越过网关。 */
function boom(): never {
  throw new Error("disk on fire");
}

describe("证据页大小（设置项兜底）", () => {
  it("非数/NaN 回落默认 20", () => {
    assert.equal(clampPageSize(undefined), DEFAULT_RULE_DETAIL_PAGE_SIZE);
    assert.equal(clampPageSize("30"), DEFAULT_RULE_DETAIL_PAGE_SIZE);
    assert.equal(clampPageSize(Number.NaN), DEFAULT_RULE_DETAIL_PAGE_SIZE);
  });

  it("合法数取整并夹到 5–100", () => {
    assert.equal(clampPageSize(20.9), 20, "小数只取整数部分");
    assert.equal(clampPageSize(0), 5, "低于下限抬到 5");
    assert.equal(clampPageSize(500), 100, "高于上限压到 100");
    assert.equal(clampPageSize(42), 42);
  });
});

describe("规则读取接口（官方 Typert Remote 源模式）", () => {
  it("装进真 Context：四个方法都带 @Remote 标记，客户端 descriptor 逐项对质", () => {
    const service = serviceOf(depsOf());
    const markers = remoteMethods(service)
      .map((marker) => marker.method)
      .toSorted();
    assert.deepEqual(markers, ["lessons", "ruleAction", "ruleDetail", "rules", "stats"]);
    // 每个自有方法都必须带标记：新增方法漏写 markRemote 时 descriptor 与标记两边都不变
    // （下面那条对质仍绿），卡片却永远读不到新方法。按原型逐名对账钉住这类漏项。
    const ownMethods = Object.getOwnPropertyNames(LessonRulesService.prototype)
      .filter(
        (name) =>
          name !== "constructor" &&
          typeof Reflect.get(LessonRulesService.prototype, name) === "function",
      )
      .toSorted();
    assert.deepEqual(ownMethods, markers, "每个自有方法都要有 @Remote 标记");
    assert.deepEqual(RULES_DESCRIPTORS.map((descriptor) => descriptor.method).toSorted(), markers);
    for (const descriptor of RULES_DESCRIPTORS) {
      assert.equal(descriptor.service, RULES_REMOTE_NAMESPACE);
      assert.equal(descriptor.namespace, RULES_REMOTE_NAMESPACE);
      assert.equal(descriptor.invocation.kind, "direct");
      assert.equal(descriptor.result.mode, "src-json");
    }
  });

  it("注册口缺席时返回 false（可选读取接口，不让 apply 下线）", () => {
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
      okRules(service.rules({ project: "p1" })).map((rule) => rule.id),
      ["rule-1"],
    );
    assert.equal(okRules(service.rules({})).length, 2);
    assert.equal(okRules(service.rules(null as never)).length, 2);
  });

  it("lessons 的 project/limit 过滤：缺省/≤0 取默认条数；detail 截断、不外借 evidence", () => {
    const service = serviceOf(depsOf());
    assert.equal(okLessons(service.lessons({ project: "p1" })).count, 1);
    assert.equal(okLessons(service.lessons({ limit: 1 })).count, 1);
    // 缺省 / ≤0 / 非数字：取默认条数（事件流水只增不减，"缺省 = 全量"会让一次调用
    // 把整份流水序列化过网关）。
    assert.equal(okLessons(service.lessons({ limit: -1 })).count, 2, "≤0 与缺省同义：默认条数");
    assert.equal(okLessons(service.lessons(null as never)).count, 2);
    assert.equal(okLessons(service.lessons({ limit: Number.NaN })).count, 2);
    // 读取接口投影：detail 是门禁输出原文一类的敏感内容，下发前截断（400 字 + 省略号）；
    // 原始 evidence 不外借。
    const view = okLessons(service.lessons({})).lessons[0]!;
    assert.ok(view.detail.endsWith("…") && view.detail.length === 401, "detail 已截断");
    assert.ok(!("evidence" in view), "原始 evidence 不上网线");
  });

  it("三个读方法遇到 I/O 抛错时折成 ok:false + 本地化文案，不让异常越过网关", () => {
    // 网关的异常分支只交出 `gateway/internal` 那句英文并原样贴到卡片上；读方法各摸
    // 一个 I/O 面（规则库、settings CAS、事件流水），抛出去等于把内部错误当用户文案。
    const failing: LessonRulesDeps = {
      store: {
        rules: boom,
        rulesReadable: boom,
        ruleDetail: boom,
        recentLessons: boom,
        isUndeterminable: () => true,
        ruleAction: async () => "persisted",
      },
      stats: () => ({ undeterminableCount: 0 }),
      messagesOf: () => MESSAGES.zh,
    };
    const service = serviceOf(failing);
    // stats 的返回类型是开放记录，拒读取接口同样折在这份记录里
    const stats = service.stats();
    assert.deepEqual(
      [stats["ok"], stats["status"], stats["error"]],
      [false, 500, MESSAGES.zh.errStatsUnavailable],
    );
    const rules = service.rules({});
    assert.deepEqual(
      [rules.ok, rules.ok ? 0 : rules.status, rules.ok ? "" : rules.error],
      [false, 500, MESSAGES.zh.errRulesUnavailable],
    );
    const lessons = service.lessons({});
    assert.deepEqual(
      [lessons.ok, lessons.ok ? 0 : lessons.status, lessons.ok ? "" : lessons.error],
      [false, 500, MESSAGES.zh.errLessonsUnavailable],
    );
    const detail = service.ruleDetail({ id: "r" });
    assert.deepEqual(
      [detail.ok, detail.ok ? 0 : detail.status, detail.ok ? "" : detail.error],
      [false, 500, MESSAGES.zh.errRuleDetailUnavailable],
    );
    // 三种拒读各打自己那条日志片段（模板表按方法名区分，日志里能看出自哪一处炸的）
    assert.match(loggedText(), /\[lesson-loop\] stats request failed:/u);
    assert.match(loggedText(), /\[lesson-loop\] rules request failed:/u);
    assert.match(loggedText(), /\[lesson-loop\] lessons request failed:/u);
  });

  it("ruleAction：invalid-statement / statement-too-long → 400（本地化文案）；unchanged → 按成功回执", async () => {
    const invalid = await serviceOf(depsOf("invalid-statement")).ruleAction({
      id: "r",
      action: "arm",
    });
    assert.deepEqual([invalid.ok, invalid.ok ? 0 : invalid.status], [false, 400]);
    assert.equal(invalid.ok ? "" : invalid.error, MESSAGES.zh.errStatementRequired);
    const tooLong = await serviceOf(depsOf("statement-too-long")).ruleAction({
      id: "r",
      action: "edit",
      statement: "x",
    });
    assert.deepEqual([tooLong.ok, tooLong.ok ? 0 : tooLong.status], [false, 400]);
    assert.equal(tooLong.ok ? "" : tooLong.error, MESSAGES.zh.errStatementTooLong);
    const unchanged = await serviceOf(depsOf("unchanged")).ruleAction({
      id: "r",
      action: "edit",
      statement: "同文",
    });
    assert.deepEqual([unchanged.ok, unchanged.ok ? unchanged.id : 0], [true, "r"]);
  });

  it("ruleAction：缺字段/未知动作 → 400，找不到 → 404，写到磁盘失败 → 500", async () => {
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

  it("ruleAction：彻底删除只对已归档/已拒绝开放 → 400 并点名原因（库未动）", async () => {
    const forbidden = await serviceOf(depsOf("invalid-status")).ruleAction({
      id: "r",
      action: "delete",
    });
    assert.deepEqual([forbidden.ok, forbidden.ok ? 0 : forbidden.status], [false, 400]);
    assert.equal(forbidden.ok ? "" : forbidden.error, MESSAGES.zh.errRuleDeleteNotAllowed);
  });

  it("ruleDetail：空 id → 400、cursor 非法 → 400、不存在 → 404、库读不懂 → 500、页大小走设置项", () => {
    const calls: number[] = [];
    const deps = depsOf();
    const pages: LessonRulesDeps = {
      ...deps,
      store: {
        ...deps.store,
        rulesReadable: () => true,
        ruleDetail: (id: string, cursor: number, pageSize: number) => {
          calls.push(cursor, pageSize);
          if (id !== "rule-1") {
            return null;
          }
          return {
            evidence: [{ ts: 7, source: "quality-gate", detail: "整段输出" }],
            nextCursor: 20,
          };
        },
      },
    };
    const service = serviceOf(pages);
    const sized = serviceOf({ ...pages, pageSize: () => 30 });
    const oversized = serviceOf({ ...pages, pageSize: () => 500 });

    const notRecord = service.ruleDetail(null as never);
    assert.deepEqual([notRecord.ok, notRecord.ok ? 0 : notRecord.status], [false, 400]);

    const blank = service.ruleDetail({ id: "", cursor: 0 });
    assert.deepEqual([blank.ok, blank.ok ? 0 : blank.status], [false, 400]);
    assert.equal(
      blank.ok ? "" : blank.error,
      MESSAGES.zh.errRuleIdRequired,
      "缺 id 与查无此卡分开讲",
    );
    assert.deepEqual(calls, [], "空 id 不触达存储");

    const missing = service.ruleDetail({ id: "ghost" });
    assert.deepEqual([missing.ok, missing.ok ? 0 : missing.status], [false, 404]);
    assert.equal(missing.ok ? "" : missing.error, MESSAGES.zh.errRuleNotFound);

    const page = service.ruleDetail({ id: "rule-1", cursor: 40 });
    assert.equal(page.ok, true, page.ok ? "" : page.error);
    // 上一行已断言成功形状，下面直接读成功分支的字段（`ok` 是字面量 true，条件判断是多余的）。
    assert.equal(page.nextCursor, 20);
    assert.equal(page.evidence.length, 1);
    // cursor 非法（小数 / 字符串 / 负数）一律 400：静默归 0 会让用户"莫名回到第一页"。
    for (const bad of [1.5, "7" as never, -3]) {
      const refused = service.ruleDetail({ id: "rule-1", cursor: bad });
      assert.deepEqual(
        [refused.ok, refused.ok ? 0 : refused.status, refused.ok ? "" : refused.error],
        [false, 400, MESSAGES.zh.errRuleCursorInvalid],
      );
    }
    service.ruleDetail({ id: "rule-1", cursor: 0 });
    sized.ruleDetail({ id: "rule-1" });
    oversized.ruleDetail({ id: "rule-1" });
    assert.deepEqual(
      calls,
      [0, 20, 40, 20, 0, 20, 0, 30, 0, 100],
      "非法 cursor 与空 id 都不触达存储；cursor 0 是合法起点；页大小夹在 5–100",
    );

    // 库读不懂（rules() 折成空数组，ruleDetail 因此交 null）= 500，不是 404。
    const unreadable = serviceOf({
      ...pages,
      store: { ...pages.store, rulesReadable: () => false },
    });
    const broken = unreadable.ruleDetail({ id: "ghost" });
    assert.deepEqual(
      [broken.ok, broken.ok ? 0 : broken.status, broken.ok ? "" : broken.error],
      [false, 500, MESSAGES.zh.errRuleDetailUnavailable],
    );
  });

  it("ruleDetail 的证据投影：单条截到 400 字、整页超预算就收口并交回 consumed", () => {
    const deps = depsOf();
    const evidenceOf = (lengths: readonly number[]): LessonRulesDeps => ({
      ...deps,
      store: {
        ...deps.store,
        rulesReadable: () => true,
        ruleDetail: () => ({
          evidence: lengths.map((length, index) => ({
            ts: index,
            source: EVIDENCE_SOURCE,
            detail: "x".repeat(length),
          })),
          nextCursor: null,
        }),
      },
    });

    // 短正文原样交回（投影不改写不需要截的条目）；长正文按码点截到 400 再补省略号。
    const mixed = serviceOf(evidenceOf([3, 500])).ruleDetail({ id: "r" });
    // assert.ok 带断言签名：它会收窄掉失败支，后面才读得到 evidence（这是用例里
    // "先断言成功形状再读成功字段"的标准写法，别改成 assert.equal 再挂可选链）。
    assert.ok(mixed.ok, mixed.ok ? "" : mixed.error);
    const [kept, capped] = mixed.evidence;
    assert.ok(kept !== undefined && capped !== undefined, "两条都要发回来");
    assert.equal(kept.detail, "xxx", "没超上限的条目不重造对象");
    assert.equal(capped.detail.length, 401, "400 个码点 + 一枚省略号");
    assert.equal(capped.detail.at(-1), "…");

    // 整页预算（20,000 字）用尽即收口：不吞条、不静默丢证据，nextCursor 交回已发条数。
    // 60 条各 400 字（换了长度就得重算"少发几条"那条期望）：每条都随下标微差，
    // 免得被 prefer-array-fill 当成"常量回调"要求改写成 fill。
    const many = Array.from({ length: 60 }, (_unused, index) => 400 + index);
    const page = serviceOf(evidenceOf(many)).ruleDetail({ id: "r" });
    assert.ok(page.ok, page.ok ? "" : page.error);
    assert.ok(page.evidence.length < many.length, "超预算时必须少发几条，而不是整页照发");
    assert.ok(page.evidence.length > 0, "至少要发一条，不能把页发成空的");
    assert.equal(page.nextCursor, page.evidence.length, "0 起点时下一页指针等于已发条数");
    // 预算真的守着上限：已发条目的正文合计不超过 20,000。
    const used = page.evidence.reduce((sum, entry) => sum + entry.detail.length, 0);
    assert.ok(used <= 20_000, `整页正文合计 ${used} 超了 20000 字预算`);

    // 非零起点：服务端返回的 evidence 是 cursor 之后的切片，预算截断时下一条
    // 必须是“起点 + 本页已发条数”，不能把本页相对条数当作绝对 cursor。
    const long = Array.from({ length: 200 }, (_unused, index) => 500 + index);
    const paged: LessonRulesDeps = {
      ...deps,
      pageSize: () => 100,
      store: {
        ...deps.store,
        ruleDetail: (_id, cursor, pageSize) => ({
          evidence: long.slice(cursor, cursor + pageSize).map((length, index) => ({
            ts: cursor + index,
            source: EVIDENCE_SOURCE,
            detail: "x".repeat(length),
          })),
          nextCursor: cursor + pageSize < long.length ? cursor + pageSize : null,
        }),
      },
    };
    const offsetPage = serviceOf(paged).ruleDetail({ id: "r", cursor: 40 });
    assert.ok(offsetPage.ok, offsetPage.ok ? "" : offsetPage.error);
    assert.ok(offsetPage.evidence.length > 0, "截断页至少要发一条");
    assert.equal(
      offsetPage.nextCursor,
      40 + offsetPage.evidence.length,
      "非零起点下 nextCursor 必须是绝对偏移，而不是本页相对条数",
    );
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
