# Enforcement tests

Each control claim in `docs/design/2026-10-12-omf-v0-design.md` links to one test here. A claim
without a test is labeled "not enforced" in the spec.

| Test | Claim | Spec |
|---|---|---|
| `E1-metric-tamper-stops.test.ts` | An unapproved metric is never measured, an edited metric lock stops measurement, and a change to a metric's watched code or to `goal.md` is a regime change until J1 approves again. The locked target stays in force. | §4.1, §4.2, §4.6 |
| `E3-budget-no-reset.test.ts` | Budgets accumulate in the host ledger, never reset on restart, and only people declare or raise them. Truncating the ledger is not detected, and moving the checkout starts a new project (spec §8). | §4.4, §6 J8 |
| `E5-init-non-pollution.test.ts` | `omf init` and `omf doctor` write nothing to the repository, `~/.claude`, `~/.claude.json` or `~/.codex`, even when the agent CLIs they probe would | §11 rule 1 |
| `ledger-tamper-stops.test.ts` | Every M1 command (`ledger verify`, `doctor`, `init`) verifies the ledger chain, stops on a broken chain and leaves the ledger unchanged. Truncation is not detected (spec §8). Commands added in later milestones join this test. | §8 |
| `tests/core/lock-contention.test.ts`, `tests/core/ledger-contention.test.ts`, `tests/core/budget-contention.test.ts` | Concurrent processes never both hold the lock, never break the chain, and never both spend the last budget round | §4.4, §8 |

Planned in later milestones: E2 canary-no-leak (M2/M3), E4
unevaluated-is-undetermined (M3), E6 l2-leak-redteam (M3), E7 empty-means-fail (M3),
E8 no-auto-approve (M4).
