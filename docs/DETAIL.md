# Lesson loop

Turns gate and approval evidence into rules: it promotes the ones that keep recurring, injects the armed ones into new turns, and lets the ones nobody follows decay.

## What the card changes

- **Loop** — `enabled` (on) off drops the reports, injects nothing, stops the session-end settlement and the periodic decay pass, and disables the standing prompt section and the `/lessons-digest` command. `reportEnabled` (on) is the lesson-entry gate: `report()` and `/lessons-digest` refuse when it is off, while `pass()` accounting and the session-end settlement follow `enabled` alone. `injectEnabled` (on) puts armed rule text into new turns. `sectionEnabled` (on) keeps the fixed system-prompt section that tells the model how to use the rules.
- **Promotion and decay** — `promoteThreshold` (1–20, default 3) how many reports move a candidate up to awaiting confirmation. `demoteThreshold` (1–50, default 3) how many recurrences arm-demote a rule. `demoteMinSamples` (1–100, default 5) the minimum number of "violation happened and was suppressed" samples before a demotion counts. `demoteRatio` (0.05–1, step 0.05, default 0.5) the ratio that triggers it. `reviveThreshold` (1–20, default 3) how many reports bring a rejected rule back to candidate. `decayDays` (1–365, default 30) how long an armed rule may go un-followed before it is marked undecidable and only a person can move it.
- **Capacity** — `maxLessonsBytes` (0 = unlimited, hard cap 1 GiB) bounds the event stream on disk, not the rule library. `maxStatementChars` (1–100000, default 4000) bounds one rule statement.

Every setting except the three restart-only values takes effect without restarting the host.

## The rule list is not a settings grid

Each rule is acted on individually from its own card — arm, edit, demote, archive, reject, revive. That is deliberate: a batch toggle would let one turn silently change every rule at once.

## Restart-only values

`digestTimeoutMs` (120000), `decayIntervalMs` (24 h) and `maxInjectedRules` (50) stay off the card as deployment tunings. Set them in the `config:` block of this plugin's row in `cordis.patch.yml`; they take effect on restart.

## What it needs from outside

The evidence comes from other plugins over the shared lesson bus — danger guard, quality gate and session rescue are the useful producers. With none of them installed the loop still learns from `/lessons-digest` and manual reports, but receives no gate evidence. The digest command is registered when the host exposes a command service; without it the command is simply absent and the rest still works.

## Further detail

The rule-store layout, the JSONL fuse that keeps a corrupt line from poisoning the store, and the digest prompt are in the package README (`README.md` / `README.zh-CN.md`).
