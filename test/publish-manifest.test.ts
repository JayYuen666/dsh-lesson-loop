// test/publish-manifest.test.ts —— 发布形态门禁：入口面必须**与发布器无关**地可解析。
//
// 为什么值得一条测试：构建与单测都在源码侧跑绿，而真实故障发生在装出去之后。三类坑都在
// 那一侧。其一是入口指向没随包发出去的文件；其二是入口覆盖写在 `publishConfig` 里——
// pnpm 发布时把它合并到顶层，npm 不合并（npm 会打印
// "Unknown publishConfig config main/exports" 并忽略），同一个仓库换个发布器就发出一个
// import 必失败的包。这里不模仿任何发布器的实现，而是把不变式钉成断言：**顶层入口自己就
// 完整可解析，且 publishConfig 不再承载入口字段**，于是两套发布器语义的差恒为空。
// 其三是宿主包被写进 `dependencies`：profile 的安装布局会把它们落成真实目录，于是宿主进程
// 里出现第二份实例——判据与它的崩法写在「宿主依赖的版本形状」那组门禁的第一条里。
//
// 第二组门禁扫注释：日期与轮次编号写下时有用，读的人只会困惑，且没有任何读者能从中重建
// 当时的上下文。只扫注释行与文档；测试夹具里的日期（modifiedAfter 之类的边界值）是数据，
// 角色文档里的日期是内容，两者都不在禁面内。
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listDeclarations } from "../build-types.mjs";
import { SETTINGS_NAMESPACE } from "../lib/rules-layout.ts";

const pkgDir = path.join(import.meta.dirname, "..");

/** 声明入口（package.json 的 `types` 指向它），也是「types/ 是否产出」的存在性锚点。 */
const DECLARATION_ENTRY = "types/host.d.ts";

/**
 * 只在注释与文档里禁的指涉：日期。
 *
 * 「轮次编号」刻意不进门禁。本仓的 `本轮` / `第 N 轮` 绝大多数指的是**会话轮次**这个产品概念
 * （`第一轮消息不支持 fork`、gate 的「下一轮重新计数」），而不是写下这段注释时的工作轮次。
 * 两种含义在中文里同形，机器分不开；要禁只能靠逐条人工判断，那不是门禁能做到的事。
 */
const FORBIDDEN_IN_COMMENTS: readonly RegExp[] = [/\b(?:19|20)\d{2}-\d{2}-\d{2}\b/u];

/** `publishConfig` 里唯一允许出现的字段：可见性与源，都不是入口面。 */
const ALLOWED_PUBLISH_CONFIG = new Set(["access", "registry"]);

/** 遍历时跳过的目录：依赖、产物、以及本门禁刻意不管的面。 */
const SKIP_DIRS = new Set([
  "node_modules",
  "coverage",
  "_env",
  "dist",
  ".git",
  // 测试夹具里的日期与轮次编号是数据，不是注释噪音。
  "test",
  "tests",
  "__tests__",
  // 角色文档库：那里的日期是内容（例如下一份威胁报告的时间线）。
  "agents",
]);

