# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.5

这一版统一到伞工作区的构建与门禁基线，并修掉规则库、会话清算与蒸馏解析里几处会静默算错或静默丢数据的面；两份 README 按模板重写。条目与注入文案的对外形状未改。

### Changed

- **宿主线抬到 `0.2.1-rc.3`**：`engines.dsh`、peer/dev 依赖、`pnpm-workspace.yaml` 的 overrides 与 README 徽标/正文同值；shared 下限随根真源投影。
- **不可判定窗口锚定在 `armedAt`（回退 `createdAt`）**：最近一次复发不再重置窗口。旧写法会让一条零星复发、却从未被遵守的规则永远到不了「挂满」——既降不了级，也判不成不可判定，只能一直 armed。
- **候选升格提示改为边沿触发**：只在刚越过门槛的那一回报一次，不再每次上报都重复同一句。
- **蒸馏墙钟只约束模型流**：解析与落库不再被算进模型超时；`reasoningEffort` 原样透传。
- **构建脚本薄化**：host/client/types 的编排统一走 shared 的 `lib/build-*`，产物仍落 `dist/`；CI/CodeQL/Scorecard/Dependabot 与 Windows 矩阵补齐。
- **两份 README 按伞工作区的 README 模板重写**。顺序改成「这是什么 → 怎么装 → 怎么确认真在工作 → 它做什么 → 怎么调 → 对外接口 → 数据与隐私 → 已知边界 → 疑难 → 开发 → 许可」，读者不必再从全文里拼出安装路径；补齐头部视觉层（logo、徽章行、技术栈图标、个人与语言链接）与目录节；逐节的正文都比旧稿短（旧稿把同一件事在两三个小节里各说一遍），总篇幅与旧稿持平——按模板补出了「确认它真的在工作」「已知边界」「开发」「许可」四节，另加头部视觉层。设置表补上此前两份文档都漏掉的 `maxInjectedRules`（默认 50、0–1000、`0` = 不设上限），并把「两枚部署值」改正为三枚。
- **新增「教训总线」一节**，把 `report` / `pass` / `rules` / `recentLessons` / `ruleAction` / `stats` 六个方法、回执里的三种 `reason`、开放来源集与自报名的长度约束、以及签名折叠到类别级稳定键这件事集中在一处。此前这些散在四节里，接入方要读完两份文档才拼得出来。

### Fixed

