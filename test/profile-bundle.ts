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

/** profile 清单路径：`~/.dsh/profiles/web/package.json`（DSH_PROFILE_PACKAGE_JSON 可改指）。 */
function profileManifestPath(): string {
  const override = process.env["DSH_PROFILE_PACKAGE_JSON"] ?? "";
  return override === ""
    ? path.join(os.homedir(), ".dsh", "profiles", "web", "package.json")
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

/** profile 的 `dsh.profile.bundles` 清单；没装 profile 的环境（CI、消费者克隆）回 null。 */
function profileBundleListOrNull(): string[] | null {
  const file = profileManifestPath();
  if (!existsSync(file)) {
    return null;
  }
  const dshSection = readJson(file)["dsh"];
  const profileSection = isRecord(dshSection) ? dshSection["profile"] : {};
  const listed = isRecord(profileSection) ? profileSection["bundles"] : [];
  return assertBundleListOf(listed, `${file} 的 dsh.profile.bundles`);
}

/**
 * 本包在 profile 里那条 bundle 的包名 —— `plugins.bundle.config` 的 key 必须是它。
 * 取的是本包自己的 `package.json.name`：宿主派发的 `entryKey` 就是**被装的那个 bundle**
 * 的包名，所以对任何装法（registry / link / 本机 profile）它都是那个值。
 * profile 只存在在这台开发机上，装了才加一道机器侧针（清单里确有这一条）。
 */
export function profileBundleName(): string {
  const own = readJson(path.join(PKG_DIR, "package.json"))["name"];
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

/** YAML 标量值归一：剥行尾注释（`#` 前要有空白）与成对引号。 */
function yamlScalar(raw: string): string {
  const withoutComment = raw.replace(/\s+#.*$/u, "").trim();
  const quoted = /^(?<q>["'])(?<body>.*)\k<q>$/u.exec(withoutComment);
  return quoted === null ? withoutComment : (quoted.groups?.["body"] ?? "");
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
  return ids[0] ?? "";
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
 * 导出供本文件的守卫用例直接喂夹具（真实产物那条路经 bundleSlotKeyFacts）。
 */
export function constLiteral(text: string, name: string): string {
  const pattern = new RegExp(
    `const\\s+${escapeRegExp(name)}\\s*=\\s*(?:"(?<dq>[^"]*)"|'(?<sq>[^']*)')`,
    "u",
  );
  const groups = pattern.exec(text)?.groups ?? {};
  const value = groups["dq"] ?? groups["sq"] ?? "";
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

/** 取产物里 `plugins.bundle.config` 那次 register 的 key（字面量或常量标识符都解析）。
 *  导出供本文件的守卫用例直接喂夹具（真实产物那条路经 bundleSlotKeyFacts）。 */
export function registeredSlotKey(text: string): string {
  const marker = text.indexOf('name: "plugins.bundle.config"');
  assert.notEqual(marker, -1, "产物里没有 plugins.bundle.config 的注册");
  // 窗口收到本次 register 的对象字面量：从 marker 到第一个 `})`（对象闭合），防止
  // 产物里后面别处的 `key:`（React list key、下一个 register 的 desc）被抓进来。
  const windowEnd = text.indexOf("})", marker);
  assert.notEqual(windowEnd, -1, "产物里 plugins.bundle.config 的注册对象没有闭合");
  const nearby = text.slice(marker, windowEnd);
  const groups =
    /(?<![\w$])key:\s*(?:"(?<literal>[^"]*)"|(?<ident>[A-Za-z_$][A-Za-z0-9_$]*))/u.exec(nearby)
      ?.groups ?? {};
  const literal = groups["literal"] ?? "";
  if (literal !== "") {
    return literal;
  }
  const ident = groups["ident"] ?? "";
  assert.notEqual(ident, "", "产物里读不到 slot 注册 desc 的 key（既不是字面量也不是标识符）");
  return constLiteral(text, ident);
}

/** 实参 → 条目 id：字符串字面量直接取，标识符去产物里查 const 声明。 */
function entryIdOfArgument(text: string, arg: string): string {
  const inline = /^(?<q>["'])(?<value>.*)\k<q>$/u.exec(arg)?.groups?.["value"];
  return inline ?? constLiteral(text, arg);
}

/** 取产物里 `ctx.configForms.get(<入参>)` 实际用到的条目 id（同样兼容字面量/常量）。
 *  收集**全部**调用并断言同值：多处调用各不相同时，只取第一处会把断言对到与本包
 *  无关的那一处上。实参按括号深度取全（嵌套调用/带空格都要能读）。
 *  导出供本文件的守卫用例直接喂夹具（真实产物那条路经 bundleSlotKeyFacts）。 */
export function configFormsEntryId(text: string): string {
  const args: string[] = [];
  let cursor = text.indexOf("configForms.get(");
  while (cursor !== -1) {
    const openAt = cursor + "configForms.get(".length - 1;
    const arg = balancedParens(text, openAt).trim();
    assert.notEqual(arg, "", "产物里 configForms.get(…) 的实参是空的");
    args.push(arg);
    cursor = text.indexOf("configForms.get(", cursor + 1);
  }
  assert.ok(args.length > 0, "产物里没有 ctx.configForms.get(…) 调用");
  assert.equal(
    new Set(args).size,
    1,
    `产物里有多处不同的 configForms.get(…) 入参（${args.join(", ")}）`,
  );
  return entryIdOfArgument(text, args[0] ?? "");
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
