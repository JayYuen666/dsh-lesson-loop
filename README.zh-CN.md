# @jayyuen66/dsh-lesson-loop

[English](./README.md)

### 它做什么

- dsh 的自进化闭环插件：守卫拒绝、门禁失败、异常续跑、人工差评经一条总线沉淀为项目教训与规则卡，已确认的规则在会话开始注回模型。
- Host 半 `provide` 出 `lessonLoop` 服务（其他插件经 `ctx.get("lessonLoop")` 可选读），client 半是 web 设置卡（开关 + 规则评审台，`dsh.client` 声明 `platform: web`、`immediately: true`）。
- 机器永不自动升格：候选规则只有人在卡片上 `arm` 才生效。运行期依赖只有 `@deepseek-ai/schemastery`（宿主 fork，公共 `schemastery` 没有 `.volatile()`）、`@deepseek-ai/dsh-home-paths`、`@deepseek-ai/dsh-brand`、`@jayyuen66/dsh-plugin-shared`；版本要求的**读取口只有 `peerDependencies` 一处**（见下面「装机验收口径」），`engines.dsh` 写的是同一个值但宿主代码里没有它的读取方。
  - 前三枚宿主包在产物 `host.js` 里都是**值导入**，因此声明为非 optional 的 `peerDependencies`，并在 `devDependencies` 里以同一枚精确版本再写一份给本包的编译与测试用——它们都**不进 `dependencies`**。这条不是风格偏好：消费侧 profile 的安装布局是 `nodeLinker: hoisted` 且 `autoInstallPeers: false`，宿主包一旦进了 `dependencies` 就会被落成真实目录，与宿主进程已加载的那份并存；而 `@deepseek-ai/dsh-tools` 的 `TOOL_RUNTIME_SCHEDULER` 是普通 `Symbol`（不是 `Symbol.for`），符号身份按模块实例计算，宿主 `dsh-agent-loop` 于是读到 `undefined`，每一次原生工具调用都抛 `Cannot read properties of undefined (reading 'prepare')`，整个 profile 的工具一起失效——本包的构建、类型检查与测试在这之前全部照绿。判据钉在 `test/publish-manifest.test.ts`。

### 自进化闭环的四个阶段

1. 观察与沉淀：`report()` 把教训整行追加进 `$DSH_HOME/cache/lesson-loop/events.jsonl`，同时按 (project, category, signature) 归并候选卡；同键累计到 `promoteThreshold` 次回 `ready`。
2. 升格（只有人工）：动作 `arm` / `reject`，另有 `demote` / `archive` / `edit` / `revive`；`arm` 可带改写后的正文，并把 `violation` / `suppressed` / `samples` / `recurrences` 清零重测。状态机：`candidate` → `armed` → `demoted`，旁路 `rejected` / `archived`。
3. 提醒：常驻 systemPrompt 段（名称 `lesson-loop`、order 1560，项目无关）+ `agent/created` 时把该项目 armed 规则全文经 `agent.inject` 注入根会话（子代理会话不注入）。
4. 度量与衰减：`violation` = 场景触发且被违反；`suppressed` = 场景触发且被遵守（`pass` 信号驱动）；`samples` = 在场未违反的暴露数（永不进分母）。装载时立即跑一轮衰减，此后每 `decayIntervalMs`（默认 24 小时）一轮。

### 安装

```sh
dsh plugin --profile web add @jayyuen66/dsh-lesson-loop
```

本包与运行期依赖 `@jayyuen66/dsh-plugin-shared` 都在公共 npm 上，安装侧不需要凭据；卸载用 `dsh plugin --profile web remove @jayyuen66/dsh-lesson-loop`。

### 在 dsh 里启用

- 包内 `cordis.patch.yml`（由 `package.json` 的 `dsh.bundle.patch` 指向）里的注册行是 `- id: lesson-loop` + `name: "@jayyuen66/dsh-lesson-loop"`；必须按裸包名引用，client 半才会被装载。
  - `dsh plugin --profile web add/remove` 维护这一层，`dsh --profile web --dump-config` 可验证。