- **会话清算按 durable 会话去重**：`session/disposed` 是每条 store 条目生命周期各发一次，同一会话每 resume 一次就多一条边，旧实现把 `samples` 数成了「重开过几次」。现在首次清算才记账，退出清算与 disposed 两条入口共用同一判据。
- **归并碎片不复活人工否决**：主卡处于 rejected/archived/demoted 时只合并度量，不再把状态改回候选；`needsUserConfirmation` 上报只补证据，不计复发。
- **蒸馏解析逐切片回退并按类别白名单过滤**：输出里找不到任何可解析的 JSON 数组时按硬错误上报，不再冒充「蒸馏出 0 条」；单条落库失败记 `dropped`，其余候选择常入库。
- **JSONL 锁改成带持有者令牌、陈旧锁原子接管、临时文件唯一命名、追加后自查补写**：并发追加不再被裁剪的 rename 静默抹掉；流水读失败会告警一次，不再与空库同形。
- **规则库 revision 非法或解析值不是数组时判不可用**：不再拿空库回写；缺 `id` 的行被丢弃时会记日志。
- **归档汇总正文改为类别无关模板**：不再把 `:rejected` 签名当成路径或命令嵌入。
- **未知 rating 的差评不再清空已有差评**；会话备注按内容指纹去重。
- **注入定界按 CR/LS/PS 切行**，防止一条草稿伪造规则条目。
- **保存期间配置行冻结，成功后只清本次真正写下的键**：在途期间的新改动留在待保存面；Remote 挂载失败不再缓存，卡片可自行恢复。
- **插件关闭时系统提示常驻段一并停用**：`enabled=false` 的承诺与 `sectionEnabled` 同一条判据。
- **两份 README 的宿主版本校验口径与宿主实现相反**。原文写「宿主安装期强制逐条比对 `@deepseek-ai/dsh*` peer，`engines.dsh` 在宿主代码里没有读取方」。实测 `evaluatePluginCompatibility` 的行为是：**存在 `engines.dsh` 时它单独决定、完全不读 peer**，只有缺 `engines.dsh` 才逐条比 peer。本包两者都有，所以那句结论对本包不成立。现在按实测重写：版本门槛来自 `engines.dsh`（本版最终声明为 `^0.2.1-rc.3`），peer 的精确钉改述为编译期纪律，两条不再混为一谈。
- **装机验收的判据改成读者可观察的结果**。原文把「peer 被强制比对」写进验收步骤里，而那是宿主机制不是可观察结果；现在五条分别是层行、卡片实时数据、一条教训真的进库、armed 规则真的注回会话，以及「profile 里没有 `@deepseek-ai/` 目录」这条宿主包漏进 `dependencies` 的指纹。
- **数据与隐私一节按代码重述**。原文说证据「全文落盘、零截断」，与 `lib/rules-layout.ts` 的写侧收敛（单条 `detail` 上限、每卡只留最近几条）不符——那句现在只描述事件流水与规则正文，规则卡证据另起一行写明收敛上限、`signature` 与计数器不受影响、以及收敛只发生在写侧。
- **注入条数上限与「不可判定」两条边界原来互相矛盾**：一处说 armed 规则全文注入不设上限，另一处说零干净命中的卡永不自动收敛。现在写明两者是同一件事的两面——正文仍全文注入，收紧的是条数，而收紧的理由正是不可判定卡没有自动收敛路径。
- **四处证据面口径按代码改正**。①「具体路径或命令留在证据的 signature」只对 `secret-path` 与 `dangerous-bash` 成立：`factgate-deny` 上报的签名本身就是折叠后的稳定键，路径落在证据的 `target` 里。②「不可判定时复发率恒为 1.0」错一格：违反也为零时那是 0/0，未定义而不是 1.0。③写入落点补上事件流旁边瞬时的 `.lock` / `.tmp` 兄弟文件，以及 `arm` 连衰减锚点一起清空这件事。④报告回执的形状补上 `justReady`，它此前只说 `ready`。

### Added

- 新增四条本地化错误文案：输出无法解析、蒸馏超时、墙钟非法、规则库拒写。

## 0.1.4

### Fixed

- **jsonl 保险丝补上乐观并发控制**：rename 前先确认读完之后没有人追加过，有人追加就放弃本轮裁剪；锁的四条降级路径一并补齐。此前该层只被 `lesson-store` 间接覆盖，「并发追加不许被裁剪的 rename 抹掉」这条不变式没有自己的判据，现在单独成文件钉住。
- **归并键与签名归一收口**：rejected 卡复发转回候选时不再覆盖累计观测数（旧写法 `occurrences = recurrences` 会让卡片上的「观察 N 次」凭空变小）。
- **草稿与注入段的取数口径对齐**：`prompt` / `digest` 读同一份草稿状态；消息表补新词条。

## 0.1.3-rc

本版只出库一处修复：规则库落盘前的证据收敛。总线接口、规则卡动作、判定阈值与十二项设置的默认值一律未改。

### Fixed

- **证据逐字落盘把 patch 文档撑到上千行**。规则库整份存在 profile 的 patch 文档里，`evidence` 是其中唯一会无界增长的部分：每次命中追加一条逐字 `detail`，而 gate 失败与 lint 报错本身就是整段输出（实测一份 940 行的 patch 里绝大部分是这些转储）。现在 `lib/rules-layout.ts` 的 `capEvidence` 在**写这一刻**收敛——单条 `detail` 超过 `MAX_EVIDENCE_DETAIL_CHARS`（400）截断并补省略号，每卡只留最近 `MAX_EVIDENCE_ENTRIES`（5）条；`signature`（命中的原始路径/命令）与 `occurrences`、`violation`/`suppressed`/`samples` 度量原样保留，人审判"这张卡管的是哪条命令"不受影响。收敛只放在写侧、读侧 `cardsOfValue` 照旧全量解析不做二次改写，于是"盘上存的"与"读出来的"仍是同一份事实，截断一生只发生一次；存量库不需要迁移，下一次写盘自然收敛。`test/lesson-store.test.ts` 新增用例钉住保留条数、丢的是最旧几条、截断后长度（上限 + 一枚省略号）与不改入参。
- **两份 README 的「全量存储、零截断」口径收窄**：那句此前对规则库同样成立，现在只描述事件流水的 `detail` 与规则正文；规则卡的 `evidence` 另起一条写明落盘收敛（上限、保留条数、`signature` 与度量不受影响）。HTTP 投影那句的「证据是全文」也按上限重述。

