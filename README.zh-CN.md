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
- `settings` 是唯一插件级硬依赖（`default.inject = ["settings"]`）；设置卡的数据面是 `lessonLoopRules` 这枚官方 Typert Remote 命名空间上的四个方法，随 apply 无条件注册（它们不依赖任何可选宿主服务，所以不需要像旧路由那样等 webServer 到位）。其余服务（`timer` / `commands` / `systemPrompt` / `llm`）可选读：缺位只让对应能力不注册，装载照跑。

### 装机验收口径

四条判据，本机对 `dsh 0.2.1-rc.2` 实测过（把 `DSH_HOME` 指到临时目录跑，别动日常那份）：

- 装完 `dsh plugin --profile web add <tarball>` 之后，profile 的 `node_modules/` 顶层只该有 `@jayyuen66/` 一枚，**不该有 `@deepseek-ai/` 目录**——那正是「宿主包被写进 `dependencies`、profile 里物化出第二份宿主类型面」的指纹，`test/publish-manifest.test.ts` 的门禁防的就是它。
- `dsh --profile web --dump-config` 末尾出现 `# == @jayyuen66/dsh-lesson-loop` 与 `- id: lesson-loop`，说明组合包层认领了这条目。
- 宿主在安装期**强制**比对 peer：`@deepseek-ai/dsh` 与每一枚 `@deepseek-ai/dsh-*` peer 都按 `semver.satisfies(运行版本, 需求, { includePrerelease: true })` 判（`dsh-app-boot/src/plugin-compatibility.ts:61-86`；`add` 的预检与装后复查在 `dsh-plugin-manager/src/operations.ts:344`、`:479`）。实测一枚把 peer 写成 `@deepseek-ai/dsh: 0.1.0` 的探针包会得到 `dsh: installation rejected: … is incompatible with dsh 0.2.1-rc.2`，随后 `dsh: restored package.json, pnpm-lock.yaml, and node_modules.` 三项回滚。`engines.dsh` 写的也是同一个值，但宿主代码里**没有它的读取方**（`@deepseek-ai/dsh-package-manifest` 只给类型，其 README 明写安装器与载入器不执行它）。
- 本包把 `dsh-*` peer **精确钉**（与同门九包同一条纪律），因此高于本下限的宿主同样判为不兼容，出路是逐条授权、且按宿主版本生效：`dsh plugin --profile web allow-version @jayyuen66/dsh-lesson-loop@<版本> --dsh-version <宿主精确版本> --accept-risk`；核对与撤销分别是 `version-exemptions` 与 `revoke-version`（三条命令均实测）。

装载侧的同一批性质由 `test/integration/host-contract.test.ts` 在真实 cordis + loader 上钉住：服务经官方 reflect 交出、兄弟条目 `inject: ["lessonLoop"]` 解析得动、装载失败的那两条路径（`Config` 非法、`settings` 缺席）都在 webServer 探针上留下「一条路由也没注册」的读数、本包条目 `Config` 非法只把自己那条 fiber 置为 FAILED 而不外溢，以及 `settings` 缺席时不进 ACTIVE。

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

设置命名空间 = profile 条目 id `lesson-loop`（运行时可改）。0.2.1-rc.2 的注册是隐式的（宿主按条目导出的 `Config` 反推命名空间与可编辑字段），一个条目只有这一段：`rules` 是它的一个 volatile 字段（用户可直接编辑），开关与阈值是同段的其余可编辑项，下面两枚部署值也落在这一段、只是不投影到卡片。旧版「开关与规则分属两段（`lesson-loop-rules`）」的隔离改由三处补回：`rules` 标了 `.loose()`（人把它改成非数组不会让整条条目装载失败）、读侧另看 `describe().user` 的原文形状（读不懂即拒写，绝不拿空库去覆写等人修的数据）、以及整段共用一枚 revision 的 CAS 重读重放。坏一条规则不会打死开关，反之亦然。四个布尔默认全为 `true`：`enabled`（总开关，关掉后不上报、不注入、不做退出清算）、`reportEnabled`（落盘与归并）、`injectEnabled`（会话开始注入）、`sectionEnabled`（常驻段）。

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

设置卡的数据面是一枚**官方 Typert Remote 命名空间** `lessonLoopRules`（`lib/rules-shape.ts`）上的四个方法。没有 `/_dsh/*` 路由、没有 CSRF token、本包也不自带 body 上限：认证、Host / DNS 重绑定 / Origin 判据与请求体上限都由宿主 `/api` 网关承担，而它只把这枚命名空间暴露给同一 profile 的客户端。

| 方法 | 入参 | 回执 |
| --- | --- | --- |
| `stats()` | — | `{ ok: true, …计数, …配置摘要, rules }`；规则投影里带着派生态 `undeterminable`，且**不带** `evidence[]` 正文 |
| `rules(request)` | `{ project? }` | `{ ok: true, rules }`；`project` 不是字符串就按缺省处理，也就是给全量库 |
| `lessons(request)` | `{ project?, limit? }` | `{ ok: true, count, lessons }`；`limit` 不是有限数、≤ 0 或缺省都是全量，内容零截断 |
| `ruleAction(request)` | `{ id, action, statement? }` | `{ ok: true, id, action }`，或 `{ ok: false, error, status }` |

