# oh-my-factory (OMF) — v0 Design

- Status: Draft for owner review
- Date: 2026-10-12
- Canonical language: English. Korean translation: `docs/ko/design/2026-10-12-omf-v0-design.md`
- Sources and read status: `docs/design/references.md`

## 0. Summary

oh-my-factory (OMF) is an open-source software factory for coding agents. It runs on top of
Claude Code and Codex CLI and does not replace either of them.

A person approves a **goal**: an objective, a measurement, and an approach. OMF measures the gap
between the current value and the target and turns that gap into work. Each work item goes through
a verification line. A person resolves the design decisions. A different vendor writes sealed
acceptance scenarios that the implementer never sees. The implementer works in an isolated
container. A trusted harness judges the result in a second, disposable container. The implementer
gets back masked feedback only. People review **decisions and evidence**, not every line of code.
People also merge, and people sign off that the goal was met.

OMF is not:

- a new agent runtime. It drives the stock CLIs.
- an auto-merge or auto-deploy tool.
- an installer that rewrites the user's `AGENTS.md`, `CLAUDE.md`, `.claude/`, `~/.claude` or
  `~/.codex`.
- a way to stop thinking. It moves human judgment to where it is cheapest and most useful.
- a claim of effectiveness. OMF measures itself and reports what it finds (§12).

## 1. Philosophy and sources

The sources are listed in priority order. When they conflict, the higher one wins, unless a
lower one names a concrete failure mode that the higher one does not address.

1. **Will Larson, "Trying the software factory pattern"** (lethain.com; read in full). "The
   software factory pattern is looping on a broad goal, and then relying on the harness to drive
   progress towards that goal." His `/linear-project-loop` has four steps:
   1. Audit the project's goal definition. This means an RFC that describes the goals, how they are
      measured, and the approach, plus dashboards or queries that measure progress against them.
      If any of these is missing, iterate with the user to create it.
   2. Review the state of the metrics and the issues. Add newly identified work, and update issues
      that have moved.
   3. Work on the non-blocked tasks: write or update a pull request, ping for review, ask a
      clarifying question.
   4. When a task completes, take the next one if the project description is fresh. If it has not
      been updated in a while, rerun the loop from step 1.

   The insight behind it: agents "didn't have the ability to evaluate if they were going in the
   right direction, or if it was missing necessary tasks. Now it does." Larson had been
   "accidentally hoarding parts of the state for myself regarding the goals of the project." The
   same loop in "a less frequent post-release mode" catches adoption spikes or rising error rates.
   The pieces compound only together: goal tracking (Datadog MCP, Snowflake), Linear as "the single
   source of state for the company's work", and "an orchestrated harness that can perform work
   independently from your laptop". Larson tentatively attributes the term to Justin McCarthy of
   StrongDM (February 2026).
2. **Anthropic, "The AI-native SDLC playbook"** (claude.com, 2026-08-21; PDF read). This is the same
   idea applied to the whole lifecycle, written against real Claude Code features. "A stage ends by
   committing an artifact with the commit initiating the next stage": `intent.md` → `spec.md` →
   `plan.md` → merged PR → pipeline, "and a breached control band in production writes the next
   intent.md and so the loop continues." "Detection stays deterministic. Claude is invoked once a
   band is breached, and the tier sets what it may do." Every play pairs a leading indicator with a
   lagging indicator. OMF uses the playbook as its **reference implementation for the tool layer
   and the artifact chain**.
3. **StrongDM, Software Factory** (factory.strongdm.ai; all pages read). "Seed → Validation
   harness → Feedback loop. Tokens are the fuel." "The loop runs until the holdout scenarios pass
   (and stay passing)." A test stored in the codebase "can be lazily rewritten to match the code",
   so a scenario is "an end-to-end 'user story', often stored outside the codebase (similar to a
   'holdout' set in model training)". Satisfaction asks: "of all the observed trajectories through
   all the scenarios, what fraction of them likely satisfy the user?" Other ideas used here:
   - The Digital Twin Universe: "replicate behavior at the boundary", validated against the live
     dependency "until we stop finding behavioral differences".
   - Shift work, which separates interactive work from fully specified work.
   - The functional versus non-functional split: the difficulty of a plausible Instagram clone
     "lies primarily outside the functional specification: scalability, performance,
     availability, security, efficiency".
   - Attractor, an open spec for a graph-of-phases pipeline with many community implementations.
   - The Weather Report, which publishes which model plays which role.
4. **Piotr Sarnacki, "I'm sorry, but you still have to think"** (read in full). "If your prompt is
   not specific enough, many decisions are a coin flip": backwards compatibility, latency versus
   throughput, memory under load, losing notifications after a crash. A single metric misleads.
   His benchmarks used constant arrival rate and compared delivery, errors, latency and memory
   together. "If you want a reliable system you should know when to fail."
   **Addy Osmani, "Human judgment doesn't leave the software factory. It relocates."** (read in
   full). "Someone still chooses the problem. Someone still chooses the architecture. Someone still
   sets the quality bar. Someone decides which verification signals deserve trust. Someone decides
   when the evidence is sufficient to ship." Also: "Consider optimising the software factory for
   your reviewer." "Verification buys you trust, and it buys the ability to grant more autonomy to
   your agents." A factory earns its keep when it is "stopping production when human review is
   falling behind".
