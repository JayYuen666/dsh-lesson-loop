// test/schema-coverage.ts —— 卡片字段覆盖门禁（多包共用，复制式分发，同 client-freshness.ts）。
//
// 背景：host.ts 用 `settings.register(ns, Schema.object({...}), base)` 注册 N 个设置字段，
// client 卡片只渲染 M 个（M < N）→ 那 N-M 个字段用户无法从 UI 触及，只能改 settings 底层或
// 读源码。曾踩过的坑：quality-gate 的 `memoryFeedback`（功能性开关——host.ts 的
// `if (cfg.memoryFeedback !== false)` 决定是否把门禁失败写入记忆库，且有专门测试）在卡片
// 漏项，反复审查后才被发现。
//
// 做法：解析 host.ts 的 Schema.object 字段名 + client 源码树（src/** + lib/**）实际绑定的
// 字段名，断言后者 ⊇ 前者。漏项必须显式列入 allowUnbound 并给理由——测试同时校验
// allowUnbound 里的每一项确实未被绑定（防止"挂名豁免"绕过门禁）。
//
// 用法（各包 test/build-client.test.ts 的用例里断言一次；helper 交回**问题清单**，
// 空数组即通过 —— 同 client-freshness.ts 的理由）：
//   assert.deepEqual(schemaCoverageProblems(import.meta.url), []);
//   assert.deepEqual(schemaCoverageProblems(import.meta.url, {
//     allowUnbound: [{ field: 'x', reason: '仅 CLI 侧使用，UI 无入口' }],
//   }), []);
//
// 注意：绑定识别是"出现即算绑定"的宽松启发式（见 isBoundField），假阳性只会让门禁
// 更宽松（不会假绿漏拦功能性缺失）；假阴性会立刻报错，故宁可宽不可严。反向校验
// （stale 豁免）可能被假阳性误伤成假失败——那份失败是响亮的、自修正的（删豁免即恢复），
// 与设计前提一致。

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AllowUnbound {
  field: string;
  reason: string;
}

/** 从引号处跳到它的配对引号（返回闭合引号的下标）；未闭合则到文末。 */
function skipString(src: string, quoteAt: number): number {
  const quote = src[quoteAt] ?? "";
  for (let i = quoteAt + 1; i < src.length; i += 1) {
    const char = src[i] ?? "";
    if (char === "\\") {
      i += 1;
    } else if (char === quote) {
      return i;
    }
  }
  return src.length;
}

/** 若 `at` 处起是一段字符串或注释，返回它最后一个字符的下标；否则 -1。 */
function skipNonCode(src: string, at: number): number {
  const char = src[at] ?? "";
  if (char === '"' || char === "'" || char === "`") {
    return skipString(src, at);
  }
  if (char !== "/") {
    return -1;
  }
  if (src[at + 1] === "/") {
    const stop = src.indexOf("\n", at);
    return stop === -1 ? src.length : stop;
  }
  if (src[at + 1] === "*") {
    const stop = src.indexOf("*/", at + 2);
    return stop === -1 ? src.length : stop + 1;
  }
  return -1;
}

/** 从 `open` 处（指向 `(`）起找到与它配对的右括号下标；字符串与注释里的括号不计。
 *  只按字符深度数括号会被 `default("x)y")` 这类字面量骗到：那个 `)` 让深度提前归零，
 *  块在字符串中间被截断，其后的字段全部读不到（假绿 —— 门禁以为字段集就这么多）。 */
function matchParen(src: string, open: number): number {
  let depth = 0;
  let at = open;
  while (at < src.length) {
    const skipped = skipNonCode(src, at);
    if (skipped === -1) {
      const char = src[at] ?? "";
      if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          return at;
        }
      }
      at += 1;
    } else {
      at = skipped + 1;
    }
  }
  return -1;
}

/**
 * 从 host.ts 抽取 `Schema.object({...})` 块内的**顶层**字段名。
 *
 * 两条判据都不能省：① 深度匹配要跳过字符串，否则值里的括号会把块截断；
 * ② 字段值的写法**不限于 `Schema.`** —— `rules: RulesFieldSchema` 引用的是另一枚
 * schema 常量，按 `\s*Schema\.` 匹配就会把它当"不存在"。
 *
 * 顶层键的判定走字符扫描而不是按行切：逐字符跳过注释与字符串（复用上面的状态机），
 * 在**花括号深度为 1**（正位于 Schema.object 的对象字面量直接内层）且前一个非空白
 * 字符是 `{` 或 `,` 的位置上读 `标识符:`——多行注释的续行、跨行模板字符串里的
 * `key:`、单行写法（`Schema.object({ a: 1, b: 2 })`）因此都不会被误收或漏收。
 */
/** 捕获组取值（严格模式下 matchAll 捕获为 `string | undefined`，这里收口为 string）。 */
function group(match: RegExpExecArray, index: number): string {
  return match[index] ?? "";
}

