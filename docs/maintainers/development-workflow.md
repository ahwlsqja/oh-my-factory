# Development workflow

This is the canonical workflow for contributing to OMF. It applies to new work after adoption;
existing work is not rewritten to fabricate issue-first history. A transition issue may link it honestly.
The adoption change itself follows the preceding contribution policy.

GitHub Issues is our contributor work tracker. This does **not** require OMF product users to use GitHub,
Linear, Notion or another external tracker. It implements no product tracker adapter, dashboard,
provider routing or state-storage change. OMF remains pre-alpha; product contracts and implementation
status belong to the [design](../design/2026-10-12-omf-v0-design.md) and [README](../../README.md).

## Goals and sources of truth

Follow this loop: **goal → agreed evidence/measurement → observed gap → work issues → implementation
and verification → outcome observation → adjust work**. Task completion is not goal achievement.
A goal needs agreed outcome evidence and human sign-off. Maintenance and documentation may preserve
an invariant or demonstrate a scenario instead of inventing a numeric KPI.

| Subject | Source of truth |
|---|---|
| Product behavior and trust boundaries | Canonical English design and approved addenda in `docs/design/` |
| Goal and outcome judgment | Human-agreed goal description and evidence criteria, linked from its work |
| Contributor operating rules | This document; [AGENTS.md](../../AGENTS.md) routes agents here |
| A bounded task's scope, acceptance and status | One GitHub issue; PRs carry implementation/review evidence |
| Validation | Results tied to the checked revision/diff, including skipped checks and limitations |
| Temporary execution notes | Local `docs/plans/`; do not commit or link to these from tracked docs |

Keep the goal description fresh and record outcome observations there after delivery. Derive and adjust
work autonomously within its authorized scope. Changes to goals, acceptance, product/security boundaries
or new dependencies need the appropriate human decision. Models review reasoning; they do not replace
empirical validation. People review decisions and evidence, with targeted review of high-risk code.
These principles follow the design's F1–F11 and [reference notes](../design/references.md).

## Issue contract

Create or reuse an issue before implementing a feature, bug fix, refactor, CI/security change or document
policy change. Reporting a bug need not supply an implementation plan: a maintainer completes the
contract before Ready. Small typo/link fixes that change no behavior or policy may use the PR as their
work record; write `Issue exception: trivial docs` and the reason. Do not bundle behavior changes into it.
Vulnerabilities and sensitive response instead use the private record required by
[SECURITY.md](../../SECURITY.md) until safe public linkage; never require a public vulnerability issue.

The issue needs a short contract; one sentence per field can be enough:

- **Problem / goal:** parent goal or intended outcome, observed gap and evidence of this task's contribution.
- **Scope:** included behavior/modules and non-goals.
- **Acceptance:** observable completion checkboxes, not just an activity list.
- **Validation:** required tests/evidence, including real-container/model needs where relevant.
- **Context:** design/related links, owner, dependencies, risks and unresolved decisions, or `none`.

Default to one bounded issue per PR. Split larger work into a parent goal/epic and independently
reviewable child issues, each with its own acceptance and PR. The parent closes only when its own
acceptance is proven. If multiple PRs are necessary, record their scope/order/contribution before the
first PR. Use `Closes #N` only on the PR completing the issue's full acceptance; partial work uses `Refs #N`.

## State and completion

GitHub issues stay open through review. Maintain a simple `State:` line in the body; no Project or
automatic state synchronization is required. The Builder owns updates for agent-led work.

| State | Entry / exit evidence |
|---|---|
| Backlog | Problem recorded; implementation boundary not yet ready. |
| Ready | Goal, scope/non-goals, acceptance, owner and validation defined; blocking dependencies and important decisions resolved. |
| In Progress | Branch/worktree and starting revision linked; implementation underway. |
| In Review | PR linked; current validation/review results and limitations recorded; CI/human review may remain pending. |
| Done | PR merged to main, acceptance met and required merge-result CI/follow-up checks complete; release evidence if acceptance requires it. |

