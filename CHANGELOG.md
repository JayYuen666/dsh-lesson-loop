# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.1

本版出库两批工作，它们在同一份工作区里成型、从未分成两个发布：**（a）发布形态整改**——入口面、依赖表归属、发布流水线与门禁，都在"装出去之后"那一侧；**（b）宿主生态与工具链升到当前发布线**（`0.2.0-rc.2` → `0.2.1-alpha.2`，途经 `alpha.1` 那一步从未单独出库）。另补四类只在装机或发布之后才暴露的东西：绑定地址的取值口径、随包发布的类型声明、发布清单里的归属文档，以及真实 cordis 下的装载契约与产物体积闸门。

**总线接口、规则卡动作、判定阈值与十二项设置的默认值一律未改**——改的是"跟谁对齐"与"装出去之后对不对"。上一版 `0.1.0` 的 tarball 实测只有 `package.json`、`host.js`、`client.js`、`cordis.patch.yml`、`icon.svg`、`LICENSE`、`README.md` 七件；本版起多了 `types/` 14 份声明、`README.zh-CN.md`、`CHANGELOG.md` 与 `THIRD_PARTY_NOTICES.md`。

### Changed

- **宿主线 `@deepseek-ai/dsh-*` 从 `0.2.0-rc.2` 升到 `0.2.1-alpha.2`**，四处同值：`devDependencies`（27 枚）、`peerDependencies`（`dsh` 本体 + `dsh-brand` + `dsh-home-paths`）、`engines.dsh`（`>=0.2.1-alpha.2`）、`pnpm-workspace.yaml` 的 `overrides`（86 条同族钉）。只改 `package.json` 会被解析器静默改回去——`overrides` 钉的是整个家族，这正是它存在的理由；`test/publish-manifest.test.ts` 要求同族每一枚都与 peer 的 `dsh` 逐项相等。**cordis 半区不动**：`@deepseek-ai/cordis` `4.0.5-alpha.1`、`@deepseek-ai/cosmokit` `1.8.6-alpha.1`、`@deepseek-ai/schemastery` `3.18.5-alpha.1` 与三枚 cordis 插件就是 `dsh@0.2.1-alpha.2` 自己声明的那几枚（`~4.0.5-alpha.1` / `~3.18.5-alpha.1`），registry 上没有更新的 alpha，它们的 `latest` tag 反而指向更旧的稳定线。同批 `@deepseek-ai/dsh-invariants` 退出 `overrides`（无 alpha 发布，运行期内置插件也已移除）。