/** package.json 里与入口面有关的形状；其余字段本门禁不关心。 */
interface Manifest {
  readonly name?: string;
  readonly main?: string;
  readonly types?: string;
  readonly exports?: Record<string, unknown>;
  readonly files?: readonly string[];
  readonly publishConfig?: Record<string, unknown>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

/** 一条 `files` 模式的两种形态。 */
type PatternShape =
  /** 目录或后缀模式：列该目录（可递归）下以 `extension` 结尾的文件。 */
  | { readonly kind: "glob"; readonly dir: string; readonly extension: string }
  /** 精确文件名：带点号又无通配的条目是**文件名**（`host.js`），不是后缀过滤。 */
  | { readonly kind: "exact"; readonly file: string };

/**
 * 把 `files` 的一条模式归类。本仓实际用到的只有三种写法：裸文件名、目录名、`dir/*.ext`。
 *
 * 「精确文件名」这一档不能和后缀过滤混为一谈：把 `host.js` 当成 `.js` 后缀过滤，于是
 * `files` 里列的每个构建产物都匹配不上任何条目——`files` 覆盖这道断言的集合会空掉，门禁
 * 自己先失效。实测报出来是「main 指向 host.js，但它不在 files 覆盖范围内」。
 *
 * @param entry - `files` 数组里的一项
 * @returns 该模式要列的目录与后缀过滤，或一个精确文件名
 */
function shapeOf(entry: string): PatternShape {
  const dot = entry.lastIndexOf(".");
  const star = entry.indexOf("*");
  if (star !== -1) {
    return {
      kind: "glob",
      dir: entry.slice(0, star).replace(/\/$/u, ""),
      extension: entry.slice(dot),
    };
  }
  if (!entry.includes(".")) {
    return { kind: "glob", dir: entry, extension: "" };
  }
  return { kind: "exact", file: entry };
}

/**
 * 按 `files` 模式列出包内确实存在的文件（相对包根、`/` 分隔）。
 *
 * @param shape - 见 {@link shapeOf}
 * @returns 命中的文件清单
 */
async function expand(shape: PatternShape): Promise<string[]> {
  if (shape.kind === "exact") {
    return existsSync(path.join(pkgDir, shape.file)) ? [shape.file] : [];
  }
  const names = await readdir(path.join(pkgDir, shape.dir), { recursive: shape.dir !== "." });
  return names
    .map((name) => name.split(path.sep).join("/"))
    .filter((name) => shape.extension === "" || name.endsWith(shape.extension))
    .map((name) => path.posix.join(shape.dir, name));
}

/**
 * 递归收集一条 `exports` 值里的具体目标文件。通配条目（值含 `*`）没有可验证的固定文件。
 *
 * @param value - `exports` 里某一键的值（字符串或条件对象）
 * @returns 该条目要求存在的包内路径
 */
function filesOf(value: unknown): string[] {
  if (typeof value === "string") {
    return value.includes("*") ? [] : [value];
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap((nested) => filesOf(nested));
  }
  return [];
}

/** 入口目标的相对形态（去掉 `./` 前缀）。 */
function asRelative(target: string): string {
  return target.replace(/^\.\//u, "");
}

/**
 * manifest 里全部需要落地的入口文件：main、types 与每个 exports 具体目标。
 *
 * @param manifest - 解析后的 package.json
 * @returns 目标清单，每项带来源标签以便失败时点名
 */
function entryFiles(manifest: Manifest): readonly { label: string; file: string }[] {
  const flat = Object.entries(manifest.exports ?? {}).flatMap(([specifier, value]) =>
    filesOf(value).map((file) => ({ label: specifier, file })),
  );
  const scalars = [
    ...(typeof manifest.main === "string" ? [{ label: "main", file: manifest.main }] : []),
    ...(typeof manifest.types === "string" ? [{ label: "types", file: manifest.types }] : []),
  ];
  return [...scalars, ...flat];
}

/**
 * 发布器无条件附带的文件：不受 `files` 约束，但也不该由门禁去断言它在 `files` 里。
 * 清单是实测的：npm 只附带 package.json、README* 与 LICENSE*，`CHANGELOG.md` /
 * `THIRD_PARTY_NOTICES.md` 都不在其中，留在这里会让"漏写 files"这种故障照绿。
 */
const ALWAYS_SHIPPED = ["package.json", "README.md", "README.zh-CN.md", "LICENSE"];

/**
 * 读 manifest 与它应当发出去的文件清单。
 *
 * @returns manifest 本体与 `files` 展开后的集合（含发布器无条件附带的件）
 */
async function readSurface(): Promise<{ manifest: Manifest; shipped: Set<string> }> {
  const manifest = JSON.parse(
    await readFile(path.join(pkgDir, "package.json"), "utf8"),
  ) as unknown as Manifest;
  const groups = await Promise.all((manifest.files ?? []).map((entry) => expand(shapeOf(entry))));
  const attached = ALWAYS_SHIPPED.filter((name) => existsSync(path.join(pkgDir, name)));
  return { manifest, shipped: new Set([...groups.flat(), ...attached]) };
}

/**
 * 递归收集该纳入注释门禁的源文件与文档（相对包根、`/` 分隔）。
 *
 * @param dir - 当前目录的绝对路径
 * @param prefix - 相对包根的前缀
 * @returns 命中的文件清单
 */
async function collectSources(dir: string, prefix: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  // 每个条目一个 promise 再一起等：顺序无关，而顺序相关的写法（循环里 await）在这里既
  // 慢又没有对应的正确性理由——收集的是文件名集合，先返回谁都一样。
  const groups = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          return [];
        }
        const nested = await collectSources(path.join(dir, entry.name), `${prefix}${entry.name}/`);
        return nested;
      }
      if (/\.(?:ts|tsx|mjs|yml|md)$/u.test(entry.name)) {
        return [`${prefix}${entry.name}`];
      }
      return [];
    }),
  );
  return groups.flat();
}

