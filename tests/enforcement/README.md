# Enforcement tests

Each control claim in `docs/design/2026-10-12-omf-v0-design.md` links to one test here. A claim
without a test is labeled "not enforced" in the spec.

| Test | Claim | Spec |
|---|---|---|
| `E3-budget-no-reset.test.ts` | Budgets accumulate in the host ledger, never reset on restart, and only people declare or raise them | §4.4, §6 J8 |
| `E5-init-non-pollution.test.ts` | `omf init` writes nothing to the repository, `~/.claude`, `~/.claude.json` or `~/.codex` | §11 rule 1 |
| `ledger-tamper-stops.test.ts` | Every command verifies the ledger chain and stops on a broken chain | §8 |
| `tests/core/lock-contention.test.ts`, `tests/core/ledger-contention.test.ts`, `tests/core/budget-contention.test.ts` | Concurrent processes never both hold the lock, never break the chain, and never both spend the last budget round | §4.4, §8 |

Planned in later milestones: E1 metric-tamper-stops (M2), E2 canary-no-leak (M2/M3), E4
unevaluated-is-undetermined (M3), E6 l2-leak-redteam (M3), E7 empty-means-fail (M3),
E8 no-auto-approve (M4).
