// lesson-jsonl 读侧的窗口用例：existsSync 之后 readFileSync 之前文件被删（ENOENT）。
// 同步临界区在单进程里造不出真实窗口，只有这一条用假 fs 拦截（同 jsonl-fuse.test.ts 的
// 口径：拦截只对被瞄准的那个文件生效，其余路径穿透到真实实现）。
import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// 新增分支的补测：statSync 的非 ENOENT 读失败（与 ENOENT 分开）与"读成功即清去重闩"。
describe("readJsonl 的读失败口径（补测）", () => {
  it("statSync 非 ENOENT（路径是目录）→ warn 一次 + 空表；恢复后再犯同样的错要能再报", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dsh-lesson-jsonl-"));
    try {
      const file = path.join(dir, "lessons.jsonl");
      // 文件先正常写一行 → 读一次（建立缓存）；随后把它换成目录触发 statSync 的 EISDIR。
      writeFileSync(
        file,
        `${JSON.stringify({ ts: 1, source: "manual", category: "c", signature: "s", detail: "d", project: "p" })}\n`,
      );
      assert.equal(readJsonl(file).length, 1);
      rmSync(file);
      mkdirSync(file);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {
        // 断言在下方
      });
      assert.equal(readJsonl(file).length, 0, "读不到按空表，不外抛");
      assert.match(String(warn.mock.calls[0]?.[0]), /lesson ledger unreadable/u);
      // 第一次失败只报一次（去重）；修好再坏，同样的错误必须能再报一次。
      assert.equal(readJsonl(file).length, 0);
      assert.equal(warn.mock.calls.length, 1, "错误没变不重复刷");
      rmSync(file, { recursive: true });
      writeFileSync(
        file,
        `${JSON.stringify({ ts: 2, source: "manual", category: "c", signature: "s", detail: "d", project: "p" })}\n`,
      );
      assert.equal(readJsonl(file).length, 1, "恢复可读");
      rmSync(file);
      mkdirSync(file);
      assert.equal(readJsonl(file).length, 0);
      assert.equal(warn.mock.calls.length, 2, "读成功清了去重闩：同样的错误第二次照样报");
      warn.mockRestore();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("statSync 非 ENOENT（父路径是普通文件 → ENOTDIR）→ warn 一次 + 空表", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dsh-lesson-jsonl-stat-"));
    try {
      // 父路径是文件，不是目录：statSync 抛 ENOTDIR（非 ENOENT），走 warnReadFailure
      // 而不是"文件不存在"的静默分支。
      const blocker = path.join(dir, "blocker");
      writeFileSync(blocker, "x");
      const file = path.join(blocker, "lessons.jsonl");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {
        // 断言在下方
      });
      assert.deepEqual(readJsonl(file), [], "读不到按空表，不外抛");
      assert.match(String(warn.mock.calls[0]?.[0]), /lesson ledger unreadable/u);
      warn.mockRestore();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
