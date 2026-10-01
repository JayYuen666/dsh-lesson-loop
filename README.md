# @jayyuen66/dsh-lesson-loop

[中文](#中文) · [English](#english)

## 中文

### 它做什么

- dsh 的自进化闭环插件：守卫拒绝、门禁失败、异常续跑、人工差评经一条总线沉淀为项目教训与规则卡，已确认的规则在会话开始注回模型。
- Host 半 `provide` 出 `lessonLoop` 服务（其他插件经 `ctx.get("lessonLoop")` 可选读），client 半是 web 设置卡（开关 + 规则评审台，`dsh.client` 声明 `platform: web`、`immediately: true`）。
- 机器永不自动升格：候选规则只有人在卡片上 `arm` 才生效。运行期依赖只有 `@deepseek-ai/schemastery`（宿主 fork，公共 `schemastery` 没有 `.volatile()`）、`@deepseek-ai/dsh-home-paths`、`@jayyuen66/dsh-plugin-shared`；版本要求写在 `peerDependencies` 与 `engines.dsh`（同为 `>=0.2.0-rc.2`）。

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

设置命名空间 = profile 条目 id `lesson-loop`（运行时可改）。0.1.7 的注册是隐式的（宿主按条目导出的 `Config` 反推命名空间与可编辑字段），一个条目只有这一段：规则库就是它的第 12 个 volatile 字段 `rules`（用户可直接编辑），开关与阈值是同段的另外 11 项。旧版「开关与规则分属两段（`lesson-loop-rules`）」的隔离改由三处补回：`rules` 标了 `.loose()`（人把它改成非数组不会让整条条目装载失败）、读侧另看 `describe().user` 的原文形状（读不懂即拒写，绝不拿空库去覆写等人修的数据）、以及整段共用一枚 revision 的 CAS 重读重放。坏一条规则不会打死开关，反之亦然。四个布尔默认全为 `true`：`enabled`（总开关，关掉后不上报、不注入、不做退出清算）、`reportEnabled`（落盘与归并）、`injectEnabled`（会话开始注入）、`sectionEnabled`（常驻段）。

| 字段               | 默认       | 取值                    | 作用                                                    |
| ------------------ | ---------- | ----------------------- | ------------------------------------------------------- |
| `promoteThreshold` | `3`        | 1–20                    | 同键教训达此次数 → 候选卡待人工确认                     |
| `demoteThreshold`  | `3`        | 1–50                    | 降级所需的 armed 后复发次数                             |
| `demoteMinSamples` | `5`        | 1–100                   | 降级所需真实证据 `violation+suppressed` 下限            |
| `demoteRatio`      | `0.5`      | 0.05–1（步长 0.05）     | 复发率 `violation/(violation+suppressed)` 红线          |
| `decayDays`        | `30`       | 1–365                   | armed 超此天数且双零 → 标记「不可判定」                 |
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

- 信任闸门：四条路由 handler 体的第一条语句都是 `shared/lib/trust` 的 `guardTrust(req, res, { servingNonLoopback })`，判据依次为 Host 权威 → `sec-fetch-site` 白名单 → `Origin` 逐字比对；`servingNonLoopback` 只从 `webServer.host === "0.0.0.0"` 取。
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
- 规则一直显示「不可判定」？说明这条 armed 规则至今零复发、零 `pass` 命中（场景没被触发，或该类教训的上报方不发 `pass`）：既不降级也不归档，保持 `armed` 由你停用或归档。
- 别的插件收不到总线？未装本包或 `ctx.provide` 不可用（后者会打一条 error 日志点破）时，上报方只丢报告，自身功能不受影响。

## English

### What it does

- A self-evolution loop plugin for dsh: guard denials, gate failures, abnormal resumptions and human negative feedback go through one bus, sink into project lessons and rule cards, and confirmed rules get injected back into the model at session start.
- The host half `provide`s the `lessonLoop` service (other plugins read it optionally via `ctx.get("lessonLoop")`); the client half is a web settings card (switches + rule review desk, declared in `dsh.client` as `platform: web`, `immediately: true`).
- A machine never promotes a rule: a candidate takes effect only after a human presses `arm` in the card.
- Runtime dependencies are only `@deepseek-ai/schemastery` (the host's fork - public `schemastery` has no `.volatile()`), `@deepseek-ai/dsh-home-paths` and `@jayyuen66/dsh-plugin-shared`.
  - The version requirement `>=0.2.0-rc.2` is written in both `peerDependencies` and `engines.dsh`.

### The four stages of the loop

1. Observe and sink: `report()` appends the lesson as one line to `$DSH_HOME/cache/lesson-loop/events.jsonl` and merges it into a candidate card keyed by (project, category, signature); the receipt says `ready` once that key reaches `promoteThreshold` reports.
2. Promotion (human only): actions `arm` / `reject`, plus `demote` / `archive` / `edit` / `revive`; `arm` may carry a rewritten statement and zeroes `violation` / `suppressed` / `samples` / `recurrences` so the new lifecycle is measured clean. State machine: `candidate` → `armed` → `demoted`, with `rejected` / `archived` as side exits.
3. Remind: a permanent systemPrompt section (name `lesson-loop`, order 1560, project-agnostic) plus the full armed rules of that project injected into the root session via `agent.inject` on `agent/created` (subagent sessions are skipped).
4. Measure and decay: `violation` = scenario triggered and violated; `suppressed` = scenario triggered and followed (`pass`-signal driven); `samples` = exposure where the rule was present and not violated (never in a denominator). One decay pass runs at load, then every `decayIntervalMs` (24 hours by default).

### Install

```sh
dsh plugin --profile web add @jayyuen66/dsh-lesson-loop
```

Both this package and its runtime dependency `@jayyuen66/dsh-plugin-shared` are on the public npm registry, so installs need no credentials; remove it with `dsh plugin --profile web remove @jayyuen66/dsh-lesson-loop`.

### Enabling it in dsh

- The in-package `cordis.patch.yml`, pointed at by `dsh.bundle.patch` in `package.json`, carries the registration line `- id: lesson-loop` + `name: "@jayyuen66/dsh-lesson-loop"`; the bare package name is what makes the client half load.
  - `dsh plugin --profile web add/remove` maintains that layer, and `dsh --profile web --dump-config` verifies it.
- Deployment defaults may go on the registration line's `config:`; precedence is runtime value in the settings card > line `config` > built-in default, and invalid config fails the load loudly.
- `settings` is the only plugin-level hard dependency (`default.inject = ["settings"]`). Every other service (`timer` / `commands` / `systemPrompt` / `llm`) is read optionally: a missing one only skips that capability, the plugin still loads.
  - The four `/_dsh/lesson-loop/*` routes hang off an `inject(["webServer"])` child fiber - on the real host webServer arrives about a second after this entry, so a one-off `ctx.get` in apply would never register them.

### Bus interface (how other plugins report)

- Service methods: `report` / `pass` / `rules` / `ruleAction` / `recentLessons` / `stats`.
  - `report({ source, category, cwd, sessionId, turn, signature, detail, evidence })` returns `{ ok, reason?, violationOf?, candidate?, ready? }`.
  - `reason` has exactly three values: `disabled` (a switch is off), `rules-not-persisted` (this change did not reach the rule library — retry), `error` (internal failure).
  - The bus never throws outward, because its reporters sit on guard hot paths.
- `source` is an open set: `danger-guard` / `quality-gate` / `session-rescue` / `lessons-digest` / `manual` are built in, and a third-party plugin may name itself freely and still gets stored and counted.
  - Constraint on self-naming: non-empty after trim and ≤ 64 characters, otherwise it falls back to `manual` with a log line.
- Built-in producers:
  - danger-guard reports `factgate-deny` / `secret-path` / `dangerous-bash` and emits `pass` when evidence gathering succeeds.
  - quality-gate reports `gate-failure` (real code failure) and `gate-not-run` (the check never ran — an environment or policy problem that must not be learned as a code lesson), signed with the gate command string.
  - session-rescue reports `transient-failure` / `max-tokens` / `unfinished-turn`.
- Signatures of `factgate-deny` and `secret-path` fold into the category-level stable keys `edit-before-factgate` / `edit-before-secret-path`, while the concrete path or command stays in the evidence `signature`.
  - One general lesson therefore no longer shatters into dozens of per-file cards.
  - Callers should go through `settleLessonCall` from `@jayyuen66/dsh-plugin-shared/lib/lesson-bus`, which routes sync throws and async rejections to one exit.

### Settings

Settings namespace = the profile entry id `lesson-loop` (changeable at runtime). Registration is implicit under 0.1.7 - the host derives the namespace and its editable fields from the `Config` the entry exports - and one entry has exactly one section: the rule library is its 12th `.volatile()` field, `rules` (directly user-editable), while the switches and thresholds are the other 11 fields of that same section. What the old two-namespace split (`lesson-loop-rules`) used to guarantee is now recovered in three places: `rules` carries `.loose()` (a human editing it into a non-array cannot make the whole entry fail to load), the read side additionally checks the raw shape in `describe().user` (unreadable means it refuses to write rather than overwriting the data with an empty library), and the section is mutated under one shared revision with CAS re-read/replay. One broken rule never takes the switches down, and vice versa. The four booleans all default to `true`: `enabled` (master switch: no reporting, no injection, no exit settlement when off), `reportEnabled` (sink and merge), `injectEnabled` (session-start injection), `sectionEnabled` (permanent section).

| Field              | Default    | Range                  | Purpose                                                                   |
| ------------------ | ---------- | ---------------------- | ------------------------------------------------------------------------- |
| `promoteThreshold` | `3`        | 1–20                   | Same-key lessons reaching this count mark the card for human review       |
| `demoteThreshold`  | `3`        | 1–50                   | Violations after arming required to demote                                |
| `demoteMinSamples` | `5`        | 1–100                  | Minimum real evidence `violation+suppressed` required                     |
| `demoteRatio`      | `0.5`      | 0.05–1 (step 0.05)     | Recurrence ratio `violation/(violation+suppressed)` red line              |
| `decayDays`        | `30`       | 1–365                  | Armed longer than this with both counters at zero → undeterminable        |
| `reviveThreshold`  | `3`        | 1–20                   | A rejected rule seen this often returns to candidates for human re-review |
| `maxLessonsBytes`  | `0`        | ≤ 1 GiB (0 = no limit) | Disk fuse for the event stream, never to save context                     |
| `digestTimeoutMs`  | `120000`   | ≥ 1000                 | Wall clock for one digest run (ms); no card row, line `config:` only      |
| `decayIntervalMs`  | `86400000` | ≥ 1000                 | Interval arming the periodic decay pass (ms); likewise no card row        |

The last two rows are the deployment values: deliberately not `.volatile()`, so the host does not project them, the card has no row for them, and they are given only on the registration line's `config:` (cordis hands apply plain values, so a change takes effect on restart).

### Public surface

The endpoints:

| Route                                | Notes                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| `GET /_dsh/lesson-loop/stats`        | issues the csrf token plus the config summary, counters and the full rule projection |
| `GET /_dsh/lesson-loop/rules`        | filterable by `project`                                                              |
| `GET /_dsh/lesson-loop/lessons`      | `project` filter plus `limit`, ≤ 0 or absent = everything                            |
| `POST /_dsh/lesson-loop/rule-action` | `{ id, action, statement? }`, action restricted to the six whitelisted values above  |

- Trust gate: all four handlers open with `guardTrust(req, res, { servingNonLoopback })` from `shared/lib/trust`, judged as Host authority -> `sec-fetch-site` allowlist -> verbatim `Origin` comparison.
  - Any failure -> `403` plus JSON `{ ok: false, error: "untrusted host authority" | "cross-origin request rejected" }`, the second text shared by the `sec-fetch-site` and `Origin` legs; `servingNonLoopback` comes only from `webServer.host === "0.0.0.0"`.
- Write-endpoint guards: `x-lesson-csrf` must echo the token handed out by a GET (missing or wrong -> 403 `invalid csrf token`), body ≤ 1 MiB (oversized 413, unreadable stream 400).
- Status codes: wrong method 405, oversized body 413, invalid JSON / missing `id` or `action` / non-whitelisted action 400, unknown card 404, unpersisted change 500 with the error echoed as `rules-not-persisted`.
  - 405 is no longer an empty body: it carries `Allow` plus `{ ok: false, error: "GET only" }` (the three GET routes) or `"POST only"` (rule-action).
- The HTTP projection deliberately drops `evidence[]` bodies (evidence is full text and cards poll) and adds the derived `undeterminable` flag.
- The `/lessons-digest [additional note]` command sends this session's human negative feedback plus the project's recent lessons to the model and distils candidate cards (`origin` `lessons-digest`).
- It only runs when a human triggers it, and refuses loudly when a switch is off, outside a session, without the `llm` service, or without a model selection.

### Data and privacy

- Two derived-data stores only:
  - `$DSH_HOME/cache/lesson-loop/events.jsonl` — cache is the discardable derived-data location, it can be rebuilt from sessions and the rule library after deletion.
  - With `$DSH_HOME` unset the official home-paths package falls back to `.dsh` in the user's home directory.
  - The `rules` array inside the `lesson-loop` section of the settings document, which the user may edit directly.
- Everything stays on this machine: the package sends data to no external service, and the distillation call goes through the host `llm` service with the current default model selection.
- Lesson `detail` and rule statements are stored in full with zero truncation and may contain paths, command lines and raw tool output — treat them as sensitive when backing up or cleaning.
- Rule-library reads and writes carry cross-process CAS (provider write lock plus re-read/replay against the revision, at most 3 attempts), so a long-running web instance and a short-lived CLI cannot wipe each other's cards.
- Host-side wording follows the official locale preference (Chinese / English, Chinese when unregistered); stored rule statements are user data and are never rewritten by a language switch.

### FAQ

- Do rules ever enable themselves? No. Only `arm` writes status `armed`; a `rejected` card that hits the revive threshold goes back to `candidate`, and reviving `demoted` / `archived` is a human action too.
- What happens with `reportEnabled` off? `report()` returns `{ ok: false, reason: "disabled" }` immediately — no event line, no card (the integration test pins this negative path).
  - `/lessons-digest` refuses as well; the read endpoints and the settings card keep working.
- The arm button reports failure? `rules-not-persisted` means this change never reached the library (the port refused the write or CAS retries ran out); the library still holds the old state, so retry.
  - If the `rules` field is hand-edited into a non-array, the rule side degrades to "reads empty, refuses writes" (the bad content is left untouched for a human to fix, and this process never writes that section) while the switches in the same section keep working; repairing the field restores the rule side.
- A rule keeps showing "undeterminable"? That armed rule has zero violations and zero `pass` hits so far (its scenario never triggered, or its reporter does not emit `pass`): it is neither demoted nor archived, it stays armed for you to disable or archive.
- Another plugin cannot see the bus? Without this package installed, or when `ctx.provide` is unavailable (which logs one explicit error), reporters just drop their lessons and their own functionality is unaffected.
