// test/client-freshness.ts —— 产物新鲜度指纹门禁。
// 本包副本形态：只提供**证据**（磁盘产物 vs 内存构建产物 + 包名），用例注册留在
// test/build-client.test.ts 的 describe 里。共享夹具一旦自行 it()，它就变成用例文件，
// vitest 的结构类规则（require-hook / consistent-test-it / valid-title）全部落到夹具上。
// 复制式分发：同 test/host-freshness.ts、test/schema-coverage.ts、test/profile-bundle.ts。
//
// 背景：src/client-entry.ts 改后忘跑 node build-client.mjs，浏览器一直加载旧
// client.js。mtime 断言在 git clone / touch 下不稳定，故用**内容指纹**：内存构建
// （buildClient()，纯函数、确定性输出）vs 磁盘 client.js 逐字节比对。src 任何变更
// 未重建 → 字节必差 → 红。
//
// 用法（test/build-client.test.ts 的指纹用例里）：
//   const evidence = await clientFreshnessEvidence(import.meta.url)
//   —— 自动定位 ../client.js 与 ../build-client.mjs
//
// 注意：buildClient() 必须是确定性构建（同输入同输出）。本包 build-client.mjs
// 不含时间戳/随机数（rollup 无 banner hash 变量），逐字节相等成立；若未来构建
// 引入非确定性，改为规范哈希比较并在 build-client.mjs 里输出 canonical 形态。

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 指纹门禁的两份产物 + 包名与包根（消息里标身份与修复命令，两侧同源）。 */
export interface FreshnessEvidence {
  readonly pkgName: string;
  readonly pkgDir: string;
  readonly onDisk: string;
  readonly built: string;
}

/** 取包名：JSON.parse 而不是正则——正则会命中文件里第一个 "name"（嵌套键同形），
 *  解析失败也不能静默标成 unknown（诊断信息里失去包身份）。 */
function packageNameOf(pkgDir: string): string {
  const parsed: unknown = JSON.parse(readFileSync(path.resolve(pkgDir, "package.json"), "utf8"));
  const name =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)["name"]
      : undefined;
  if (typeof name !== "string") {
    throw new TypeError(`[client-freshness] package.json 里没有字符串 name，指纹门禁标不出包身份`);
  }
  return name;
}

/** 取指纹门禁证据：磁盘 client.js 与当期内存构建产物。 */
export async function clientFreshnessEvidence(testFileUrl: string): Promise<FreshnessEvidence> {
  const testDir = path.dirname(fileURLToPath(testFileUrl));
  const pkgDir = path.resolve(testDir, "..");
  const pkgName = packageNameOf(pkgDir);
  // 动态导入 .mjs 对 TS 为 any，先收窄到调用面再 await（避免 no-unsafe-*）；
  // 导出面也校验：build-client.mjs 改名/删导出时给出可操作的诊断，而不是让
  // mod.buildClient() 以 "is not a function" 的裸 TypeError 收场。
  const mod = (await import(pathToFileURL(path.resolve(pkgDir, "build-client.mjs")).href)) as {
    buildClient?: () => Promise<string>;
  };
  const build = mod.buildClient;
  if (typeof build !== "function") {
    throw new TypeError(
      `[${pkgName}] build-client.mjs 没有可调用导出 buildClient：门禁靠它取得内存构建产物。`,
    );
  }
  const artifactPath = path.resolve(pkgDir, "client.js");
  return {
    pkgName,
    pkgDir,
    // 产物缺失时给占位正文：让门禁红在"内容不一致"的比对里（带修复提示），而不是
    // 红在 ENOENT 的裸栈里。注意 client.js 是 gitignored 的构建产物，git 的换行
    // 转换碰不到它——不做 BOM/CRLF 规范化，文件被人为改动就该红。
    onDisk: existsSync(artifactPath)
      ? readFileSync(artifactPath, "utf8")
      : "[产物缺失：运行 node build-client.mjs]",
    built: await build(),
  };
}
