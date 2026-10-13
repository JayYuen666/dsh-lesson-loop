// 四条 HTTP 路由的**真实线上契约**：真 `@deepseek-ai/dsh-host-webserver`（127.0.0.1:0，
// OS 分配端口）+ 真 cordis Loader 装载 host.ts 副本 + 真 `node:http` 请求。
//
// 为什么必须走真服务器（mock 面盖不住的四件事）：
//   1. `register({kind})` 的语义：mock 只记 path，kind 拼错（"exact" 写成别的串）在官方实现里
//      会落进**前缀表**（webserver/src/index.ts:334-341 的 `route.kind === 'exact' ? exact :
//      prefixes`），于是 `/stats` 连 `/stats/anything` 一起吃掉——只有真服务器能验"不吃子路径"。
//   2. 信任闸门（shared/lib/trust）对**真 Node 请求**的落点：Host / sec-fetch-site / Origin
//      三判据、403 文案、以及被拒时绝不带出 csrf。
//   3. `guardBody` 对真流的处理：content-length 与流式两种路径下的 413/400。
//   4. 状态码与响应头（405 的 `Allow`、`cache-control: no-store`）。
//
// 夹具纪律同 bus-boot.test.ts：装载对象是逐字节副本，避免同一份文件被两条路径各载一次。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdir, rm } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as flushAsync } from "node:timers/promises";
import { Context } from "@deepseek-ai/cordis";
import { Loader } from "@deepseek-ai/cordis-plugin-loader";
import { WebServer } from "@deepseek-ai/dsh-host-webserver";
import { RULES_FIELD, SETTINGS_NAMESPACE } from "../../lib/rules-layout.ts";
import { MESSAGES } from "../../lib/messages.ts";
import { makeSettingsProvider } from "../rules-fake.ts";

const PKG_ROOT = path.resolve(import.meta.dirname, "../..");
const FIXTURE_DIR = path.join(PKG_ROOT, ".tmp", "http");
const FIXTURE_HOST = path.join(FIXTURE_DIR, "host.ts");

const STATS_PATH = "/_dsh/lesson-loop/stats";
const RULES_PATH = "/_dsh/lesson-loop/rules";
const LESSONS_PATH = "/_dsh/lesson-loop/lessons";
const ACTION_PATH = "/_dsh/lesson-loop/rule-action";

/** 被操作的规则 id（多处断言共用：路由回执、投影里那一行、动作载荷）。 */
const RULE_ID = "rule-armed";

/** 一条 armed 规则（含 evidence：HTTP 投影必须把它丢掉）。 */
const ARMED_RULE = {
  id: RULE_ID,
  project: "proj-1",
  cwd: "/repo",
  category: "gate-failure",
  signature: "pnpm check",
  statement: "结束回合前先本地运行 pnpm check",
  status: "armed",
  createdAt: 1,
  updatedAt: 2,
  armedAt: 2,
  occurrences: 4,
  sources: ["quality-gate"],
  violation: 1,
  suppressed: 2,
  samples: 3,
  recurrences: 0,
  lastSeenAt: 2,
  evidence: [{ ts: 1, source: "quality-gate", detail: "整段工具输出" }],
  origin: "threshold",
};

/** 一次真实 HTTP 往返的结果。 */
interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * 打一次真请求（`node:http`：Host 可被显式改写，body 不受 fetch 的守护面限制）。
 *
 * `agent: false` = 每次请求独享一条连接（默认 Agent 的 keep-alive 池会把连接留到下一次；
 * 而夹具每个用例后都要 dispose 掉整个服务器，池里那些空闲连接会被对端 reset，冒成
 * "unhandled ECONNRESET" 把整轮测试判脏——连接复用不是本文件要验的东西）。
 *
 * @param port - 监听端口
 * @param options - method / path / headers / body
 * @returns 状态码、响应头与响应体
 */