/** 键扫描的单步结果：word = 当前位置的标识符（无则空串），next = 下一扫描位置。 */
function stepWord(src: string, at: number, end: number): { word: string; next: number } {
  const match = /^[A-Za-z_$][\w$]*/u.exec(src.slice(at, end));
  if (match === null) {
    return { word: "", next: at + 1 };
  }
  const word = group(match, 0);
  let cursor = at + word.length;
  while (cursor < end && /\s/u.test(src[cursor] ?? "")) {
    cursor += 1;
  }
  return { word, next: cursor };
}

/** 从 `from` 起找 `needle` 第一次出现在**代码区**的位置（注释与字符串里的不算）。
 *  直接用 indexOf 会被文件头的文档注释锚住（注释里写一句 `Schema.object({...})` 是
 *  常见的说明形态）：轻则 matchParen 找不到配对而报「解析失败」，重则锚到一段示例
 *  拿到错误的字段集。 */
function codeIndexOf(src: string, needle: string, from = 0): number {
  let at = from;
  while (at < src.length) {
    const skipped = skipNonCode(src, at);
    if (skipped === -1) {
      if (src.startsWith(needle, at)) {
        return at;
      }
      at += 1;
    } else {
      at = skipped + 1;
    }
  }
  return -1;
}

export function hostSchemaFields(hostTs: string): string[] {
  const marker = "Schema.object(";
  const start = codeIndexOf(hostTs, marker);
  if (start === -1) {
    return [];
  }
  // marker 自带 `(`，配对括号从它起算。
  const end = matchParen(hostTs, start + marker.length - 1);
  if (end === -1) {
    return [];
  }
  const fields = new Set<string>();
  let depth = 0;
  let expectKey = true;
  let at = start + marker.length;
  while (at < end) {
    const skipped = skipNonCode(hostTs, at);
    if (skipped === -1) {
      const char = hostTs[at] ?? "";
      const { word, next } = stepWord(hostTs, at, end);
      if (char === "{") {
        depth += 1;
        expectKey = depth === 1;
      } else if (char === "}") {
        depth -= 1;
      } else if (char === ",") {
        expectKey = depth === 1;
      } else if (char === ":" || char === "(") {
        // 冒号（值开始）与括号（计算键/方法形态）之后都不是键位。
        expectKey = false;
      } else if (word !== "" && expectKey && depth === 1 && hostTs[next] === ":") {
        // 键位上的标识符且后面紧跟冒号才是字段；其余（值里的字面量如 Schema.any）跳过。
        fields.add(word);
        expectKey = false;
      }
      at = next;
    } else {
      at = skipped + 1;
    }
  }
  return [...fields];
}

