# M3c: where the contract differs from the spec, and the seam M3b2 fills

The v0 spec (`docs/design/2026-10-12-omf-v0-design.md`, §5.0, §5.2, §5.3, §8, §11) is the intent. Where M3c had to
be more exact than the spec's examples, or could not wire into a part that is built in parallel, the choice is
recorded here. The schema files and the code are the contract; the spec's examples are not.

| # | Where | Spec says | M3c does | Why |
|---|---|---|---|---|
| V1 | `stdout_matches` | a bare string | a typed object: `{ kind: "exact", text }` or `{ kind: "anchored", pattern }` (`schemas/scenario.schema.json`, `src/scenario/matcher.ts`) | one string cannot say exact from pattern, and unanchored substring matching is not allowed. Patterns use OMF's own linear-time matcher, never a host `RegExp`. |
| V2 | scenario text | an `expect` with values | an `expect.note` that OMF prefixes with the scenario's canary, and no canary in any `invoke` | the note is assertion text that must never reach the implementer, which makes it the place a leak would show (`src/scenario/intake.ts`) |
| V3 | step state | not stated | the steps of one scenario share one scratch directory, every scenario starts in a fresh one, a process ended by a signal never satisfies an expectation, and an exact match is the whole stdout including the trailing newline (`src/scenario/runner.ts`) | contradiction detection compares invoke prefixes, and the container judge of a later milestone must run the same model |
| V4 | vault layout | `vault/scenarios/` | `vault/scenarios/<work-id>/<seal-id>/<scenario-id>.yaml`, one set directory per seal, never overwritten, never swept (`src/vault/vault.ts`) | two seals of one item cannot collide, and a crash leaves an orphan directory that no ledger event names |
| V5 | "a stub that returns errors or empty output" | one stub | two null implementations (`fixtures/null-error.mjs`, `fixtures/null-empty.mjs`) and an echo-everything stub (`fixtures/echo-everything.mjs`); every behavior scenario must fail both nulls | the two shapes pass different weak scenarios (`exit_code: 0` only, or an empty stdout only) |
| V6 | scenario status and exposure | fields in the scenario file | neither is in the file. Status is the ledger's (`scenario.status_changed`, default `active`); the exposure limit is the code constant `EXPOSURE_LIMIT` over a count function the feedback milestone supplies (`src/scenario/types.ts`) | a file edit can then neither loosen a check nor retire a scenario; an edited file is `set_tampered` through the set digest |
| V7 | GATE-2 failure routes | back to S2 | by cause: J2 when GATE-1 no longer passes; J3 for a ledger anomaly, a tampered, missing or unreadable set, a seal after the start, or a judge that is broken or gamed; J7 for a probe error; back to S2 only for author-quality reasons (`src/scenario/gate2.ts`, `src/scenario/gate2-adapter.ts`) | a reseal must never run the author again for a fault the author did not cause, and a deleted vault file is never replaced by a quiet reseal |
| V8 | wiring into the line | GATE-2 is a gate, S2 is a station | M3c ships the pieces and a pass over them, and does not edit M3b2: `evaluateGate2Step` (`src/scenario/gate2-adapter.ts`), `runS2Station` and `runS2ThenGate2` (`src/seal/station.ts`). The sequencer's registration is a few lines that M3b2 or M3h adds (below). | M3c is built in parallel with M3b2 and may merge first, so it depends only on what is on `main` |
| V9 | guard failures | M3c rule 4 (spec §8): refuse to run | a sealed file or a symlink under the state is a J7 stop with a closed code (`sealed_material_in_repo`, `symlink_in_state`, `unsafe_state_path`) at line entry and before each stage, GATE-2 included (a throw that is not a guard refusal is `gate_error`); the `decide` write actions and `beginRun` throw instead (`src/vault/line-guard.ts`, `src/cli/decide.ts`, `src/work/w-run.ts`) | the line needs a stop route; a person at a terminal needs the error |
| V10 | the author | a different vendor, sealed away from the implementer | a host command process behind the `AgentSession` port, labelled `author.isolation: "host_command"`; the stage result says `stored`, not `sealed` | sealing is not enforced: the stub sees the intent, spec and contract and can write anywhere its OS user can. M3c proves what OMF puts in the prompt and records, nothing about the author's reach. A container session is a later milestone. |

## The seam M3b2 fills

The M3b2 names below (`Gate.evaluate`, `defaultGates()`, `unimplementedGate`, `gate1ForItem`) come from the M3b2 plan and were not on `main` when M3c was built. Check them against M3b2's merged code before wiring. In that plan `Gate.evaluate` may return a promise. Registering GATE-2 and the S2 station is these steps, none of which M3c did:

1. In `defaultGates()`, replace `unimplementedGate("GATE-2")` with a gate whose `evaluate` calls `evaluateGate2Step` and maps the outcome: `verdict` to the tri-state (`pass`, `fail`, `not_run`), `reasons` to the reasons, and `next: "stop"` with `stop_route` to the route that ends the line at J2, J3 or J7 instead of the default back to S2.
2. Register the S2 station as `runS2Station` and map its `S2Next`: `gate2` continues, `retry_s2` loops under the visit cap, `stop` ends the line at its route. `runS2ThenGate2` is the same two calls in one unit and is what the line's tests use.
3. Call `assertLineSafe` at line entry and before every station. The stage functions run it themselves; this adds the entry check for stations that are not S2. `beginRun` (M3b1's run entry) and the `decide` writes already call it.
4. Replace the four-call GATE-1 snapshot inside `runSealStage` and `runGate2` with M3b2's `gate1ForItem`, when it exists.
5. Persist a `stop` as `needs-human.json` and the handoff record, and cap the `back_to_S2` loop (M3b2's visit counter).

The `work.started` event type is the string `WORK_STARTED_EVENT` (`src/scenario/events.ts`); `tests/enforcement/W-gate1-then-gate2-walk.test.ts` asserts it is the type M3b1 writes.

## Known limits

The symlink guard does not stop a writer that races the walk (spec §8). The poka-yoke is a name and canary scan, not a proof. GATE-2 requires one contradiction canary per set but cannot require a useful one beyond the static rule. The contradiction-canary rule proves static unsatisfiability only for the shape "exact `stdout_matches` plus `json_path` entries that the exact text cannot satisfy"; `exit_code` never counts toward it. `fixtures/**` and `src/scenario/fixtures.ts` are guarded by review and a drift test only; CODEOWNERS and branch protection are an owner decision.
