// test/profile-bundle.ts —— 卡片槽位 key 的漂移针（多包共用，复制式分发，同 client-freshness.ts）。
//
// 背景（这一条就是当初查出来的真缺陷）：`plugins.bundle.config` 是**按 bundle 包名**
// keyed 的槽位，宿主派发时拿注册项的 key 与该 bundle 的包名做精确相等匹配：
//   installed dsh-client-ui-plugin-manager/lib/client.js:2907
//     renderSlot("plugins.bundle.config", { view: "page" }, { entryKey: pkg.name })
//   installed dsh-client-ui-renderer/lib/client.js:1179
//     host.entriesOfSlot(slotKey).find((e) => e.options.key === opts?.entryKey)
//   同插件页 :3979 的「这个 bundle 有没有配置卡」位 = ledger.bundles.has(openPkg.name)，
//   而 ledger.bundles 就是上面那批注册 key 的集合（:62 `keysOf("plugins.bundle.config")`）
//   installed dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:111-115
//     —— "keyed by the bundle's package name"，key 必填
//   首方先例 installed dsh-experimental-client-ui-voice-input/lib/client.js:5659-5661
//     —— key 写的就是 bundle 包名
// key 写成 loader 的裸条目 id（cordis.patch.yml 的 `- id:`）时，宿主拿包名找不到这个
// 键，`configured` 也是 false → 插件页上永不出卡（本文件存在的理由）。
//
// 两个标识**各管各的**，本模块把两侧真源都读出来，防止「一改全改」把另一边带坏：
//   - 槽位 key = bundle 包名，真源是本包自己的 package.json（宿主派发 entryKey 用的就是
//     被装 bundle 的包名，与装法无关）；profile 只在这台开发机上存在，装了才顺手钉一道
//     「清单里确有这一条」的机器侧漂移针；
//   - configForms.get(entryId) 的入参（= 0.2.1-alpha.2 隐式 settings 命名空间）= 裸条目 id，
//     真源本包 cordis.patch.yml（installed dsh-client-ui-settings/lib/client.js:1294-1298
//     把 entryId 原样当命名空间用）。
// 所以这里**不写任何包名/条目 id 字面量**：测试里抄一份常量，正是本缺陷当初漏网的原因。

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** 本包根目录：helper 与 client-freshness.ts 同放 test/，据此定位包内文件。 */
const PKG_DIR = path.resolve(import.meta.dirname, "..");

/** unknown → Record 的窄化判据。刻意手抄：test/ 不引运行时依赖，真源见
 *  shared/lib/record.ts（本包 client 半那份已回删，别再往这里加判据）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 读一份 JSON 文件并投影为 Record（形状不对即抛，不静默兜成空对象）。 */
function readJson(file: string): Record<string, unknown> {
  assert.ok(existsSync(file), `读不到 ${file}`);
  const text = readFileSync(file, "utf8");
  const parsed: unknown = JSON.parse(text);
  assert.ok(isRecord(parsed), `${file} 的顶层不是 JSON 对象`);
  return parsed;
}

const PKG_MANIFEST_FILE = "package.json";

/** profile 清单路径：`~/.dsh/profiles/web/package.json`（DSH_PROFILE_PACKAGE_JSON 可改指）。 */
function profileManifestPath(): string {
  const { DSH_PROFILE_PACKAGE_JSON: override = "" } = process.env;
  return override === ""
    ? path.join(os.homedir(), ".dsh", "profiles", "web", PKG_MANIFEST_FILE)
    : override;
}

/**
 * bundle 清单的形状守卫（导出供本文件的守卫用例直接喂夹具）：数组里每一项都必须是
 * 字符串——静默滤掉非字符串项会把「清单损坏」伪装成「没装这个包」，让漂移针报出
 * 误导性的「不在 bundles 里」（或反过来掩盖损坏）。
 */
export function assertBundleListOf(listed: unknown, label: string): string[] {
  assert.ok(Array.isArray(listed), `${label} 不是数组`);
  const bundles: string[] = [];
  for (const item of listed) {
    assert.equal(typeof item, "string", `${label} 含非字符串条目`);
    if (typeof item === "string") {
      bundles.push(item);
    }
  }
  return bundles;
}

/** 本包 npm scope 前缀（`@jayyuen66/`）：真源是本包 package.json 的 name，不写字面量——
 *  fork/换 scope 后清单里全部条目都不以旧前缀开头，硬编码会让漂移针静默失效。 */