/** 扫描一个 client 源文件，收集作为「设置写入第一参」出现的字段名字面量。 */
function boundFieldsIn(src: string): Set<string> {
  const out = new Set<string>();
  // 输入行组件的 field prop：field: 'x'
  for (const match of src.matchAll(/\bfield\s*:\s*["'](?<name>[A-Za-z_$][\w$]*)["']/gu)) {
    out.add(group(match, 1));
  }
  // 各种写入惯用法：props.set('x' / set('x' / unset('x' / fireAndForget('x' / writeSet('x'
  //   刻意不要求限定 receiver——各包惯用法不同（props.set / fireAndForget / writer.set），
  //   收得太紧会假阴性。字段名是否算"绑定"由 declareSchemaCoverage 与 host 字段名交集判定。
  for (const match of src.matchAll(
    /\b(?:set|unset|fireAndForget|writeSet|commit)\s*\(\s*["'](?<name>[A-Za-z_$][\w$]*)["']/gu,
  )) {
    out.add(group(match, 1));
  }
  return out;
}

/** 源码扩展名白名单：卡片控件用 TSX 写是常见形态，.mts/.cts 同属 TS 源——只收 .ts
 *  会让搬进 .tsx 的绑定全部失踪，门禁报出「卡片未暴露」的假失败。 */
const SOURCE_EXTENSION = /\.(?:tsx|mts|cts|ts)$/u;

/** 单个目录项的收集结果：目录递归、TS 源读文本、其余（软链/读不到/非源码）为空。 */
/** 单个目录项的处理：目录压栈（pending）、TS 源读进 out，其余（软链/读不到/非源码）
 *  跳过——符号链接不跟随（指向上级的软链会成环），权限问题按"读不到"跳过而不让
 *  门禁挂着原始异常。 */
function handleEntry(entry: string, dir: string, pending: string[], out: string[]): void {
  if (entry === "node_modules" || entry === "test") {
    return;
  }
  const filePath = path.join(dir, entry);
  let stats;
  try {
    stats = lstatSync(filePath);
  } catch {
    // stat 不到：跳过，不让原始异常冒进用例。
    return;
  }
  if (stats.isSymbolicLink()) {
    return;
  }
  if (stats.isDirectory()) {
    pending.push(filePath);
    return;
  }
  if (SOURCE_EXTENSION.test(entry)) {
    try {
      out.push(readFileSync(filePath, "utf8"));
    } catch {
      // 读不到的源文件跳过：门禁的判据面是"读得到的源码"。
    }
  }
}

/** 递归收集目录下所有 TS 源文件文本（跳过 node_modules 与 test）。用显式栈代替递归：
 *  单步处理既读目录又读文件，拆成两个互相调用的函数会撞 no-use-before-define，
 *  合回来又把 continue 带回来。目录间顺序无意义（绑定面是各文件字段名的并集）。 */
function walk(root: string): string[] {
  const out: string[] = [];
  const pending: string[] = [root];
  while (pending.length > 0) {
    const dir = pending.pop() ?? "";
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      // 目录读不到（权限/竞态删除）：这一枝按空处理，别的目录照常。
      entries = [];
    }
    for (const entry of entries) {
      handleEntry(entry, dir, pending, out);
    }
  }
  return out;
}

/** client 侧实际绑定的字段名集合（src/** + lib/**）。 */
function clientBoundFields(pkgDir: string): Set<string> {
  const out = new Set<string>();
  for (const src of [...walk(path.join(pkgDir, "src")), ...walk(path.join(pkgDir, "lib"))]) {
    for (const field of boundFieldsIn(src)) {
      out.add(field);
    }
  }
  return out;
}

/** 包名：JSON.parse 取 name（正则从整份 manifest 抠第一个 "name" 会撞嵌套键）。 */
function packageNameOf(pkgDir: string, problems: string[]): string {
  const file = path.resolve(pkgDir, "package.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const { name } = parsed as Record<string, unknown>;
      if (typeof name === "string") {
        return name;
      }
    }
    problems.push(`[${file}] package.json 里没有字符串 name`);
    return "unknown";
  } catch (error) {
    problems.push(
      `[${file}] 读不到或解析失败：${String(error instanceof Error ? error.message : error)}`,
    );
    return "unknown";
  }
}

/**
 * 「卡片字段覆盖 host schema」门禁的问题清单（空数组即通过）。
 *
 * 交回清单而不是自己登记用例：登记只能发生在用例文件的 describe/用例体内，
 * 且断言得写在那个体内才看得见（vitest require-hook + expect-expect）。
 * 调用点写法见本文件头。
 */
export function schemaCoverageProblems(
  testFileUrl: string,
  opts: { allowUnbound?: AllowUnbound[] } = {},
): string[] {
  const testDir = path.dirname(fileURLToPath(testFileUrl));
  const pkgDir = path.resolve(testDir, "..");
  const problems: string[] = [];
  const pkgName = packageNameOf(pkgDir, problems);
  const hostPath = path.resolve(pkgDir, "host.ts");
  if (!existsSync(hostPath)) {
    problems.push(`[${pkgName}] 未找到 host.ts（该包若无设置段，这是配置错误而非豁免项）`);
    return problems;
  }
  const hostTs = readFileSync(hostPath, "utf8");
  const hostFields = hostSchemaFields(hostTs);
  const bound = clientBoundFields(pkgDir);
  // 同一字段写两条豁免（理由不同）会被 Map 静默去重：第二条理由丢失没人发现。
  // 显式把重复列成问题，豁免表才不会悄悄累积无效条目。
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const item of opts.allowUnbound ?? []) {
    if (seen.has(item.field)) {
      duplicated.add(item.field);
    }
    seen.add(item.field);
  }
  if (duplicated.size > 0) {
    problems.push(
      `[${pkgName}] allowUnbound 有重复字段（只留一条）：${[...duplicated].join(", ")}`,
    );
  }
  const exemptions = new Map((opts.allowUnbound ?? []).map((item) => [item.field, item.reason]));

  if (hostFields.length === 0) {
    problems.push("host.ts 未找到 Schema.object 字段（解析失败或该包无设置）");
  }
  const missing = hostFields.filter((field) => !bound.has(field));
  const unexempted = missing.filter((field) => !exemptions.has(field));
  if (unexempted.length > 0) {
    problems.push(
      `[${pkgName}] 以下 host 设置字段卡片未暴露：${unexempted.join(", ")}\n` +
        `host 字段全集：${hostFields.join(", ")}\n` +
        `卡片已绑定：${[...bound].join(", ")}\n` +
        `→ 补卡片控件；若确实不该有 UI 入口，在 schemaCoverageProblems 的 allowUnbound 里\n` +
        `  显式声明 { field, reason }（测试会校验被豁免项确实未绑定，防止挂名豁免）。`,
    );
  }
  // 反向校验：豁免项若其实已绑定，说明豁免过时——删除即可，留着会让门禁失效。
  const stale = [...exemptions].filter(([field]) => bound.has(field));
  if (stale.length > 0) {
    problems.push(
      `[${pkgName}] allowUnbound 已过时——这些字段其实已绑定，请删除豁免声明：${stale.map(([field, reason]) => `${field}（${reason}）`).join(", ")}`,
    );
  }
  // 豁免必须有理由，否则等于无门禁。
  const noReason = [...exemptions].filter(
    ([, reason]) => typeof reason !== "string" || reason.trim().length === 0,
  );
  if (noReason.length > 0) {
    problems.push(
      `[${pkgName}] allowUnbound 项缺少 reason：${noReason.map(([field]) => field).join(", ")}`,
    );
  }
  return problems;
}