- **`@jayyuen66/dsh-plugin-shared` `^0.1.0` → `^0.1.4`**。这一枚跨了三个小版本，改变的是**依赖树的形状**：`0.1.2` 把宿主依赖抬上 alpha 线并把 `MessagesCatalog` 换成 homomorphic mapped type（各消费方那几份 `interface Messages` 此前过不了隐式索引签名这一关）；`0.1.3` 把 `dsh-tools`/`dsh-session` 等宿主包从 shared 自己的 `dependencies` 挪进 `peerDependencies`，消费方 profile（`nodeLinker: hoisted` + `autoInstallPeers: false`）不再为依赖的依赖物化出第二份宿主类型面；`0.1.4` 把那几枚 peer 钉到 `0.2.1-alpha.2`，与本包同版本，树里最后一处 `alpha.1` 需求随之清零。装完后锁文件解析出 46 个 `@deepseek-ai/*` 名字、**没有任何一个落到两个版本**，`pnpm outdated` 为空。
- **宿主包从 `dependencies` 移到 `peerDependencies`，`dependencies` 只剩 `@jayyuen66/dsh-plugin-shared`**。`@deepseek-ai/dsh-brand`、`@deepseek-ai/dsh-home-paths`、`@deepseek-ai/schemastery` 是本包产物里三枚**值导入**（品牌构造函数、home 解析、schema），运行期确实必须在场——但"在场"由宿主交付，不由本包安装：写进 `dependencies` 就会在消费方 profile 里落成真实目录，与宿主进程已加载的那份并存。分流口径以**构建产物**为准而不是源码：源码里的 `import type` 会被编译抹掉，只有 `host.js`/`client.js` 里真出现裸说明符的那些才需要运行期在场；只被类型面引用的留在 `devDependencies`。
- **入口面改为顶层自证，`publishConfig` 不再承载入口字段**。`main` 与 `exports["."]` 从 `./host.ts` 改指产物 `host.js`；原先那份正确性挂在 `publishConfig` 的入口覆盖上，而 pnpm 发布时会把它合并到顶层、npm **不**合并（打印 `Unknown publishConfig config main/exports` 并忽略）——同一个仓库换个发布器就发出一个 import 必失败的包。实测 `0.1.0` 的 tarball 里 `main` 确实是 `host.js`，说明那条正确性是**发布器行为**给的，不是清单自己给的；本版把它钉成不变式：顶层入口自己完整可解析，`publishConfig` 只留 `access` 与 `registry`。
- **`pnpm-workspace.yaml` 补齐三件套**：`autoInstallPeers: false`（可选 peer 不再被拖进安装面）、覆盖整族的 `overrides`、以及 `catalog:` 单源工具链版本。前两项是「只改 `package.json` 会被解析器改回去」这件事的解法，`test/publish-manifest.test.ts` 的版本形状门禁与之配套。
- **工具链（`catalog`）跟到发布线**：`@types/node` 26.6.3→26.6.5、`vitest` 与 `@vitest/coverage-v8` 5.0.2→5.0.3、`vite` 8.3.1→8.3.4、`rolldown` 1.2.11→1.2.13、`oxlint` 1.86.0→1.87.0、`oxfmt` 0.71.0→0.72.0、`oxlint-tsgolint` 7.0.2003→7.0.2004，以及本包暂不安装但同表的 `happy-dom` 20.14.6、`jsdom` 30.1.2（免得将来某条 `catalog:` 引用领到一枚陈年值）。`typescript` 7.0.2、`eslint-plugin-sonarjs` 4.2.2、`react`/`@types/react*` 19.3.0 已是发布线，未动。
- **README 拆成两份语言文档**：`README.md` 只留英文、`README.zh-CN.md` 承载中文，顶部互链。此前一份文件里 `## 中文` / `## English` 两段共处，npm 页面与仓库首页只能展示其中的混合体。
- **`files` 显式列全归属文档**（`README.md`、`README.zh-CN.md`、`CHANGELOG.md`、`THIRD_PARTY_NOTICES.md`、`types`）。实测 npm 只无条件附带 package.json、`README*` 与 `LICENSE*`：`CHANGELOG.md` 与 `THIRD_PARTY_NOTICES.md` 不写进 `files` 就**静默不随包分发**，npm 页面看不出任何异常。门禁改为「包根每一份 `.md` 都必须在发布面里」，不再每加一份文档补一条断言。

### Fixed