## 0.1.2

### Fixed

- **开机迁移在真实宿主上曾经静默空转**。`startBootMigrations` 在 `apply()` 内同步读规则库，而宿主 `settings.describe()` 只投影 `entry.fiber.state === ACTIVE` 的条目、`apply` 又跑在自己那条 fiber 变 ACTIVE **之前**（harness `packages/settings/settings/src/index.ts:305-306` 与 `:665-672`）——那一刻读到的 describe() 是空的，规则库端口判「不可用」，`commit` 不写，于是存量碎片归并（`migrateFragmentRules`）与 project 键归一（`migrateProjectKeys`）**一次都不执行**，日志一声不响。现在迁移先 `fiber.await()` 等本条目 settle 再读（装载失败即收手）；`isHostCtx` 契约守卫同步核验 `fiber.await` 这一位。新增集成测试 `test/integration/activation-order.test.ts`：假件按 harness 真实语义门控 describe()（非 ACTIVE 不投影），并断言"每一次规则库读取都发生在 ACTIVE 之后"——修复前那条断言会红。
- **事件流水尾部的半行会吞掉下一条教训**。`appendJsonl` 无条件追加，文件尾若不是换行（崩溃、ENOSPC 半写、外部编辑留下的残行），新记录会与残行拼成**一条**坏行被读侧整条丢弃，而 `report()` 仍回 `ok:true`。现在追加前先补一个换行（残行字节保留在盘上，读侧如实报坏行）；坏行 warn 改为"计数变化时才报"（`/stats` 每轮全量读不再刷屏）。
- **`/lessons-digest` 曾谎报已蒸馏**。`addCandidate` 丢弃 `commit` 的落盘结果，CAS 冲突耗尽或端口拒写时仍回显"已蒸馏 N 条候选规则"，而规则库里一张卡都没有。现在回执带 `persisted`，命令把未落盘的那批单独报成 `digestPartialFailure`（error 回执）并提示重试。
- **收尾清算与周期衰减不再把计划当事实报**。`sessionEnded` 在写失败时不再打 "session settled"（改打一条 error 点名没存住、下次会话收尾重试），`runDecay` 只在**真的写进库**后才报 `demoted` 计数（写失败时报 0 并点明"规则仍是 armed"）。
- **revive 不再抹小累计观察数**：rejected 卡转回候选时把复发次数**并入** `occurrences`（旧实现写 `occurrences = recurrences`，卡片上的"观察 N 次"会凭空变小）。
- **project 键撞车合并会丢掉生命周期度量**：两张 armed 卡撞同键时，被并那张的 `violation`/`suppressed`/`samples` 现在累加进主卡（三个时间戳取较晚者，衰减锚点不被拉早）——旧实现只折叠观察类字段，等于把一条规则真实被测到的证据抹掉。
- **卡片保存改为一次原子提交**：改用官方 `ConfigForm.mutate(ops, revision)`（一次校验、一次 CAS、一次落盘），并消费受理位——被拒时报错并**保留草稿**（旧实现逐字段写、忽略受理位、无条件清草稿，中途失败会留下改了一半的库，用户却以为全保存成功）。
- **卡片不再把解析异常原文贴给用户**：`/stats` 回包不是 JSON 时（路由未注册，SPA fallback 回一页 HTML）显示本地化兜底文案，原文只进 console。
- **数字输入不再与模型长期分叉**：越界/非数草稿在失焦时纠回模型值（此前输入框会永久显示一个从未被接受的数）。
- **未知规则状态不再被塞进默认折叠的分组**：状态漂移兜成 `unknown` 并与候选同列可见、原文状态串显形、不给动作按钮（旧实现归 `archived`，宿主要新增合法状态时用户会完全看不到那张卡）。
- **卡片字段分组一次遍历**（旧实现对同一份规则数组做四次 filter，规则库一大就是 4N 次比较 × 每次渲染）。
- **卡片声明挂在 `configForms.whileServed` 上**：宿主没投影本命名空间时页面不再出现一张全只读、stats 也拉不到的空卡（官方首方口径同款）；`apply` 增加按 ctx 的幂等守卫（重复 apply 会让官方 locale 对同名 `(ns, locale)` 抛错，整条 client fiber 变 FAILED）。
- **文档口径对齐代码**：两份 README 的「不可判定」说明改为与 `decay-policy.ts` 一致——`suppressed` 为 0 且（静置超过 `decayDays`，锚点为最近一次活动）或（复发已达 `demoteThreshold`）即不可判定，而不是"两个计数器都为 0"，并写明出现一次 `pass` 即退出该态。
- **事件流水的裁剪会覆盖并发追加的那一行**。裁剪是"读整份 → 按行裁尾 → 写回"，另一进程在「读完之后、写回之前」追加的记录被整段覆盖掉（事件静默消失，而 `report()` 仍回 `ok`）。现在 `lib/jsonl-fuse.ts` 把裁剪与追加放进**同一把跨进程排他锁**：`.lock` 兄弟文件以 `wx`（O_CREAT|O_EXCL）原子占位，`mtime` 超过 10s 视为持有者已死、可接管，**拿不到锁仍追加、只跳过裁剪**（宁可这轮不裁，绝不丢事件）；整文件重写改走 `.tmp` + 原子 `rename`，读者要么见旧全文、要么见新全文。取舍：每条追加多两次同步 fs 调用；崩溃时可能留下 `.lock`/`.tmp` 两个兄弟文件（前者靠陈旧接管回收，后者是覆盖写、下一轮裁剪自然复用）。
- **locale 偏好未注册时，host 的回显文案不再一律中文**：四条路由里只有 `rule-action` 产人读文案，现在按请求的 `Accept-Language` 协商（`lib/messages.ts` 新增 `localeFromAcceptLanguage`：q 值降序 + 主语言子标签；`*`/表外语言/坏 q 值/空串判不出 → 中文缺省）。官方 locale 条目在场时设置优先，请求头不参与；注入段与起草正文没有请求可依，仍走设置偏好。
- **卡片字段的三处口径修正**：规则卡补渲染 `signature`（投影一直带着它，卡面此前只显示正文，人审时判不出"管的是哪条命令/路径"）；所有按钮补 `type="button"`（将来被套进 `<form>` 时不会默认变成 submit）；`lessonsCount` 与规则字段改走**同一数值容忍度**（数字或**非空**数字字符串），`numericOf` 不再把空白串读成 `0`（`Number("  ")` 是 0，收下等于把"字段缺失"虚报成"计数为 0"）。

