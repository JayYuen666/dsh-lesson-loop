<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/JayYuen666/dsh-lesson-loop@main/icon.svg" width="96" height="96" alt="dsh-lesson-loop logo" />
</p>

<h1 align="center">dsh-lesson-loop</h1>

<p align="center"><em>Guard denials, gate failures and human thumb-downs become project lessons; only a rule a human confirmed is injected back into the model at session start.</em></p>

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
  <a href="./README.zh-CN.md"><img src="https://img.shields.io/badge/lang-简体中文-658EFF?style=flat-square" alt="简体中文" /></a>
</p>

**A self-evolution loop for [dsh](https://github.com/deepseek-ai/deepseek-harness): one lesson bus the guard plugins report to, one rule library a human curates, and armed rules injected into every new session of their project.**

## <img src="https://api.iconify.design/lucide/file-text.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Contents

- [What it does](#what-it-does)
- [Install](#install)
- [Verify it is live](#verify-it-is-live)
- [What it does not provide](#what-it-does-not-provide)
- [Enabling it in dsh](#enabling-it-in-dsh)
- [The lesson bus](#the-lesson-bus)
- [Settings](#settings)
- [Public interface](#public-interface)
- [Data and privacy](#data-and-privacy)
- [Known boundaries](#known-boundaries)
- [FAQ](#faq)
- [Development](#development)
- [License](#license)

## <img src="https://api.iconify.design/lucide/shield.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> What it does

- **One bus, no coupling.** Sibling plugins report through the optional `lessonLoop` service; a profile without this package only drops those reports. The host half provides the service, the client half renders a web card holding the switches and the rule review desk.
- **Sink.** Each report appends one line to the event stream and merges into a candidate card keyed by (project, category, signature); at `promoteThreshold` that key is marked ready for review.
- **A machine never promotes a rule.** Status `armed` is only ever a human decision — the card's `arm` action writes it, and the startup migration merely carries an existing armed state onto a merged card. `reject` / `demote` / `archive` / `edit` / `revive` are human actions too.
- **Remind.** A project-agnostic standing section keeps the loop visible, and each root session receives the full text of its project's armed rules at `agent/created`. Subagent sessions are skipped.
- **Zero model tools, zero HTTP routes of its own.** The card's data plane is the official Typert Remote namespace `lessonLoopRules`, reached through the host `/api` gateway.

### How a rule is judged

- Three counters answer three different questions: `violation` (the scenario fired and was broken), `suppressed` (the scenario fired and was followed, driven by `pass`), `samples` (the rule was present and not violated).
- The only ratio is `violation / (violation + suppressed)`; `samples` is exposure and never a denominator.
- `samples` counts a durable session once even when it is resumed: duplicate disposal edges are deduplicated, so reopening a session does not inflate exposure.
- Demotion needs a positive `suppressed`, `violation` at `demoteThreshold`, real evidence at `demoteMinSamples`, and the ratio at `demoteRatio`.
- A rule with zero clean hits whose scenario keeps firing is **undeterminable**: neither the ratio nor the decay can retire it, so it stays armed for a human. One `pass` clears the flag.

## <img src="https://api.iconify.design/lucide/package.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Install

```sh
dsh plugin --profile web add @jayyuen66/dsh-lesson-loop
```

Remove with `dsh plugin --profile web remove @jayyuen66/dsh-lesson-loop`. The package is on the public npm registry, so installation needs no credentials.

- **Node.js `>= 22.12`, host `dsh` on the rolling `^0.2.1-rc.3` window.** The plugin's own floor is `engines.node` (`>=22.12.0`); the `0.2.2-alpha.2` host itself declares Node `>=24.9.0`, so that host cannot run on Node 22 even though this package can. The requirement the host reads is `engines.dsh` (`^0.2.1-rc.3`), and it **decides alone** — with that field present, `evaluatePluginCompatibility` never looks at the `@deepseek-ai/dsh*` peers. Measured: `0.2.0-rc.2` and `0.2.1-rc.1` are refused, `0.2.1-rc.3` and `0.2.2-alpha.2` pass, `0.3.0` is refused. The support window rolls: this package is verified against the three most recently released host versions at publish time and re-verified once the window moves, so the version number in this bullet is not a standing promise.
- **No `@deepseek-ai/*` under `dependencies`, by contract.** Profiles install with `nodeLinker: hoisted` and `autoInstallPeers: false`, so a host package there becomes a real second copy; `@deepseek-ai/dsh-tools` keys its scheduler with a plain `Symbol`, so **every native tool call throws** in that profile while build, typecheck and coverage stay green. The four host packages `host.js` imports for value are required peers and repeated under `devDependencies` at the same exact pin, so the bundler externalizes them instead of inlining the official function bodies; `test/publish-manifest.test.ts` enforces both halves. Artifacts are rebuilt by `prepack`, never committed.

### <img src="https://api.iconify.design/lucide/arrow-down-to-line.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Shared version floor

If your profile pins `@jayyuen66/dsh-plugin-shared` with a pnpm `overrides` entry, that pin must be at least the version this package declares. A lower pin installs a copy without the names imported at runtime, and the host then reports `N entries did not activate` together with `does not provide an export named ...` at boot — the package installs fine and never loads, and no per-repository CI run can see it.

## <img src="https://api.iconify.design/lucide/circle-check.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Verify it is live

1. **The layer is mounted.** `dsh --profile web --dump-config` ends with `# == @jayyuen66/dsh-lesson-loop` plus `- id: lesson-loop`.
   - That command is the only accepted signal, and it is **not read-only** — it rewrites the profile's root assembly file. Read layer lines from stdout **and** check stderr separately: an unmatched patch target appears only on stderr, so the exit code alone proves nothing. Accept both `# == <layer>` and `# == <layer>, patched by <path>`.
2. **The card renders live data.** Its header carries the current candidate / armed / lesson counts and opening it fills the rule groups. A plain "stats unavailable" row means the layer is mounted but the Remote namespace did not reach the browser; the longer localized host error ("stats unavailable: the host read path failed — retry") means the namespace is live and that one read failed, so retry after the read path recovers.
3. **A lesson reaches the library.** Trigger one denial or gate failure from an installed reporter (danger-guard, quality-gate, session-rescue), or run `/lessons-digest` in a session with negative feedback; the candidate group gains evidence.
4. **An armed rule comes back.** Arm a card, then start a new session in that project: the injected frame begins with `[lesson-loop] Experience rules for this project`. Subagent sessions receive nothing, by design.
5. **The profile carries no host copy.** `node_modules/` in a scratch profile holds `@jayyuen66/` and no `@deepseek-ai/` directory.

## <img src="https://api.iconify.design/lucide/circle-slash.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> What it does not provide

- **No model tools.** There is no `lesson_report` tool; the surface is the service plus the card's namespace.
- **No HTTP route of its own.** Authentication, Host / DNS-rebinding / Origin checks and body limits are the host gateway's.
- **No CLI subcommand.** The only command it contributes is the in-session `/lessons-digest`.
- **No outbound request of its own.** The distillation call goes through the host `llm` service.
- **No self-re-enabling rules.** A `rejected` card may return to `candidate` at the revive threshold; only a human can arm it again.

## <img src="https://api.iconify.design/lucide/plug.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Enabling it in dsh

- `dsh.bundle.patch` points at `cordis.patch.yml`, whose single registration line is `- id: lesson-loop` with `name: "@jayyuen66/dsh-lesson-loop"`. The **bare package name** is what makes the host scan the client half.
- **One entry, one `Config`.** The settings namespace is the entry id, so switches, thresholds and the `rules` array share one section and one revision. `rules` carries `.loose()`, the read side checks the raw shape through `describe().user` (unreadable means it refuses to write rather than overwriting), and every write is one CAS commit with re-read and replay.
- `settings` is the only plugin-level hard dependency. `timer` / `commands` / `systemPrompt` / `llm` are optional: a missing one removes that capability, the plugin still loads.
- The card's data plane is installed unconditionally on the apply fiber, so it exists even on a host whose web layer arrives late.
- `locale/en.json` / `locale/zh.json` supply the plugin page's `meta.title`, `meta.description` and `meta.detail`; the detail page reads `docs/DETAIL.md` in English and `docs/DETAIL.zh.md` in Chinese. The README is not the source for that page.
- Deployment defaults go on the registration line's `config:` (card value > row `config` > schema default); an invalid config fails this entry's fiber alone.
- An incompatible host is granted per exact version, never by widening a range:

```sh
dsh plugin --profile web allow-version @jayyuen66/dsh-lesson-loop@<version> --dsh-version <exact running host version> --accept-risk
```

`version-exemptions` lists the grants and `revoke-version` removes one; `--dsh-version` must equal the version the running host reports.

## <img src="https://api.iconify.design/lucide/cable.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> The lesson bus

| Method                                        | Purpose                                                                                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `report(input)`                               | Append a lesson, merge it into that key's card; returns `{ ok, reason?, violationOf?, candidate?, ready?, justReady? }` |
| `pass(input)`                                 | The rule's scenario fired and was followed; counted as `suppressed` when the session ends                               |
| `rules()` / `recentLessons(project?, limit?)` | Read the rule library / the event stream                                                                                |
| `ruleAction(id, action, statement?)`          | The six human actions                                                                                                   |
| `stats()`                                     | Counters and the config summary behind the card                                                                         |

- `reason` is one of `disabled`, `rules-not-persisted` (this change did not reach the library — retry) or `error`. It is a receipt code, not translated text.
- `source` is an open set: `danger-guard`, `quality-gate`, `session-rescue`, `lessons-digest` and `manual` are built in, and a third party may name itself freely (trimmed, non-empty, ≤ 64 characters, else `manual` with a log line). Two report kinds carry meaning worth naming: `gate-not-run` marks a check that never ran, because an environment problem must not be learned as a code lesson, and `needsUserConfirmation: true` in the evidence marks a judgement the reporter could not make — evidence, but no violation.
- Path-shaped categories fold into category-level keys (`edit-before-factgate`, `edit-before-secret-path`, `dangerous-bash`), so one general lesson does not shatter into per-file cards. The concrete target stays in the evidence: `signature` for `secret-path` and `dangerous-bash`, `target` for `factgate-deny` (which reports the folded key as its signature).
- Callers should go through `settleLessonCall` from `@jayyuen66/dsh-plugin-shared/lib/lesson-bus`, which routes sync throws and async rejections to one exit.

## <img src="https://api.iconify.design/lucide/sliders-horizontal.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Settings

Namespace = the entry id `lesson-loop`. Four switches default to `true`: `enabled` (master — off means no reporting, injection, exit settlement or standing section, periodic decay pauses, and `/lessons-digest` refuses), `reportEnabled` (lesson **entry** gate: it stops `report()` and `/lessons-digest` only — `pass()` accounting and the dispose-time settlement follow `enabled` alone), `injectEnabled`, `sectionEnabled`.

| Field               | Default    | Range              | Purpose                                                                                                                             |
| ------------------- | ---------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `promoteThreshold`  | `3`        | 1–20               | Same-key lessons reaching this count mark the card for review                                                                       |
| `demoteThreshold`   | `3`        | 1–50               | Violations after arming required to demote                                                                                          |
| `demoteMinSamples`  | `5`        | 1–100              | Minimum real evidence `violation + suppressed`                                                                                      |
| `demoteRatio`       | `0.5`      | 0.05–1 (step 0.05) | Recurrence-ratio red line                                                                                                           |
| `decayDays`         | `30`       | 1–365              | Armed this long without a clean hit turns the card undeterminable; later violations do not reset the window                         |
| `reviveThreshold`   | `3`        | 1–20               | A rejected rule seen this often returns to candidates                                                                               |
| `maxLessonsBytes`   | `0`        | 0–1 GiB            | Disk fuse; `0` = no cap, content never truncated to save context                                                                    |
| `maxStatementChars` | `4000`     | 1–100000           | Character limit for an armed rule statement on arm/edit (UTF-16 units); longer writes are refused, stored statements are unaffected |
| `digestTimeoutMs`   | `120000`   | ≥ 1000             | Wall clock for one digest run (ms); no card row                                                                                     |
| `decayIntervalMs`   | `86400000` | ≥ 1000             | Interval arming the periodic decay pass (ms); no card row                                                                           |
| `maxInjectedRules`  | `50`       | 0–1000             | Armed rules injected per session; when capped, the newest rules are kept; `0` = no cap; no card row                                 |

The last three rows are deployment values: not `.volatile()`, so the card has no row for them and they are given only on the registration line's `config:`, taking effect on restart.

## <img src="https://api.iconify.design/lucide/network.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Public interface

Four methods on one official Typert Remote namespace, `lessonLoopRules`.

| Method                | Input                        | Reply                                                                                                                                         |
| --------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `stats()`             | —                            | `{ ok: true, …counters, …config summary, rules }`; the rule projection carries the derived `undeterminable` flag and **no** `evidence` bodies |
| `rules(request)`      | `{ project? }`               | `{ ok: true, rules }`; a non-string `project` reads as absent, i.e. the whole library                                                         |
| `lessons(request)`    | `{ project?, limit? }`       | `{ ok: true, count, lessons }`; an absent, non-finite or ≤ 0 `limit` means the default 50, and an explicit value is capped at 500             |
| `ruleAction(request)` | `{ id, action, statement? }` | `{ ok: true, id, action }`, or `{ ok: false, error, status }`                                                                                 |

- `action` must be one of the six whitelisted values; `statement` is read by `arm` and `edit` only, trimmed, and a blank string counts as "not given". A statement longer than `maxStatementChars` returns `{ ok: false, status: 400 }` and the library stays untouched.
- A refusal's `status` is a **retained semantic code, not an HTTP status**: 400 for a missing field or an off-whitelist action, 404 for an unknown card, 500 for a change the library refused to persist (carrying `rules-not-persisted`).
- The read methods return `{ ok: false, error, status: 500 }` when the host read path fails; `error` is localized and the original exception stays in the host log. A 500 here means the read failed, not that the request was malformed.
- Reads are pulled, not pushed: on panel open, after a save, and after each manual action. There is no polling loop and no client-side wall clock.

## <img src="https://api.iconify.design/lucide/lock.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Data and privacy

| Aspect               | Content                                                                                                                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Written to disk      | The event stream at `$DSH_HOME/cache/lesson-loop/events.jsonl` (a discardable derived-data location) plus its transient `.lock` / `.tmp` siblings, and the `rules` array in the `lesson-loop` section of the settings document          |
| Network              | No call of its own. `/lessons-digest` sends this session's negative feedback and the project's recent lessons to the current default model through the host `llm` service, so that content leaves the machine when that model is remote |
| Retention            | The event stream keeps details and rule statements in full, with zero truncation; `maxLessonsBytes` is a disk fuse, not a context cap                                                                                                   |
| Evidence convergence | Rule-card `evidence` is the one exception: an over-long detail is truncated with an ellipsis and only the most recent rows per card are kept, at write time only. `signature` and the counters are never trimmed                        |
| Concurrency          | Rule-library writes carry cross-process CAS; event-stream appends share one lock with trimming                                                                                                                                          |
| Language             | Host-side wording follows the official locale preference; stored rule statements are user data and are never rewritten                                                                                                                  |

## <img src="https://api.iconify.design/lucide/triangle-alert.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Known boundaries

- **Nothing is promoted automatically** — a rule that armed itself would turn one noisy report into a permanent instruction.
- **Undeterminable rules do not converge**: with no clean hit there is no denominator, so only a human retires them, and the injection cap keeps that population out of the context.
- **Subagent sessions are skipped** — a second injection would count as exposure for a rule they never saw.
- **The card is pull-based**, so a value cached across a reconnect would be stale by design.
- **Evidence bodies never cross the wire**; the card sees the signature and the counters.
- **No machine translation**: rule statements and evidence are user data.
- **Optional services remove capabilities, not the plugin**: no `commands` means no `/lessons-digest`, no `systemPrompt` means no standing section, no `llm` means the digest refuses, no `timer` leaves manual review only; without `settings` the entry never activates and the startup diagnostic names it.
- **A digest run can partially fail**: cards that did not reach the library are reported separately, and the receipt never claims "distilled" for a card that is not on disk. A response that contains no parseable JSON array is a hard error, not "zero candidates".

## <img src="https://api.iconify.design/lucide/circle-help.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> FAQ

| Question                                      | Answer                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Do rules ever enable themselves?              | No. Only `arm` writes `armed`; reaching the revive threshold only returns a rejected card to `candidate`.                                                                                                                                                                                                                                        |
| What happens with `reportEnabled` off?        | `report()` returns `{ ok: false, reason: "disabled" }` immediately and `/lessons-digest` refuses; the Remote reads and the card keep working.                                                                                                                                                                                                    |
| The arm button reports `rules-not-persisted`. | That change never reached the library; the old state still holds, so retry.                                                                                                                                                                                                                                                                      |
| A rule keeps showing "undeterminable".        | `suppressed` is still zero, so there is no clean hit to divide by: the rule either sat past `decayDays` or hit `demoteThreshold` violations without one followed session. With zero violations too the ratio is undefined, not 1.0 — either way the machine will not decide for you. Disable or archive it yourself; one `pass` clears the flag. |
| I hand-edited `rules` into a non-array.       | The rule side degrades to "reads empty, refuses writes" and this process never writes that section; the switches keep working until you repair the field.                                                                                                                                                                                        |
| Another plugin cannot see the bus.            | Without this package, or when `ctx.provide` is unavailable (one explicit error), reporters drop their reports and their own functionality is unaffected.                                                                                                                                                                                         |

## <img src="https://api.iconify.design/lucide/wrench.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Development

```sh
pnpm install
pnpm run check   # typecheck → lint → client build → host build → types → tests → format
```

- `test/` splits by the class of defect a stub cannot see: unit tests drive the store and the pure helpers; `test/integration/` drives a real cordis and loader, so service hand-out, sibling `inject` resolution, activation order and bulkhead isolation are measured rather than mocked.
- Two artifact gates: `test/build-host.test.ts` holds the cross-package imports external as bare specifiers, `test/dist-size.test.ts` a size budget, so an inlined dependency cannot pass unnoticed. `test/publish-manifest.test.ts` guards the published shape — entry targets covered by `files`, no source file as an entry point, host packages absent from `dependencies`, `dsh-*` pins exact and uniform, no dates in comments or documents.
- Coverage thresholds are 100% across four metrics, so a new branch needs a case that reaches it.

## <img src="https://api.iconify.design/lucide/scale.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> License

MIT. Source at [github.com/JayYuen666/dsh-lesson-loop](https://github.com/JayYuen666/dsh-lesson-loop). Issues go to that repository's tracker.

This package contains no third-party source code: `host.js` and `client.js` keep every cross-package import external as a bare specifier. Runtime dependencies carry their own licenses; [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) records that artifact boundary and how to re-check it.
