#!/usr/bin/env node
/// <reference types="node" />
// 构建 types/：先让 tsc 出声明，再把声明里的相对说明符从源码后缀改写成产物后缀。
//
// 为什么要后处理：源码按 NodeNext 写 `./lib/lesson-store.ts`（基线的 allowImportingTsExtensions
// + verbatimModuleSyntax 要求它），而 tsc 会把这枚说明符**原样抄进 .d.ts**——包里没有
// `lib/lesson-store.ts`，消费方解析 `types/host.d.ts` 就指向一个不存在的文件。改成 `.js` 才由
// TypeScript 解析到同名的 `types/lib/lesson-store.d.ts`。`rewriteRelativeImportExtensions`
// 只作用于 JS 产物，对 emitDeclarationOnly 是空操作，救不了这件事。
//
// 出声明前清空 types/：tsc 不清 outDir，删掉源文件后旧 .d.ts 会留在原地，而 `files` 里的
// `types` 是整目录，陈旧声明照样发出去。
//
// 与同门包 @jayyuen66/dsh-danger-guard 的 build-types.mjs 同源；本包没有独立设置入口，
// 产出的是 types/host.d.ts + types/lib/*.d.ts。
//
// 顶部 node reference：oxlint 类型检查对 .mjs 不自动加载 @types/node，需显式声明才能解析
// node:fs/promises、node:child_process、process（否则整文件按 error 类型误报 unsafe）。
import { execFileSync } from "node:child_process";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = import.meta.dirname;
const outDir = path.join(root, "types");

/** 相对说明符里指向源码的那一层后缀。 */
const RELATIVE_SOURCE_SPECIFIER = /(?<quote>["'])(?<prefix>\.{1,2}\/[^"']*)\.ts\k<quote>/gu;

/**
 * 只改写相对说明符（以 `./` 或 `../` 开头）里的 `.ts` 后缀；裸说明符一概不碰——放宽到任意
 * 说明符会误伤 `import("some-pkg.ts")` 这类合法的第三方引用。
 *
 * @param {string} text - 声明文件正文
 * @returns {string} 改写后的正文
 */
export function canonicalizeDeclarationSpecifiers(text) {
  return text.replace(
    RELATIVE_SOURCE_SPECIFIER,
    (_match, quote, prefix) => `${quote}${prefix}.js${quote}`,
  );
}

/**
 * 跑一条命令；失败时把子进程自己的 stderr 原样抛出。
 *
 * @param {string} file - 可执行文件
 * @param {string[]} args - 参数
 * @returns {void}
 */
function run(file, args) {
  try {
    execFileSync(file, args, { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error ? error.stderr : "";
    const detail = typeof stderr === "string" ? stderr.trim() : "";
    throw new Error(detail === "" ? String(error) : detail, { cause: error });
  }
}

/**
 * 递归列出目录下的 `.d.ts` 文件（相对包根、`/` 分隔）。
 *
 * 导出而非私藏：`test/publish-manifest.test.ts` 的声明门禁按同一口径列 types/，测试里另写
 * 一份遍历会让两边的目录形状悄悄分叉。
 *
 * @param {string} dir - 当前目录绝对路径
 * @param {string} prefix - 相对包根前缀
 * @returns {Promise<string[]>} 命中的文件清单（相对包根）
 */
export async function listDeclarations(dir, prefix) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((entry) => !entry.isDirectory() && entry.name.endsWith(".d.ts"))
    .map((entry) => `${prefix}${entry.name}`);
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => listDeclarations(path.join(dir, entry.name), `${prefix}${entry.name}/`)),
  );
  return [...files, ...nested.flat()];
}

/**
 * 产出 types/：跑 tsc 出声明，再逐个改写相对说明符。
 *
 * @returns {Promise<string[]>} 改写过的声明文件清单（相对包根，`/` 分隔）
 */
export async function buildTypes() {
  // 先清空：tsc 不清 outDir，留着旧声明等于把陈旧类型一起发出去。
  await rm(outDir, { recursive: true, force: true });
  // tsc 自己已经按 tsconfig 排好了依赖与增量，交给它报错即可；这里只把失败原样抛出。
  run("npx", ["tsc", "-p", "tsconfig.types.json"]);
  const files = await listDeclarations(outDir, "");
  await Promise.all(
    files.map(async (file) => {
      const full = path.join(outDir, file);
      const text = await readFile(full, "utf8");
      await writeFile(full, canonicalizeDeclarationSpecifiers(text), "utf8");
    }),
  );
  return files;
}

async function main() {
  const files = await buildTypes();
  console.info("types/ written:", files.length, "files");
}

if (process.argv[1] === import.meta.filename) {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