- **信任闸门的绑定地址取值口径跟着宿主走**。`host.ts` 里那枚 `servingNonLoopback` 原先等于 `webServer.host === "0.0.0.0"`，而 `@deepseek-ai/dsh-host-webserver` 从 alpha.2 起把 `Config.host` 从两值联合换成**任意本机网卡 IP 字面量**，通配地址（`0.0.0.0`、`::` 及其映射形态）在载入即被拒绝——于是那枚比较恒为 `false`：绑真实网卡的装机把自己的每一条 `Host` 权威整片拒成 `403 untrusted host authority`，LAN 上的评审台再也打不开。它是 fail-closed 的，不构成暴露，但功能就这么没了，且**类型检查、构建、覆盖率与其余信任用例一条都不红**（`host: string` 与普通串比较完全合法）。现在改由 `shared/lib/trust` 的 `isNonLoopbackBindHost(webServer.host)` 取，并补两条一放一拒的用例：本机网卡地址在场时断言该权威照常放行（把推导改回字面量比较它立刻失败，已实测），以及回环绑定时私网权威仍拒（挡住"恒为 true"这种绕过）。测试替身也补上 `host: "127.0.0.1"`——原先根本没有那一位，绑定侧的判据一次都没跑过。
- **注释里的官方声明行号引用逐条对表 alpha.2，修正 20 处**。本包的镜像类型处处以 `installed <声明文件>:<行号>` 指认官方出处，而 alpha.2 挪动了 `dsh-host-webserver`（`WebServer` 类 :67→:119、`register` :90→:157）、`dsh-system-prompt`（`SystemPrompt` :226→:234）、`dsh-session`（`Session` :101→:135、`header` :115→:150、`snapshotEvents` :186→:218-224）、`dsh-llm`（`RequestMessage` :464→:475、`StreamChunk` :406-436→:417-447）与 `dsh-client-ui-plugin-manager` 的行位。核对脚本按「引用点 → 装好的那份声明里该行的实际内容」逐条打印比对，46 处可解析引用现在全部指在对的位置上；其中若干条**升级前就已失效**（它们对不上 alpha.1，指更早的宿主构建），本轮一并归位。这类引用错了不报错，只会把后来人引到一段无关声明上。
- 两份 README 里"版本要求写在 `peerDependencies` 与 `engines.dsh`"的说法与实测不符：宿主安装期用 `semver.satisfies(运行版本, 需求, {includePrerelease: true})` 逐条比对 `@deepseek-ai/dsh` 与每一枚 `@deepseek-ai/dsh-*` **peer**（`dsh-app-boot/src/plugin-compatibility.ts:61-86`，`add` 预检与装后复查在 `dsh-plugin-manager/src/operations.ts:344`、`:479`），而 `engines.dsh` 在宿主代码里**没有任何读取方**（`@deepseek-ai/dsh-package-manifest` 只声明类型，其 README 明写安装器与载入器不执行它）。同一段还补上一条推论：本包的 `dsh-*` peer 是精确钉的，所以**高于**本下限的宿主同样判为不兼容，出路是按宿主版本逐条 `allow-version … --accept-risk`。
- 集成测试里两处失效口径：`bus-boot.test.ts` 头部写着 cordis/loader "4.0.3 / 1.0.3"（实际随宿主线走的那两枚已是 `4.0.5-alpha.1` / `1.0.6-alpha.1`；注释里的版本号是给后来人指错地方的东西，这里直接去掉数字，改为"本包 devDependencies 里的那对"）；以及"翻开关会重挂载条目、旧句柄随旧 fiber 作废"——这份 loader 对**全为 volatile** 的 config 变化走 `_commitVolatile` 就地提交，实测翻完开关后 `entry.fiber` 与 `ctx.get("lessonLoop")` 都是同一枚对象，拿着翻转前的句柄读到的就是新值。这条性质现在不再写在注释里，而由用例断言。

### Added

