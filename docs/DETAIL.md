Field names, defaults and ranges are in the in-card ⓘ help and the bundled README; every setting except the three restart-only values applies without restarting the host.

**The rule list is not a settings grid.** Each rule is acted on from its own card — arm, edit, demote, archive, reject, revive; a batch toggle would let one turn change every rule at once. Archived and rejected cards can be **deleted permanently**; that is irreversible and needs a second click to confirm.

**Restart-only values.** `digestTimeoutMs`, `decayIntervalMs` and `maxInjectedRules` live in the `config:` block of this plugin's row and take effect on restart.

**Data and integration.** Evidence arrives from danger guard, quality gate and session rescue over the shared lesson bus; rules, lessons and the session ledger share one SQLite database at `$DSH_HOME/data/lesson-loop/lesson-loop.db`. Schema, concurrency and retention details are in the README.

Issues and pull requests: [https://github.com/JayYuen666/dsh-lesson-loop/issues](https://github.com/JayYuen666/dsh-lesson-loop/issues).
