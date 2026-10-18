# Third-party notices

本包自身编写的代码以 MIT 发布，见 [`LICENSE`](./LICENSE)。本文件记录**运行期依赖**与
**产物边界**：发布出去的 `host.js` / `client.js` 里到底有没有第三方代码，以及哪一部分第三方
内容以什么形式进入用户机器。

## 产物里没有第三方源码

这不是声明，是按产物面核对出来的结论，核对方式一并写出以便复核：

- `host.js` 由 `build-host.mjs` 产出，外部化清单取 `dependencies` ∪ `peerDependencies` 的
  **包名段**（子路径说明符也按包名段判定——rolldown 的 `external` 字符串项是精确匹配，只列包名
  会漏掉 `…/lib/record` 这类子路径）。因此产物里留下的是裸说明符而不是被复制进来的实现：
  `@deepseek-ai/schemastery`、`@deepseek-ai/dsh-brand`、`@deepseek-ai/dsh-home-paths`、
  `@jayyuen66/dsh-plugin-shared/lib/*`。`test/build-host.test.ts` 逐条断言这些说明符仍在，
  并断言官方的 `brandString` 函数体没被内联——内联即"把别人的代码打进本包产物"，那才是需要随包
  分发上游许可文本的情形。
- `client.js` 由 `build-client.mjs` 产出，`react` 显式外部化（`external: ["react"]`），产物
  按宿主注入的模块加载器取用 React，**不复制** React 代码。
- 类型面 `types/` 由 `build-types.mjs` 从本包 TS 源码 emit，只引用第三方包的**类型说明符**
  （`import type … from "@deepseek-ai/…"`），不含上游实现代码。

## 运行期依赖

运行期依赖的许可由各自包随包分发，本包不重复其文本：

| 包 | 在本包里的角色 | 为什么只能是运行期依赖 |
| --- | --- | --- |
| `@jayyuen66/dsh-plugin-shared` | 自有同门库包（`dependencies`） | 它的 apply 幂等守卫落在 `globalThis` 上，必须全进程只有那一处读写；内联进每个插件会各得一份标记 |
| `@deepseek-ai/schemastery` | 配置 schema（`peerDependencies`） | 只有宿主 fork 的 `resolve` 会把 `.volatile()` 字段包成 Volatile 引用；公共 `schemastery` 连该方法都没有 |
| `@deepseek-ai/dsh-brand` | 幻影品牌构造（`peerDependencies`） | 宿主类型面用品牌串做名义类型，构造品牌需要**真实函数值**，没有 type-only 的构造途径；降为 `devDependencies` 会被打包器内联，于是每个包各得一份官方构造函数，单例语义失效 |
| `@deepseek-ai/dsh-home-paths` | 数据落盘位置（`peerDependencies`） | `cacheFile()` 的路径解析规则必须由宿主单源提供，插件不该再实现一份 |
| `@deepseek-ai/dsh` | 宿主本体（可选 `peerDependencies`） | 只在装机时由宿主在场提供，本包不安装它 |

上表四枚 `@deepseek-ai/*` 一律**不进 `dependencies`**：消费方 profile 以 `nodeLinker: hoisted`
+ `autoInstallPeers: false` 安装，宿主包只要出现在 `dependencies` 就会在 profile 里落成真实目录，
与宿主进程已加载的那份并存。`@deepseek-ai/dsh-tools` 的 `TOOL_RUNTIME_SCHEDULER` 是普通
`Symbol`（不是 `Symbol.for`），符号身份按模块实例计算，于是宿主读副本挂出的 `ToolRuntime` 会拿到
`undefined`，整个 profile 的工具一起失效——而本包的构建、类型检查与覆盖率门禁在这之前全部照绿。
判据因此落在 `test/publish-manifest.test.ts` 的 manifest 门上，而不是运行时。

## 机制来源

本包不含来自其它项目的代码、词表或文案：蒸馏提示词的骨架、规则卡的六个动作白名单、衰减与
升/降格阈值、事件流水的熔断与归并顺序，均为本包自行编写。上游生态里与本包**协同**而非**派生**
的部分记在这里以免误读：差评信号读的是宿主 `@deepseek-ai/dsh-message-feedback` 的事件形状，
总线报告方是同门的 `@jayyuen66/dsh-danger-guard`、`@jayyuen66/dsh-quality-gate` 与
`@jayyuen66/dsh-session-rescue`——它们各自独立发布，本包只经 `ctx.get('lessonLoop')` 与被它们
可选读取的服务面打交道，不共享代码。

## 构建期与开发期依赖

`rolldown`、`vite`、`vitest`、`@vitest/coverage-v8`、`typescript`、`oxlint`、`oxfmt`、
`oxlint-tsgolint`、`eslint-plugin-sonarjs`、`react`/`@types/react*`、`@types/node` 以及全部
`@deepseek-ai/dsh-*` 类型面包都只在**本仓库的构建与检查**里使用，既不在 `dependencies`，也不会
被装进用户机器的插件目录。它们的许可文本留在各自的安装目录里，不随本包分发。