- **`test/publish-manifest.test.ts`：把"构建与单测全绿、装出去却坏"这一类坑钉成 manifest 门禁**。入口面四条（`files` 覆盖全部入口目标、入口不指源码、`publishConfig` 只留可见性与源、`@deepseek-ai/*` 一律不进 `dependencies`）+ 版本形状三条（`dsh-*` 精确钉、同族与 peer 的 `dsh` 逐项相等、peer 缺失即红）+ 注释卫生一条（注释与文档里不写日期）。判据落在 manifest 而不是运行时，是因为那三类故障的真实形状是**本包一切照绿、宿主瘫痪**：`dsh-tools` 的 `TOOL_RUNTIME_SCHEDULER` 是普通 `Symbol`，符号身份按模块实例计算，第二份实例只会让每次原生工具调用抛 `Cannot read properties of undefined (reading 'prepare')`。本版在其上又加了五条：包根每一份 `.md` 都在发布面内、声明入口存在且 `types/` 有产出、声明不比源码旧、声明不含构建机路径、声明不残留指向源码的相对说明符。
- **类型声明随包发布**（本包此前最实在的一处缺口）。新增 `tsconfig.types.json` 与 `build-types.mjs`，产出 `types/host.d.ts` 与 `types/lib/*.d.ts` 共 14 份；`package.json` 加 `types` 字段，`.` 入口导出改为同时带 `types` 与 `default` 条件。`exports` 把入口暴露成可 import 却没有任何声明，消费方在 `strict` 下拿到的是 TS7016，而这条故障**没有运行期信号**（宿主按包名载入不需要类型）。`build-types.mjs` 在出声明前清空 `types/`（tsc 自己不清 `outDir`，删掉的源文件其旧声明会留在原地，而 `files` 里 `types` 是整目录），并把声明里 `./lib/x.ts` 这种源码后缀改写成 `./lib/x.js`——tsc 会原样抄它，而包里没有 `lib/x.ts`。`build:types` 已接进 `check` 与 `prepack`，配四条门禁：入口存在且 `types/` 有产出、声明不比源码旧、声明不含构建机路径（判据以引号为锚，否则会把 JSDoc 里"macOS `/tmp` ↔ `/private/tmp` 软链"那句事实说明误杀）、相对说明符不残留 `.ts`。
- **`THIRD_PARTY_NOTICES.md`**：记录产物边界（`host.js`/`client.js` 里第三方代码一律以裸说明符外部化、React 亦外部化，故不随包分发上游实现）、四枚宿主级运行期依赖各自"为什么只能是运行期依赖"的理由，以及本包不含第三方派生代码这一结论的核对方式。
- **一条产物可链接性守卫**（`test/build-host.test.ts`）。类型检查只读 `.d.ts`，`import()` 才证明运行时那份模块真有这些出口——ESM 在 link 阶段就校验具名导出。
- **一条 `plugin:` 记录不污染蒸馏输入的用例**（`test/digest.test.ts`）。alpha.2 给插件开了 `appendPluginRecord`/`pluginRecordOf` 这条 ignorable 记录通道，且 V3→V4 的格式边会把未知可忽略事件统一改名进 `plugin:` 命名空间——本包经 `observeSession()` 读到的事件流从此一定混有读不懂的条目。本包按精确类型分派、未知类型无副作用这件事此前只是隐含性质，现在载荷长得像差评的记录被直接喂进扫描器也断言不出东西。
- **真实 cordis 装载契约测试 `test/integration/host-contract.test.ts`（七条）**：此前本包所有宿主交互都由手搓 mock ctx 承担，有四件事在结构上就盖不住——服务是否真经官方 reflect 交出（而不只是 `ctx.provide` 被调用过）、兄弟插件声明 `inject: ["lessonLoop"]` 时依赖图解析不解析得动、注入子 fiber 交回的 disposer 形状被不被 cordis 采纳（不采纳就是卸载后路由撤不掉、热重载一次多一套 handler），以及装载失败是不是舱壁内的失败。现在这四点各有一条断言，另加"合法 config 的反向对照"与"`settings` 缺席时不进 ACTIVE"。顺带记下一个 d.ts 与实现的出入：`Fiber.dispose` 声明为 `() => Promise<void>`，实测交回 `undefined`，故卸载按返回值是不是 thenable 决定要不要 await。
- **两条舱壁用例进 `bus-boot.test.ts`**：本包条目 `Config` 非法（`decayIntervalMs: 500`，官方约束 `natural().min(1000)`）时，该 fiber 停在 `FAILED`、总线不 provide、`cache/lesson-loop` 不创建，而同桌的兄弟条目照样 `ACTIVE` 且服务可调；反向对照喂合法值，两条 fiber 都 `ACTIVE`。
- **产物体积闸门 `test/dist-size.test.ts`（三条预算）**：挡两类不会让任何行为用例变红的回退——切面里塞大查表/字面量，以及外部化清单漏一枚包导致整包内联（`build-host.test.ts` 那两条断言判的是说明符字符串还在，翻倍本身不触发它们）。预算取实测值上浮约 25%。产物保持不 minify：压缩后 `from "@jayyuen66/dsh-plugin-shared/lib/record"` 这类说明符字符串会从产物里消失，外部化断言随之恒绿。
- **发布流水线加固**（照同门 `dsh-danger-guard` 的口径）：`concurrency.group: publish` 挡住两次 dispatch 并行跑同一份 check+publish；三枚 action 改按 commit SHA 引用（tag 被动就等于本仓换构建器）；token 形态校验只报"有没有杂质"、不再打印长度（CI 日志长期留存，字符数是关于凭据本身的信息）；registry 预检加**本包自身**那一读（只查依赖的话，"版本号没进 main 就触发 workflow"这个最常见的失败模式预检发现不了，只能等 publish 自己以版本冲突收尾）；publish 注入的是与预检同款清洗过的 token（预检剔 `\r\n` 与空白，裸 secret 尾部一个换行就会造成"whoami 通过、publish 401"），并加 `--provenance`（`id-token: write` 就是给它用的）与 `--publish-wait-timeout 600000`（等 registry 真正放出该版本并对 tarball 回 HEAD，"发出去了但装不上"在 workflow 里就红）。
- **两份 README 的「装机验收口径」**：四条判据 + 一条装载侧口径，全部本机对 `dsh 0.2.1-alpha.2` 实测——`DSH_HOME` 指临时目录装 tarball，profile 的 `node_modules/` 只有 `@jayyuen66/` 一层、无 `@deepseek-ai/` 目录（第二份宿主实例的指纹）；`--dump-config` 末尾认领 `- id: lesson-loop`；一枚把 peer 写成 `@deepseek-ai/dsh: 0.1.0` 的探针包被 `dsh: installation rejected` 拒绝并回滚 `package.json`/`pnpm-lock.yaml`/`node_modules`（回滚以加装前后的 diff 为空核对）；`allow-version` / `version-exemptions` / `revoke-version` 三条命令均跑通。
- **`CHANGELOG.md`**，并按上面的口径写进 `files`。