### Changed

- **client 分组懒渲染**：每组默认只画 20 条 + 「加载更多」（每组各记已展开条数，组间互不影响），标题与副标题的计数仍按全量——规则库不设条数上限，展开时不再一次渲染上千张卡。不做完整虚拟化：折叠面板不是长列表，滚动容器/测量/回收那套复杂度换不来对应收益。
- **`build-client.mjs` 的 `external` 对齐官方 client 基线**：从硬编码 `["react"]` 改为官方 `PLATFORM_MODULES` 九枚（外壳预置的冻结模块表）∪ 本包 `dsh.client.external`（现无声明），并在测试里逐条钉住——基座里的模块必须保持外部引用，内联一份副本就是同一个模块两份身份（宿主只认模块表那一条）。
- 注释里反复出现的「0.1.7」统一改成现装版本 `0.2.1-alpha.2`：它是 harness 的旧版本号，留着容易被读成本包版本（本包是 `0.1.x` 线）。

### Added

- `test/integration/activation-order.test.ts`：真实 cordis + Loader 下的**装载时序契约**（见上）。
- `test/integration/http-routes.test.ts`：四条 `/_dsh/lesson-loop/*` 路由的**真实 HTTP 契约**——真 `@deepseek-ai/dsh-host-webserver`（127.0.0.1:0）+ 真 `node:http` 请求，覆盖 `kind: "exact"`（子路径不被吃掉）、405 的 `Allow`、缺/错 csrf 的 403、413（含 content-length 与流式两条路径）、以及信任闸门三判据在真请求上的落点。
- `test/client-data.test.ts`：client 半的**数据面**契约（此前零覆盖）——`/stats` 拉取与错误呈现、rule-action 的 csrf 与回执、原子保存（ops/revision/受理位）、越界输入纠偏、未知状态可见性；测试侧带一个最小的有状态 hook 运行时（setter 身份跨渲染稳定，否则 effect 会与 setState 自激）。
- `test/publish-manifest.test.ts` 新增五条发布面门禁：`dsh.client` 必须伴随 `./client` export 且在发布面内、`dsh.bundle.patch` 指向存在且随包发布的文件、patch 的裸条目 id 与包名必须与代码里的 settings 命名空间同源、client 与 host 两半的端点/请求头常量一致、`client.js` 的 `require` 清单只允许平台模块。
- `test/host.test.ts`：`/lessons-digest` 的"部分失败"回执用例、装载失败（`fiber.await` 重抛）时迁移整条收手的用例。
- `test/lesson-store.test.ts`：残尾保护、空文件追加、坏行 warn 去重、落盘失败不报成功（含无 sessionId 的卸载清算）、两张 armed 卡撞键累加度量、revive 不抹小累计观察数等用例。
- `test/digest.test.ts`：候选没写进规则库时落进 `dropped` 的用例。
- 事件流水读取加 `(size, mtimeMs)` 解析缓存：卡片轮询 `/stats` 不再每轮把整份流水重新解析；`/stats` 一次读取同时用于投影与计数（此前同一轮读两遍规则库）。
- `test/lesson-store.test.ts` 新增用例：同类别两条不同命令必须汇成**一张卡**（`occurrences=2`），且两条命令原文分别落在各自证据行的 `signature` 上；稳定正文不含单条命令。`DRAFT_CASES` 增补稳定签名一格（11 → 12 条模板）。
- 新增用例覆盖：事件流水保险丝（忙锁跳过裁剪、陈旧锁接管、接管失败也不丢追加、失败路径释放锁）；`accept-language` 协商的纯函数与真 HTTP 回显；client 分组懒渲染、数值口径与 `signature` 渲染；`build-client` 的 external 基座；`dangerous-bash` 的存量碎片迁移。

