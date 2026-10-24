// 客户端规则读面（src/rules-reader.ts）的挂载纪律直测。
//
// 为什么单独立一份：这份读取器是**卡片生命周期内唯一**持有远程面的地方，它的缓存语义
// （挂载幂等、失败不缓存）没有任何页面级用例能观察到 —— 端到端只会看到"数据读不到"，
// 而读不到既可能是网关拒绝了、也可能是它再也没去问过网关。这里的判据是后者：
// `$mount` 的**调用次数**。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { createRulesReader } from "../src/rules-reader.ts";
import { RULES_REMOTE_NAMESPACE } from "../lib/rules-shape.ts";

/** 一次成功回执的命名空间服务面（四个方法齐全，`isRulesNamespace` 才认）。 */
function namespaceOf(statsValue: Record<string, unknown>): Record<string, unknown> {
  return {
    stats: async () => ({ ok: true, value: statsValue }),
    rules: async () => ({ ok: true, value: { rules: [] } }),
    lessons: async () => ({ ok: true, value: { lessons: [] } }),
    ruleAction: async () => ({ ok: true, value: { id: "x", action: "arm" } }),
  };
}

/** 客户端上下文替身：`remote` 给挂载面，`remote.<namespace>` 给挂载后的服务面。 */
function ctxOf(
  remote: unknown,
  service?: unknown,
): { get: (name: string, strict?: boolean) => unknown } {
  return {
    get: (name) => {
      if (name === "remote") {
        return remote;
      }
      return name === `remote.${RULES_REMOTE_NAMESPACE}` ? service : undefined;
    },
  };
}

describe("客户端规则读面：$mount 的缓存纪律", () => {
  it("挂载成功后不重复挂载（同一次会话里反复拉取只挂一次）", async () => {
    let mounts = 0;
    const remote = {
      $mount: async () => {
        mounts += 1;
        return () => {
          // 撤销器：本用例不关心
        };
      },
    };
    const reader = createRulesReader(ctxOf(remote, namespaceOf({ armed: 1 })));
    assert.ok(reader !== undefined);
    const reads = await Promise.all([reader.stats(), reader.stats(), reader.stats()]);
    for (const value of reads) {
      assert.deepEqual(value, { armed: 1 });
    }
    assert.equal(mounts, 1, "成功之后必须复用那枚 promise，不许每次都问网关");
  });

  it("挂载失败不缓存：下一次读取会重新问网关，失败恢复后即可用", async () => {
    let mounts = 0;
    const remote = {
      $mount: async () => {
        mounts += 1;
        if (mounts <= 2) {
          throw new Error("网关拒绝（版本不匹配）");
        }
        return () => {
          // 撤销器：本用例不关心
        };
      },
    };
    const reader = createRulesReader(ctxOf(remote, namespaceOf({ armed: 1 })));
    assert.ok(reader !== undefined);
    // 前两次都失败，且每次都要重新问网关（缓存住 rejected promise 的实现只会问一次）
    await assert.rejects(async () => reader.stats(), /网关拒绝/u);
    assert.equal(mounts, 1);
    await assert.rejects(async () => reader.stats(), /网关拒绝/u);
    assert.equal(mounts, 2, "失败必须清掉缓存的 promise，否则恢复后永远不再挂载");
    // 第三次网关放行：读取成功，且此后不再重复挂载
    assert.deepEqual(await reader.stats(), { armed: 1 });
    assert.equal(mounts, 3);
    assert.deepEqual(await reader.stats(), { armed: 1 });
    assert.equal(mounts, 3, "成功后重新进入缓存分支");
  });

  it("挂载成功但命名空间服务没挂上 → 抛错（该错误不进挂载缓存，不影响下次读取）", async () => {
    let mounts = 0;
    const remote = {
      $mount: async () => {
        mounts += 1;
        return () => {
          // 撤销器：本用例不关心
        };
      },
    };
    // 第一次：服务面缺席（用盒子持有，补上之后再读一次）
    const service: { current: unknown } = { current: null };
    const ctx = {
      get: (name: string) => {
        if (name === "remote") {
          return remote;
        }
        return name === `remote.${RULES_REMOTE_NAMESPACE}` ? service.current : null;
      },
    };
    const reader = createRulesReader(ctx);
    assert.ok(reader !== undefined);
    await assert.rejects(async () => reader.stats(), /未提供/u);
    // 服务面补上之后照常可用，且挂载仍是缓存的那一次
    service.current = namespaceOf({ armed: 2 });
    assert.deepEqual(await reader.stats(), { armed: 2 });
    assert.equal(mounts, 1, "服务面缺席不是挂载失败，不该触发重挂");
  });

  it("没有远程面的部署：返回 undefined（卡片照常渲染，数据面显示读不到）", () => {
    assert.equal(
      createRulesReader({
        get: () => null,
      }),
      undefined,
    );
    assert.equal(createRulesReader({ get: () => ({}) }), undefined, "畸形 remote 保守当作没有");
  });
});