`Blocked` annotates the current open state with cause, owner and next action. Cancellation/duplicate closure
records its reason and replacement, not Done. If automatic issue closure happens at merge, reopen it while
required completion evidence is pending. Reopen if a required post-merge check disproves acceptance.

Do not move unmet core acceptance to a follow-up issue just to close the original. Narrowing acceptance
requires a recorded owner/product decision and reason. Newly discovered nonblocking work outside scope
may go to an actual linked follow-up issue with an owner. Closing the task still does not close the goal:
if outcome observation is task acceptance, wait for it. Otherwise record the goal observation's owner,
checkpoint date or trigger, and current unknown/pending status; the task may close after its own acceptance
and required checks pass. Do not declare the goal achieved while its evidence remains pending.

## Execution and roles

1. Read the issue, goal, design, related PRs and current git state. Resolve only genuinely missing decisions.
2. Create a separate worktree/branch from main or an explicit dependency revision, such as
   `feat/gh-123-description`. Preserve dirty checkouts and others' edits; isolate each write lane.
3. Plan the file changes and acceptance-to-test mapping. A short issue note suffices for simple work.
   Settle product design changes before code. Important plans affecting interfaces, permissions, isolation,
   ledger or schemas require the Reviewer's bounded review of contracts and failure boundaries.
4. Write regression tests and implementation, validate, review, and update the issue/PR evidence.
5. Check the current PR revision, CI and relevant review before delivery. Merge only within user authority
   and the kernel restriction below;
   otherwise leave the reviewable PR. Verify required merge-result evidence and any observation required
   by task acceptance, then mark the task Done. For longer goal observations outside task acceptance,
   record their owner, checkpoint date/trigger and unknown/pending status rather than waiting on every PR.
   Remove worktrees only after checking for unpreserved changes.

All model-role requirements in this section, including required Reviewer checks, govern **maintainer agent-led work**. External
contributors follow the ordinary issue, PR and evidence rules; maintainers arrange the required plan
and final reviews. External contributors need not purchase, access or execute these models.

| Maintainer agent-led role | Responsibility |
|---|---|
| Builder | Lead, plan, write code/tests, integrate, validate and own task state and the final evidence/report. |
| Explorer | Scoped read-only file/symbol/document searches, parallel when independent and useful; report facts, inference and unknowns. |
| Reviewer | Important-plan challenge, repeated-error diagnosis and final omission review for substantive changes; not routine writing/search. |

| Session profile | Builder | Explorer | Reviewer |
|---|---|---|---|
| Codex (default in Codex sessions) | Sol 6.1 | Luna 6 | Astra |
| Claude | Sonnet | Haiku | Opus |

The active session/request selects the profile; an explicit user choice takes precedence. The Codex
mapping preserves the maintainer's chosen models. Claude names denote model families: the maintainer
pins available versions when starting work and records the selected mapping in the task note. Do not
silently fall back between models or providers. A profile changes staffing, not authority or review gates.

After a failure with the same apparent cause recurs following a fix attempt, consult the Reviewer with the
reproduction, changes and relevant logs before further speculative fixes. Unrelated transient failures
do not trigger this rule. A substantive change requires the final omission review; trivial fixes do not.
Send a compact packet: issue/acceptance, base/current revision or diff identity, affected files/key diff,
relevant contracts, validation/gaps and 1–3 questions. The Builder records accepted/rejected findings with reasons.
Do not repeatedly send full conversation history or treat self-review as independent approval.

Review becomes stale for relevant changes to code, acceptance or risk boundaries; recheck those parts and
rerun affected validation. Pure wording changes need a recorded impact judgment, not full review replay.
If a requested model or required Reviewer check is unavailable, report the gap and leave that review
incomplete. Continue safe independent work. Substitution/waiver follows existing authorization or an
explicit user decision; never silently substitute models/providers or start a recurring permission flow.

Carry clear, authorized local edits/tests through without per-step approval. A request to execute this
workflow covers ordinary scoped issue/PR bookkeeping unless the user restricts it. Merge, release,
deployment, destructive actions and credential/cost use stay within existing user authority. Ask only
when authority or a material decision is missing. These roles do not alter OMF's product `roles.*`.

## Validation and review evidence