async function send(
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<HttpResult> {
  const req = httpRequest({
    host: "127.0.0.1",
    port,
    path: options.path,
    method: options.method ?? "GET",
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  });
  req.end(options.body ?? "");
  const [res] = (await once(req, "response")) as [IncomingMessage];
  const chunks: Buffer[] = [];
  for await (const chunk of res) {
    chunks.push(chunk as Buffer);
  }
  // 用完即关：默认 Agent 的 keep-alive 池会把这条连接留到下一次，而夹具每个用例后都要
  // dispose 掉整个服务器——池里那些空闲连接被对端 reset，冒成 unhandled ECONNRESET（
  // 连接复用不是本文件要验的契约）。读完响应主动 destroy 掉本次连接即可。
  req.destroy();
  return {
    status: res.statusCode ?? 0,
    headers: res.headers,
    body: Buffer.concat(chunks).toString("utf8"),
  };
}

/** 本测试用到的 ctx 面（与 host-contract.test.ts 同一写法）。 */
interface TestCtx {
  plugin: (plugin: unknown, config?: unknown) => Promise<unknown>;
  get: (name: string) => unknown;
  loader: {
    create: (options: { id: string; name: string }) => Promise<string>;
    await: () => Promise<void>;
    entries: () => Iterable<{ id: string; fiber?: { dispose: () => unknown } }>;
  };
  fiber?: { dispose: () => unknown };
}

describe("四条路由的真实 HTTP 契约（真 webServer + 真请求）", () => {
  let scratch: string;
  let origDshHome: string | undefined;
  let live: TestCtx | undefined;
  /** 监听端口：在 beforeEach 里随每次挂载刷新（独立声明而非闭包内局部量，用例体才读得到）。 */
  const server = { port: 0 };

  beforeAll(async () => {
    await mkdir(path.join(FIXTURE_DIR, "lib"), { recursive: true });
    await cp(path.join(PKG_ROOT, "host.ts"), FIXTURE_HOST);
    await cp(path.join(PKG_ROOT, "lib"), path.join(FIXTURE_DIR, "lib"), { recursive: true });
  });

  beforeEach(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), "lesson-http-"));
    origDshHome = process.env["DSH_HOME"];
    process.env["DSH_HOME"] = scratch;

    const provider = makeSettingsProvider({
      [SETTINGS_NAMESPACE]: { [RULES_FIELD]: [ARMED_RULE] },
    });
    const ctx = new Context() as unknown as TestCtx;
    const settings = {
      ...provider,
      configure: () => () => {
        // 页面策略登记：测试假件无收尾资源
      },
    };
    await ctx.plugin({
      name: "deps",
      apply(child: { provide: (name: string, value: unknown) => void }) {
        child.provide("settings", settings);
      },
    });
    // 真 webServer：port 0 = 让 OS 分配（绑定失败会让 fiber FAILED，用例自然红）。
    await ctx.plugin(WebServer, { host: "127.0.0.1", port: 0 });
    await ctx.plugin(Loader);
    live = ctx;
    await ctx.loader.create({ id: SETTINGS_NAMESPACE, name: FIXTURE_HOST });
    await ctx.loader.await().catch(() => null);
    await flushAsync(0);
    server.port = (ctx.get("webServer") as { port?: number } | undefined)?.port ?? 0;
    if (server.port <= 0) {
      throw new Error("webServer 必须已监听（port 0 → OS 分配）");
    }
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

  it("stats 端点：200 + csrf + 规则投影（evidence 被丢掉、派生态在场）", async () => {
    const res = await send(server.port, { path: STATS_PATH });
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = JSON.parse(res.body) as {
      ok: boolean;
      csrf: string;
      rules: Record<string, unknown>[];
      lessonsCount: number;
    };
    expect(body.ok).toBe(true);
    expect(body.csrf, "csrf 只由这条 GET 下发").toBeTypeOf("string");
    expect(body.csrf.length).toBeGreaterThan(0);
    expect(body.rules).toHaveLength(1);
    const [rule] = body.rules;
    expect(rule?.["id"]).toBe(RULE_ID);
    expect("evidence" in (rule ?? {}), "HTTP 投影必须丢掉 evidence（全文，且卡片在轮询）").toBe(
      false,
    );
    expect(rule?.["undeterminable"], "派生态随投影下发").toBe(false);
    expect(body.lessonsCount).toBeTypeOf("number");
  });

  it("路由是 exact：/stats 的子路径不被吃掉（kind 拼错会落进前缀表 = 端点连子路径一起吞）", async () => {
    const res = await send(server.port, { path: `${STATS_PATH}/extra` });
    expect(res.status).toBe(404);
  });

  it("只读端点对 POST 回 405 + Allow（不是空体）", async () => {
    // 三条 GET 路由并行打（顺序无关，串行 await 只会被 lint 判成"该并发"）。
    const replies = await Promise.all(
      [STATS_PATH, RULES_PATH, LESSONS_PATH].map((routePath) =>
        send(server.port, { method: "POST", path: routePath, body: "{}" }),
      ),
    );
    for (const res of replies) {
      expect(res.status).toBe(405);
      expect(res.headers["allow"]).toBe("GET");
      expect(JSON.parse(res.body)).toStrictEqual({ ok: false, error: "GET only" });
    }
    const action = await send(server.port, { method: "GET", path: ACTION_PATH });
    expect(action.status).toBe(405);
    expect(action.headers["allow"]).toBe("POST");
    expect(JSON.parse(action.body)).toStrictEqual({ ok: false, error: "POST only" });
  });

  it("写端点：缺 csrf / 令牌不对 → 403，且响应里不许带出令牌", async () => {
    const noToken = await send(server.port, {
      method: "POST",
      path: ACTION_PATH,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: RULE_ID, action: "arm" }),
    });
    expect(noToken.status).toBe(403);
    expect(JSON.parse(noToken.body)).toStrictEqual({ ok: false, error: "invalid csrf token" });

    const stats = await send(server.port, { path: STATS_PATH });
    const { csrf } = JSON.parse(stats.body) as { csrf: string };
    const wrong = await send(server.port, {
      method: "POST",
      path: ACTION_PATH,
      headers: { "content-type": "application/json", "x-lesson-csrf": `${csrf}-wrong` },
      body: JSON.stringify({ id: RULE_ID, action: "arm" }),
    });
    expect(wrong.status).toBe(403);
    expect(wrong.body).not.toContain(csrf);
  });

  it("写端点：带正确令牌 → 200（人工升格落库）；未知卡 → 404；非法 action → 400", async () => {
    const stats = await send(server.port, { path: STATS_PATH });
    const { csrf } = JSON.parse(stats.body) as { csrf: string };
    const headers = { "content-type": "application/json", "x-lesson-csrf": csrf };

    const armed = await send(server.port, {
      method: "POST",
      path: ACTION_PATH,
      headers,
      body: JSON.stringify({ id: RULE_ID, action: "arm", statement: "改写后的规则正文" }),
    });
    expect(armed.status).toBe(200);
    expect(JSON.parse(armed.body)).toStrictEqual({ ok: true, id: RULE_ID, action: "arm" });

    const after = await send(server.port, { path: RULES_PATH });
    const rules = JSON.parse(after.body) as { rules: Record<string, unknown>[] };
    expect(rules.rules[0]?.["statement"]).toBe("改写后的规则正文");

    const missing = await send(server.port, {
      method: "POST",
      path: ACTION_PATH,
      headers,
      body: JSON.stringify({ id: "nope", action: "arm" }),
    });
    expect(missing.status).toBe(404);

    const badAction = await send(server.port, {
      method: "POST",
      path: ACTION_PATH,
      headers,
      body: JSON.stringify({ id: RULE_ID, action: "delete-everything" }),
    });
    expect(badAction.status).toBe(400);
  });

  it("写端点：非法 JSON → 400；超 1 MiB 的体 → 413（content-length 与流式两条路径）", async () => {
    const stats = await send(server.port, { path: STATS_PATH });
    const { csrf } = JSON.parse(stats.body) as { csrf: string };
    const headers = { "content-type": "application/json", "x-lesson-csrf": csrf };

    const broken = await send(server.port, {
      method: "POST",
      path: ACTION_PATH,
      headers,
      body: "{",
    });
    expect(broken.status).toBe(400);

    const huge = "x".repeat(1024 * 1024 + 16);
    const tooLarge = await send(server.port, {
      method: "POST",
      path: ACTION_PATH,
      headers: { ...headers, "content-length": String(Buffer.byteLength(huge)) },
      body: huge,
    });
    expect(tooLarge.status).toBe(413);
    expect(JSON.parse(tooLarge.body)).toStrictEqual({ ok: false, error: "request body too large" });
  });

  it("信任闸门对真请求的落点：恶意 Host / cross-site / 跨源 Origin 各自 403，合法请求照常", async () => {
    const rebound = await send(server.port, {
      path: STATS_PATH,
      headers: {
        host: "evil.test:8787",
        origin: "http://evil.test:8787",
        "sec-fetch-site": "same-origin",
      },
    });
    expect(rebound.status).toBe(403);
    expect(JSON.parse(rebound.body)).toStrictEqual({
      ok: false,
      error: "untrusted host authority",
    });

    const crossSite = await send(server.port, {
      path: STATS_PATH,
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);
    expect(JSON.parse(crossSite.body)).toStrictEqual({
      ok: false,
      error: "cross-origin request rejected",
    });

    const foreignOrigin = await send(server.port, {
      path: STATS_PATH,
      headers: { origin: "http://evil.test" },
    });
    expect(foreignOrigin.status).toBe(403);
    expect(JSON.parse(foreignOrigin.body)).toStrictEqual({
      ok: false,
      error: "cross-origin request rejected",
    });

    // 回环绑定时同源请求照常放行（一放一拒，挡住"恒拒"这种绕过）。
    const sameOrigin = await send(server.port, {
      path: STATS_PATH,
      headers: {
        host: `127.0.0.1:${server.port}`,
        origin: `http://127.0.0.1:${server.port}`,
        "sec-fetch-site": "same-origin",
      },
    });
    expect(sameOrigin.status).toBe(200);
  });

  it("lessons 端点：limit 语义（≤0/缺省 = 全量）与 project 过滤", async () => {
    const all = await send(server.port, { path: LESSONS_PATH });
    expect(all.status).toBe(200);
    const parsedAll = JSON.parse(all.body) as { count: number; lessons: unknown[] };
    expect(parsedAll.count).toBe(0);

    const limited = await send(server.port, { path: `${LESSONS_PATH}?limit=5` });
    expect(limited.status).toBe(200);

    const filtered = await send(server.port, { path: `${LESSONS_PATH}?project=proj-1&limit=0` });
    expect(filtered.status).toBe(200);
  });

  it("回显文案跟着请求的 Accept-Language 走（locale 偏好未注册时的兜底，真头真请求）", async () => {
    const stats = await send(server.port, { path: STATS_PATH });
    const { csrf } = JSON.parse(stats.body) as { csrf: string };
    /** 打一次必然 404 的 rule-action：回执的 error 就是被测的那行文案。 */
    const notFound = (accept: string): Promise<HttpResult> =>
      send(server.port, {
        method: "POST",
        path: ACTION_PATH,
        headers: {
          "content-type": "application/json",
          "x-lesson-csrf": csrf,
          "accept-language": accept,
        },
        body: JSON.stringify({ id: "nope", action: "arm" }),
      });

    // 本夹具的 settings 假件只投影本条目那一条（跨命名空间的 locale 恒缺席 = 未装 client-locale）
    const en = await notFound("en-US,en;q=0.9");
    expect(en.status).toBe(404);
    expect(JSON.parse(en.body)).toStrictEqual({ ok: false, error: MESSAGES.en.errRuleNotFound });

    const zh = await notFound("en;q=0.1, zh-CN;q=0.9");
    expect(JSON.parse(zh.body)).toStrictEqual({ ok: false, error: MESSAGES.zh.errRuleNotFound });

    const neither = await notFound("fr-FR,de;q=0.8");
    expect(JSON.parse(neither.body)).toStrictEqual({
      ok: false,
      error: MESSAGES.zh.errRuleNotFound,
    });
  });
});