- 部署默认可写在注册行的 `config:` 上，优先级为设置卡运行时值 > 行 `config` > 包内置默认，配置不合法时加载失败（响亮报错）。
- `settings` 是唯一插件级硬依赖（`default.inject = ["settings"]`）；四条 `/_dsh/lesson-loop/*` 路由另挂在 `inject(["webServer"])` 的子 fiber 上（真实宿主上 webServer 比本条目晚到位约 1 秒，只在 apply 里 `ctx.get` 读一次就永不注册）。其余服务（`timer` / `commands` / `systemPrompt` / `llm`）可选读：缺位只让对应能力不注册，装载照跑。

### 装机验收口径

四条判据，本机对 `dsh 0.2.1-alpha.2` 实测过（把 `DSH_HOME` 指到临时目录跑，别动日常那份）：

- 装完 `dsh plugin --profile web add <tarball>` 之后，profile 的 `node_modules/` 顶层只该有 `@jayyuen66/` 一枚，**不该有 `@deepseek-ai/` 目录**——那正是「宿主包被写进 `dependencies`、profile 里物化出第二份宿主类型面」的指纹，`test/publish-manifest.test.ts` 的门禁防的就是它。
- `dsh --profile web --dump-config` 末尾出现 `# == @jayyuen66/dsh-lesson-loop` 与 `- id: lesson-loop`，说明组合包层认领了这条目。
- 宿主在安装期**强制**比对 peer：`@deepseek-ai/dsh` 与每一枚 `@deepseek-ai/dsh-*` peer 都按 `semver.satisfies(运行版本, 需求, { includePrerelease: true })` 判（`dsh-app-boot/src/plugin-compatibility.ts:61-86`；`add` 的预检与装后复查在 `dsh-plugin-manager/src/operations.ts:344`、`:479`）。实测一枚把 peer 写成 `@deepseek-ai/dsh: 0.1.0` 的探针包会得到 `dsh: installation rejected: … is incompatible with dsh 0.2.1-alpha.2`，随后 `dsh: restored package.json, pnpm-lock.yaml, and node_modules.` 三项回滚。`engines.dsh` 写的也是同一个值，但宿主代码里**没有它的读取方**（`@deepseek-ai/dsh-package-manifest` 只给类型，其 README 明写安装器与载入器不执行它）。
- 本包把 `dsh-*` peer **精确钉**（与同门九包同一条纪律），因此高于本下限的宿主同样判为不兼容，出路是逐条授权、且按宿主版本生效：`dsh plugin --profile web allow-version @jayyuen66/dsh-lesson-loop@<版本> --dsh-version <宿主精确版本> --accept-risk`；核对与撤销分别是 `version-exemptions` 与 `revoke-version`（三条命令均实测）。

装载侧的同一批性质由 `test/integration/host-contract.test.ts` 在真实 cordis + loader 上钉住：服务经官方 reflect 交出、兄弟条目 `inject: ["lessonLoop"]` 解析得动、卸载时四条路由的 disposer 各自被采纳、本包条目 `Config` 非法只把自己那条 fiber 置为 FAILED 而不外溢，以及 `settings` 缺席时不进 ACTIVE。

### 总线接口（其他插件怎么上报）

- 服务方法：`report` / `pass` / `rules` / `ruleAction` / `recentLessons` / `stats`。
  - `report({ source, category, cwd, sessionId, turn, signature, detail, evidence })` 回执 `{ ok, reason?, violationOf?, candidate?, ready? }`。
  - `reason` 只有三种值：`disabled`（闸门关着）、`rules-not-persisted`（这一次没进规则库，该重试）、`error`（内部异常）。
  - 总线任何故障都不外抛，因为上报方多在守卫热路径上。
- `source` 是开放集：内置 `danger-guard` / `quality-gate` / `session-rescue` / `lessons-digest` / `manual`，第三方自报名字同样可入库与统计。
  - 自报名的约束：trim 后非空且 ≤ 64 字符，否则按 `manual` 记账并留日志。
- 宿主自带生产者：
  - danger-guard 报 `factgate-deny` / `secret-path` / `dangerous-bash`，并在取证通过时发 `pass`。
  - quality-gate 报 `gate-failure`（代码失败）与 `gate-not-run`（检查没跑成，不许被学成代码教训），签名是门禁命令串。
  - session-rescue 报 `transient-failure` / `max-tokens` / `unfinished-turn`。