Run the smallest useful check first, then the required checks for the change. Bug fixes start with a
reproducer; other behavior changes need regression coverage. Do not add tests that merely mirror prose.

| Change | Required local evidence |
|---|---|
| Behavior, schema or CLI | Targeted regression tests, `npm run typecheck`, `npm test`, `npm run build`, `npm run lint`, `npm run format:check`. |
| Documentation/templates only | Inspect diff, paths, examples and links; run `npm test -- tests/docs/links.test.ts` for Markdown links, parse changed YAML/forms and check formatting for supported files. Add relevant checks if executable/CI contracts change. |
| Coverage-affecting behavior | Also `npm run test:coverage`, or current-revision CI coverage evidence; never lower thresholds to pass. |
| Isolation/container/model guarantees | Identify required gated suites and run when authorized; record revision, suite and result. Offline tests alone do not prove these guarantees. |
| Workflow/release configuration | Relevant workflow checks and CI; do not claim unavailable local tools ran. |

The docs-only row is the explicit lightweight exception to the full local checks; full CI still runs.
Test setup rebuilds `dist/` and shields real CLIs/Docker. Follow [testing](testing.md) and the
[gated runner](../../scripts/gated-docker.mjs) for real tests: `--model` needs a dedicated key/spend
authority, and `--record` requires a clean tree and changes the gated evidence manifest. Historical
records at another revision do not validate new guarantees. Separate pre-existing warnings from errors.

Record the checked revision/diff, commands/results, skipped work and remaining risks. Required acceptance,
validation or review that is skipped/unavailable keeps the task In Review/Blocked, not Done. Optional
additional proof may simply be listed as a limitation. Continue independent checks and PR preparation.
CI green does not establish goal attainment, empirical model validation or independent review.

The existing [CI workflow](../../.github/workflows/ci.yml) aggregates checks as `ci`; inspect live branch
rules and current-head results before merging rather than assuming protections or approval settings.
The [PR-title check](../../.github/workflows/pr-title.yml) is advisory, outside aggregate `ci`.
Issue links, manual state, model-role/review and goal-observation rules here are contributor requirements,
**not automated gates**. This workflow adds no hooks, dependencies, tracker synchronization or CI changes.

## Kernel changes require a human merge

The verification/trust kernel is defined by [kernel-paths.txt](kernel-paths.txt), a repository-relative
POSIX-style glob manifest. Check all changed paths against the base revision's manifest, including
deletions and both names of renames. A match makes the entire PR a kernel PR; mixed PRs inherit the rule.
Whole design directories conservatively cover principles/gates. The manifest and policy instructions
protect themselves because changing them could weaken this requirement.

A human must inspect the **current diff** and personally merge a kernel PR. Agents may prepare, test
and review it but must never merge it, even with general merge authority. Bot/model approvals or counts
of peer reviews do not establish human inspection or satisfy personal merge. Relevant new changes need
fresh human inspection. This policy change itself touches protected instructions and needs human merge.

Record the classification and required handoff in the PR. The manifest defines scope; it is not a CI
classifier or proof of enforcement. Automatic classification/enforcement requires separate implementation.

## Commits and handoff

Use Conventional Commit subjects, `type(scope): reason for the change`, and PR titles. Lore is a concise
decision record using git-native trailers. Add those trailers
when they capture decisions: `Constraint`, `Rejected: alternative | reason`, `Confidence: low|medium|high`,
`Scope-risk: narrow|moderate|broad`, `Directive`, `Tested`, `Not-tested`. Keep them factual and relevant;
do not add unrelated verification disclaimers. For example:

```text
fix(ledger): prevent a restart from hiding unfinished work

Constraint: Preserve the existing event schema
Rejected: Reset state on startup | would discard recovery evidence
Confidence: high
Scope-risk: narrow
Tested: regression test and typecheck
```

PRs explain the problem/result, issue relationship, decisions, current validation and limitations.
Disclose substantial AI authorship as required by [CONTRIBUTING.md](../../CONTRIBUTING.md).
Keep temporary plans local; retain durable decisions in the appropriate design, workflow or issue/PR.