### Fixed（`dangerous-bash` 类别，先于本批）

- **`dangerous-bash` 类的教训现在可审，且不再碎片化**。该类别原先**未登记**在 `CATEGORY_SIGNATURES` 里，于是两处毛病并存：① 每条不同命令各开一张 `occurrences=1` 的碎片卡，永远够不到 `promoteThreshold`（默认 3）；② "认不准"的那一种（`bash-nested-shell-unconfirmed`）签名是常量、**命令原文根本没进证据**，卡片里每一条证据都是逐字相同的模板拒绝文案——人审时看不出该审哪条命令。现在该类别折叠到类别级稳定签名 `dangerous-bash`，**每次命中的命令原文落进 `evidence.signature`**（走 `evidenceRow` 的既有机制：`raw ≠ folded` 才写该键），正文改走通用模板 `statementDangerousBashStable`（不嵌单条命令，与 `secret-path` 同形）。
- 存量碎片由启动时的 `migrateFragmentRules` 一次性收拢（幂等；碎片判据**按类别**走：路径型类别看 `looksLikePathSignature`，`dangerous-bash` 的命令原文一律算碎片——路径判据只能偶然命中它（`curl https://… | sh` 里那个斜杠），`git commit --no-verify` 这类会被整批漏掉；跨项目绝不合并）。**下次启动自动执行**，各条命令原文随证据保留，无人工动作丢失。判据收在 `lib/rule-signature.ts` 的 `isFragmentSignatureOf`（`test/lesson-store.test.ts` 有一条两条命令碎片归并的用例钉住）。

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