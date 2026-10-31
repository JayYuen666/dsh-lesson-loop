// 端到端：**双进程**对同一份 events.jsonl 持续追加——test/jsonl-fuse.test.ts 的文件头
// 写明「真实 end-to-end 的竞争由 /tmp 下双进程夹具体现」，但那份夹具在本轮之前不存在，
// 锁的正确性（跨进程互斥、接管、补写）只被单进程 vi.mock 拦截验证过。本文件把它补上：
// 子进程经 node --experimental-strip-types 直接 import 本仓的 lib/jsonl-fuse.ts 源码
// （类型注解-only 的 TS，Node 22.12+/24 原生剥类型），真进程、真盘、真竞争。
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "vitest";
import { strict as assert } from "node:assert";

import { readJsonl } from "../../lib/lesson-jsonl.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const FUSE_SOURCE = path.join(REPO_ROOT, "lib/jsonl-fuse.ts");
const LEDGER_NAME = "events.jsonl";

/** 子进程 worker：同一根 lib 源码，向指定文件追加 N 行（行尾 \n 由 payload 自带，与
 *  appendJsonl 的调用口径一致——fuse 层只管原样写）。import 的必须是 file:// URL：
 *  Windows 的绝对路径字面量（D:\…）既不是合法 URL，反斜杠还会先被字符串转义吃掉。 */
const WORKER_SOURCE = `
import { appendUnderFuse } from "${pathToFileURL(FUSE_SOURCE).href}";
const [file, rows, workerId] = process.argv.slice(2);
for (let index = 0; index < Number(rows); index += 1) {
  appendUnderFuse(file, JSON.stringify({ worker: workerId, index }) + "\\n", 1_000_000);
}
process.stdout.write("done");
`;

interface Fixture {
  dir: string;
  workerPath: string;
}

async function makeFixture(): Promise<Fixture> {
  const made = await mkdtemp(path.join(os.tmpdir(), "jsonl-fuse-e2e-"));
  const dir = await realpath(made);
  const workerPath = path.join(dir, "fuse-worker.ts");
  await writeFile(workerPath, WORKER_SOURCE, "utf8");
  return { dir, workerPath };
}

/** 起一个追加进程，等它跑完（退出码非零当场抛）。 */
async function spawnAppender(
  workerPath: string,
  file: string,
  rows: number,
  workerId: string,
): Promise<void> {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", workerPath, file, String(rows), workerId],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  const childStderr = child.stderr;
  childStderr.setEncoding("utf8");
  childStderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const [code] = (await once(child, "close")) as [number | null];
  if (code !== 0) {
    throw new Error(`worker ${workerId} 退出码 ${String(code)}：${stderr}`);
  }
}

describe("双进程 jsonl 保险丝竞争（真进程、真盘）", () => {
  it("两个进程各追加 40 行：零丢失、零重复，读回行数 = 80", async () => {
    const { dir, workerPath } = await makeFixture();
    try {
      const file = path.join(dir, LEDGER_NAME);
      // 双方真并发：不等彼此，两个子进程同时起。
      await Promise.all([
        spawnAppender(workerPath, file, 40, "A"),
        spawnAppender(workerPath, file, 40, "B"),
      ]);
      const rows = readJsonl(file);
      assert.equal(rows.length, 80, `行数丢了：${String(rows.length)}`);
      const keys = rows.map((row) => `${String(row["worker"])}:${String(row["index"])}`);
      const workerA = keys.filter((key) => key.startsWith("A:"));
      const workerB = keys.filter((key) => key.startsWith("B:"));
      assert.equal(new Set(keys).size, 80, "出现重复行（锁没有互斥住）");
      // 两边各 40 条，谁也没把自己的对手挤掉。
      assert.equal(workerA.length, 40);
      assert.equal(workerB.length, 40);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("裁剪线在竞争中不吞行：maxBytes 压到 200，两个进程各追加 30 行后仍是合法 JSONL", async () => {
    const { dir } = await makeFixture();
    try {
      const file = path.join(dir, LEDGER_NAME);
      // worker 的 maxBytes 参数写死 1_000_000，这条用例用小的窗口：写一份带小配额的变体。
      const smallWorker = path.join(dir, "fuse-worker-small.ts");
      await writeFile(smallWorker, WORKER_SOURCE.replaceAll("1_000_000", "200"), "utf8");
      await Promise.all([
        spawnAppender(smallWorker, file, 30, "A"),
        spawnAppender(smallWorker, file, 30, "B"),
      ]);
      const raw = await readFile(file, "utf8");
      const lines = raw.split("\n").filter((line) => line.trim().length > 0);
      for (const line of lines) {
        assert.doesNotThrow(() => JSON.parse(line), `残行（半条 JSON）：${line}`);
      }
      // 裁剪是「保最新一段」的语义：读回的行数必须落在 [1, 60]。
      const rows = readJsonl(file);
      assert.ok(rows.length > 0 && rows.length <= 60, `读回 ${String(rows.length)} 行`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
