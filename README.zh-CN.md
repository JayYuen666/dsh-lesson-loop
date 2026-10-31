<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/JayYuen666/dsh-lesson-loop@main/icon.svg" width="96" height="96" alt="dsh-lesson-loop logo" />
</p>

<h1 align="center">dsh-lesson-loop</h1>

<p align="center"><em>守卫拒绝、门禁失败与人工差评沉淀为项目教训；只有人工确认过的规则，才会在会话开始时注回模型。</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@jayyuen66/dsh-lesson-loop"><img src="https://img.shields.io/npm/v/@jayyuen66/dsh-lesson-loop?style=flat-square&logo=npm&logoColor=white" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@jayyuen66/dsh-lesson-loop"><img src="https://img.shields.io/npm/d18m/@jayyuen66/dsh-lesson-loop?style=flat-square" alt="npm downloads (total)" /></a>
  <a href="https://github.com/JayYuen666/dsh-lesson-loop/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/JayYuen666/dsh-lesson-loop/ci.yml?branch=main&style=flat-square&label=ci" alt="ci" /></a>
  <img src="https://img.shields.io/badge/license-MIT-4c1?style=flat-square" alt="MIT" />
  <img src="https://img.shields.io/badge/node-%3E%3D22.12-4c1?style=flat-square&logo=nodedotjs&logoColor=white" alt="node" />
  <img src="https://img.shields.io/badge/dsh-%5E0.2.1--rc.3-658EFF?style=flat-square" alt="dsh" />
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/powered_by_dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white" alt="powered by dsh" /></a>
</p>

<p align="center">
  <img src="https://skillicons.dev/icons?i=typescript,nodejs,react,vitest,githubactions" alt="tech stack" />
</p>

<p align="center">
  <a href="https://github.com/JayYuen666"><img src="https://img.shields.io/badge/GitHub-JayYuen666-181717?style=flat-square&logo=github&logoColor=white" alt="GitHub" /></a>
  <a href="mailto:cqwkkj@gmail.com"><img src="https://img.shields.io/badge/Email-cqwkkj@gmail.com-EA4335?style=flat-square&logo=gmail&logoColor=white" alt="Email" /></a>
  <a href="https://twitter.com/JayYuen666"><img src="https://img.shields.io/badge/Twitter-X%2FJayYuen666-000000?style=flat-square&logo=x&logoColor=white" alt="Twitter/X" /></a>
  <a href="./README.md"><img src="https://img.shields.io/badge/lang-English-658EFF?style=flat-square" alt="English" /></a>
</p>

