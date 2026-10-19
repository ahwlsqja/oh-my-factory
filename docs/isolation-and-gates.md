# Gates, audit and isolation (M3e)

What the integrity line of the verification loop is, what it proves and what it does not. Everything here runs
offline: no container and no model, and no module under `src/` runs candidate code on the host. A command a gate
or a prove-test runs goes through a `CommandTarget`; the tests supply a fixture target, and the container
judge (`docs/container-judge.md`) supplies a container-backed one.

## What exists

| Piece | Where | What it decides |
|---|---|---|
| Hardened host git | `src/git/hardened.ts` | Git is always addressed with an explicit `--git-dir`; a `.git`, hook, config or symlink written by a container is data, never configuration. |
| Gate line | `src/gate/gate-line.ts` | `OMF_GATES: fast=pass full=pass deep=skip`. A required gate that is skipped, empty, absent, duplicated or unknown makes the line `MISCONFIGURED`; an empty gate (zero rules) is not a pass. |
| prove-test | `src/gate/prove-test.ts` | Reverts the non-test part of the diff in a throwaway copy and expects the tests to fail. A test that passes without the fix is `FAILED`. |
| Audit | `src/audit/work-audit.ts` | Tests edited, judge config touched, edits to this work item's projections, `.omf/<work-id>/spec.md` and `.omf/<work-id>/intent.md` (a repository's own root `spec.md` is an ordinary file and does not count), canary hits on implementer-side surfaces, and a risk recompute that can only raise. |
| Isolation types | `src/isolation/types.ts` | Per stage (`author`, `implementer`, `sut`, `harness`) measurements. The stage level is the minimum over its measurements and the run level is the minimum over the stages, with `unmeasured` lowest. |
| GATE-3 | `src/gate/gate3.ts` | A pure function over what was measured. |
| GATE-3 adapter | `src/gate/gate3-gate.ts` | Registered in `defaultGates()`. Reads the round's gate run, audit, judge and isolation events from the ledger and the item directory, nothing else. |

## GATE-3

GATE-3 passes only when no condition below is present. `failed` lists every condition found. The route is J7 when
any isolation condition is present, otherwise J6. The route is advisory: it is recorded in `gate3.evaluated`, and the
line's J act comes from the outcome classifier, not from this field.

| Condition | Meaning |
|---|---|
| `canary_hit` | A canary appeared on an implementer-side surface. |
| `canary_not_scanned` | No scan, a scan with a missing surface, or a truncated scan. Never read as clean. |
| `judge_config_changed` | A file the gate commands name, or a runner config, is in the diff. |
| `judge_config_not_checked` | No judge file could be resolved from the gate commands. Never read as unchanged. |
| `contradiction_canary_passing` | The judge accepted a contradiction against the candidate. |
| `contradiction_canary_not_run` | No verdict for the candidate sha, or no contradiction scenario. |
| `gate_line_misconfigured` | See the gate line above. A `red` line passes GATE-3: a failing gate is a gate result, not an integrity failure. |
| `gate_line_not_run` | No gate run. |
| `isolation_below_declared` | The run level is below the declared level. |
| `isolation_unmeasured` | The run level reads `unmeasured`: no measurement at all, fewer than four stages measured, a stage with a record that contradicts itself (L2 with violations or on the host, or L3), an author stage that is missing because the seal is stamped `host_command`, superseded or absent, or the seal fold has anomalies. |

The tests are `tests/enforcement/E7c-empty-means-fail.test.ts` and `tests/enforcement/W-gate3-isolation.test.ts`.

## `omf doctor` is advisory

`omf doctor` always runs its container probe and marks the result `advisory`. Without a `[judge]` section (no `judge.docker_context`) it reports `unmeasurable` with the note "judge.docker_context is not set, so no container runtime is used"; it also reports `unmeasurable` when the daemon is unreachable, the endpoint is not a local socket or the base image is not already local. Otherwise it measures one throwaway golden container and reports L2 or L1. GATE-3 never reads `preflight.json`.
The level of a run comes only from `isolation.measured` events in the ledger; `isolation.json` and `audit-<round>.json` in
a run directory are views of those events.

## Not enforced

- A level measured on a real container is not enforced until a gated run is recorded in `docs/evidence/gated-runs.json`. The `docker inspect` parser is tested against recorded real output and the stage evaluator against fixtures; a fake Docker stands in everywhere else.
- `omf seal` runs the author container and `omf run` runs the implementer container (`src/author/` and `src/implementer/`, see `docs/author.md` and `docs/implementer.md`); both are tested offline against a fake Docker and, for the implementer, a real git, and neither has been run against a real daemon or model. Their behaviour in a real container and with a real model is not enforced until `G-implementer-boundary-real`, `G-implementer-real-run` and `G-e6-l2-leak-redteam` are recorded in `docs/evidence/gated-runs.json`, and for the author container until `G-author-boundary-real`, `G-author-canary` and `G-skeleton-real` are recorded. The golden values of the SUT and harness stages and the harness image digest are not enforced until their gated runs are recorded.
- A scenario set that is sealed against the implementer is not enforced by this page; see the design spec.
- OMF records the implementer's reported cost and bounds it per work item with `[w] max_model_usd`. OMF neither records nor bounds the spend of an author call; the only bound is the spend limit on the provider key.
- Requirement states are generated into [the conformance matrix](conformance-matrix.md). A requirement that needs a real container or model stays unproven until a gated run is recorded:
  - F6.vault-host-only: no agent session or container reads the vault. [not enforced: F6.vault-host-only]
  - S5.4.implementer-container: the implementer container on a real daemon with a real model. [not enforced: S5.4.implementer-container]
  - S7.l2-label: the label "sealed (container)" on a real run. [not enforced: S7.l2-label]
  - S7.docker-client-trusted: the measurement trusts the `docker` client found on PATH and the configured docker context. A replaced client, or a shim that answers the probe, can make every stage measure L2 through the shipped commands. [not enforced: S7.docker-client-trusted]
  - S5.3.author-measured-before-key: the author key reaches a container only after that container measured golden, on a real daemon with the real Codex CLI. [not enforced: S5.3.author-measured-before-key]