/**
 * 取一段文本里属于注释或文档的行。文档（`.md`）整体算；代码只取注释行，免得把字符串
 * 字面量里的数据（日期夹具、示例路径）误判成注释噪音。
 *
 * @param file - 相对包根的文件名，用于决定判定口径
 * @param text - 文件全文
 * @returns 参与门禁的行
 */
function commentLines(file: string, text: string): string[] {
  if (file.endsWith(".md")) {
    return text.split("\n");
  }
  return text.split("\n").filter((line) => /^\s*(?:\/\/|\/\*|\*|#)/u.test(line));
}

describe("发布形态", () => {
  it("files 覆盖全部入口目标（换个发布器也不会发出悬空入口）", async () => {
    const { manifest, shipped } = await readSurface();
    const targets = entryFiles(manifest);
    expect(targets.length, "入口面不该是空的").toBeGreaterThan(0);
    for (const target of targets) {
      expect(
        shipped.has(asRelative(target.file)),
        `${target.label} 指向 ${target.file}，但它不在 files 覆盖范围内`,
      ).toBe(true);
    }
  });

  it("入口一律指向构建产物，源码目录不参与发布", async () => {
    // `.d.ts` 与 host.js 同为产物，故用负向后顾把它排除；`host.ts` / `lib/x.ts` 指进来照样红。
    const sourceSuffix = /(?<!\.d)\.tsx?$/u;
    const { manifest } = await readSurface();
    for (const target of entryFiles(manifest)) {
      expect(target.file, `${target.label} 不该指源码`).not.toMatch(sourceSuffix);
    }
  });

  it("包根的每一份 .md 都在发布面里（npm 只自动附带 README* 与 LICENSE）", async () => {
    // 封住这一类而不是每加一份文档补一条断言：漏写 `files` 时 npm 页面看不出异常。
    const { shipped } = await readSurface();
    const docs = readdirSync(pkgDir)
      .filter((name) => name.endsWith(".md"))
      .toSorted();
    expect(docs.length, "包根至少该有一份 .md").toBeGreaterThan(0);
    for (const doc of docs) {
      expect(shipped.has(doc), `${doc} 不在发布面：写进 files，或确认它本就不该随包发`).toBe(true);
    }
  });

  it("publishConfig 只留可见性与源，不留入口覆盖", async () => {
    const { manifest } = await readSurface();
    for (const key of Object.keys(manifest.publishConfig ?? {})) {
      expect(ALLOWED_PUBLISH_CONFIG.has(key), `publishConfig.${key} 会被 npm 忽略`).toBe(true);
    }
  });
});

/** 产出 `types/host.d.ts` 的那批输入：lib/ 下任一文件变新都算声明过期。 */
function declarationSources(): string[] {
  return [
    "host.ts",
    ...readdirSync(path.join(pkgDir, "lib"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => path.join("lib", name)),
  ];
}

/**
 * `types/` 下全部声明的清单与正文（循环里 await 会被 `no-await-in-loop` 判红）。
 *
 * @returns 声明文件名（相对 `types/`）与其正文
 */
async function declarationTexts(): Promise<{ file: string; text: string }[]> {
  const produced = await listDeclarations(path.join(pkgDir, "types"), "");
  expect(produced.length, "types/ 至少该产出一个声明文件").toBeGreaterThan(0);
  return Promise.all(
    produced.map(async (file) => ({
      file,
      text: await readFile(path.join(pkgDir, "types", file), "utf8"),
    })),
  );
}

describe("类型声明随包发布（build:types 的产物面）", () => {
  it("声明入口存在，且 types/ 真的产出了声明文件", async () => {
    // 缺声明没有运行期信号：tsserver 与 npm 页面只会静默退化成"无类型模块"。
    expect(existsSync(path.join(pkgDir, DECLARATION_ENTRY)), `${DECLARATION_ENTRY} 不存在`).toBe(
      true,
    );
    const produced = await listDeclarations(path.join(pkgDir, "types"), "");
    expect(produced.length, "types/ 至少该产出一个声明文件").toBeGreaterThan(0);
  });

  it("声明不比它派生的源码旧（types 不能停在上一版源码上）", () => {
    // 按时间判：声明由 host.ts / lib/*.ts emit，"过期"的充要表现就是某个源文件比声明新。
    // 按导出名比对反过来要求产物已存在，`vitest run` 单跑时先撞墙。
    const declaredAt = statSync(path.join(pkgDir, DECLARATION_ENTRY)).mtimeMs;
    const stale = declarationSources().filter(
      (rel) => statSync(path.join(pkgDir, rel)).mtimeMs > declaredAt,
    );
    expect(
      stale,
      `types/ 比这些源文件旧：${stale.join("、")}——请运行 npm run build:types`,
    ).toStrictEqual([]);
  });

  it("声明产物不含本机绝对路径或包管理器内部路径", async () => {
    // tsc 会把 rootDir 之外解析到的真实路径写进类型（`typeof import("/Users/…")`），那是
    // 构建机的家目录。两条判据都以引号为锚：泄漏只可能走说明符与字符串字面量类型这两种形态，
    // 不带引号去扫正文会把注释里的 factual 表述误判成泄漏（实测误杀过"macOS /tmp ↔
    // /private/tmp 软链"那句）。
    const MACHINE_PATH_PATTERNS: readonly RegExp[] = [
      /["']\/(?:Users|home|var|private)\//u,
      /["'][^"']*node_modules\//u,
    ];
    for (const entry of await declarationTexts()) {
      for (const pattern of MACHINE_PATH_PATTERNS) {
        expect(
          pattern.test(entry.text),
          `types/${entry.file} 命中 ${pattern}：声明里带了构建机的本机路径`,
        ).toBe(false);
      }
    }
  });

  it("声明里的相对说明符不残留源码 .ts 后缀（消费方解析得到的必须是产物）", async () => {
    // 包里没有 `lib/x.ts`，只有 `types/lib/x.d.ts`；留着源码后缀，消费方解析到的就是悬空文件。
    const SOURCE_SPECIFIER = /from\s+["']\.{1,2}\/[^"']*\.ts["']/u;
    for (const entry of await declarationTexts()) {
      expect(
        SOURCE_SPECIFIER.test(entry.text),
        `types/${entry.file} 的相对说明符仍指源码 .ts，消费方解析不到：请运行 npm run build:types`,
      ).toBe(false);
    }
  });
});

/** 宿主 dsh 家族的包名前缀（本组三条判据都要按它筛，收常量）。 */
const DSH_PREFIX = "@deepseek-ai/dsh-";

describe("宿主依赖的版本形状（升级防线）", () => {
  it("@deepseek-ai/* 一律不进 dependencies：装出去会在宿主进程里物化第二份", async () => {
    // 钉的是「全绿但宿主瘫痪」这一类坑，别把它当成风格偏好去「恢复」。消费侧的 profile 用
    // `nodeLinker: hoisted` 安装（本仓 workspace 同样钉了 `autoInstallPeers: false`），
    // 于是宿主包只要出现在 `dependencies`，pnpm 就会在 profile 里把它们落成**真实目录**，
    // 与宿主进程里已经加载的那份并存在一起。而 `@deepseek-ai/dsh-tools` 的
    // `TOOL_RUNTIME_SCHEDULER` 是普通 `Symbol`（不是 `Symbol.for`），符号身份按模块实例计算：
    // 宿主 `dsh-agent-loop` 拿自己那份的 Symbol 去读由副本挂载出来的 `ToolRuntime`，
    // 得到 `undefined`，于是每一次原生工具调用都抛
    // "Cannot read properties of undefined (reading 'prepare')"，整个 profile 的工具一起失效。
    // 本包的构建、类型检查与覆盖率门禁在此之前全部照绿，判据只能落在 manifest 面上。
    //
    // 分流口径以**构建产物**为准而不是源码：源码里的 `import type` 会被编译抹掉，只有
    // host.js/client.js 里真出现裸说明符的那些才需要宿主在运行期在场。当前三枚
    // （`schemastery` 默认导入、`dsh-brand` 与 `dsh-home-paths` 具名导入）都是值导入，
    // 因此进 peer 且不标 optional；只被类型面引用的留在 dev，编译期解析得到、运行期不相干。
    const { manifest } = await readSurface();
    const leaked = Object.keys(manifest.dependencies ?? {}).filter((name) =>
      name.startsWith("@deepseek-ai/"),
    );
    expect(leaked, "这些宿主包会随消费方装进 profile，物化出第二份实例").toStrictEqual([]);
  });

  it("devDependencies 里的 dsh-* 家族一律精确钉，不留任何范围算子", async () => {
    // registry 上的 dist-tag 是实测出来的陷阱：`latest` 可能指向远早于宿主 ABI 的版本。
    // 精确钉是让「不带版本地装成远古版本」这件事不发生的最小条件；一旦放宽成 `^`/`~`，
    // 宿主某天发新 minor 就会自动跟上去，而插件与宿主 ABI 耦合，那等于让本包在没有测试的
    // 情况下换掉编译用的宿主类型面。
    // 只判 dev 这一侧：它才是本包真正装下来的那一份。peer 记的是「运行期由宿主提供」，
    // 装什么版本由宿主决定，判据在下面那条。
    const { manifest } = await readSurface();
    // 过滤出违规项再一次性断言，而不是在循环里按条件 expect：失败时 diff 直接列出
    // 「哪个包钉成了什么」，比逐条抛错更好读。
    const ranged = Object.entries(manifest.devDependencies ?? {}).filter(
      ([name, range]) => name.startsWith(DSH_PREFIX) && !/^\d+\.\d+\.\d+-/u.test(range),
    );
    expect(ranged, "这些 dsh-* 开发依赖没有精确钉住版本").toStrictEqual([]);
  });

  it("devDependencies 里的 dsh-* 全部同版本（不许装出第二份宿主类型）", async () => {
    // 宿主类型面被这些包以 type-only 方式消费；同一次安装里出现两枚 dsh-session 的拷贝，
    // nominal 类型（品牌串、投影状态）会开始互相不认，而那不报编译错、只报运行期
    // 「认不出这个 callId」。同版本是让这件事不发生的最小条件。
    const { manifest } = await readSurface();
    const dshDev = Object.entries(manifest.devDependencies ?? {}).filter(([name]) =>
      name.startsWith(DSH_PREFIX),
    );
    expect(dshDev.length, "至少要钉住一枚 dsh-* 开发依赖，否则这条是空转").toBeGreaterThan(0);
    const baseline = dshDev[0]?.[1];
    const drifted = dshDev.filter(([, range]) => range !== baseline);
    expect(drifted, `这些 dsh-* 与 ${baseline} 不同版本`).toStrictEqual([]);
  });

  it("peerDependencies 里的 dsh 家族写支持窗口范围，与裸 dsh 逐条同一条", async () => {
    // peer 由宿主拿自己安装的那版去满足：钉成精确版本等于要求两者版本号完全相等，而滚动支持
    // 窗口本来就含三个版本。宿主侧只在 manifest 没有 engines.dsh 时才读 peer（app-boot 的
    // plugin-compatibility 里 engines.dsh 存在即独判），所以这一位是发布元数据的含义问题。
    const { manifest } = await readSurface();
    const bare = manifest.peerDependencies?.["@deepseek-ai/dsh"] ?? "";
    expect(bare, "裸 dsh 的 peer 缺失：支持窗口就失去基准了").toMatch(/^\^/u);
    const offPolicy = Object.entries(manifest.peerDependencies ?? {}).filter(
      ([name, range]) => name.startsWith(DSH_PREFIX) && range !== bare,
    );
    expect(offPolicy, "这些 dsh-* peer 与裸 dsh 不是同一条范围").toStrictEqual([]);
  });
});

describe("注释与文档没有内部指涉", () => {
  it("源码与文档的注释里没有日期", async () => {
    const collected = await collectSources(pkgDir, "");
    const sources = collected.toSorted();
    expect(sources.length, "至少要扫到源码文件").toBeGreaterThan(0);
    const texts = await Promise.all(
      sources.map(async (file) => ({
        file,
        text: await readFile(path.join(pkgDir, file), "utf8"),
      })),
    );
    for (const entry of texts) {
      for (const line of commentLines(entry.file, entry.text)) {
        for (const pattern of FORBIDDEN_IN_COMMENTS) {
          expect(
            pattern.test(line),
            `${entry.file} 的注释命中内部指涉 ${pattern}：${line.trim().slice(0, 80)}`,
          ).toBe(false);
        }
      }
    }
  });
});

/** `dsh` 声明面的形状（宿主按它决定装什么、加载什么）。 */
interface DshDeclaration {
  manifestVersion?: number;
  bundle?: { patch?: string | string[] };
  client?: { platform?: string; immediately?: boolean; external?: readonly string[] };
}

/** `dsh` 声明的类型收窄（不做断言：谓词函数即可）。 */
function isDshDeclaration(value: unknown): value is DshDeclaration {
  return typeof value === "object" && value !== null;
}

/** 读取 `dsh` 声明（缺席时给空对象，由各条断言自己点名）。 */
function dshOf(manifest: Manifest): DshDeclaration {
  const declared: unknown = (manifest as Manifest & { dsh?: unknown }).dsh;
  return isDshDeclaration(declared) ? declared : {};
}

/** patch 列表（字符串与数组两种声明形态都吃）。 */
function patchFiles(bundle: DshDeclaration["bundle"]): string[] {
  const declared = bundle?.patch;
  if (typeof declared === "string") {
    return [declared];
  }
  return Array.isArray(declared) ? [...declared] : [];
}

/** 产物里的 require 说明符清单（去重排序；跨半门禁用它钉"只允许平台模块"）。 */
function requiresIn(text: string): string[] {
  return [...new Set(text.match(/require\("(?<specifier>[^"]+)"\)/gu))].toSorted();
}

describe("dsh 声明面（宿主按这些字段决定装什么、加载什么）", () => {
  it("dsh.client 声明 web 平台时必须同时交出 ./client export（缺了宿主扫描直接抛错）", async () => {
    const { manifest, shipped } = await readSurface();
    const { client } = dshOf(manifest);
    if (client === undefined) {
      return;
    }
    // client-modules 的判据（packages/client/modules/src/index.ts:836-857）：platform 必须是
    // "web" 才当 client 行；声明了 dsh.client 却 export 不出 ./client 时**抛错**，整条装载失败。
    expect(client.platform).toBe("web");
    const target = filesOf(manifest.exports?.["./client"] ?? undefined);
    expect(target.length, "dsh.client 声明了，但 exports 里没有 ./client 目标").toBeGreaterThan(0);
    for (const file of target) {
      expect(shipped.has(asRelative(file)), `./client 指向 ${file}，但它不在发布面`).toBe(true);
    }
  });

  it("dsh.bundle.patch 指向存在的文件且在发布面里（读不到 patch 的 bundle 会被宿主静默跳过）", async () => {
    const { manifest, shipped } = await readSurface();
    const patches = patchFiles(dshOf(manifest).bundle);
    expect(patches.length, "dsh.bundle.patch 缺失：这条 bundle 在宿主侧等于不存在").toBeGreaterThan(
      0,
    );
    for (const file of patches) {
      expect(existsSync(path.join(pkgDir, file)), `${file} 不存在`).toBe(true);
      // app-boot 对读不出 patch 的 bundle 走 skippedBundles（只跳过、不报错）：漏进 files
      // 就等于装机后插件永不加载，而本地一切照绿。
      expect(shipped.has(asRelative(file)), `${file} 不在 files 覆盖面里`).toBe(true);
    }
  });

  it("patch 的裸条目 id 与 name 必须与包名、代码里的 settings 命名空间同源", async () => {
    const { manifest } = await readSurface();
    const patches = patchFiles(dshOf(manifest).bundle);
    expect(patches.length).toBeGreaterThan(0);
    const texts = await Promise.all(
      patches.map((file) => readFile(path.join(pkgDir, file), "utf8")),
    );
    const yml = texts.join("\n");
    // 条目 id 是设置命名空间的真源（宿主读 entry.options.id）：代码侧读同一枚常量的导出口。
    const entryId = SETTINGS_NAMESPACE;
    expect(yml, `patch 里没有 - id: ${entryId}，规则库的命名空间就会对不上`).toContain(
      `id: ${entryId}`,
    );
    // 行按裸包名引用本包：client-modules 只扫裸包名条目的 dsh.client 声明。
    expect(yml, "patch 的 name 必须是本包包名（裸名，不带版本/路径）").toContain(
      `name: "${manifest.name}"`,
    );
  });

  it("client.js 只 require 平台模块（其余依赖一律内联，避免第二份实例）", async () => {
    const out = await readFile(path.join(pkgDir, "client.js"), "utf8");
    const required = requiresIn(out);
    // 平台模块由宿主 shell 提供（react 与 zod 都是 harness PLATFORM_MODULES 的成员）；再出现
    // 别的裸说明符就等于把一份依赖整包内联/外置进浏览器，符号身份与版本都不再由宿主决定。
    expect(required, "client.js 的 require 清单只允许平台模块").toStrictEqual([
      'require("react")',
      'require("zod")',
    ]);
  });
});