**一条用于 [dsh](https://github.com/deepseek-ai/deepseek-harness) 的自进化回路：守卫插件上报到同一条教训总线，规则库由人工裁定，armed 规则注入到所属项目的每个新会话。**

## <img src="https://api.iconify.design/lucide/file-text.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 目录

- [它做什么](#它做什么)
- [安装](#安装)
- [确认它真的在工作](#确认它真的在工作)
- [它不提供什么](#它不提供什么)
- [在 dsh 里启用](#在-dsh-里启用)
- [教训总线](#教训总线)
- [设置项](#设置项)
- [对外接口](#对外接口)
- [数据与隐私](#数据与隐私)
- [已知边界](#已知边界)
- [常见问题](#常见问题)
- [开发](#开发)
- [许可](#许可)

## <img src="https://api.iconify.design/lucide/shield.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 它做什么

- **一条总线，无耦合。** 兄弟插件经可选的 `lessonLoop` 服务上报；没装本包的 profile 只是丢掉这些上报。host 半提供这个服务，client 半渲染带开关与规则评审台的 web 设置卡。
- **沉淀。** 每次上报往事件流追加一行，并按 (project, category, signature) 归并进一张候选卡；同键达到 `promoteThreshold` 时，这张卡被标为待评审。
- **机器永不升格规则。** 状态 `armed` 只可能来自人工决定——卡片上的 `arm` 动作写它，启动时的迁移只是把既有的 armed 状态搬到归并后的主卡上。`reject` / `demote` / `archive` / `edit` / `revive` 同样是人工动作。
- **提醒。** 一段与项目无关的常驻段让回路一直可见，每个根会话在 `agent/created` 时收到本项目 armed 规则的全文。子代理会话跳过。
- **零模型工具，零自有 HTTP 路由。** 卡片的数据面是官方 Typert Remote 命名空间 `lessonLoopRules`，经宿主 `/api` 网关访问。

### 规则如何判定

- 三个计数器回答三个不同的问题：`violation`（场景触发且被违反）、`suppressed`（场景触发且被遵守，由 `pass` 驱动）、`samples`（规则在场且未被违反）。
- 唯一的比值是 `violation / (violation + suppressed)`；`samples` 是暴露数，永不进分母。
- `samples` 按 durable 会话计一次：同一会话被 resume 产生的重复 disposed 边会被去重，重开不会虚增暴露数。
- 降级需要 `suppressed` 为正、`violation` 达到 `demoteThreshold`、真实证据达到 `demoteMinSamples`，且比值达到 `demoteRatio`。
- 场景一直触发却零干净命中的规则是**不可判定**：比值与衰减都退不掉它，于是它一直保持 armed，等人工处置。一次 `pass` 即清除该标记。

## <img src="https://api.iconify.design/lucide/package.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 安装

```sh
dsh plugin --profile web add @jayyuen66/dsh-lesson-loop
```

卸载用 `dsh plugin --profile web remove @jayyuen66/dsh-lesson-loop`。本包在公共 npm registry 上，所以安装不需要凭据。

- **Node.js `>= 22.12`、宿主 `dsh` 在滚动的 `^0.2.1-rc.3` 窗口上。** 插件自己的下限是 `engines.node`（`>=22.12.0`）；`0.2.2-alpha.2` 宿主自身声明的 Node 下限是 `>=24.9.0`，所以本包虽然能在 Node 22 上装，那一版宿主本身起不来。宿主读取的版本要求是 `engines.dsh`（`^0.2.1-rc.3`），而且它**单独决定**——这个字段在时，`evaluatePluginCompatibility` 从不看 `@deepseek-ai/dsh*` 这批 peer。实测：`0.2.0-rc.2` 与 `0.2.1-rc.1` 被拒，`0.2.1-rc.3` 与 `0.2.2-alpha.2` 通过，`0.3.0` 被拒。支持窗口是滚动的：本包在发布时最近的三个已发布宿主版本上逐版取证，窗口滚动后重新取证，不把这一句里的版本号当长期承诺。
- **按契约，`dependencies` 下不放任何 `@deepseek-ai/*`。** profile 以 `nodeLinker: hoisted` 与 `autoInstallPeers: false` 安装，那里放一个宿主包就会变成真实的第二份副本；`@deepseek-ai/dsh-tools` 用普通 `Symbol` 给调度器做键，于是那个 profile 里**每一次原生工具调用都抛错**，而构建、类型检查与覆盖率一直全绿。`host.js` 按值导入的四枚宿主包都是必需 peer，并在 `devDependencies` 里按同一个精确钉版再写一份，好让打包器把它们外部化，而不是内联官方函数体；`test/publish-manifest.test.ts` 把这两半都钉住。产物由 `prepack` 重建，从不提交。

### <img src="https://api.iconify.design/lucide/arrow-down-to-line.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> shared 的版本下限

如果你的 profile 用 pnpm `overrides` 把 `@jayyuen66/dsh-plugin-shared` 钉在某个版本，那个钉住的值必须不低于本包声明的版本。钉得更低就会装到一份缺少运行期所导入名字的副本，宿主起来时报 `N entries did not activate` 并附一句 `does not provide an export named ...`——包装得上、永远不加载，而任何单仓 CI 都看不见。

## <img src="https://api.iconify.design/lucide/circle-check.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 确认它真的在工作

1. **层已经进栈。** `dsh --profile web --dump-config` 末尾出现 `# == @jayyuen66/dsh-lesson-loop` 加 `- id: lesson-loop`。
   - 那条命令是唯一被接受的判据，而且它**不是只读命令**——它会重写该 profile 的根装配文件。层行要从 stdout 读，**并且**单独检查 stderr：没匹配上的 patch 目标只出现在 stderr，只看退出码证明不了任何事。两种形态都要认：`# == <layer>` 与 `# == <layer>, patched by <path>`。
2. **卡片渲染实时数据。** 它的标头带着当前的候选 / armed / 教训计数，打开后规则分组能填出内容。只出现一行「stats 不可用」说明层进了栈，但 Remote 命名空间没到浏览器；若出现的是带宿主读面说明的「stats unavailable: the host read path failed — retry」（中文界面为「读不到统计：宿主侧读面出错，请重试」），则命名空间已到，失败的是这一次读取，读面恢复后重试即可。
3. **一条教训进得了规则库。** 用装好的上报方（danger-guard、quality-gate、session-rescue）触发一次拒绝或门禁失败，或在收集到人工负反馈的会话里跑 `/lessons-digest`；候选分组就会多出证据。
4. **armed 规则回得来。** 把一张卡 arm，然后在那个项目里开一个新会话：注入的那段以 `[lesson-loop] Experience rules for this project` 开头。子代理会话按设计什么也收不到。
5. **profile 里没有宿主副本。** 临时 profile 的 `node_modules/` 里只有 `@jayyuen66/`，没有 `@deepseek-ai/` 目录。

## <img src="https://api.iconify.design/lucide/circle-slash.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 它不提供什么

- **没有模型工具。** 没有 `lesson_report` 工具；对外接口就是那个服务加上卡片的命名空间。
- **没有自有 HTTP 路由。** 认证、Host / DNS 重绑定 / Origin 判据与请求体上限都是宿主网关的。
- **没有 CLI 子命令。** 它贡献的唯一命令是会话内的 `/lessons-digest`。
- **没有自有出网请求。** 蒸馏调用走宿主 `llm` 服务。
- **没有自行重新启用的规则。** `rejected` 卡在达到 revive 阈值时可以回到 `candidate`；再次 arm 只能由人工做。

## <img src="https://api.iconify.design/lucide/plug.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 在 dsh 里启用

- `dsh.bundle.patch` 指向 `cordis.patch.yml`，其中唯一的注册行是 `- id: lesson-loop`，带 `name: "@jayyuen66/dsh-lesson-loop"`。让宿主去扫描 client 半的是**裸包名**。
- **一个条目，一份 `Config`。** 设置命名空间就是条目 id，于是开关、阈值与 `rules` 数组共用同一段、同一枚 revision。`rules` 带了 `.loose()`，读侧经 `describe().user` 检查原文形状（读不懂就拒写，而不是覆写），每次写都是一次 CAS 提交加重读重放。
- `settings` 是唯一插件级硬依赖。`timer` / `commands` / `systemPrompt` / `llm` 可选：缺一个只让对应能力消失，插件照常装载。
- 卡片的数据面在 apply fiber 上无条件安装，所以即使宿主的 web 层到得晚，它也在。
- `locale/en.json` / `locale/zh.json` 提供插件页的 `meta.title`、`meta.description` 与 `meta.detail`；详情页英文读 `docs/DETAIL.md`、中文读 `docs/DETAIL.zh.md`。README 不是那一页的来源。
- 部署默认值写在注册行的 `config:` 上（卡片值 > 行 `config` > schema 默认值）；配置不合法只让这个条目的 fiber 失败。
- 不兼容的宿主按精确版本逐条授权，绝不靠放宽范围：

```sh
dsh plugin --profile web allow-version @jayyuen66/dsh-lesson-loop@<version> --dsh-version <exact running host version> --accept-risk
```

`version-exemptions` 列出这些授权，`revoke-version` 撤销其中一条；`--dsh-version` 必须等于运行中宿主自报的版本。

## <img src="https://api.iconify.design/lucide/cable.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 教训总线

| 方法                                          | 用途                                                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `report(input)`                               | 追加一条教训并归并进该键的卡片；返回 `{ ok, reason?, violationOf?, candidate?, ready?, justReady? }` |
| `pass(input)`                                 | 规则对应的场景触发且被遵守；会话结束时计为 `suppressed`                                              |
| `rules()` / `recentLessons(project?, limit?)` | 读规则库 / 读事件流                                                                                  |
| `ruleAction(id, action, statement?)`          | 那六个人工动作                                                                                       |
| `stats()`                                     | 卡片背后的计数器与配置摘要                                                                           |

- `reason` 是 `disabled`、`rules-not-persisted`（这次改动没进规则库——重试）或 `error` 三者之一。它是回执码，不是翻译过的文案。
- `source` 是开放集：`danger-guard`、`quality-gate`、`session-rescue`、`lessons-digest` 与 `manual` 是内置的，第三方可以自报名字（trim 后非空、不超过 64 字符，否则按 `manual` 记账并留一行日志）。有两种上报值得点名：`gate-not-run` 标记一次从未跑成的检查，因为环境问题不许被学成代码教训；证据里的 `needsUserConfirmation: true` 标记上报方做不了的判断——是证据，但不是违反。
- 路径形态的类别折叠到类别级键（`edit-before-factgate`、`edit-before-secret-path`、`dangerous-bash`），于是一条通用教训不会按文件碎成几十张卡。具体目标是哪个，证据里仍看得出来：`secret-path` 与 `dangerous-bash` 落在 `signature`，`factgate-deny` 落在 `target`（它上报的签名本身就是折叠后的键）。
- 调用方应经 `@jayyuen66/dsh-plugin-shared/lib/lesson-bus` 的 `settleLessonCall`，它把同步抛错与异步拒绝归到同一个出口。

## <img src="https://api.iconify.design/lucide/sliders-horizontal.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 设置项

命名空间 = 条目 id `lesson-loop`。四个开关默认都是 `true`：`enabled`（总开关——关掉即不上报、不注入、不做退出清算、没有常驻段、周期衰减暂停，且 `/lessons-digest` 拒绝执行）、`reportEnabled`（教训**入口**闸门：只停 `report()` 与 `/lessons-digest`——pass 记账与退出清算只随 `enabled`）、`injectEnabled`、`sectionEnabled`。

| 字段                | 默认值     | 取值范围            | 作用                                                                                        |
| ------------------- | ---------- | ------------------- | ------------------------------------------------------------------------------------------- |
| `promoteThreshold`  | `3`        | 1–20                | 同键教训达到此次数即把卡片标为待评审                                                        |
| `demoteThreshold`   | `3`        | 1–50                | 升格后被违反到此次数才降级                                                                  |
| `demoteMinSamples`  | `5`        | 1–100               | 真实证据 `violation + suppressed` 的下限                                                    |
| `demoteRatio`       | `0.5`      | 0.05–1（步长 0.05） | 复发率红线                                                                                  |
| `decayDays`         | `30`       | 1–365               | armed 满这么久仍无干净命中，卡片转为不可判定；之后的复发不会重置窗口                        |
| `reviveThreshold`   | `3`        | 1–20                | 被拒的规则再见到此次数就回到候选                                                            |
| `maxLessonsBytes`   | `0`        | 0–1 GiB             | 磁盘保险丝；`0` = 不设上限，内容绝不为了省上下文被截断                                      |
| `maxStatementChars` | `4000`     | 1–100000            | arm/edit 时生效正文的字符上限（UTF-16 码元）；超限的写入被拒，已落库正文不受影响            |
| `digestTimeoutMs`   | `120000`   | ≥ 1000              | 一次蒸馏的墙钟（ms）；卡片上没有这一行                                                      |
| `decayIntervalMs`   | `86400000` | ≥ 1000              | 周期衰减轮次的间隔（ms）；卡片上没有这一行                                                  |
| `maxInjectedRules`  | `50`       | 0–1000              | 每个会话注入的 armed 规则条数；设了上限时保留最新的若干条；`0` = 不设上限；卡片上没有这一行 |

最后三行是部署值：不标 `.volatile()`，所以卡片上没有对应的行，只能在注册行的 `config:` 上给，重启后生效。

## <img src="https://api.iconify.design/lucide/network.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 对外接口

官方 Typert Remote 命名空间 `lessonLoopRules` 上的四个方法。

| 方法                  | 入参                         | 回执                                                                                                                    |
| --------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `stats()`             | —                            | `{ ok: true, …counters, …config summary, rules }`；规则投影带着派生的 `undeterminable` 标记，且**不带** `evidence` 正文 |
| `rules(request)`      | `{ project? }`               | `{ ok: true, rules }`；`project` 不是字符串就按缺省读，也就是全量规则库                                                 |
| `lessons(request)`    | `{ project?, limit? }`       | `{ ok: true, count, lessons }`；`limit` 缺省、不是有限数或 ≤ 0 时取默认 50 条，显式值封顶 500                           |
| `ruleAction(request)` | `{ id, action, statement? }` | `{ ok: true, id, action }`，或 `{ ok: false, error, status }`                                                           |

- `action` 必须是那六个白名单值之一；`statement` 只由 `arm` 与 `edit` 读取，会被 trim，空白串按「没给」处理。生效正文超过 `maxStatementChars` 时回 `{ ok: false, status: 400 }`，库不动。
- 拒绝回执里的 `status` 是**保留下来的语义码，不是 HTTP 状态**：缺字段或动作不在白名单是 400，未知的卡片是 404，规则库拒绝落盘是 500（带 `rules-not-persisted`）。
- 读方法在宿主读面失败时回 `{ ok: false, error, status: 500 }`；`error` 是本地化文案，原始异常留在宿主日志里。这里的 500 是「这次没读到」，不是请求写错了。
- 读数是拉的，不是推的：打开面板时、保存之后、每次人工动作之后各一次。这里没有轮询循环，也没有客户端墙钟。

## <img src="https://api.iconify.design/lucide/lock.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 数据与隐私

| 口径     | 内容                                                                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 写盘     | 事件流写在 `$DSH_HOME/cache/lesson-loop/events.jsonl`（可丢弃的派生数据位置）与它瞬时的 `.lock` / `.tmp` 兄弟文件，以及设置文档 `lesson-loop` 段的 `rules` 数组 |
| 网络     | 本包没有自己的网络调用。`/lessons-digest` 经宿主 `llm` 服务把本会话的人工差评与该项目的近期教训交给当前默认模型——那个模型在外网时，这些内容就出域了             |
| 保留     | 事件流完整保留 detail 与规则正文，零截断；`maxLessonsBytes` 是磁盘保险丝，不是上下文上限                                                                        |
| 证据收敛 | 规则卡的 `evidence` 是唯一例外：过长的 detail 截断并补省略号，每张卡只留最近的若干行，且只在落盘那一刻发生。`signature` 与计数器一律不裁                        |
| 并发     | 规则库写入带跨进程 CAS；事件流的追加与裁剪共用同一把锁                                                                                                          |
| 语言     | host 侧文案随官方 locale 偏好走；已落库的规则正文是用户数据，永不改写                                                                                           |

## <img src="https://api.iconify.design/lucide/triangle-alert.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 已知边界

- **没有任何东西自动升格**——一条自行 arm 的规则会把一次噪音上报变成永久指令。
- **不可判定的规则不收敛**：没有干净命中就没有分母，只有人工能退掉它，而注入上限让这一批规则不进上下文。
- **子代理会话被跳过**——再注入一次会让子代理在一批没见过的规则上被计成暴露。
- **卡片是拉取式的**，所以跨重连缓存下来的值按设计就是旧的。
- **证据正文永不过线**；卡片看到的是签名与计数器。
- **没有机器翻译**：规则正文与证据是用户数据。
- **可选服务去掉的是能力，不是插件**：没有 `commands` 就没有 `/lessons-digest`，没有 `systemPrompt` 就没有常驻段，没有 `llm` 蒸馏会拒绝，没有 `timer` 就只剩人工评审；没有 `settings` 则条目永不被激活，启动诊断会点名它。
- **一次蒸馏可以局部失败**：没进规则库的卡分开报，而回执绝不会对盘上没有的卡声称「已蒸馏」。模型输出里找不到可解析的 JSON 数组时按硬错误上报，不当成「零条候选」。

## <img src="https://api.iconify.design/lucide/circle-help.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 常见问题

| 问题                                    | 回答                                                                                                                                                                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 规则会不会自己生效？                    | 不会。只有 `arm` 写 `armed`；达到 revive 阈值只把被拒的卡送回 `candidate`。                                                                                                                                                                            |
| 把 `reportEnabled` 关掉会怎样？         | `report()` 立刻回 `{ ok: false, reason: "disabled" }`，`/lessons-digest` 同样拒绝；Remote 读面与卡片照常工作。                                                                                                                                         |
| 卡片上点 arm 报 `rules-not-persisted`。 | 这次改动没进规则库；库里仍是旧状态，重试即可。                                                                                                                                                                                                         |
| 规则一直显示「不可判定」。              | `suppressed` 仍是零，没有干净命中可作分母：规则要么静置超过 `decayDays`，要么违反已达 `demoteThreshold` 却始终没有一次被遵守的会话。违反也为零时这个比值是未定义的，不是 1.0——两种情况机器都不会替你做决定。自行停用或归档；一次 `pass` 即清除该标记。 |
| 我把 `rules` 手改成了非数组。           | 规则面降级为「读空、写拒」，本进程一次都不写那一段；开关在你修好该字段之前照常工作。                                                                                                                                                                   |
| 别的插件收不到总线。                    | 没装本包，或 `ctx.provide` 不可用（一条明确的 error）时，上报方只丢报告，自身功能不受影响。                                                                                                                                                            |

## <img src="https://api.iconify.design/lucide/wrench.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 开发

```sh
pnpm install
pnpm run check   # 类型检查 → lint → client 构建 → host 构建 → 类型 → 测试 → 格式
```

- `test/` 按「桩看不见的那类缺陷」分层：单元测试驱动存储与纯函数；`test/integration/` 驱动真实的 cordis 与 loader，于是服务交出、兄弟条目 `inject` 的解析、激活顺序与舱壁隔离都是量出来的，不是打桩模拟的。
- 两道产物门：`test/build-host.test.ts` 让跨包导入保持为外部裸说明符，`test/dist-size.test.ts` 守住体积预算，于是被内联的依赖不会悄悄过关。`test/publish-manifest.test.ts` 守住发布形态——入口目标都被 `files` 覆盖、没有源文件当入口、`dependencies` 里没有宿主包、`dsh-*` 钉版精确且统一、注释与文档里没有日期。
- 覆盖率阈值是四项指标都 100%，所以新加一个分支就要有一条能走到它的用例。

## <img src="https://api.iconify.design/lucide/scale.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 许可

MIT。源码在 [github.com/JayYuen666/dsh-lesson-loop](https://github.com/JayYuen666/dsh-lesson-loop)。问题请提到那个仓库的 issue tracker。

本包不含任何第三方源码：`host.js` 与 `client.js` 把所有跨包导入都保持为外部裸说明符。运行期依赖各自带自己的许可；[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) 记录那条产物边界以及如何复查它。