- `factgate-deny` 与 `secret-path` 的签名折叠到类别级稳定键 `edit-before-factgate` / `edit-before-secret-path`，具体路径与命令留在证据的 `signature` 里。
  - 于是一条通用教训不再按文件碎成几十张卡。
  - 调用方建议经 `@jayyuen66/dsh-plugin-shared/lib/lesson-bus` 的 `settleLessonCall`，同步抛错与异步拒绝归到同一个出口。

### 设置项

设置命名空间 = profile 条目 id `lesson-loop`（运行时可改）。0.2.1-alpha.2 的注册是隐式的（宿主按条目导出的 `Config` 反推命名空间与可编辑字段），一个条目只有这一段：规则库就是它的第 12 个 volatile 字段 `rules`（用户可直接编辑），开关与阈值是同段的另外 11 项。旧版「开关与规则分属两段（`lesson-loop-rules`）」的隔离改由三处补回：`rules` 标了 `.loose()`（人把它改成非数组不会让整条条目装载失败）、读侧另看 `describe().user` 的原文形状（读不懂即拒写，绝不拿空库去覆写等人修的数据）、以及整段共用一枚 revision 的 CAS 重读重放。坏一条规则不会打死开关，反之亦然。四个布尔默认全为 `true`：`enabled`（总开关，关掉后不上报、不注入、不做退出清算）、`reportEnabled`（落盘与归并）、`injectEnabled`（会话开始注入）、`sectionEnabled`（常驻段）。

| 字段               | 默认       | 取值                    | 作用                                                    |
| ------------------ | ---------- | ----------------------- | ------------------------------------------------------- |
| `promoteThreshold` | `3`        | 1–20                    | 同键教训达此次数 → 候选卡待人工确认                     |
| `demoteThreshold`  | `3`        | 1–50                    | 降级所需的 armed 后复发次数                             |
| `demoteMinSamples` | `5`        | 1–100                   | 降级所需真实证据 `violation+suppressed` 下限            |
| `demoteRatio`      | `0.5`      | 0.05–1（步长 0.05）     | 复发率 `violation/(violation+suppressed)` 红线          |
| `decayDays`        | `30`       | 1–365                   | armed 超此天数仍无一次干净命中 → 「不可判定」（锚点是最近一次活动） |
| `reviveThreshold`  | `3`        | 1–20                    | rejected 后再现此次数 → 自动转回候选待人重审            |
| `maxLessonsBytes`  | `0`        | ≤ 1 GiB（0 = 不设上限） | 事件流水的磁盘保险丝，不为省上下文而截断内容            |
| `digestTimeoutMs`  | `120000`   | ≥ 1000                  | 一次蒸馏的墙钟（ms），无卡片行、只在注册行 `config:` 给 |
| `decayIntervalMs`  | `86400000` | ≥ 1000                  | 周期衰减的武装间隔（ms），同样无卡片行                  |

末两行是两枚部署值：刻意不标 `.volatile()` ⇒ 宿主不投影它们，设置卡上没有对应的行，只在注册行的 `config:` 上给（cordis 交进 apply 的是值而不是引用，改值随重启生效）。

### 对外接口

端点清单：

| 路由                                 | 说明                                                   |
| ------------------------------------ | ------------------------------------------------------ |
| `GET /_dsh/lesson-loop/stats`        | 下发 csrf + 配置摘要 + 计数 + 全量规则投影             |
| `GET /_dsh/lesson-loop/rules`        | 可按 `project` 过滤                                    |
| `GET /_dsh/lesson-loop/lessons`      | `project` 过滤 + `limit`，≤ 0 或缺省为全量             |
| `POST /_dsh/lesson-loop/rule-action` | `{ id, action, statement? }`，动作限于上面六个白名单值 |

