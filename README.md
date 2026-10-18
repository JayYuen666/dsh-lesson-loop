# @jayyuen66/dsh-lesson-loop

[中文](./README.zh-CN.md)

### What it does

- A self-evolution loop plugin for dsh: guard denials, gate failures, abnormal resumptions and human negative feedback go through one bus, sink into project lessons and rule cards, and confirmed rules get injected back into the model at session start.
- The host half `provide`s the `lessonLoop` service (other plugins read it optionally via `ctx.get("lessonLoop")`); the client half is a web settings card (switches + rule review desk, declared in `dsh.client` as `platform: web`, `immediately: true`).
- A machine never promotes a rule: a candidate takes effect only after a human presses `arm` in the card.
- Runtime dependencies are only `@deepseek-ai/schemastery` (the host's fork - public `schemastery` has no `.volatile()`), `@deepseek-ai/dsh-home-paths`, `@deepseek-ai/dsh-brand` and `@jayyuen66/dsh-plugin-shared`.
  - `peerDependencies` is the **only** place the host reads a version requirement from; `engines.dsh` carries the same value but has no reader in the host (see the install acceptance checks below).
  - The three host packages are **value** imports in the shipped `host.js`, so they are declared as required `peerDependencies` and repeated at the same exact pin in `devDependencies` for this repository's own typecheck/build/tests - never in `dependencies`. That is not a style preference: consumer profiles install with `nodeLinker: hoisted` and `autoInstallPeers: false`, so a host package listed under `dependencies` is written into the profile as a **real directory**, coexisting with the copy the host process already loaded. `@deepseek-ai/dsh-tools` keys its `TOOL_RUNTIME_SCHEDULER` with a plain `Symbol` (not `Symbol.for`), so symbol identity is per module instance: the host's `dsh-agent-loop` gets `undefined` and **every native tool call throws** `Cannot read properties of undefined (reading 'prepare')` - the whole profile loses its tools. Build, typecheck and tests all stay green right up to that point, so the invariant is pinned in `test/publish-manifest.test.ts`.

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
  - The card's data plane is four methods on one official Typert Remote namespace, installed unconditionally on the apply fiber — they depend on no optional host service, so unlike the old route surface they exist even on a host whose web layer arrives late or never arrives at all.

### Install acceptance checks

Four checks, all run locally against `dsh 0.2.1-rc.2` with `DSH_HOME` pointed at a temporary directory so the day-to-day profile stays untouched:

- After `dsh plugin --profile web add <tarball>`, the profile's `node_modules/` should contain exactly one scope directory, `@jayyuen66/`, and **no `@deepseek-ai/` directory**. That directory is the fingerprint of host packages leaking into `dependencies` and materializing a second copy of the host type surface in the profile - the invariant `test/publish-manifest.test.ts` guards.
- `dsh --profile web --dump-config` ends with `# == @jayyuen66/dsh-lesson-loop` plus `- id: lesson-loop`, which is the bundle layer claiming the entry.
- The host **enforces** peers at install time: `@deepseek-ai/dsh` and every `@deepseek-ai/dsh-*` peer go through `semver.satisfies(runtime, requirement, { includePrerelease: true })` (`dsh-app-boot/src/plugin-compatibility.ts:61-86`; preflight on `add` at `dsh-plugin-manager/src/operations.ts:344`, re-check after install at `:479`). A probe package whose peer said `@deepseek-ai/dsh: 0.1.0` came back as `dsh: installation rejected: … is incompatible with dsh 0.2.1-rc.2`, followed by `dsh: restored package.json, pnpm-lock.yaml, and node_modules.` - all three rolled back. `engines.dsh` carries the same value but **nothing in the host reads it**: `@deepseek-ai/dsh-package-manifest` only declares the type, and its own README states that installers and loaders do not enforce it.
- Because this package pins its `dsh-*` peers exactly (the discipline shared by all nine sibling packages), a host **newer** than this floor mismatches the same way and needs an explicit, per-runtime-version grant: `dsh plugin --profile web allow-version @jayyuen66/dsh-lesson-loop@<version> --dsh-version <exact host version> --accept-risk`. `version-exemptions` lists grants and `revoke-version` removes them (all three commands measured).

The same properties on the loading side are pinned against a real cordis + loader in `test/integration/host-contract.test.ts`: the service is handed out through the official reflect face, a sibling entry declaring `inject: ["lessonLoop"]` resolves it, a load that fails — whether the `Config` is invalid or `settings` is missing — registers **no** route on the webServer stub and provides no bus, an invalid `Config` fails **only** this entry's fiber, and a missing `settings` keeps the entry out of ACTIVE.

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

Settings namespace = the profile entry id `lesson-loop` (changeable at runtime). Registration is implicit under 0.2.1-rc.2 - the host derives the namespace and its editable fields from the `Config` the entry exports - and one entry has exactly one section: `rules` is one of its `.volatile()` fields (directly user-editable), the switches and thresholds are the section's other editable fields, and the two deployment-only values below share the section without being projected into the card. What the old two-namespace split (`lesson-loop-rules`) used to guarantee is now recovered in three places: `rules` carries `.loose()` (a human editing it into a non-array cannot make the whole entry fail to load), the read side additionally checks the raw shape in `describe().user` (unreadable means it refuses to write rather than overwriting the data with an empty library), and the section is mutated under one shared revision with CAS re-read/replay. One broken rule never takes the switches down, and vice versa. The four booleans all default to `true`: `enabled` (master switch: no reporting, no injection, no exit settlement when off), `reportEnabled` (sink and merge), `injectEnabled` (session-start injection), `sectionEnabled` (permanent section).

| Field              | Default    | Range                  | Purpose                                                                   |
| ------------------ | ---------- | ---------------------- | ------------------------------------------------------------------------- |
| `promoteThreshold` | `3`        | 1–20                   | Same-key lessons reaching this count mark the card for human review       |
| `demoteThreshold`  | `3`        | 1–50                   | Violations after arming required to demote                                |
| `demoteMinSamples` | `5`        | 1–100                  | Minimum real evidence `violation+suppressed` required                     |
| `demoteRatio`      | `0.5`      | 0.05–1 (step 0.05)     | Recurrence ratio `violation/(violation+suppressed)` red line              |
| `decayDays`        | `30`       | 1–365                  | Armed this long without a single clean hit → undeterminable (anchor: last activity) |
| `reviveThreshold`  | `3`        | 1–20                   | A rejected rule seen this often returns to candidates for human re-review |
| `maxLessonsBytes`  | `0`        | ≤ 1 GiB (0 = no limit) | Disk fuse for the event stream, never to save context                     |
| `digestTimeoutMs`  | `120000`   | ≥ 1000                 | Wall clock for one digest run (ms); no card row, line `config:` only      |
| `decayIntervalMs`  | `86400000` | ≥ 1000                 | Interval arming the periodic decay pass (ms); likewise no card row        |

The last two rows are the deployment values: deliberately not `.volatile()`, so the host does not project them, the card has no row for them, and they are given only on the registration line's `config:` (cordis hands apply plain values, so a change takes effect on restart).

### Public surface

The card's data plane is four methods on one **official Typert Remote namespace**, `lessonLoopRules` (`lib/rules-shape.ts`). There is no `/_dsh/*` route, no CSRF token and no body cap of ours: the namespace reaches clients of this profile through the host `/api` gateway, and authentication plus the Host / DNS-rebinding / Origin checks and the request-size limit are the gateway's own. What the methods enforce is unchanged from the HTTP version — the six-action whitelist and "no such rule ⇒ refused" guard the action, not the transport.

| Method | Input | Reply |
| --- | --- | --- |
| `stats()` | — | `{ ok: true, …counters, …config summary, rules }`; the rule projection carries the derived `undeterminable` flag and **no** `evidence[]` bodies |
| `rules(request)` | `{ project? }` | `{ ok: true, rules }`; a `project` that is not a string is read as absent, i.e. the whole library |
| `lessons(request)` | `{ project?, limit? }` | `{ ok: true, count, lessons }`; a `limit` that is not a finite number, is ≤ 0, or is absent means everything — the event feed is never truncated |
| `ruleAction(request)` | `{ id, action, statement? }` | `{ ok: true, id, action }`, or `{ ok: false, error, status }` |

- `action` must be one of the six whitelisted values, and `statement` is read by `arm` and `edit` only — it is trimmed, and a blank string (empty or whitespace-only) counts as "not given": the stored statement stays as it is.
- A refusal's `status` is a **retained semantic code, not an HTTP status**: a missing `id` / `action` or an off-whitelist action is 400, an unknown card is 404, and a change the library refused to persist is 500 with the text `rules-not-persisted`. The card renders `error`; the number exists so the tests can pin which rule fired. There is no 405 or 413 arm any more — whether the method exists and how big the body is, are the gateway's verdicts now.
- The client (`src/rules-reader.ts`) holds the four descriptors, `$mount`s them once and then reads the derived key `remote.lessonLoopRules`. With no `remote` service in the client context there is no reader at all and the card shows its `statsUnavailable` line; with the service present but this namespace unmounted, the read throws — a missing capability is said out loud instead of being rendered as "the library is empty".
- Reads are pulled, not pushed: once when the panel opens, once after a save, once after each manual action. There is **no polling loop and no client-side wall clock**; how long a call may take is the gateway's decision, and a second deadline inside the card is how a slow write gets reported as lost while it actually landed.
- The evidence bodies stay on the host deliberately: each detail can run to 400 characters, and `undeterminable` — armed long enough with zero recurrence and zero compliance — is a machine's way of saying "this one needs a human".
- The `/lessons-digest [additional note]` command sends this session's human negative feedback plus the project's recent lessons to the model and distils candidate cards (`origin` `lessons-digest`).
### Data and privacy

- Two derived-data stores only:
  - `$DSH_HOME/cache/lesson-loop/events.jsonl` — cache is the discardable derived-data location, it can be rebuilt from sessions and the rule library after deletion.
  - With `$DSH_HOME` unset the official home-paths package falls back to `.dsh` in the user's home directory.
  - The `rules` array inside the `lesson-loop` section of the settings document, which the user may edit directly.
- Everything stays on this machine: the package sends data to no external service, and the distillation call goes through the host `llm` service with the current default model selection.
- Event-stream lesson `detail` and rule statements are stored in full with zero truncation and may contain paths, command lines and raw tool output — treat them as sensitive when backing up or cleaning.
  - Rule-card `evidence` is the only exception, and it converges at the moment of writing: a `detail` longer than 400 characters (`MAX_EVIDENCE_DETAIL_CHARS` in `lib/rules-layout.ts`) is truncated with an ellipsis, and only the 5 most recent rows per card are kept (`MAX_EVIDENCE_ENTRIES`). The `signature` (the concrete path or command that hit), `occurrences` and the `violation`/`suppressed`/`samples` counters are never trimmed, so a card still shows which command it guards. Reads (`cardsOfValue`) parse what is on disk without rewriting it, so truncation happens exactly once; an existing library needs no migration and converges on its next write.
- Rule-library reads and writes carry cross-process CAS (provider write lock plus re-read/replay against the revision, at most 3 attempts), so a long-running web instance and a short-lived CLI cannot wipe each other's cards.
- Host-side wording follows the official locale preference (Chinese / English, Chinese when unregistered); stored rule statements are user data and are never rewritten by a language switch.

### FAQ

- Do rules ever enable themselves? No. Only `arm` writes status `armed`; a `rejected` card that hits the revive threshold goes back to `candidate`, and reviving `demoted` / `archived` is a human action too.
- What happens with `reportEnabled` off? `report()` returns `{ ok: false, reason: "disabled" }` immediately — no event line, no card (the integration test pins this negative path).
  - `/lessons-digest` refuses as well; the Remote reads and the settings card keep working.
- The arm button reports failure? `rules-not-persisted` means this change never reached the library (the port refused the write or CAS retries ran out); the library still holds the old state, so retry.
  - If the `rules` field is hand-edited into a non-array, the rule side degrades to "reads empty, refuses writes" (the bad content is left untouched for a human to fix, and this process never writes that section) while the switches in the same section keep working; repairing the field restores the rule side.
- A rule keeps showing "undeterminable"? The machine has no clean hit to divide by: `suppressed` is still zero, and either the rule has been sitting unchanged for `decayDays` (the anchor is its most recent activity — armed / last violation / last pass) or it has already hit `demoteThreshold` violations without a single followed-through session. In both cases the ratio `violation/(violation+suppressed)` would be 1.0 by construction, so the machine neither demotes nor archives it: it stays armed for you to disable or archive. A single `pass` hit clears the flag.
- Another plugin cannot see the bus? Without this package installed, or when `ctx.provide` is unavailable (which logs one explicit error), reporters just drop their lessons and their own functionality is unaffected.
