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
  - The four `/_dsh/lesson-loop/*` routes hang off an `inject(["webServer"])` child fiber - on the real host webServer arrives about a second after this entry, so a one-off `ctx.get` in apply would never register them.

### Install acceptance checks

Four checks, all run locally against `dsh 0.2.1-alpha.2` with `DSH_HOME` pointed at a temporary directory so the day-to-day profile stays untouched:

- After `dsh plugin --profile web add <tarball>`, the profile's `node_modules/` should contain exactly one scope directory, `@jayyuen66/`, and **no `@deepseek-ai/` directory**. That directory is the fingerprint of host packages leaking into `dependencies` and materializing a second copy of the host type surface in the profile - the invariant `test/publish-manifest.test.ts` guards.
- `dsh --profile web --dump-config` ends with `# == @jayyuen66/dsh-lesson-loop` plus `- id: lesson-loop`, which is the bundle layer claiming the entry.
- The host **enforces** peers at install time: `@deepseek-ai/dsh` and every `@deepseek-ai/dsh-*` peer go through `semver.satisfies(runtime, requirement, { includePrerelease: true })` (`dsh-app-boot/src/plugin-compatibility.ts:61-86`; preflight on `add` at `dsh-plugin-manager/src/operations.ts:344`, re-check after install at `:479`). A probe package whose peer said `@deepseek-ai/dsh: 0.1.0` came back as `dsh: installation rejected: … is incompatible with dsh 0.2.1-alpha.2`, followed by `dsh: restored package.json, pnpm-lock.yaml, and node_modules.` - all three rolled back. `engines.dsh` carries the same value but **nothing in the host reads it**: `@deepseek-ai/dsh-package-manifest` only declares the type, and its own README states that installers and loaders do not enforce it.
- Because this package pins its `dsh-*` peers exactly (the discipline shared by all nine sibling packages), a host **newer** than this floor mismatches the same way and needs an explicit, per-runtime-version grant: `dsh plugin --profile web allow-version @jayyuen66/dsh-lesson-loop@<version> --dsh-version <exact host version> --accept-risk`. `version-exemptions` lists grants and `revoke-version` removes them (all three commands measured).

The same properties on the loading side are pinned against a real cordis + loader in `test/integration/host-contract.test.ts`: the service is handed out through the official reflect face, a sibling entry declaring `inject: ["lessonLoop"]` resolves it, unloading adopts each of the four route disposers, an invalid `Config` fails **only** this entry's fiber, and a missing `settings` keeps the entry out of ACTIVE.

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
  - Any failure -> `403` plus JSON `{ ok: false, error: "untrusted host authority" | "cross-origin request rejected" }`, the second text shared by the `sec-fetch-site` and `Origin` legs; `servingNonLoopback` comes only from `isNonLoopbackBindHost(webServer.host)` - from host `0.2.1-alpha.2` on `Config.host` is any concrete local-interface IP literal and a wildcard bind is rejected at load, so comparing against `"0.0.0.0"` would be constant false.
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
