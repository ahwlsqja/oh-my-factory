# M3d re-check of its Depends-on list

M3d was planned before M3b2 and M3c merged. This is the record of reading the merged code against everything the
M3d plan assumed from them. Each row ends with `verified` or `diff: <what> -> <where it is handled>`.
A row is changed here, never silently fixed in code: the commands that produced the rows are the list below the table.

| Row | Dependency | Needed by | Result |
|---|---|---|---|
| R1 | `classifyWEvent` and `lastStateEvent` in `src/work/w-events.ts` keep the signatures M3d read | `src/work/recent-outcomes.ts` | verified |
| R2 | `W_REASON_CODES` holds the four M3d codes and `schemas/work-event.schema.json` lists the same ones (equality test in `tests/work/w-events.test.ts`) | `src/feedback/test-run.ts`, `noise.ts` | verified |
| R3 | `dispositionOf` in `src/work/outcome.ts` maps the new codes to park/unchanged and flawed/`noise_unverified` to submit/`not_recommended` | `tests/feedback/test-run.test.ts` | verified |
| R4 | `verifiedItems(...).repairable` carries `work_id` | `recentOutcomes` callers in `src/goal/reconcile.ts` | verified |
| R5 | The test helpers `recordW` and `seedWorkItem` exist under `tests/helpers/` | `tests/work/recent-outcomes.test.ts`, `tests/enforcement/W-aggregates-counts-only.test.ts` | verified |
| R6 | A `manual` park refuses re-entry (`src/work/w-run.ts`), which is why the test-split blocks are `blocked` | `testRunBlock` | verified |
| R7 | The caller of `releaseFeedback` holds the item claim; no caller exists outside `src/feedback` yet, so there is nothing to read | `releaseFeedback` | verified |
| R8 | Evidence `noise_check` is the string enum `ok`, `within_variance`, `not_evaluated`, `not run`, not an object | `NoiseCheck` | diff: the object does not fit the string enum -> `noiseCheckField` in `src/feedback/test-run.ts` adapts it: `not run` when there is no check, `not_evaluated` for every computed check including k < 2 (kept fail closed: both are unverified areas); a flaky scenario reaches the classifier through the sealed counts as `flaky_scenario`, `noise_unverified` stays reserved with no producer, and the S6 station (M3f) does the wiring |
| R9 | Evidence `sealed.test` is `{ pass, total }` or `"not run"`, with no `flaky` and no other word | `SealedTestField` | diff: `SealedTestField` has two more words and a flaky count -> `evidenceSealedTest` in `src/feedback/test-run.ts` |
| R10 | The line maps the `withheld` reasons and the `FeedbackError` codes to reason codes, and calls `feedbackEntryCheck` after the seal stands and before the round opens | `releaseFeedback`, `feedbackEntryCheck` | diff: no station calls `releaseFeedback`, `planTestRun` or `feedbackEntryCheck` yet, so the mapping is not wired -> the S6 station (M3f) adds the calls, the mapping and its `disclosure_unavailable` code |
| R11 | The line order puts S6 after GATE-3 and before GATE-4 | `planTestRun` placement | verified: S7 stays last |
| R12 | M3f: k repetitions default to 2 or more, and the judge station builds `ScenarioResult` and supplies the candidate sha | `noiseCheck`, the E2-W-b mapper | diff: M3f is not merged -> carried to M3f: k >= 2 by default, and a re-run of this canary set through the real mapper |
| R13 | M3c seal and GATE-2 produce at least 5 train scenarios per work item | `releaseFeedback` `too_few_scenarios` | diff: GATE-2 needs fewer than 5 train scenarios -> a smaller set ends `blocked` with `scenarios_exhausted` at the first release; the walking-skeleton fixture must seed 5 or more |
| R14 | M3c `splitDigest(set, statuses, split)` is the digest source for `train_digest` and `test_digest`, and it changes when a scenario or its `decision_refs` change | `ReleaseInput.trainDigest`, `beginTestRun` | verified |
| R15 | M3c GATE-2 `exposure_exhausted` calls `ExposureCount = ({split, digest}) => number` (no `reserveExposure`, no `scenario.exposed` event), and M3d supplies it | `exposureCountFor`, `exposureUnitsOf` | verified: `exposureCountFor` returns the (goal, work item) count for any key, and `src/scenario/gate2-gate.ts` passes it to GATE-2 |
| R16 | Linked `decision_refs` resolve to `decision.class` through `foldDecisions` | the E2-W-b mapper | verified |
| R17 | `DECISION_CLASSES` and `DecisionClass` in `src/decision/types.ts` | `src/feedback/types.ts` | verified |
| R18 | A started item always reuses its standing seal (`src/seal/seal.ts`), so a rerun gets the same train and test digests | the handoff routes of `test_run_incomplete`, `test_reseal_required`, `scenarios_exhausted` | diff: a rerun cannot clear these states -> their routes offer `review` (show, veto) only; a fresh test digest is reachable only through a scenario status change, and the reseal verb (M3h) must add its own option |

## Commands

The commands that produced the table (run from the repository root):

- R1: `grep -n "export function classifyWEvent\|export function lastStateEvent" src/work/w-events.ts`
- R2: `grep -n "test_run_incomplete\|test_reseal_required\|noise_unverified\|scenarios_exhausted" src/work/w-events.ts schemas/work-event.schema.json` and `npx vitest run tests/work/w-events.test.ts`
- R3: `npx vitest run tests/feedback/test-run.test.ts`
- R4: `grep -n "repairable" src/work/ledger-verify.ts`
- R5: `grep -rn "export function recordW\|export function seedWorkItem" tests/helpers`
- R6: `grep -rn "manual" src/work/w-run.ts src/work/outcome.ts`
- R7: `grep -rln "releaseFeedback\|beginTestRun\|planTestRun\|feedbackEntryCheck" src --include='*.ts'`
- R8, R9: `grep -n "noise_check\|sealed" schemas/evidence.schema.json`
- R10: `grep -rn "scenarios_exhausted\|disclosure_exhausted\|testRunBlock" src --include='*.ts'`
- R11: `grep -n "export const LINE_ORDER" src/work/line-types.ts`
- R13, R14: `grep -rn "train_digest\|test_digest\|splitDigest" src --include='*.ts'`
- R15: `grep -rn "ExposureCount\|exposure_exhausted" src --include='*.ts'`
- R18: `grep -n "reused" src/seal/seal.ts`
- R16, R17: `grep -rn "export function foldDecisions\|export const DECISION_CLASSES" src`

R12 has no command: M3f is not merged.