- 信任闸门：四条路由 handler 体的第一条语句都是 `shared/lib/trust` 的 `guardTrust(req, res, { servingNonLoopback })`，判据依次为 Host 权威 → `sec-fetch-site` 白名单 → `Origin` 逐字比对；`servingNonLoopback` 只由 `isNonLoopbackBindHost(webServer.host)` 取（宿主 `0.2.1-alpha.2` 起 `Config.host` 是任意本机 IP 字面量、通配地址载入即拒，比 `=== "0.0.0.0"` 那种字面量恒为 false）。
  - 任一不成立 → `403` + JSON `{ ok: false, error: "untrusted host authority" | "cross-origin request rejected" }`，后一句是 `sec-fetch-site` 与 `Origin` 两条腿共用的文案。
- 写端点守卫：`x-lesson-csrf` 头须回灌 GET 下发的 token（缺或错 → 403 `invalid csrf token`），body ≤ 1 MiB（超限 413、坏流 400）。
- 状态码：方法不符 405、超限 413、JSON 不合法或缺 `id`/`action` 或动作不在白名单 400、无此卡 404、没存住 500 且 error 原样回 `rules-not-persisted`。
  - 405 不再是空体：带 `Allow` 头与 `{ ok: false, error: "GET only" }`（三条 GET 路由）或 `"POST only"`（rule-action）。
- HTTP 投影刻意去掉 `evidence[]` 正文（证据是全文，卡片按轮询取数），并补上派生态 `undeterminable`。
- 命令 `/lessons-digest [附加说明]` 把本会话人工差评与该项目近期教训交给模型蒸馏成候选卡（`origin` 为 `lessons-digest`），只能人工触发。
- 闸门关着、不在会话内、无 `llm` 服务或无模型选择都会明确拒绝。

### 数据与隐私

- 派生数据只有两份：
  - `$DSH_HOME/cache/lesson-loop/events.jsonl`（cache 是「可丢弃派生数据」定位，删掉后可由会话与规则库重建）。
  - 未设 `$DSH_HOME` 时由官方 home-paths 退到用户主目录下的 `.dsh`。
  - 设置文档里 `lesson-loop` 段的 `rules` 数组（与开关同段，用户可直接编辑）。
- 一切留在本机：本包不向任何外部服务发数据，蒸馏的模型调用走宿主 `llm` 服务与当前默认模型选择。
- 教训 `detail` 与规则正文全量存储、零截断，可能含路径、命令行与工具输出原文，备份或清理时按敏感数据对待。
- 规则库读写带跨进程 CAS（provider 写锁 + revision 重读重放，最多 3 次），常驻 web 实例与短命 CLI 交替写同一份不会互相抹卡。
- host 侧文案随官方 locale 偏好走（中/英，未注册即中文），已落库的规则正文是用户数据、切语言不改写。

### 常见问题

- 规则会不会自己生效？不会。只有 `arm` 把状态写成 `armed`；`rejected` 卡复发达阈值也只回到 `candidate`，`demoted` / `archived` 的复活同样是人工动作。
- 把 `reportEnabled` 关掉会怎样？`report()` 直接回 `{ ok: false, reason: "disabled" }`，既不写事件流水也不建卡（集成测试钉了这条负向路径）。
  - `/lessons-digest` 同样拒绝执行；读端点与设置卡照常可用。
- 卡片上点 arm 提示失败？`rules-not-persisted` 意味着这一次没进库（端口拒写或 CAS 冲突用满），库里仍是旧状态，重试即可。
  - 若段里的 `rules` 被手改成非数组，规则面降级为「读空、写拒」（坏内容原样留着等人修，本进程一次都不写这段），同段的开关照改照生效，修好那段设置即恢复。
- 规则一直显示「不可判定」？说明机器**没有干净命中可作分母**：`suppressed` 仍为 0，且要么这条规则已静置超过 `decayDays`（锚点是它最近一次活动：arm / 最后一次复发 / 最后一次遵守），要么复发已达 `demoteThreshold` 却始终没有一次被遵守的会话。两种情况下 `violation/(violation+suppressed)` 结构上恒为 1.0，机器既不降级也不归档——保持 `armed` 由你停用或归档；出现一次 `pass` 命中即自动退出该态。
- 别的插件收不到总线？未装本包或 `ctx.provide` 不可用（后者会打一条 error 日志点破）时，上报方只丢报告，自身功能不受影响。