- 写面只认那六个动作白名单（`arm` / `reject` / `demote` / `archive` / `edit` / `revive`），`statement` 也只由 `arm` 与 `edit` 读取——它会被 trim，空白串（空串或全空白）按「没给」处理：已存的正文原样保留。
- 拒绝回执里的 `status` 是**保留下来的语义码，不是 HTTP 状态**：缺 `id` / `action` 或动作不在白名单是 400，规则查无此条是 404，库侧拒绝落盘是 500 且文案就是 `rules-not-persisted`。卡片渲染的是 `error`，那个数字的作用是让测试钉住是哪条判据拦的；405 与 413 那一档已经没有了——方法名对不对、body 大不大都是网关的判定。
- 客户端（`src/rules-reader.ts`）持四条 descriptor，`$mount` 只做一次，然后按派生键 `remote.lessonLoopRules` 取。客户端上下文里没有 `remote` 服务时根本不构造读面，卡片退回它的 `statsUnavailable`；服务在、这枚命名空间没挂上时读面抛错——缺能力要明说，不能被渲染成「规则库是空的」。
- 读数是被拉的，不是被推的：打开面板一次、保存之后一次、每次人工动作之后一次。这里**没有轮询循环也没有客户端墙钟**——一次调用允许跑多久由网关决定，卡片再设一枚就是「写得慢的那次被判成丢了，而它其实落了」。
- `/lessons-digest [附加说明]` 这条命令把本会话的人工负反馈与该项目的近期教训一起交给模型，蒸馏出候选卡片（`origin` 为 `lessons-digest`）。
### 数据与隐私

- 派生数据只有两份：
  - `$DSH_HOME/cache/lesson-loop/events.jsonl`（cache 是「可丢弃派生数据」定位，删掉后可由会话与规则库重建）。
  - 未设 `$DSH_HOME` 时由官方 home-paths 退到用户主目录下的 `.dsh`。
  - 设置文档里 `lesson-loop` 段的 `rules` 数组（与开关同段，用户可直接编辑）。
- 一切留在本机：本包不向任何外部服务发数据，蒸馏的模型调用走宿主 `llm` 服务与当前默认模型选择。
- 事件流水里的教训 `detail` 与规则正文全量存储、零截断，可能含路径、命令行与工具输出原文，备份或清理时按敏感数据对待。
  - 规则卡的 `evidence` 是唯一例外，收敛发生在落盘那一刻：单条 `detail` 超过 400 字符（`lib/rules-layout.ts` 的 `MAX_EVIDENCE_DETAIL_CHARS`）截断并补省略号，每卡只留最近 5 条（`MAX_EVIDENCE_ENTRIES`）。`signature`（命中的具体路径或命令）、`occurrences` 与 `violation`/`suppressed`/`samples` 计数一律不动，卡片照样看得出管的是哪条命令。读侧 `cardsOfValue` 照旧全量解析、不做二次改写，所以截断一生只发生一次；存量库无需迁移，下一次写盘自然收敛。
- 规则库读写带跨进程 CAS（provider 写锁 + revision 重读重放，最多 3 次），常驻 web 实例与短命 CLI 交替写同一份不会互相抹卡。
- host 侧文案随官方 locale 偏好走（中/英，未注册即中文），已落库的规则正文是用户数据、切语言不改写。

### 常见问题

- 规则会不会自己生效？不会。只有 `arm` 把状态写成 `armed`；`rejected` 卡复发达阈值也只回到 `candidate`，`demoted` / `archived` 的复活同样是人工动作。
- 把 `reportEnabled` 关掉会怎样？`report()` 直接回 `{ ok: false, reason: "disabled" }`，既不写事件流水也不建卡（集成测试钉了这条负向路径）。
  - `/lessons-digest` 同样拒绝执行；四个读面方法与设置卡照常可用。
- 卡片上点 arm 提示失败？`rules-not-persisted` 意味着这一次没进库（端口拒写或 CAS 冲突用满），库里仍是旧状态，重试即可。
  - 若段里的 `rules` 被手改成非数组，规则面降级为「读空、写拒」（坏内容原样留着等人修，本进程一次都不写这段），同段的开关照改照生效，修好那段设置即恢复。
- 规则一直显示「不可判定」？说明机器**没有干净命中可作分母**：`suppressed` 仍为 0，且要么这条规则已静置超过 `decayDays`（锚点是它最近一次活动：arm / 最后一次复发 / 最后一次遵守），要么复发已达 `demoteThreshold` 却始终没有一次被遵守的会话。两种情况下 `violation/(violation+suppressed)` 结构上恒为 1.0，机器既不降级也不归档——保持 `armed` 由你停用或归档；出现一次 `pass` 命中即自动退出该态。
- 别的插件收不到总线？未装本包或 `ctx.provide` 不可用（后者会打一条 error 日志点破）时，上报方只丢报告，自身功能不受影响。
