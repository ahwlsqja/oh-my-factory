# Implementation plans

The v0.1 walking skeleton (`docs/design/2026-10-12-omf-v0-design.md` §13) is built in four
milestones. Each milestone has its own plan and ends with working, tested software. A plan is
written in full only when the previous milestone is merged, so it can build on real code.

| Milestone | Plan | Delivers | Enforcement tests |
|---|---|---|---|
| M1 Foundation | `2026-10-12-omf-m1-foundation.md` | Host state, hash-chained ledger, schema validation, budgets, claim lock, `omf init`, `omf doctor`, `omf ledger verify` | E3 budget-no-reset, E5 init-non-pollution, ledger-tamper-stops |
| M2 Goal loop | to be written after M1 | `goal.md`, J1 approval and locks, `measure-cmd`, gap and `bands.yaml`, reconcile, dispatch with WIP cap and claim lock, seed lint, mechanical risk class, `state-markdown` | E1 metric-tamper-stops, G-side part of E2 |
| M3 Verification loop | to be written after M2 | Decision ledger and `spec.md`, GATE-1 to GATE-4, seal (Codex one-shot), devcontainer runner, two-container judge, gate line, outcome classes, masked feedback, evidence report, `prove-test` | E2 canary-no-leak, E4, E6 l2-leak-redteam, E7 empty-means-fail |
| M4 People and end-to-end | to be written after M3 | `request_human_input`, handoff packet, `veto`, `ship`, `goal sign`, self-metrics, `examples/hello-goal` with two goal-loop turns | E8 no-auto-approve, end-to-end acceptance |