## Not implemented

The design states these requirements and v0.1 does not implement them. Each is a `deferred_to` entry in `docs/requirements.json`.

- F4.goal-closes-by-signature: not implemented (deferred to M4)
- F11.autonomy-dial: not implemented (deferred to after v0.1)
- S7.l3-label: not implemented (deferred to v0.3)
- S11.1.plugin-dir-shells: not implemented (deferred to after v0.1)
- S11.2.ship-only-pushes: not implemented (deferred to M4)
- S11.3.public-artifacts-in-worktree: not implemented (deferred to M4)
- S11.6.break-glass-events: not implemented (deferred to M4)

## Known limits

- A gate with zero rules that prints no `OMF_GATE_RULES` marker still reads `pass`.
- A gate script reached only through a directory argument (`eslint src`) is not a judge file.
- A test directory that `TEST_GLOBS` does not cover is missed unless the caller lists it.
- Compressed objects under `.git/` are not canary-scanned, and a re-encoded canary (base64) is not detected.
- A concurrent writer can swap a path component between the check and the open; hosts read a tree only after the container that wrote it has stopped.
- The item's stored risk is not rewritten by the audit; the effective risk lives in the audit record and the ledger event.

## Re-check against merged code

The skeleton listed what M3e depends on in milestones that were not merged when it was planned. Each row was run
against merged code before this task was committed. R9 describes M3e as merged: since M3f `defaultGates()` registers `gate3Gate()` (`src/gate/gate3-gate.ts`).

| ID | What was checked | Check | Result |
|---|---|---|---|
| R1 | Run id pattern copied into the gate event schema | the pattern text appears once in `schemas/work-event.schema.json` and once in `schemas/gate-event.schema.json` | confirmed |
| R2 | A claim-checked append of a non-W event fits `RecordSink` | `src/work/w-run.ts` and `src/work/w-verbs.ts` append W events only; `Ledger` is the `RecordSink` | confirmed |
| R3 | No clash on `<item.dir>/runs/<run_id>` | no other creator of that directory under `src/work` or `src/cli` | confirmed |
| R4 | `gates.*`, `audit.*`, `isolation.*` and `gate3.*` are inert for the W verifier | `tests/gate/gate-events-inert.test.ts` | confirmed |
| R5 | The outcome classifier takes the audit signals | `classifyOutcome` in `src/work/classify.ts`, fed by `auditInputsOf` in `src/audit/work-audit.ts` | deviation: the classifier input is the four `AuditInputs` fields (canary hits, tests edited, prove-test, judge config); `review_required` is not an input, and only its high-risk-path and judge-config parts reach the classifier |
| R6 | One gate-line formatter | `OMF_GATES` outside `src/gate/` appears only in a comment in `src/work/classify.ts` | confirmed |
| R7 | Evidence fields are filled by `WorkAudit` without loss | `unverified_areas`, `isolation_level` and `high_risk_paths_touched` in `src/work/evidence.ts` | deviation: the audit reaches the evidence through `auditInputsOf`, a translation step (counts become booleans, the prove-test result becomes pass, fail or not run) |
| R8 | M3e did not edit the reason code list or the W event schema | empty diff of the W event files against main and in the M3e part 1 merge | confirmed |
| R9 | GATE-3 is registered as required, with no caller yet | `unimplementedGate` for GATE-3 in `src/work/gates.ts` (always not_run); no caller of `evaluateGate3` | confirmed |
| R10 | `CommandTarget` and the `ScenarioRunner` port | `ScenarioRunner` in `src/scenario/runner.ts` and `CommandTarget` in `src/gate/ports.ts` | deviation: the port has `openScenario`, which returns a session with `runStep` and `close`, not a run method; a `CommandTarget` needs an adapter that opens one session per scenario |
| R11 | Canary source and contradiction-canary rule | `CANARY_PATTERN` in `src/scenario/types.ts` (43 characters, above the 16 minimum) and the `canary_missing` rule in `src/scenario/gate2.ts` | confirmed |
| R12 | The no-follow tree primitive is shared or left alone | `O_NOFOLLOW` in `src/git/tree-walk.ts`, `src/core/safe-fs.ts` and `src/vault/vault.ts`; all left as they are | confirmed |
| R13 | One canary scanner | `scanCanaries` in `src/audit/canary-scan.ts` and `scanWorktreeCanaries` in `src/vault/pokayoke.ts` | deviation: two scanners; the audit uses `scanCanaries`, and `scanWorktreeCanaries` has no caller in `src/`; both left alone until the run that supplies the vault canaries (M3f) |
| R14 | M3a names in `src/decision/types.ts` | the six exports | confirmed |