### Not changed, deliberately

- **不采用官方新的会话插件记录（`appendPluginRecord` / `pluginRecordOf`）来承载本包状态**。四条理由，逐条都是硬条件：本包没有"随会话走"的状态可搬——事件流水是一份全局 `cache/events.jsonl`（按官方定位正是可丢弃的派生数据，丢了能由会话与规则库重建），规则卡与升/降格计数在设置命名空间的 `rules` 数组里带 CAS revision，两者都不是会话级的；写入需要活 `Session` 实例，而本包的读面刻意只经 `ctx.sessionQuery.observeSession()` 拿事件切片，把 `sessions` 写进插件级 `inject` 会让没装那个 bundle 的 profile 整条功能下线（同门 `dsh-danger-guard` 记过同一条纪律）；官方把可调用者限定在 `packages/experimental/` 的生产源（`verify-plugin-record-callers` 门禁），包外插件不在被许可的调用面内；且官方明说格式迁移对记录只是 best-effort 保留，而"违规/抑制"计数一旦静默丢失就会把规则卡的判定基础抽掉——那正是 `@deprecated snapshotEvents` 之外另一处"官方不保证"的地方。读侧则按上面的新增用例处理。
- **不跟进 `dsh-danger-guard` 的 `effectiveCwdOf()`（活目录搬到 `ctx.workingDirectory`）**。那一包需要它是因为判据把工具调用的相对路径按当前目录解析（会话 `cd` 之后密钥路径会按创建期目录判，该拦的拦不住）；本包读 `header.cwd` 只为**项目桶归因**，"这场会话属于它起步时那个工程"恰恰是想要的语义，而全包没有任何一处按 cwd 解析相对路径的判定（`lib/lesson-store.ts` 的键归一另有 `path.resolve` + `realpath` 口径，与 cwd 无关）。没有缺陷就不引入服务依赖。
- **不放宽精确钉**。`dsh-*` 与 cordis 半区继续逐位钉死；registry 的 `dist-tag` 是实测过的陷阱，`latest` 可能指向远早于当前宿主 ABI 的版本。
- **不改总线契约、规则卡动作面与任何阈值默认值**。`lessonLoop` 的 `report`/`arm`/`observe` 形状、六个动作白名单、`promoteThreshold`/`demoteThreshold`/`decayDays` 等十二项设置的默认值一律未动，同门三包（danger-guard / quality-gate / session-rescue）经 `ctx.get("lessonLoop")` 的调用面因此不受本版影响。

## 0.1.0

作用域与发布源迁移，版本号与同门九包对齐。**判定逻辑与运行期行为未改**。

### Changed

- 包作用域 `@jayyuen666/` → `@jayyuen66/`，发布源迁到公共 npm（安装侧不再需要凭据；`@jayyuen66:registry` 在 `.npmrc` 里显式钉住，且不放 `_authToken`——pnpm 不展开 `.npmrc` 里的环境变量占位，那行会被整个丢掉）。
- 版本号从 `1.0.0` 定为 `0.1.0`：发布凭据改走 workflow 的 `NODE_AUTH_TOKEN`（`setup-node` 配了 `registry-url` 后会把自己那份 `.npmrc` 指给 npm，`$HOME/.npmrc` 被完全忽略，所以 token 必须以环境变量注入而不是写文件）。

### Fixed

- locale 消息字典按命名空间缓存，不再每次取用都重建；蒸馏超时取值处重复的 `max-tokens` 判定合并为一处。
