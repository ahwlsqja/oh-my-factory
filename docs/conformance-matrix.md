# Conformance matrix

Generated from `docs/requirements.json` by `node scripts/conformance-matrix.mjs --write`; `--check` fails on drift. Do not edit by hand.

- **covered**: a test that exists and carries its `// covers: <id>` marker passes offline, and a requirement that needs a real container or model also has a passing record in `docs/evidence/gated-runs.json`.
- **unproven**: offline tests exist and the real-world run has no record yet. The documents that make the claim say `[not enforced: <id>]`.
- **deferred**: the design states it and v0.1 does not implement it. It has no test, and the documents say `not implemented`.
- **missing**: no test counts, or a mapped file is absent. CI fails.

Totals: 21 covered, 4 unproven, 7 deferred, 0 missing.

| Id | State | Last recorded | Tests | Claim |
|---|---|---|---|---|
| `F1.goal-is-top-unit` | covered | - | 1 offline | Work items belong to a goal: a work item carries its goal id, and the goal file is the entry point of the loop. |
| `F2.metric-lock-before-measure` | covered | - | 1 offline | A metric that nobody approved is never measured, and an edited metric lock, bands file or goal.md stops measurement until J1 approves again. |
| `F3.code-controls-loop` | covered | - | 2 offline | Budgets and visit caps live in the host ledger and in code, not in a session, and nothing extends them on its own. |
| `F4.goal-closes-by-signature` | deferred (M4) | - | none | Agents produce at most a candidate; a goal closes only by a person's signature (J5). |
| `F5.bands-detect-regression` | covered | - | 1 offline | Control bands detect a drift after launch and record a breach event. |
| `F6.vault-host-only` | unproven | - | 3 offline, 2 gated, 1 wiring only | No agent session or container can read the vault; only the harness container reads it, during S4. |
| `F7.unevaluated-undetermined` | covered | - | 1 offline | A guardrail that was not evaluated is undetermined, never passing. |
| `F8.open-decision-blocks` | covered | - | 1 offline | Work does not run while a required decision is open. |
| `F9.unverified-areas-first` | covered | - | 2 offline | The evidence report lists the unverified areas, and nothing that nobody produced reads as passed. |
| `F10.wip-and-stop-if` | covered | - | 1 offline | New production stops when unreviewed evidence piles up; the work-in-progress cap and STOP_IF are reachable through real commands. |
| `F11.autonomy-dial` | deferred (after v0.1) | - | none | Autonomy is a dial by risk tier and widens only on recorded evidence. |
| `S5.0.empty-means-fail` | covered | - | 4 offline | Empty means fail: zero scenarios, a missing gate, a missing verdict or outcome file and a gate never visited all count as not passed. |
| `S5.1.spec-is-projection` | covered | - | 1 offline | spec.md is a projection of the decision ledger, byte for byte. |
| `S5.2.decisions-human-only` | covered | - | 1 offline | Only a person closes a decision; the writers refuse an agent actor. |
| `S5.3.seal-inputs-closed` | covered | - | 1 offline | What the sealing author receives is a closed set: intent, spec and the interface contract, never a plan or code. |
| `S5.4.implementer-container` | unproven | - | 3 offline, 2 gated | The implementer runs in a measured container with one vendor key, no vault and no other credential. |
| `S5.5.judge-two-container` | covered | 2026-10-15 | 2 offline, 1 gated | The judge runs the candidate and the harness in two measured containers, and the harness is the only reader of the vault. |
| `S5.5.null-implementation-fails` | covered | - | 1 offline | A null implementation never reaches success: the judge fails it. |
| `S5.7.masked-feedback` | covered | - | 2 offline | Feedback released to the implementer is masked, and releases are counted per goal in the host ledger. |
| `S5.8.evidence-no-pass-by-default` | covered | - | 2 offline | A clean line ends success with human_needed and lists noise_check_not_evaluated as unverified, so merge_recommended is unreachable in v0.1. |
| `S7.isolation-measured` | covered | 2026-10-18 | 2 offline, 1 gated | The isolation level comes from measurements in the ledger, and a daemon-reported deviation lowers it. |
| `S7.l2-label` | unproven | - | 1 offline, 1 gated | The label "sealed (container)" appears only when every stage of a run measured L2. |
| `S7.docker-client-trusted` | unproven | - | 1 offline | A substituted docker client or a lying daemon cannot make a stage measure L2. |
| `S7.l3-label` | deferred (v0.3) | - | none | L3 adds an egress allowlist and a leak red-team on every run, and earns its own label. |
| `S11.1.non-pollution` | covered | - | 1 offline | OMF only reads the user's agent configuration, keeps its state out of the repository and the agent config homes, and writes nothing there. |
| `S11.1.plugin-dir-shells` | deferred (after v0.1) | - | none | Shells prefer --plugin-dir injection, and marketplace installation is opt-in and labeled. |
| `S11.2.never-merges` | covered | - | 2 offline | OMF never commits to a user branch and never merges; a candidate adds exactly one ref and nothing writes done. |
| `S11.2.ship-only-pushes` | deferred (M4) | - | none | Push and pull request creation happen only through omf ship. |
| `S11.3.public-artifacts-in-worktree` | deferred (M4) | - | none | Public artifacts are written into the OMF worktree and committed by people through the normal pull request flow. |
| `S11.4.sealed-not-in-repo` | covered | - | 1 offline | OMF refuses to run when sealed material appears inside the repository. |
| `S11.5.governance-unreadable-stops` | covered | - | 2 offline | When a governance file cannot be read or fails verification, OMF stops instead of falling back to defaults. |
| `S11.6.break-glass-events` | deferred (M4) | - | none | A break-glass exception is a J7 ledger event with a reason and an expiry. |