function ownScopePrefix(): string {
  const { name } = readJson(path.join(PKG_DIR, PKG_MANIFEST_FILE));
  const raw = typeof name === "string" ? name : "";
  const slash = raw.indexOf("/");
  return raw.startsWith("@") && slash > 0 ? raw.slice(0, slash + 1) : "";
}

/** profile 的 `dsh.profile.bundles` 清单；没装 profile 的环境（CI、消费者克隆）回 null。 */
function profileBundleListOrNull(): string[] | null {
  const file = profileManifestPath();
  if (!existsSync(file)) {
    return null;
  }
  const manifest = readJson(file);
  // 键**缺失**才按"没装/陌生 profile"回 null；键在而形状坏（bundles 写成对象/字符串、
  // dsh 整段不是记录）当场抛——静默兜成空值会让机器侧漂移针在清单损坏时直接跳过，
  // 把"清单坏了"洗成"没装 profile"的假绿。
  if (!("dsh" in manifest)) {
    return null;
  }
  const dshSection = manifest["dsh"];
  assert.ok(isRecord(dshSection), `${file} 的 dsh 不是对象`);
  if (!("profile" in dshSection)) {
    return null;
  }
  const profileSection = dshSection["profile"];
  assert.ok(isRecord(profileSection), `${file} 的 dsh.profile 不是对象`);
  const listed = profileSection["bundles"] ?? [];
  const bundles = assertBundleListOf(listed, `${file} 的 dsh.profile.bundles`);
  // 同名 profile 未必属于本工作面：`--from-default-profile web` 也会造一个只装官方基座的
  // web profile。清单里一个 @jayyuen66 包都没有时按「没装 profile」处理——机器侧针只钉
  // 在真装着本族插件的 profile 上，把陌生 profile 报成「本包不在清单」是把环境当成了漂移。
  const scope = ownScopePrefix();
  if (scope !== "" && !bundles.some((name) => name.startsWith(scope))) {
    return null;
  }
  return bundles;
}

/**
 * 本包在 profile 里那条 bundle 的包名 —— `plugins.bundle.config` 的 key 必须是它。
 * 取的是本包自己的 `package.json.name`：宿主派发的 `entryKey` 就是**被装的那个 bundle**
 * 的包名，所以对任何装法（registry / link / 本机 profile）它都是那个值。
 * profile 只存在在这台开发机上，装了才加一道机器侧针（清单里确有这一条）。
 */
export function profileBundleName(): string {
  const { name: own } = readJson(path.join(PKG_DIR, PKG_MANIFEST_FILE));
  assert.equal(typeof own, "string", "本包 package.json 没有 name");
  const name = typeof own === "string" ? own : "";
  const listed = profileBundleListOrNull();
  if (listed !== null) {
    assert.ok(
      listed.includes(name),
      `${name} 不在 profile 的 dsh.profile.bundles 里：没有 bundle 行就没有配置卡`,
    );
  }
  return name;
}

/** YAML 标量值归一：成对引号先剥、行尾注释只在未加引号时剥——注释剥离若走在引号
 *  识别之前，`"a #b"` 会被吃成 `"a`，随后成对引号正则不匹配，原样带回半截引号。 */
