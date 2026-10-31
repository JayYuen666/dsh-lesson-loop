// build-types 防回归：类型/构建命令失败时，诊断必须原样到达调用方。
//
// 为什么值得一条测试（失败形态是「报错信息自己把错因丢掉了」）：runCommand 此前用
// `stdio: ["ignore","ignore","pipe"]` 且不传 encoding——tsc 的诊断走 **stdout**，于是被
// ignore 吞掉；而 stderr 拿到的是 Buffer，`typeof === "string"` 恒 false，拼 detail 的那一步
// 永不成立。合成效果是：任何一处 TS 类型错都只报 `Command failed: <argv>`，行号与错误码全看不到。
// 这个坏法不会让任何门变红——构建确实失败了，只是没人读得出为什么。
//
// 诊断标记必须住在**子进程读的文件**里，不能写在命令行参数上：命令行会被 Node 拼进
// `Command failed: <argv>`，那样即使诊断被吞，消息里也照样含标记，断言就成了自证。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { runCommand, tscEntryFromManifest } from "../build-types.mjs";

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw);
}

/** 本包解析到的 tsc 入口（与 build-types.mjs 的 tscEntry 同源，但不导出那一面）。 */
function tscEntryOf(): string {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("typescript/package.json");
  const pkg: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
  const bin = isRecord(pkg) && isRecord(pkg["bin"]) ? pkg["bin"]["tsc"] : undefined;
  assert.equal(typeof bin, "string", "typescript package.json 须有 bin.tsc");
  return path.join(path.dirname(pkgPath), bin as string);
}

/** 造一个只往指定流写一行标记、然后以非零码退出的脚本；标记只在文件正文里。 */
function maker(dir: string, name: string, stream: "stdout" | "stderr", marker: string): string {
  const file = path.join(dir, name);
  writeFileSync(
    file,
    `process.${stream}.write(${JSON.stringify(marker)});\nprocess.exit(1);\n`,
    "utf8",
  );
  return file;
}

/** 跑一次并交出它抛出的那个错误；没抛就是用例失败（而不是把断言藏在回调里）。 */
function errorOf(run: () => void): Error {
  try {
    run();
  } catch (error: unknown) {
    assert.ok(error instanceof Error, "抛出来的必须是一个 Error");
    return error;
  }
  return assert.fail("应当抛出错误，但调用正常返回了");
}

describe("runCommand()", () => {
  it("失败时把子进程 stdout 上的诊断带进错误信息（tsc 的诊断走 stdout，不是 stderr）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lesson-loop-run-stdout-"));
    try {
      const script = maker(dir, "on-stdout.mjs", "stdout", "DIAG-ONLY-ON-STDOUT");
      const error = errorOf(() => {
        runCommand(process.execPath, [script]);
      });
      assert.ok(
        error.message.includes("DIAG-ONLY-ON-STDOUT"),
        `错误信息必须含子进程 stdout：${JSON.stringify(error.message.slice(0, 300))}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 这一条锁的是行为承诺，**不是**回归判据：实测（node v26.11.1）即使 detail 那个分支永不
  // 成立，`String(error)` 也已含 Node 自己追加的 stderr 正文，故坏形状下这条同样绿。真正把
  // 用户挡在外面的是 stdout 那一半——tsc 的诊断全在 stdout。留着它只为固定「stderr 不许被丢」
  // 这条承诺，别把它读成「这条测试证明了修复有效」。
  it("失败时把子进程 stderr 上的诊断带进错误信息（行为锁，非判据）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lesson-loop-run-stderr-"));
    try {
      const script = maker(dir, "on-stderr.mjs", "stderr", "DIAG-ONLY-ON-STDERR");
      const error = errorOf(() => {
        runCommand(process.execPath, [script]);
      });
      assert.ok(
        error.message.includes("DIAG-ONLY-ON-STDERR"),
        `错误信息必须含子进程 stderr：${JSON.stringify(error.message.slice(0, 300))}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("跑真正的 tsc 时，类型错的行号与错误码可读（端到端）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lesson-loop-types-probe-"));
    try {
      const tsFile = path.join(dir, "bad.ts");
      // 独立的小 tsconfig：判据不随本仓 tsconfig.types.json 的 include 面变化。
      const config = path.join(dir, "tsconfig.json");
      writeFileSync(
        config,
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
          },
          include: ["bad.ts"],
        }),
        "utf8",
      );
      // 先证「拦得到」：同一份配置喂一个合法文件必须是绿的，否则下面那条断言可能因为
      // 别的原因（配置本身读不懂）而失败，看着像测到了诊断。
      writeFileSync(tsFile, "export const n: number = 1;\n", "utf8");
      assert.doesNotThrow(() => {
        runCommand(process.execPath, [tscEntryOf(), "-p", config]);
      });

      writeFileSync(tsFile, 'export const n: number = "x";\n', "utf8");
      const error = errorOf(() => {
        runCommand(process.execPath, [tscEntryOf(), "-p", config]);
      });
      assert.ok(
        error.message.includes("TS2322"),
        `错误信息必须含 TS2322：${JSON.stringify(error.message.slice(0, 300))}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** tscEntryFromManifest 用例共用的临时目录前缀。 */
const MANIFEST_PREFIX = "lesson-loop-tsc-manifest-";

/** 写一份临时包清单并交出它的路径。 */
function writeManifest(dir: string, body: string): string {
  const file = path.join(dir, "package.json");
  writeFileSync(file, body, "utf8");
  return file;
}

/** 建一个临时包目录，把 body 当作 package.json 写进去，交出清单路径。 */
function manifestDir(body: string): { dir: string; pkgPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), MANIFEST_PREFIX));
  return { dir, pkgPath: writeManifest(dir, body) };
}

describe("tscEntryFromManifest()", () => {
  it("bin.tsc 解析为包目录内的绝对路径", () => {
    const { dir, pkgPath } = manifestDir(JSON.stringify({ bin: { tsc: "bin/tsc" } }));
    try {
      const entry = path.join(dir, "bin", "tsc");
      mkdirSync(path.dirname(entry), { recursive: true });
      writeFileSync(entry, "#!/usr/bin/env node\n", "utf8");
      assert.equal(tscEntryFromManifest(pkgPath), entry);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("清单不是 JSON 时，错误消息带清单路径", () => {
    const { dir, pkgPath } = manifestDir("{ not json");
    try {
      const error = errorOf(() => {
        tscEntryFromManifest(pkgPath);
      });
      assert.ok(error.message.includes(pkgPath), `错误信息必须点名清单：${error.message}`);
      assert.ok(error.message.includes("读取/解析"), `错误信息必须说明读取失败：${error.message}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bin.tsc 指向包目录之外时拒绝", () => {
    const { dir, pkgPath } = manifestDir(JSON.stringify({ bin: { tsc: "../escape.js" } }));
    try {
      const error = errorOf(() => {
        tscEntryFromManifest(pkgPath);
      });
      assert.ok(error.message.includes("包目录之外"), `错误信息必须点明越界：${error.message}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bin.tsc 指向的入口不存在时，错误消息带解析后的路径", () => {
    const { dir, pkgPath } = manifestDir(JSON.stringify({ bin: { tsc: "bin/missing.js" } }));
    try {
      const error = errorOf(() => {
        tscEntryFromManifest(pkgPath);
      });
      assert.ok(error.message.includes("不存在"), `错误信息必须点明入口缺失：${error.message}`);
      assert.ok(
        error.message.includes(path.join(dir, "bin", "missing.js")),
        `错误信息必须带解析后的入口路径：${error.message}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