5. Context: DHH (hand-written code is no longer economically productive for most programmers),
   Tunguz ("Thinking in Systems, Shipping in Loops"), Dan Shapiro (the five levels).

**How the tension is resolved.** StrongDM's rules are "Code must not be written by humans" and
"Code must not be reviewed by humans". Its validation constraint says code is "validated
automatically without semantic inspection of source", treated like "opaque weights whose
correctness is inferred exclusively from externally observable behavior". Sarnacki and Osmani want
human thinking, and Osmani wants a "lights-on" factory with targeted review. OMF deliberately
departs from StrongDM on one point: **targeted code review stays**. It is required on high-risk
paths and optional elsewhere. Everything else changes **what** people work on rather than removing
them:
- People approve goals and measurements before work starts (J1).
- They resolve design decisions before implementation (J2).
- They choose which signals to trust (J3).
- They judge evidence at merge (J4) and sign off on the goal (J5).

**Corrections from reading the originals.**
- The sentence "task completion ≠ goal achievement" is not in Larson's post. It is the GeekNews
  summary's reading of it. OMF states it as its own invariant (F4).
- Larson's loop has four steps, not five. Measurement is checked inside step 1.

## 2. First principles

Each mechanism below must be backed by an enforcement test in `tests/enforcement/` (§13). A claim
without a test is labeled "not enforced".

| # | Principle | Source | Mechanism |
|---|---|---|---|
| F1 | The top-level unit is a goal. Work is derived from it. | Larson; playbook | `goal.md` is the entry point. Every work item carries `goal_id`. Manual seeds without one are allowed but warned. |
| F2 | No loop without measurement. Whoever builds a metric must not judge their own success with it. | Larson; Goodhart | `omf goal audit` fails closed. Agent-proposed metrics stay `proposed` until J1 approves them. Approved metrics are hash-locked in the Metric Vault. |
| F3 | Code controls the loop. Models interpret and implement. | Larson; playbook | A deterministic state machine, deterministic detection (bands), budgets kept outside the session, no automatic extension. |
| F4 | Task completion is not goal achievement (OMF invariant). | GeekNews summary of Larson | Agents produce at most a `candidate`. A goal closes only by human signature (J5). |
| F5 | Keep watching after launch. | Larson; playbook Stage 6 | `mode: watch` with `bands.yaml`. Regressions reopen the goal. |
| F6 | Verification and measurement live outside generation. | StrongDM | Vaults are host-only: no agent session or container can read them, except the harness container during S4. People can read them. A different vendor authors the scenarios. The implementer never sees scenarios, metric values or thresholds. |
| F7 | Success is reported with uncertainty. Unevaluated means undetermined, not passed. | StrongDM; evals literature | Deterministic checks run first. Anything unevaluated is `undetermined`. Interval estimates are used once there are enough independent scenarios (v0.3). |
| F8 | Only fully specified work runs autonomously. | StrongDM (shift work) | Execution is blocked while any required decision is open. |
| F9 | People decide, and the factory makes deciding cheap. | Sarnacki; Osmani | Decision interview, evidence report with an "unverified areas" list at the top, handoff packet that names the decision required. |
| F10 | Human bandwidth does not scale with agent count. | Osmani; Larson | WIP caps. `STOP_IF`: new production stops when unreviewed evidence piles up. |
| F11 | Autonomy is a dial, widened only by accumulated evidence. | Osmani; playbook tiers | Autonomy level × risk tier grid. Promotion requires recorded evidence. |

