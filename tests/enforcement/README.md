# Enforcement tests

Each control claim in `docs/design/2026-10-12-omf-v0-design.md` links to one test here. A claim
without a test is labeled "not enforced" in the spec.

| Test | Claim | Spec |
|---|---|---|
| `E1-metric-tamper-stops.test.ts` | An unapproved metric is never measured, an edited metric lock stops measurement, and a change to a metric's watched code, to a bands file or to `goal.md` is a regime change until J1 approves again; an edited bands hash in the goal lock stops measurement. The locked target stays in force. | §4.1, §4.2, §4.6 |
| `E2-g-canary-no-leak.test.ts` | The goal loop shows the reconciler a direction and a size bucket and nothing else. Canaries planted in the measured value, the target, the metric id, its command and watched path, and the goal body never reach the model input, the stored work items, the ledger events about the model or the output of `omf goal tick`. A model that leaks canaries on its own has each such candidate rejected and none of it stored; a forbidden key voids its whole response. Positive controls prove the canaries existed on the host. The W side of E2 (verifier and implementer) is M3. | §4.6 (F6) |
| `E3-budget-no-reset.test.ts` | Budgets accumulate in the host ledger, never reset on restart, and only people declare or raise them. At tick level: a restarted process keeps the rounds and disclosure already spent, a tick with none left never calls the reconciler, and rounds come back only through a person's raise and resume. Truncating the ledger is not detected, and moving the checkout starts a new project (spec §8). | §4.4, §6 J8 |
| `E4-unevaluated-is-undetermined.test.ts` | A guardrail that was not evaluated is not a passing guardrail: with no bands file, or a baseline that is still too short, a goal never becomes a success candidate however long it is observed; it does once the guardrail evaluates `pass`. Pulled forward from M3; the verification-evidence half of E4 stays in M3. | §4.5 (F7) |
| `E5-init-non-pollution.test.ts` | `omf init` and `omf doctor` write nothing to the repository, `~/.claude`, `~/.claude.json` or `~/.codex`, even when the agent CLIs they probe would | §11 rule 1 |
| `ledger-tamper-stops.test.ts` | Every command (`ledger verify`, `doctor`, `init`, `goal new\|audit\|measure\|tick\|status\|resume\|cancel`, `metric propose`, `work list\|show\|approve`, `veto`, `budget show\|declare\|raise`) verifies the ledger chain, stops on a broken chain, leaves the ledger unchanged and creates no file. Truncation is not detected (spec §8). Commands added later join this test. | §8 |
| `tests/core/lock-contention.test.ts`, `tests/core/ledger-contention.test.ts`, `tests/core/budget-contention.test.ts` | Concurrent processes never both hold the lock, never break the chain, and never both spend the last budget round | §4.4, §8 |

The leak tests use `tests/helpers/reconciler-stub.mjs` in `leaky` mode and the planted strings in
`tests/helpers/canary.ts`. A change to what the goal loop discloses is a change to E2: update the
test in the same commit.

Planned in later milestones: E2 canary-no-leak for the sealed-scenario side (M3), E6 l2-leak-redteam (M3),
E7 empty-means-fail (M3), E8 no-auto-approve (M4). E2 on the goal-loop side and E4 landed in M2b, together with
the two-turn walking skeleton in `tests/examples/hello-goal.test.ts`. The command table in the READMEs is
checked against `omf --help` by `tests/cli/help-drift.test.ts`.
