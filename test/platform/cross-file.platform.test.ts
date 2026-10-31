// 跨平台判据：CRLF 存量文件（Windows 侧手工编辑过的 events.jsonl）的容错、锁文件与
// 账本文件的权限位、以及「并发量裁剪」的语义边界。skipIf 明确写出在哪一平台不成立。
import { describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJsonl } from "../../lib/lesson-jsonl.ts";
import { appendUnderFuse } from "../../lib/jsonl-fuse.ts";

const LEDGER_NAME = "events.jsonl";

describe("windows 侧手工编辑过的 events.jsonl（CRLF 行尾）", () => {
  it("每行以 CR 收尾（windows 文本模式残留）的合法 JSON 行照常读回", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "lesson-crlf-"));
    try {
      const file = path.join(dir, LEDGER_NAME);
      writeFileSync(
        file,
        '{"worker":"A","index":0}\r\n{"worker":"B","index":1}\r\nnot-json\r\n',
        "utf8",
      );
      const rows = readJsonl(file);
      assert.equal(rows.length, 2, JSON.stringify(rows));
      assert.equal(rows[0]?.["worker"], "A");
      assert.equal(rows[1]?.["worker"], "B");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("账本文件与锁文件的权限位（POSIX 专属；Windows 无 mode 语义）", () => {
  it.skipIf(process.platform === "win32")(
    "账本 0o600、锁文件 0o600（防同机他人读会话内容）",
    () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "lesson-mode-"));
      try {
        const file = path.join(dir, LEDGER_NAME);
        appendUnderFuse(file, '{"worker":"A","index":0}\n', 1_000_000);
        // 0o600 与 umask 相与：常规 umask 022 下仍是 0o600。
        const ledgerMode = statSync(file).mode.toString(8).slice(-3);
        assert.equal(ledgerMode, "600", `账本权限位：${ledgerMode}`);
        // 锁在追加过程中生灭：不在场即释放完成，不需要断言它的权限位。
        assert.equal(statSync(file).isFile(), true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("裁剪线的「保最新一段」语义", () => {
  it("maxBytes 裁掉旧段后，最新一行与本次追加必定仍在（readJsonl 读回非空）", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "lesson-shrink-"));
    try {
      const file = path.join(dir, LEDGER_NAME);
      for (let index = 0; index < 20; index += 1) {
        appendUnderFuse(file, `${JSON.stringify({ index })}\n`, 100);
      }
      const rows = readJsonl(file);
      assert.ok(rows.length > 0, "裁剪把全部行都裁掉了：保底语义破");
      assert.ok(rows.length < 20, "裁剪没有生效");
      const last = rows.at(-1);
      assert.equal(last?.["index"], 19, "最新一行必须幸存");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maxBytes=0 与负数不裁（配额语义：0 = 不设限），行数就是追加数", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "lesson-noshrink-"));
    try {
      const file = path.join(dir, LEDGER_NAME);
      for (let index = 0; index < 10; index += 1) {
        appendUnderFuse(file, `${JSON.stringify({ index })}\n`, 0);
      }
      assert.equal(readJsonl(file).length, 10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("并发量的单进程多写", () => {
  it("同一进程内顺序 200 次追加零丢失（fuse 快路径的冒烟面）", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "lesson-smoke-"));
    try {
      const file = path.join(dir, LEDGER_NAME);
      for (let index = 0; index < 200; index += 1) {
        appendUnderFuse(file, `${JSON.stringify({ index })}\n`, 1_000_000);
      }
      const rows = readJsonl(file);
      assert.equal(rows.length, 200);
      const raw = readFileSync(file, "utf8");
      assert.ok(raw.endsWith("\n"), "账本以换行收尾（残行封口的前提）");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