The poka-yoke principle ("the skill makes violations rare and the hook makes them close to
impossible", playbook) applies to every rule. Prompts and skills are advisory. Containers,
permissions, schemas and deterministic checks enforce. Hooks are signals, not security boundaries.

## 3. Layer model

```
human judgment   J1 goal/metrics/guardrails   J2 design decisions   J3 trusted signals,
(before)                 |                         |                    high-risk paths
                         |                         |                J7 isolation/security   J8 budget
       +-----------------v---------- G  GOAL LOOP (Larson + playbook Stage 6) --------------------+
       | audit -> measure -> evaluate (gap-to-target, bands) -> reconcile -> dispatch -> refresh  |
       | mode: build (push toward target) | watch (low-frequency, after launch)                   |
       +-----------------+-------------------------------------------------------^----------------+
            down: goal_id + intent.md (no metric values,         up: outcome class, deterministic
                  thresholds or queries)                             results, open decisions
       +-----------------v---------- W  WORK VERIFICATION LOOP (StrongDM) -------+----------------+
       | S1 decide (spec.md + ledger) -> S2 seal (other vendor) -> S3 implement (plan.md, code)    |
       | -> S4 judge (two containers) -> S5 audit -> S6 masked feedback -> S7 evidence report      |
       +--------------------------------------------------------------------------------------------+
human judgment   J4 merge (gate)   J5 goal sign-off (async)   J6 stall / repeated blocker (async)
(after / async)

X  EXECUTION     L2 devcontainer (default) | L3 L2 + egress allowlist + leak red-team per run
                 L1 local sandbox exists only as "no sealing guarantee"
   SHARED STATE  host-only: ledger (hash chain), Metric Vault, Scenario Vault, run records
                 public (opt-in, in repo, committed by humans): goal.md, intent.md, spec.md, plan.md
                 tracker adapter: one source of truth per artifact
```

| Layer | Responsibility | Humans decide | Humans do not decide |
|---|---|---|---|
| G goal loop | Audit goals, measure, compute the gap, check bands, generate and update work, refresh, watch | J1, J5 | Variation inside the bands, deduplication, state transitions |
| W work verification loop | Decisions, sealed scenarios, implementation, judging, audit, feedback, evidence | J2, J3, J4 | Retry counts, deterministic results, re-asking settled decisions |
| X execution | Enforce the isolation level, check that vaults are not mounted, control egress | J7 | Individual permission prompts once the isolation checks pass |
| Shared state | Append-only ledger, budgets, single source of truth, marker comments | Which tracker is the source | Ledger writes, idempotency keys, stall signatures |

## 4. Goal loop (G)

### 4.1 `goal.md`

The format follows Larson's RFC requirements (goal, measurement, approach). It lives in the repo
under an opt-in directory (default `factory/goals/<goal_id>/goal.md`) or in host state if the owner
declines repo files.

```yaml
---
schema_version: 1
goal_id: g-<slug>
title: "..."
mode: build            # build | watch
kind: default          # default | migration
objective: "..."       # the outcome in plain words
target:                # what "met" means; J1 locks it
  metric_id: m-<slug>
  operator: "<="       # <= | >= | ==
  value: 250
  unit: ms
leading: [m-<slug>]    # moved by our work
lagging: [m-<slug>]    # the real goal
link_hypothesis: "..." # why leading should move lagging; falsifiable
guardrails: [m-<slug>] # append-only; removal requires J1
prereg:                # pre-registration, locked with the goal
  min_observation: 7d
  decision_rule: "target met for 2 consecutive measurements and no guardrail breach"
  metrics_judged: 1
budget:                # required; no default extension
  rounds: 10
  wall_time: 72h
  max_open_work_items: 2
state_source: markdown # markdown | github | linear | jira  (exactly one)
---
## Approach
...
```

When J1 approves, the semantic fields are canonicalized and hashed into the Metric Vault: `target`,
`leading`, `lagging`, `link_hypothesis`, `guardrails`, `prereg`, `mode` and `budget`. A repo copy is
treated as a convenience copy. If its hash differs from the locked one, OMF records a **regime
change**. A regime change blocks `candidate` until J1 re-approves.

`kind: migration` adds the playbook from Larson's "Migrations" post (2018): derisk, enable,
finish. First "stop the bleeding" so that all new code uses the new approach, for example with a
linter ratchet. Then "build tooling to programmatically migrate the easy ninety-percent", keeping
the tools "incremental and reversible". The long tail is finished by the team leading the
migration. "Done" is a measured remainder of zero.

### 4.2 Metric Vault and `metrics.lock`

```json
{
  "schema_version": 1,
  "metric_id": "m-p95-latency",
  "command": "<argv run inside the measure container>",
  "query": null,
  "unit": "ms",
  "owner": "human:<id>",
  "approved_by": "human:<id>",
  "approved_at": "<RFC3339>",
  "sha256": "<hash of command+query+inputs>",
  "watched_paths": ["src/telemetry/**", "..."],
  "regime": 1
}
```

- Measurement runs in a disposable, network-restricted container with **read-only credentials**.
  "Read-only" is enforced by the credential's scope, not by trusting the command. Data from
  external systems is fetched by the host with read-only credentials and injected.
- `watched_paths` is derived mechanically where possible: event names, log strings and columns
  referenced by the query are resolved to source paths. People can add paths (J3). A PR that touches
  a watched path is automatically high-risk (§6) and needs a diff review at J4.
- Metric outputs are untrusted data. They are never interpreted as instructions.
- An agent may draft a metric (Larson's "build it with the user"). The draft follows the same
  separation as scenarios: a different vendor, in a one-shot session. It stays `proposed` until J1
  approves it. To make the approval cheap, J1 sees the metric's history, a sensitivity check (what
  changes move it), and a negative control (a deliberately bad change should make it worse).

### 4.3 Triggers and `bands.yaml`

The goal loop wakes for three reasons:

1. **Gap to target** (Larson, build mode): the locked target is not yet met.
2. **Band breach** (playbook Stage 6, watch mode): a deterministic detector over a rolling
   baseline fires. OMF uses the playbook's `bands.yaml` format unchanged:

   ```yaml
   metric: ci_test_failure_rate
   baseline: rolling_30d
   rules: western_electric
   tiers:
     1sigma: { action: log }
     2sigma: { action: diagnose, tools: "Read,Grep,Bash(gh run view *)" }
     3sigma: { action: propose, routes: [pull_request, runbook:rollback-deploy] }
   ```

   Detection is a versioned, unit-tested script, and no model is involved. `diagnose` runs
   read-only. `propose` may only open work that goes through W and the merge gate, or trigger a
   pre-approved runbook.
3. **Events**: a ticket, a channel message, or a schedule. Each one produces an `intent.md` draft
   that enters the same queue.

A work item may be created only if there is a gap or a breach. Being inside the bands does not
excuse a gap to target. Being at target does not excuse a breach.

### 4.4 `omf goal tick`

One tick is one pass of Larson's loop. A tick is non-interactive and stateless apart from host
state, so a scheduler, CI, or a person can run it.

1. **audit**: verify the goal hash, the metric locks, the ledger hash chain, the budget, and the
   prerequisites. Any failure stops the tick and is recorded. Missing prerequisites lead to an
   interview (J1).
2. **measure**: run the locked measurements and record value, input hash and lock hash.
3. **evaluate**: compute the gap to target, then the bands. A breach of `log` is recorded only.
4. **reconcile**: a model proposes work.
   - Input: the gap summary (direction and size), open work items, recent outcome aggregates,
     and the goal's approach text.
   - Output: `intent.md` candidates in the playbook's Stage 1 format, each with a rationale field.
   - Deterministic filters then apply: fingerprint deduplication, the WIP cap, seed lint (§4.6),
     and a mechanical risk class (§6).
5. **dispatch**: candidates inside the approved goal scope and WIP cap start automatically. The
   human gets an asynchronous veto in the gap report. High-risk candidates wait for per-item
   approval. Each started item takes a claim lock in host state, so two `omf` processes cannot
   work the same item (Osmani: "avoiding different sessions from claiming the same issue").
6. **refresh**: decide whether `goal.md` is stale using deterministic signals: time since the last
   approval, merged PRs since then, and metric movement. A model does not make this call. If the
   goal is stale, the next tick starts with a J1 re-interview.

Termination states are fixed to `finish`, `blocked_on_user`, `failed` and `cancelled`. Progress is
tracked by a signature built from work ids, update times and metric values. An unchanged signature
is not retried; it escalates to J6. The same blocker signature appearing three times also
escalates to J6. Budgets accumulate in the host ledger. They do not reset on restart and are never
extended automatically (J8).

### 4.5 Declaring success

An agent can only produce a `candidate`. A candidate requires all of the following:

- The pre-registered decision rule is met.
- Every guardrail was evaluated and passed. An unevaluated guardrail makes the result
  `undetermined`.
- No regime change happened in the observation window, and all lock hashes match.
- The minimum observation period has elapsed.

The evidence states an attribution grade: experiment, quasi-experiment, or before/after. A
before/after comparison is labeled "correlational". The goal closes only with J5. After sign-off,
watch mode re-measures after the minimum observation period and reopens the goal if it regressed.
This guards against novelty effects.

### 4.6 Anti-gaming between layers

| Path | Block | Enforcement test |
|---|---|---|
| Tampering with metric code | `watched_paths`; a change marks a regime change and forces a diff review at J4 | `E1 metric-tamper-stops` |
| Agent authors and judges its own metric | Separate authoring session, then J1 approval, then a hash lock | `E1` (unapproved metric → no candidate) |
| Metric values leaking down into work | The work item schema rejects value, threshold and query fields. Seed lint rejects numeric thresholds and metric names. The gap report is written to host state only. | `E2 canary-no-leak` |
| Re-seeding as an unbounded feedback channel | Re-seeds from G count against the same disclosure budget as S6 | `E3 budget-no-reset` |
| Scenario text reaching G | G receives aggregates only | `E2` |
| Budget reset by restart | Host ledger accumulation, hash chain | `E3` |
| Write tools on observability | The Measure adapter exposes read-only operations; credentials are read-only | conformance suite |

Known limits: canaries catch verbatim leaks, not paraphrase. Undeclared instrumentation paths
remain a hole. Data can still leave through the model API path even with the network disabled. A
bad metric approved by a person stays bad, and the lock only makes it stable.

## 5. Work verification loop (W)

### 5.1 Artifact chain

The public chain follows the playbook. These files live in an opt-in repo directory and are
committed by people through PRs. OMF never commits them to the user's branches.

| Artifact | Producer | Content |
|---|---|---|
| `intent.md` | G reconcile, an event, or a person | Playbook Stage 1 format: Problem, Proposed outcome, Affected users and systems, Constraints, Open questions, plus `goal_id` |
| `spec.md` | S1 | Requirements and the resolved decisions. This is a projection of the decision ledger. |
| `plan.md` | S3 (plan first) | Implementation plan. It is updated in the same commit if the implementation deviates. |
| candidate branch `omf/<work-id>` | S3 | Code and the implementer's own tests, in an OMF-owned worktree |
| `evidence.md` and `evidence.json` | S7 | §5.8 |

The sealed chain is host-only: decision ledger events, scenarios, verdicts, run records.

### 5.2 S1 decide: the decision ledger

Each entry is one event in an append-only JSONL log. `spec.md` is rendered from it.

```yaml
id: NFR-queue-1
class: interface | compatibility | latency | throughput | memory | durability
     | queue_bound | data_model | error_semantics | security | other
question: "..."
qas: { source, stimulus, environment, artifact, response }  # SEI quality attribute scenario
response_measure: { metric, op, threshold, unit, percentile, window }
status: open | resolved | deferred | na
resolution: { choice, rationale, rejected: [], by: "human:<id>", at }
deferral: { owner, reason, revisit_trigger, default, signed_by: "human:<id>", expires_at }
```

- `interface` is mandatory. It holds the build and run commands, the black-box kind (`cli` or
  `http` in v0.1), and the I/O contract. Without it, scenarios cannot be written before the code
  exists.
- A `resolved` entry needs a numeric `response_measure` wherever the class is quantitative.
- A `deferred` entry needs a human-signed default.
- Lint is deterministic: required fields present, thresholds numeric, no open required classes,
  every resolved decision linked to at least one scenario. The scenario link is checked on the
  host side; the ledger stores opaque references only.
- **Divergence probe** (v0.2, optional in v0.1): three independent cheap plans are drafted from
  the same intent. Behavioral differences between them surface decisions nobody stated. Each
  difference becomes an `open` question. This addresses decisions that were never written down, as
  opposed to decisions that were written down but left open.

Execution is blocked while a required decision is open (F8, J2).

### 5.3 S2 seal

- The author is the vendor that is not implementing (default: Codex). It runs as
  `codex exec --ephemeral` with an OMF-owned `CODEX_HOME`. Sealing is refused from interactive
  sessions, because their transcripts persist.
- Inputs are `intent.md`, `spec.md` and the interface contract. Plans and code are never inputs.
- Outputs go to the Scenario Vault only:

```yaml
schema_version: 1
scenario_id: <opaque random id>
work_id: w-<id>
author: { vendor: codex, model: "<id>", at: "<RFC3339>" }  # must precede implementation start
decision_refs: [NFR-queue-1]
kind: behavior | nfr | contradiction_canary
split: train | test
interface: cli | http
steps:
  - invoke: { argv: [...], stdin: "..." }      # or { method, path, body }
    expect: { exit_code: 0, stdout_matches: "...", json_path: { ... } }
nfr_probe: { arrival_rate, duration, thresholds: { p95_ms, error_rate, drop_rate } }  # optional
canary: "<per-scenario random GUID>"
exposure: { count: 0, limit: 20 }
status: active | retired | contaminated
```

**GATE-2: scenario validity.** This gate runs before implementation starts.

- A null implementation (an interface stub that returns errors or empty output) must fail every
  `behavior` scenario.
- Scenarios must not contradict each other or the ledger thresholds.
- `contradiction_canary` scenarios must fail against any implementation. If one passes, either the
  judge is broken or the result is being gamed.
- A person may sample scenarios from the vault (J3). People can see the vault. The evidence report
  carries aggregates only.

### 5.4 S3 implement

- The implementer is the other vendor (default: Claude Code). It runs headless in the L2
  devcontainer. Inputs are `intent.md`, `spec.md` and the repo. Vaults, host state, other vendors'
  CLIs and their credentials are absent from the container.
- The implementer starts with a plan and commits `plan.md` to the candidate branch.
- Settings come from OMF-generated `--settings` and restricted `--setting-sources`. OMF does not
  use `--bare`, because bare mode ignores subscription OAuth. The user's repo settings are never
  edited.
- Editing existing test files is forbidden in unattended runs. If the implementer believes a test
  is wrong, it raises a spec-conflict request instead (`request_human_input` to J2, §6.2).

### 5.5 S4 judge: the two-container contract

This contract resolves the conflict between "vaults are never mounted" and "the judge must run the
scenarios".

```
 [SUT container]  built from candidate sha; no vault; no persistent mounts;
       ^          network: only the private harness bridge
       |  interface calls only (argv/stdin via exec bridge, or HTTP on the bridge)
 [harness container]  scenarios + runner; read-only; disposable; no internet
       |
       v  verdict JSON (schema-validated) -> host
```

The SUT receives the **inputs** of each call. It never receives the scenario files, the expected
outputs or the assertions. Both containers are destroyed after every round, and caches are not
shared between rounds.

Order of checks:

1. Deterministic gates run in fast, full, deep order (verification budget; addyosmani/factory
   `gates.sh` pattern). The result is one machine-readable line, for example
   `OMF_GATES: fast=pass full=pass deep=skip`. A missing required gate is `MISCONFIGURED`, never
   green.
2. Sealed scenarios run with k repetitions to detect flakiness. v0.1 reports pass/fail plus flaky
   retries. Probability and Wilson intervals start in v0.3, once there are enough independent
   scenarios. Repeating a deterministic check measures flakiness, not generalization.
3. `prove-test` (addyosmani/factory): revert the non-test hunks and confirm that the implementer's
   own tests fail. This runs as supplementary evidence.
4. LLM judging (v0.3): a third session, read-only, from a vendor other than the implementer's. It
   scores twice with the A/B order swapped, and splits are recorded as ties.

### 5.6 Outcome taxonomy

OMF uses the run outcome classes described by Osmani and Vercel.

| Outcome | Meaning | Next step |
|---|---|---|
| `success` | All required gates passed, sealed scenarios passed, no audit flag | Evidence report → J4 |
| `flawed` | "The wrong thing was implemented or maybe it didn't have full context" (Osmani). OMF also files green-but-wrong results here: `prove-test` failed, a canary was hit, a test was edited, or open tests pass while sealed ones fail. | Masked feedback, or J6 if repeated |
| `blocked` | "The environment may have been missing a credential" (Osmani), other infrastructure faults, or a missing decision | Fix the environment, or J2 |
| `manual` | "A boundary the factory may not be allowed to cross yet" (Osmani). This is a trust boundary, and a person must act. | Handoff packet (§6.3). "A manual run isn't finished when the factory stops but when the human knows what to do next." |

Only `success` reaches J4 with a merge recommendation. Osmani notes that two of the three
non-success classes "may have mechanical fixes and the last one is about trust". The taxonomy is
always reported together with per-stage timing. Without the timing, "you know a run came back
flawed without knowing what finding out cost you".

### 5.7 S6 masked feedback

- Feedback uses the `train` split only. The `test` split is used exactly once, at the end.
- Feedback carries per-category pass ratios. A category with fewer than 5 scenarios is merged into
  a larger one before release.
- The release rule follows the Ladder: a new score is released only if it beats the best released
  score by at least `max(0.1, 1/sqrt(n))`, where `n` is the number of scenarios in the released category. Otherwise the previous released score is repeated.
  Releases are counted per goal and scenario set, so switching work items does not reset the
  budget.
- Feedback never contains scenario ids, inputs, expected outputs or assertion text.

### 5.8 S7 evidence report

`evidence.md` is written for people and `evidence.json` for machines. The top of the report lists
**what automated verification did not cover**. That is where a reviewer should look.

```yaml
schema_version: 1
work_id; goal_id; outcome: success|flawed|blocked|manual
recommendation: merge_recommended | not_recommended | human_needed   # + reason
unverified_areas: [...]
decisions: [{ id, threshold, measured, status }]   # ledger vs. reality
gates: "OMF_GATES: ..."
sealed: { train: {pass, total, flaky}, test: {pass, total} | "not yet run" }
audit: { canary_hits, tests_edited, prove_test, judge_config_touched }
isolation_level: L2
high_risk_paths_touched: [...]                     # diff review required at J4 if non-empty
label: "pre-verified / goal impact not measured"
noise_check: "gain within run-to-run variance → not_recommended"
self_metrics: { stage_times, rounds, human_interventions_by_J, budget_used }
untrusted_fields: [plan_summary, implementer_notes]  # written by the implementer
```

## 6. Human judgment map

| J | When | Decision | Default |
|---|---|---|---|
| J1 | Before | Goal, metrics, target, guardrails, prereg ("choose the problem") | None |
| J2 | Before | Design decisions and the interface contract ("choose the architecture") | None. Execution is blocked while open. |
| J3 | Before, and whenever scenarios or watched paths change | Trusted signals, the high-risk path list, scenario promotion ("set the quality bar", "decide which signals to trust") | Trust deterministic checks only. The high-risk list starts from the defaults below. |
| J4 | Gate | Merge ("decide the evidence is enough") | None. Branch protection is checked by `omf doctor`, not set by OMF. |
| J5 | Async | Goal sign-off and reopening | None. The goal waits as `candidate`. |
| J6 | Async | Stall, repeated blocker, budget exhausted: continue, stop or redefine | Stay stopped |
| J7 | Before | Isolation level, security settings, break-glass | Every exception is recorded in the ledger |
| J8 | Before | Budget caps and raises | No automatic extension |

**Risk class is mechanical.** It is computed from the diff and paths, never chosen by an agent. The
default high-risk paths are CI and workflow files, authentication, migrations, watched
(instrumentation) paths, test files, goal and factory files, and lockfiles. People extend the list
at J3.

### 6.1 Back-pressure

`STOP_IF`: no new work is dispatched while three or more evidence reports are unreviewed. The
threshold is configurable at J8. This follows the addyosmani/factory charter pattern and F10.

### 6.2 Asking a person

OMF uses the shape of 12-factor-agents Factor 7 (CC BY-SA, attributed). The loop never blocks
waiting for an answer. It persists state, exits, and resumes when the answer arrives.

```yaml
request_human_input:
  id; j: J2; question; context; options: [...]; default: null
  urgency: low|normal|high; format: choice|text
  resume_token
```

Approvals (`approve`/`deny`) and questions are separate operations.

### 6.3 Handoff packet

A `manual` outcome, a J6 escalation, or any stop that needs a person produces a handoff packet.
The run counts as finished only when the packet tells the person what to do next.

```yaml
handoff:
  schema_version: 1
  work_id; goal_id; outcome
  state: "<where the loop stopped and why>"
  ran: ["<commands and gates that ran, with results>"]
  remaining: ["<work not done>"]
  risks: ["<known risks and unverified areas>"]
  decision_required: { j: J2|J3|J4|J6|J7|J8, question, options: [...] }
  resume: "omf answer <request-id>"
```

## 7. Execution and isolation

| Level | Implementer (S3) | Judge (S4) and measure | Label in evidence |
|---|---|---|---|
| L1 | Local sandbox (deny rules, emptied env) | Disposable container | "no sealing guarantee" |
| **L2 (default)** | Devcontainer, vault not mounted, only the implementer vendor's CLI and credential | Two-container contract | "sealed (container)" |
| L3 | L2 plus an egress allowlist (model API only) and a leak red-team test on every run | Same | "sealed (container, egress-restricted)" |

**Authentication.**

- Locally, subscription use across both vendors is supported. Only the implementer vendor's
  credential enters the implementer container.
- Threat model note: code executed inside that container can read that credential. L3 reduces
  exfiltration but does not remove it.
- Remote and CI use defaults to API keys. OMF never stores or brokers subscription tokens.
- Authoring and judging sessions use OMF-owned config homes. They copy only the credential file,
  with 0600 permissions, inside OMF host state.

**Untrusted input.** Issue bodies, channel messages and metric outputs are untrusted data. Triggers
pass identifiers only, and OMF reads the content itself (addyosmani/factory `factory-fire`
pattern).

## 8. Shared state

```
~/.omf/projects/<repo-hash>/
  ledger.jsonl          # append-only, hash chain, written only by the omf host process
  vault/metrics/        # metrics.lock files, goal semantic hashes, prereg
  vault/scenarios/      # sealed scenarios (never mounted into any container except the harness)
  runs/<UTC>-<stage>-<id>.md   # immutable run records
  worktrees/<work-id>/  # OMF-owned worktrees (git writes .git/worktrees and refs/heads/omf/*)
  config.toml           # includes [roles]: model and effort per role (author, implementer,
                        # judge, reconciler), in the spirit of StrongDM's Weather Report
```

Ledger envelope:

```json
{ "schema_version": 1, "seq": 42, "prev_hash": "<sha256>", "ts": "<RFC3339>",
  "actor": "omf | human:<id> | agent:<vendor>", "type": "<event type>", "payload": {} }
```

Every command verifies the chain before acting. If the chain is broken, OMF stops. Human signatures
in v0.1 are `human:<git user.email>` plus an interactive TTY confirmation. This is not
cryptographic. SSH-signed approvals are planned for v0.2.

**Trackers.** Each artifact has exactly one source of truth. This follows the playbook's
legacy-coexistence rule: the repo is the source, a legacy system is the source, or the two are
cross-linked. The adapter contract follows Symphony SPEC §11. Two read operations are required:
`fetch_issues_by_states` and `fetch_issues_by_ids`. Writes are optional, one verb per operation. No
generic CRUD is offered. Each issue gets one marker comment for progress. Metric values are never
written to trackers, only summaries and references.

## 9. CLI (v0.1)

| Command | Purpose |
|---|---|
| `omf init` | Create host state only. Writes nothing to the repo. |
| `omf doctor` | Detect CLIs, Docker, auth, isolation level, branch protection. Report the guarantees available in this environment. |
| `omf goal new` / `audit` / `approve` | Create `goal.md`, run the interview, J1, lock |
| `omf goal tick` | One G pass (§4.4) |
| `omf goal sign` | J5 |
| `omf decide <work-id>` | S1 interview, `spec.md`, J2 |
| `omf seal <work-id>` | S2 and GATE-2 |
| `omf run <work-id>` | S3 to S6 loop, bounded by budget |
| `omf report <work-id>` | S7 |
| `omf ship <work-id> --open-pr` | Push the candidate branch and open a PR. Runs only when a person invokes it. |
| `omf veto <work-id>` | Asynchronous veto of an auto-dispatched work item |
| `omf answer <request-id>` | Answer a `request_human_input` and resume |

## 10. Tool layer

**Packaging** follows oh-my-* conventions: one npm package `oh-my-factory`, one bin `omf`, Node 22
or later, TypeScript, Apache-2.0.

```
oh-my-factory/
  packages/core         state machine, ledger (hash chain), budgets, termination states, schema validation
  packages/goal         audit, measure, evaluate (gap + bands), reconcile, dispatch, refresh, watch
  packages/verify       decide, vault, seal, judge (two containers), gates, feedback, report
  packages/adapters     state-markdown | measure-cmd | runner-devcontainer
                        (later: state-github, state-linear, measure-mcp-readonly, runner-e2b)
  packages/conformance  adapter conformance suites (third-party adapters must pass)
  packages/cli          omf
  shells/claude-code-plugin, shells/codex-skill    (v0.2: thin; they call the CLI only)
  schemas/              *.schema.json (schema_version required)
  tests/enforcement     one test per control claim
  examples/hello-goal   offline end-to-end example
  docs/                 concepts, getting started, threat model, limits; docs/ko/ Korean
```

**References OMF follows** (from, not reinvented):

| What | From (license) |
|---|---|
| Artifact chain, bands, tiers, leading/lagging indicators, verifier, skill vs hook | Anthropic AI-native SDLC playbook |
| Plugin and skill layout, headless settings isolation, loop guards (four end states, blocker breaker, progress signature) | oh-my-claudecode, oh-my-codex, oh-my-openagent |
| Gate line, `MISCONFIGURED`, `prove-test`, `STOP_IF`, immutable run records, versioned handoff, identifier-only triggers | addyosmani/factory (MIT) |
| Run outcome classes | Vercel (blog); Osmani |
| Triage states, split between read-only judge job and write job | warpdotdev-demos/cloud-factory-demo (MIT) |
| Tracker adapter contract, marker comments | openai/symphony SPEC (Apache-2.0) |
| Measurement provider contract, "N consecutive failures" thresholds | Argo Rollouts, Flagger (Apache-2.0) |
| Human request contract, persist-and-exit | 12-factor-agents Factor 7 (CC BY-SA, attribution) |
| Devcontainer runtime; remote sandbox later | devcontainer spec and devcontainers/cli; E2B (Apache-2.0) |
| Decision fields; sealed-test score | SEI QAS; spec-kitty (MIT); shadow-score-spec (MIT) |
| Keep/revert on train/holdout | Anthropic "Automating eval design and hillclimbing" |
| Pipeline-as-graph (evaluate for v0.2): phases as nodes, human gates, checkpoints, goal gates | strongdm/attractor spec (Apache-2.0) and community implementations, especially Kilroy (Dan Shapiro, Go, git worktrees), Arc (TypeScript, holdout scenarios, convergence loops) and amolstrongdm's Attractor (satisfaction scoring against holdouts and twins) |
| Role-to-model routing, published and versioned | StrongDM Weather Report |
| Load probes | k6, invoked as a binary only (AGPL, no code copied) |

**Avoid:**
- Copying AGPL code (skorokithakis/symphony, Unleash bundles).
- Kayenta, which is archived.
- The HumanLayer SDK, which is deprecated.
- The Daytona core, which went closed.
- Installers that edit target repos (addyosmani/factory installer, Gas Town `bd init`, spec-kit).

## 11. Non-pollution and safety rules

These rules are enforced by `tests/enforcement`.

1. OMF only reads the user's `AGENTS.md`, `CLAUDE.md`, `.claude/`, `~/.claude` and `~/.codex`.
   Shells prefer `--plugin-dir` injection. Marketplace installation is opt-in and labeled "writes
   user scope".
2. OMF never auto-commits to user branches and never merges. Candidates live on local `omf/*`
   branches in OMF-owned worktrees. Push and PR creation happen only through `omf ship`.
3. Public artifacts (`goal.md`, `intent.md`, `spec.md`, `plan.md`) are written into the OMF
   worktree. People commit them through the normal PR flow.
4. A poka-yoke check refuses to run if sealed material (scenarios, locks, canaries) appears inside
   the repo.
5. Every run re-reads governance files. If they cannot be read, OMF stops rather than falling back
   to defaults.
6. Break-glass exceptions are J7 events in the ledger, with a reason and an expiry.

## 12. Measuring OMF itself

Self-metrics are chosen from the playbook's leading and lagging indicators and from Osmani's
"optimize for the reviewer":

- time per stage (intent → spec → plan → candidate → evidence → merge)
- first-pass `success` rate
- rework rounds
- human interventions per J and decision time per J
- review time per evidence report
- escaped defects found after merge
- cost per merged change

**Pre-registered kill criteria for OMF (v0.1 to v0.2).** These are evaluated on the example
project and on the first dogfood goals.

- If human interventions per merged change are not lower than those of a plain agent session on
  the same tasks, the G layer is reconsidered.
- If escaped defects are higher than in the plain session, the default autonomy is lowered.
- If GATE-2 lets through scenarios that a null implementation passes, sealing is not shipped as a
  guarantee.

## 13. v0.1 walking skeleton

The skeleton must prove two full turns of the goal loop, end to end.

1. `omf init` and `omf doctor`.
2. `omf goal new`, then J1, then the lock: one target metric, one guardrail, one measure command,
   minimal prereg.
3. `omf goal tick` turn 1: measure in a container, gap and bands, reconcile (`intent.md`
   candidates, deterministic filters), auto-dispatch inside scope.
4. W for each item: `decide` (`spec.md`, ledger), `seal` (Codex one-shot, deterministic CLI
   scenarios, GATE-2), `run` (Claude in the devcontainer on `omf/<work-id>`), `judge` (two
   containers, gate line, outcome class), one round of masked feedback, `report`.
5. A person merges, optionally through `omf ship --open-pr`.
6. `omf goal tick` turn 2: re-measure. If the gap closed, a candidate is created; then
   `omf goal sign` (J5).
7. Self-metrics recorded.
8. Enforcement tests:
   - `E1 metric-tamper-stops`
   - `E2 canary-no-leak`: covers the workspace, prompts, G inputs and feedback
   - `E3 budget-no-reset`
   - `E4 unevaluated-is-undetermined`
   - `E5 init-non-pollution`
   - `E6 l2-leak-redteam`: an implementer told to find the scenarios fails, and no canary appears
9. `examples/hello-goal`: a small CLI with an offline-measurable metric, such as the p95 latency of
   a local operation over a fixed input set. The whole loop runs without external services.

**Out of v0.1:**
- LLM judging and probability intervals.
- The divergence probe beyond an optional prototype.
- External trackers and observability MCPs.
- Remote runners and L3.
- The Digital Twin Universe.
- Scheduling, beyond documenting `omf goal tick` for cron or CI.
- The Claude Code and Codex shells.
- The `migration` template.

**Roadmap:**
- v0.2: shells (plugin and skill), the GitHub state adapter, a scheduled tick workflow template,
  SSH-signed approvals, the divergence probe.
- v0.3: LLM judge with order swap, probability with Wilson intervals, the full Ladder, L3, the
  leak red-team on every run.
- v0.4: the read-only MCP measure adapter, E2B runner, the first Digital Twin kit, the
  `migration` kind.

## 14. Open questions

These are deferred and do not block v0.1.

1. Team use: several people and machines on one goal. Host vaults are per machine in v0.1, and
   team mode is out of scope.
2. Single-vendor users: allowed with a lower guarantee label ("same-vendor sealing"). The exact
   label wording is deferred.
3. Whether cross-vendor authoring measurably reduces leakage or correlated blind spots. Treated
   as a hypothesis and measured. Not claimed.
4. Defaults for the WIP cap, `STOP_IF` and the Ladder margin are starting points to be tuned from
   self-metrics.
5. Windows support (L1 only?) and corporate proxies.
6. Whether W's station graph should be expressed in the open Attractor DOT format in v0.2, so that
   OMF pipelines run on existing Attractor engines. OMF would keep its own gate semantics. The spec's
   `goal_gate` also accepts `PARTIAL_SUCCESS`, which OMF gates do not.