function yamlScalar(raw: string): string {
  const text = raw.trim();
  const quoted = /^(?<q>["'])(?<body>.*)\k<q>\s*(?:#.*)?$/u.exec(text);
  if (quoted !== null) {
    return quoted.groups?.["body"] ?? "";
  }
  return text.replace(/\s+#.*$/u, "").trim();
}

/**
 * cordis.patch.yml 的裸条目 id 解析（导出供本文件的守卫用例直接喂夹具）——
 * 0.2.1-alpha.2 的隐式 settings 命名空间与 `configForms.get(entryId)` 的入参都取它，
 * 与 bundle 包名是两回事。常见 YAML 写法（带引号、行尾注释）都要剥掉；命中多条
 * `- id:` 时必须同值——挑第一条会在多条目 patch 上读错行。
 */
export function entryIdFromPatchYml(yml: string): string {
  const ids = yml
    .split("\n")
    .map((line) => /^\s*-\s+id:\s*(?<value>.*?)\s*$/u.exec(line)?.groups?.["value"])
    .filter((value): value is string => value !== undefined)
    .map((value) => yamlScalar(value));
  assert.ok(ids.length > 0, "cordis.patch.yml 里没有 `- id:` 条目");
  assert.equal(new Set(ids).size, 1, `cordis.patch.yml 里有多条不同的 - id:（${ids.join(", ")}）`);
  assert.notEqual(ids[0], "", "cordis.patch.yml 的 - id: 是空值");
  return ids[0]!;
}

/** 本包 cordis.patch.yml 的裸条目 id。 */
function patchEntryId(): string {
  const file = path.join(PKG_DIR, "cordis.patch.yml");
  assert.ok(existsSync(file), `读不到 ${file}`);
  return entryIdFromPatchYml(readFileSync(file, "utf8"));
}

/** 转义字符串里的正则元字符（标识符可含 `$`，直接拼进 pattern 会变成行尾锚点）。 */
function escapeRegExp(text: string): string {
  return text.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);
}

/**
 * 产物里 `const <name> = "<字面量>"` 的值；取不到即抛（漂移针不许静默放过）。
 * 空白与引号形态放宽（构建器换单引号/无空格不应让针误红），标识符先转义。
 * 字面量后面必须紧跟分隔符：`const X = "a" + "b"` 是拼接，不是一条可读的常量——
 * 不设这道判据会静默只取 `a`，漂移针拿一个假值去比对。导出供本文件的守卫用例
 * 直接喂夹具（真实产物那条路经 bundleSlotKeyFacts）。
 */
export function constLiteral(text: string, name: string, depth = 0): string {
  const pattern = new RegExp(
    `const\\s+${escapeRegExp(name)}\\s*=\\s*(?:"(?<dq>[^"]*)"|'(?<sq>[^']*)'|(?<alias>[A-Za-z_$][\\w$]*))(?=\\s*(?:[;},\\n]|$))`,
    "u",
  );
  const matched = pattern.exec(text);
  const groupOf = (key: string): string => matched?.groups?.[key] ?? "";
  const alias = matched?.groups?.["alias"];
  if (alias !== undefined) {
    // 值是另一枚常量（打包器保留了共享常量的名字）：跟一层引用，最多两跳——
    // 更深的链说明产物形态变了，让它在尽头响亮失败比静默回空强。
    assert.ok(depth < 2, `产物里 const ${name} 的引用链超过两层，漂移针读不动`);
    return constLiteral(text, alias, depth + 1);
  }
  const value = groupOf("dq") || groupOf("sq");
  assert.notEqual(value, "", `产物里找不到 const ${name} = "…" 的字面量声明`);
  return value;
}

/** 从开引号处跳到它的配对引号（返回闭合引号下标；未闭合则到文末）。 */
function skipQuoted(text: string, quoteAt: number): number {
  const quote = text[quoteAt] ?? "";
  let index = quoteAt + 1;
  while (index < text.length && text[index] !== quote) {
    if (text[index] === "\\") {
      index += 1;
    }
    index += 1;
  }
  return Math.min(index, text.length - 1);
}

/** 从 `at` 处的 `(` 起按括号深度取出完整实参文本（跳过字符串字面量里的括号）。 */
function balancedParens(text: string, openAt: number): string {
  let depth = 0;
  for (let index = openAt; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (char === '"' || char === "'" || char === "`") {
      index = skipQuoted(text, index);
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(openAt + 1, index);
      }
    }
  }
  return "";
}

/** 从 `openAt` 处的 `{` 起按花括号深度找配对的 `}`（跳过字符串里的花括号）。
 *  取「第一个 `})`」当窗口终点会让密钥排在 `inject: () => ({ … })` 之后的产物读不到
 *  真实 key——那一对 `})` 来自内层箭头函数的对象，不是注册对象本身。 */
function balancedBraces(text: string, openAt: number): number {
  let depth = 0;
  for (let index = openAt; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (char === '"' || char === "'" || char === "`") {
      index = skipQuoted(text, index);
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/** 若 `at` 处起是字符串或注释，返回它最后一个字符的下标；否则 -1。 */
function skipNonCode(text: string, at: number): number {
  const char = text[at] ?? "";
  if (char === '"' || char === "'" || char === "`") {
    return skipQuoted(text, at);
  }
  if (char === "/" && text[at + 1] === "/") {
    const stop = text.indexOf("\n", at);
    return stop === -1 ? text.length - 1 : stop;
  }
  if (char === "/" && text[at + 1] === "*") {
    const stop = text.indexOf("*/", at + 2);
    return stop === -1 ? text.length - 1 : stop + 1;
  }
  return -1;
}

/** 注册对象顶层字段的原始值：区分字面量与标识符——两者都可能长得像标识符
 *  （`"right"` 与 `BUNDLE_PKG`），只按字符形态判会把字面量当常量名再查一次。 */
interface RawFieldValue {
  readonly kind: "literal" | "identifier";
  readonly value: string;
}

/** `key:` 的原始值正文（字面量或标识符）；值不是这两种形态时回 undefined。 */
function fieldValueAfter(text: string, at: number): RawFieldValue | undefined {
  const matched = /^\s*(?:"(?<dq>[^"]*)"|'(?<sq>[^']*)'|(?<ident>[A-Za-z_$][\w$]*))/u.exec(
    text.slice(at),
  );
  const literal = matched?.groups?.["dq"] ?? matched?.groups?.["sq"];
  const ident = matched?.groups?.["ident"];
  let result: RawFieldValue | undefined;
  if (literal !== undefined && literal !== "") {
    result = { kind: "literal", value: literal };
  } else if (ident !== undefined && ident !== "") {
    result = { kind: "identifier", value: ident };
  }
  return result;
}

/** 注册对象**顶层**字段的原始值（字面量正文或标识符）；嵌套对象里的同名字段不算。
 *  只认花括号深度为 1 的位置：`inject: () => ({ key: … })` 里的 key 在深度 2，
 *  把它当成注册项的 key 会让漂移针拿一个内层值去比对。注释与字符串里的 `key:` 同样跳过。 */
function topLevelField(objectText: string, field: string): RawFieldValue | undefined {
  let depth = 0;
  let index = 0;
  let result: RawFieldValue | undefined;
  while (index < objectText.length && result === undefined) {
    const skipped = skipNonCode(objectText, index);
    if (skipped !== -1) {
      index = skipped + 1;
    } else if (objectText[index] === "{") {
      depth += 1;
      index += 1;
    } else if (objectText[index] === "}") {
      depth -= 1;
      index += 1;
    } else if (
      depth === 1 &&
      objectText.startsWith(`${field}:`, index) &&
      !/[\w$]/u.test(objectText[index - 1] ?? "")
    ) {
      result = fieldValueAfter(objectText, index + field.length + 1);
      index += 1;
    } else {
      index += 1;
    }
  }
  return result;
}

/** 取产物里 `plugins.bundle.config` 那次 register 的 key（字面量或常量标识符都解析）。
 *  导出供本文件的守卫用例直接喂夹具（真实产物那条路经 bundleSlotKeyFacts）。 */
export function registeredSlotKey(text: string): string {
  // marker 按正则找（name 与值之间的空白、引号形态都容忍——产物压缩/换引号不该让针误报）。
  const markerMatch = /name:\s*["']plugins\.bundle\.config["']/u.exec(text);
  assert.notEqual(markerMatch, null, "产物里没有 plugins.bundle.config 的注册");
  const marker = markerMatch?.index ?? 0;
  // 窗口取**整个注册对象**：从最近的 register( 之后第一个 `{` 起按深度找配对的 `}`。
  // 用第一个 `})` 会被 `inject: () => ({ … })` 抢先收口，key 一旦排到 inject 之后
  // 就读不到（或读到内层无关的 key）。
  const callAt = text.lastIndexOf("register(", marker);
  assert.notEqual(callAt, -1, "产物里 plugins.bundle.config 的注册不在 register(…) 调用里");
  const openAt = text.indexOf("{", callAt);
  assert.notEqual(openAt, -1, "产物里 plugins.bundle.config 的注册没有对象字面量");
  const closeAt = balancedBraces(text, openAt);
  assert.notEqual(closeAt, -1, "产物里 plugins.bundle.config 的注册对象没有闭合");
  const raw = topLevelField(text.slice(openAt, closeAt + 1), "key");
  assert.notEqual(raw, undefined, "产物里读不到 slot 注册 desc 的 key（既不是字面量也不是标识符）");
  if (raw === undefined) {
    return "";
  }
  // 标识符分支：去产物里查 const 声明取值；字面量直接就是 key。
  return raw.kind === "literal" ? raw.value : constLiteral(text, raw.value);
}

/** 实参 → 条目 id：字符串字面量直接取，标识符去产物里查 const 声明。
 *  字面量值限定不含引号（`.*` 是贪婪的：`get("a" + "b")` 会被拼成一个假值）；既非
 *  字面量也非标识符的实参响亮失败，漂移针不许拿拼接出来的假 id 去比对。 */
function entryIdOfArgument(text: string, arg: string): string {
  const inline = /^(?<q>["'])(?<value>[^"']*)\k<q>$/u.exec(arg)?.groups?.["value"];
  if (inline !== undefined) {
    return inline;
  }
  assert.match(
    arg,
    /^[A-Za-z_$][A-Za-z0-9_$]*$/u,
    `产物里 configForms.get(…) 的实参不是字面量或标识符（${arg}）`,
  );
  return constLiteral(text, arg);
}

/** 取产物里 `ctx.configForms.get(<入参>)` 实际用到的条目 id（同样兼容字面量/常量）。
 *  收集**全部**调用并断言同值：多处调用各不相同时，只取第一处会把断言对到与本包
 *  无关的那一处上。实参按括号深度取全（嵌套调用/带空格都要能读）。
 *  导出供本文件的守卫用例直接喂夹具（真实产物那条路经 bundleSlotKeyFacts）。 */
export function configFormsEntryId(text: string): string {
  const ids: string[] = [];
  const MARKER = "configForms.get(";
  let cursor = text.indexOf(MARKER);
  while (cursor !== -1) {
    // 词边界：`xxxconfigForms.get(` 是别的标识符，不算调用点。
    const previous = cursor === 0 ? "" : (text[cursor - 1] ?? "");
    if (!/[\w$]/u.test(previous)) {
      const openAt = cursor + MARKER.length - 1;
      const arg = balancedParens(text, openAt).trim();
      assert.notEqual(arg, "", "产物里 configForms.get(…) 的实参是空的");
      ids.push(entryIdOfArgument(text, arg));
    }
    cursor = text.indexOf(MARKER, cursor + 1);
  }
  assert.ok(ids.length > 0, "产物里没有 ctx.configForms.get(…) 调用");
  // 一致性比较在**解析后的 id**上做：get(NS) 与 get("lesson-loop") 语义相同，
  // 按原始实参文本比较会把等价写法误报成"多处不一致"。
  assert.equal(
    new Set(ids).size,
    1,
    `产物里有多处不同的 configForms.get(…) 入参（${ids.join(", ")}）`,
  );
  return ids[0]!;
}

/** 漂移针要比的四个值：两个真源 + 产物里实际写出的两处。 */
export interface BundleSlotKeyFacts {
  /** profile 的 bundle 包名（= 宿主派发 entryKey，槽位 key 必须是它）。 */
  bundle: string;
  /** cordis.patch.yml 的裸条目 id（= 0.2.1-alpha.2 的 settings 命名空间）。 */
  entryId: string;
  /** 产物里 `plugins.bundle.config` 那次 register 实际用的 key。 */
  slotKey: string;
  /** 产物里 `ctx.configForms.get(…)` 实际用的入参。 */
  formsEntryId: string;
}

/**
 * 把「当期构建（buildClient()，纯函数）的产物」与「两个真源」读成一组可断言的值——
 * 本模块只读不判，判据（下面三条）留在用例正文里，这样断言与被测代码同处一个测试。
 *   1. `plugins.bundle.config` 的 key === profile `dsh.profile.bundles` 中本包那条包名；
 *   2. `configForms.get()` 的入参 === cordis.patch.yml 的裸条目 id
 *      （**没有**被顺手一起改成包名 —— 那会把 client 半的写入面再次弄坏）；
 *   3. 两个标识不同值（相等就说明本包恰好条目 id == 包名，那这一层的混用钉不住，直接红）。
 * 读盘/取字面量失败仍然当场抛（漂移针不许静默放过，见 constLiteral 与两个取值的 assert）。
 */
export async function bundleSlotKeyFacts(): Promise<BundleSlotKeyFacts> {
  // ESM 动态导入必须吃 URL：Windows 上裸盘符路径（`C:\…`）会被当成 URL scheme 直接抛
  // ERR_UNSUPPORTED_ESM_URL_SCHEME，pathToFileURL 是唯一跨平台写法。
  const { buildClient } = (await import(
    pathToFileURL(path.join(PKG_DIR, "build-client.mjs")).href
  )) as {
    buildClient: () => Promise<string>;
  };
  const out = await buildClient();

  return {
    bundle: profileBundleName(),
    entryId: patchEntryId(),
    slotKey: registeredSlotKey(out),
    formsEntryId: configFormsEntryId(out),
  };
}
