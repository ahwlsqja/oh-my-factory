# Third-party sources and licenses

This page records what oh-my-factory (OMF) takes from other projects and in what form. It is
the licensing companion to [`design/references.md`](design/references.md), which records what was
read and how.

**Result: ideas only.** No file under `src/` is a copy or translation of code from any project
listed here. Because nothing is derived, OMF ships no `THIRD_PARTY_NOTICES.md` and no `NOTICE` file.
Reading and following an idea does not create a notice obligation under MIT or Apache-2.0, which
attach to copies and derivative works. If code is ever copied, the copy and its notice must land in
the same commit (see [When this changes](#when-this-changes)).

OMF itself is Apache-2.0 (`LICENSE`).

## Forms of borrowing

| Form | Meaning | Notice needed |
|---|---|---|
| idea | A practice or design is described in OMF's own words and implemented independently | no (cite the source) |
| code | Source text is copied, translated or closely adapted | yes (license text and copyright line) |

## Sources

| Project | License | Form in OMF | What OMF takes |
|---|---|---|---|
| danshapiro/kilroy | MIT, copyright 2026 StrongDM, Inc. | idea | per-run ownership lock with PID and start time; repeated-failure breaker; visit caps; preflight report; parity matrix |
| addyosmani/factory, factory-demo | MIT, copyright 2026 Addy Osmani | idea | gates line, run records, handoff, timing records |
| point-labs-dev/arc | README says MIT; no LICENSE file and no copyright holder | idea | empty-means-fail, per-node execution cap |
| Yeachan-Heo/oh-my-claudecode, oh-my-codex | MIT, copyright Yeachan Heo | idea | plugin layout, loop guards, settings isolation |
| code-yeongyu/oh-my-openagent | Sustainable Use License 1.0 (not open source) | concept only | progress-signature dedupe. Nothing is read for reuse; no code is copied and none may be |
| strongdm/attractor spec, strongdm/cxdb | Apache-2.0 | idea | pipeline-as-graph (v0.2 evaluation only) |
| openai/symphony SPEC | Apache-2.0 | idea | tracker adapter contract |
| Argo Rollouts, Flagger, E2B | Apache-2.0 | idea | measurement provider contract, remote sandbox |
| spec-kitty | MIT, copyright 2026 Spec Kitty, Inc. | idea | decision ledger fields, undecided lint |
| BMAD-METHOD | MIT, copyright 2025 BMad Code, LLC | idea | decision ledger fields |
| 12-factor-agents | code Apache-2.0, content CC BY-SA 4.0 | idea (Factor 7) | human request contract: persist and exit. OMF copies no text, so ShareAlike does not apply |
| warpdotdev-demos/cloud-factory-demo, DUBSOpenHub/shadow-score-spec | MIT | idea | triage states, judge and write job split; sealed-test score |
| k6 | AGPL | none | invoked as a binary only; no code copied |

Articles, papers and blog posts in `design/references.md` are cited for ideas and are not
redistributed.

## Evidence

The three checks below were run on 2026-10-14 against local clones at these commits (kilroy
`b55fb0f2b3d5`, factory `8af116567166`, arc `ecbce6c94e5f`; omc, omx, oh-my-openagent and the
spec repositories at their local HEAD).

### 1. Claim lock: `src/core/lock.ts` against Kilroy `run_ownership_lock.go`

Read side by side, both files, not only the structure.

What is the same, and why that is not derivation:

- Both create a file with an exclusive open (`O_EXCL`), write the owner's PID and a process start
  time as JSON, treat a dead PID or a changed start time as stale, and release only when the stored
  owner is the caller. These are the standard pidfile steps for guarding against PID reuse, which the
  design cites as the idea.

What differs:

| Point | Kilroy | OMF |
|---|---|---|
| Language and unit | Go, one `logs_root` per run | TypeScript, one lock path per work item or goal |
| Start time | numeric `uint64` from a `procutil` helper | `ps -o lstart=` text under `LC_ALL=C`, cached once per process |
| Field names | `pid`, `pid_start_time`, `run_id`, `acquired_at` | `pid`, `start_time`, `acquired_at`; no run id |
| Stale removal | `os.Remove` after reading, no guard | a `<path>.reclaim` guard file taken while staleness is re-checked, so the lock cannot be swapped between check and removal |
| Unreadable or empty owner | retry up to 20 times, 25 ms apart, then report a conflict | presumed mid-write for a 1 s grace by file mtime, then reclaimable |
| Unknown start time | live PID counts as owner | same, but only when the stored start time is null |
| Waiting | none (conflict error returned at once) | `withLockSync` waits up to 2 s, refuses async callbacks, is not reentrant |
| File mode | 0644, indented JSON | 0600, compact JSON |
| Comments and identifiers | none shared | none shared |

No function body, comment or distinctive condition in `lock.ts` matches the Go file. The retry
shape (open, read, test liveness, remove stale, loop) is the same because the problem is the same;
OMF's guard file and grace rules are additions that the Go file does not have.

### 2. Loop guards and signatures: `src/goal/signatures.ts` against Kilroy `loop_restart_policy.go`

- Signature shape: both use three `|`-separated fields (`node|class|reason` against
  `station|outcome_class|reason`). A delimited key of what, how and why is the obvious way to compare
  failures.
- Normalization: both lowercase text and replace hex runs, digits and whitespace. The rest differs.
  OMF also rewrites paths and metric ids, uses `#` rather than `<n>`, caps at 120 characters rather
  than 240, and has a different set of regular expressions.
- Counting: Kilroy tracks only the `deterministic` and `structural` failure classes. OMF counts every
  outcome class except `waiting` and embeds a progress hash into `ok` signatures. That is the gap
  Kilroy's own `skills/create-dotfile/SKILL.md` describes for non-failing loops.
- Limit and caps: OMF's default limit is 3 and its visit cap defaults to 3; Kilroy's visit cap default
  is 0 (off). The design says so explicitly.
- Counting window: OMF counts from the ledger since the last resume or approval, so a restart cannot
  reset it. Kilroy's counting window was not compared.

### 3. Doctor and preflight: `src/core/doctor.ts` against Kilroy preflight code

Kilroy's preflight validates provider access, a Rust sandbox and build state before a run. OMF's
doctor probes tools, git, the ledger and isolation and writes `preflight.json`. Only the word and
the "check before running" idea are shared. Structure, fields and logic are unrelated, and the
doctor code is not a port of any Go function.

### 4. Mechanical overlap scan

All `src/**/*.ts` were compared against every text file in kilroy, factory, arc, omc, omx,
oh-my-openagent, symphony, attractor, spec-kitty, bmad-method, 12-factor-agents, cxdb, factory-demo,
omd, omo and omp, using normalized six-word shingles. Matches were few (at most a few dozen per file
pair) and the largest were reviewed by hand. Every one was language boilerplate: import lines,
`typeof value === "object"` guards, `JSON.parse` try/catch, `tmpdir` imports. The highest Kilroy
match was a three-shingle sentence fragment, "to a temp file in the same directory", in a comment
of `src/core/private-fs.ts` against `atomic_write.go`; it describes the standard atomic-write
technique and is not distinctive.
addyosmani/factory is shell and Markdown while OMF is TypeScript, and it yielded zero matches.

### Limits of this check

- It is a read-and-scan comparison, not a legal opinion or a clean-room audit.
- The scan finds copied text and close translations. A very loose paraphrase would not be found,
  but a paraphrase of an idea does not need a notice.
- warpdotdev-demos/cloud-factory-demo and DUBSOpenHub/shadow-score-spec were not cloned here, so
  they are covered only by the design record that says the ideas were read; the scan did not include
  them.
- Licenses of projects without a local clone (Argo Rollouts, Flagger, E2B, k6) come from the design
  record and were not re-read.
- arc has no LICENSE file; its README says MIT, with no copyright holder. OMF therefore treats it as
  ideas only, which is the safe reading.

## When this changes

If any source text from a project above is ever copied or closely adapted:

1. Add `THIRD_PARTY_NOTICES.md` with that project's license text and copyright line, verbatim.
2. Add the file to `package.json` `files` so it ships in the package.
3. Note the file and project in the source comment and in this table.
4. Change "ideas only" above to say which files are derived.

The MIT notice for Kilroy would read "Copyright (c) 2026 StrongDM, Inc." followed by the MIT
permission text.
