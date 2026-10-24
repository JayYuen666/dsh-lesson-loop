// lesson-jsonl 读侧的窗口用例：existsSync 之后 readFileSync 之前文件被删（ENOENT）。
// 同步临界区在单进程里造不出真实窗口，只有这一条用假 fs 拦截（同 jsonl-fuse.test.ts 的
// 口径：拦截只对被瞄准的那个文件生效，其余路径穿透到真实实现）。
import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readJsonl } from "../lib/lesson-jsonl.ts";
import { loggedText } from "./setup-logs.ts";

/** readFileSync 拦截开关：`mode = "throw"` 时对被瞄准的文件抛 ENOENT（模拟读取窗口内的删除）。 */
const readHook = vi.hoisted(() => ({ mode: "" as "" | "throw", file: "" }));

// vi.mock 会被 vitest 提升到所有 import 之前执行，写在 import 之后不影响拦截时机。
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSyncSpy = (target: unknown, ...rest: unknown[]): unknown => {
    if (readHook.mode === "throw" && String(target) === readHook.file) {
      throw Object.assign(new Error("ENOENT: 文件在读取窗口内被删"), { code: "ENOENT" });
    }
    return (actual.readFileSync as (...args: unknown[]) => unknown)(target, ...rest);
  };
  return { ...actual, readFileSync: readFileSyncSpy };
});

describe("readJsonl 读侧窗口", () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "lesson-jsonl-"));
  });
  afterEach(() => {
    readHook.mode = "";
    readHook.file = "";
    rmSync(scratch, { recursive: true, force: true });
  });

  it("existsSync 过后、读取前文件被删（ENOENT）→ 静默空表并清缓存，不冒可读性告警", () => {
    const file = path.join(scratch, "events.jsonl");
    writeFileSync(file, '{"category":"c","signature":"s","detail":"d"}\n');
    // 先读一遍建立解析缓存；再追加一行让缓存键失配（否则命中缓存根本走不到 readFileSync）
    assert.equal(readJsonl(file).length, 1);
    writeFileSync(
      file,
      '{"category":"c","signature":"s","detail":"d"}\n{"category":"c","signature":"s2","detail":"d2"}\n',
    );
    readHook.mode = "throw";
    readHook.file = file;
    assert.deepEqual(readJsonl(file), [], "读取窗口内被删：与「从未存在」同待遇");
    assert.ok(!loggedText().includes("lesson ledger unreadable"), "ENOENT 不是可读性事故");
    // 缓存状态已被清掉：文件恢复后再读是新解析，不是窗口前的旧内容
    readHook.mode = "";
    writeFileSync(file, '{"category":"c2","signature":"s","detail":"d2"}\n');
    const rows = readJsonl(file);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.["detail"], "d2", "旧解析缓存已随 forgetFile 清空");
  });
});
