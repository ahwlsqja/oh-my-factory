# Third-party sources and licenses

This page records what oh-my-factory (OMF) takes from other projects and in what form. It is
the licensing companion to [`design/references.md`](design/references.md), which records what was
read and how.

**Result: ideas for most sources; one design adapted from Kilroy.** No file under `src/` is a copy or
translation of source text from any project listed here, as far as the scan under
[Evidence](#evidence) can show. Two parts of OMF adapt Kilroy's design: the staleness and ownership
checks of the claim lock (`src/core/lock.ts`) and the loop-guard signature normalization
(`src/goal/signatures.ts`). The decision structure is the same; the TypeScript is independent. Out of
caution OMF ships Kilroy's MIT license text and copyright line in
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md), which is listed in `package.json` `files`.
Every other source is an idea, which does not create a notice obligation under MIT or Apache-2.0
(those attach to copies and derivative works). If more code is ever copied, the copy and its notice
must land in the same commit (see [When this changes](#when-this-changes)).

OMF itself is Apache-2.0 (`LICENSE`).

## Forms of borrowing

| Form | Meaning | Notice needed |
|---|---|---|
| idea | A practice or design is described in OMF's own words and implemented independently | no (cite the source) |
| adapted design | The decision structure of another project's logic is followed; the implementation is written independently in OMF's language and style | notice shipped as a precaution |
| code | Source text is copied, translated or closely adapted | yes (license text and copyright line) |

## Sources

| Project | License | Form in OMF | What OMF takes |
|---|---|---|---|
| danshapiro/kilroy | MIT, copyright 2026 StrongDM, Inc. | adapted design: claim lock staleness and ownership checks (`src/core/lock.ts`) and signature normalization (`src/goal/signatures.ts`); idea: repeated-failure breaker, visit caps, preflight report, parity matrix | claim lock: same decision structure as Kilroy's `runOwnershipMatchesLiveProcess`, independent TypeScript implementation; signature normalization: lowercase, hex runs to the placeholder `<hex>`. Notice: [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) |
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

The checks below were run on 2026-10-14 against these local clones. Commit hashes are the output of
`git -C <clone>/repo rev-parse HEAD`:

| Clone | HEAD |
|---|---|
| kilroy | `b55fb0f2b3d5bfc603726d8ce5c5b89de81bfa2f` |
| factory | `8af116567166a0a16588b7ab1b9934ece0b775bc` |
| arc | `ecbce6c94e5fe12da336da1a38ef60dc257ced19` |
| omc | `63da344a70e0c5eceb0f1a617d5736a427e92e20` |
| omx | `2db7d5136b22252e83091a12ea27567b2fdd5971` |
| oh-my-openagent, omo | `ff3fc93f9c8ae132b0101e52258a83ab74de7fba` (same commit) |
| symphony | `be10a1b79df723d6d7612b5651c8522704dafb2e` |
| attractor | `fb57a55ed97372a27ac90102f436947e29f48426` |
| spec-kitty | `e074a381bf141c54212e778ea79a6e01c4c96c5d` |
| bmad-method | `9f1987169a2e5626e5ccb31bb9cee051fdb3df20` |
| 12-factor-agents | `d20c728368bf9c189d6d7aab704744decb6ec0cc` |
| cxdb | `c26258881f3c3fb039b37d9ff2dbca3dec6f6c6a` |
| factory-demo | `f367c3cd9f7dd1c3dbcf426ee6c220da254663e9` |
| omd | `0e4d6a1a1e12656d3b0c07517aa4faad67465e80` |
| omp | `b83200eb866821f02625332025b453f06ce4e12a` |

There are four checks: two side-by-side reads of Kilroy code (1, 2), one structural comparison (3)
and one mechanical scan (4).

### 1. Claim lock: `src/core/lock.ts` against Kilroy `run_ownership_lock.go`

Classification: **adapted design** (same decision structure, independent TypeScript implementation).

`isStale` in OMF makes the same four decisions, in the same order, as Kilroy's
`runOwnershipMatchesLiveProcess`:

1. the owner process is not alive: stale (Kilroy: not a live owner);
2. no start time stored in the lock: the live PID is treated as the owner;
3. the current start time of the PID cannot be read: the live PID is treated as the owner;
4. otherwise compare the stored and current start times: a difference means the PID was reused.

OMF reached this order independently in TypeScript, but because the structure matches it is recorded
as an adaptation of Kilroy's design and not as an idea only. The pidfile steps themselves (exclusive
create, PID plus start time, release by the owner) are the standard guard against PID reuse.

Differences:

| Point | Kilroy | OMF |
|---|---|---|
| Language and unit | Go, one `logs_root` per run | TypeScript, one lock path per work item or goal |
| Start time | numeric `uint64` from a `procutil` helper | `ps -o lstart=` text under `LC_ALL=C`, cached once per process |
| Field names | `pid`, `pid_start_time`, `run_id`, `acquired_at` | `pid`, `start_time`, `acquired_at`; no run id |
| Stale removal | `os.Remove` after reading, no guard | a `<path>.reclaim` guard file taken while staleness is re-checked, so the lock cannot be swapped between check and removal |
| Unreadable or empty owner on acquire | retry up to 20 times, 25 ms apart, then report a conflict | presumed mid-write for a 1 s grace by file mtime, then reclaimable |
| Release when the owner record is unreadable | returns without removing the file | removes the file without an ownership check (`rmSync` with `force`) |
| Release when another process owns the lock | returns silently | throws `refusing to release a lock owned by pid ...` |
| Waiting | none (conflict error returned at once) | `withLockSync` waits up to 2 s, refuses async callbacks, is not reentrant |
| File mode | 0644, indented JSON | 0600, compact JSON |
| Comments and identifiers | none shared | none shared |

The unreadable-owner release is a real behavioral difference: OMF is more eager to clear a lock
file it cannot read, Kilroy is more conservative. No function body, comment or distinctive condition
in `lock.ts` matches the Go file; the scan in check 4 found no shared text.

### 2. Loop guards and signatures: `src/goal/signatures.ts` against Kilroy `loop_restart_policy.go`

Classification: signature normalization is an **adapted design** (both normalizers emit the literal
placeholder `<hex>` for hex runs). The breaker, caps and counting window are ideas with different
logic.

- Signature shape: both use three `|`-separated fields (`node|class|reason` against
  `station|outcome_class|reason`). A delimited key of what, how and why is the obvious way to compare
  failures.
- Normalization: both lowercase text and replace hex runs (placeholder `<hex>`), digits and
  whitespace. The rest differs. OMF also rewrites paths and metric ids, uses `#` rather than `<n>`,
  caps at 120 characters rather than 240, and has a different set of regular expressions.
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

Scope: every text file under `src/`, `tests/`, `schemas/`, `scripts/` and `examples/` of OMF
(skipping `.git`, `node_modules`, `dist`, binary extensions and files over 2 MB) against every text
file in the clones above (their `repo/` directories, same skips).

Method, enough to re-run: lowercase each file, replace every run of non-letter, non-digit,
non-underscore characters with a single space, split into words, and take every window of six
consecutive words as a shingle. Count shingles shared between each OMF file and each clone file and
list pairs with at least three shared shingles, largest first. A script of about 30 lines implements
this; it is not committed, so the description above is the record.

Results:

- Kilroy: one pair reached the threshold, three shared shingles, `src/core/private-fs.ts` against
  `atomic_write.go` ("to a temp file in the same directory", a comment describing the standard
  atomic-write technique). Nothing else, including `lock.ts`, `signatures.ts` and all of `tests/`.
- addyosmani/factory, symphony, attractor and 12-factor-agents: zero pairs.
- cxdb and factory-demo: one or two pairs at exactly three shingles.
- The remaining clones (arc, omc, omx, oh-my-openagent/omo, omd, omp, spec-kitty, bmad-method)
  produced many low-count pairs, the largest at 12 to 25 shingles. The largest were opened and
  every one was language or tool boilerplate: `import` lists from `node:fs`, `node:path` and
  `node:child_process`, `process.kill(pid, 0)` and `ps -o lstart= -p` idioms, counting sequences
  such as "one two three four five six", digit runs in regular expressions, and JSON Schema
  keywords. No distinctive identifier, comment or condition was shared.

The scan finds copied text and close translations of text. It cannot see a design that was followed
and reimplemented, which is exactly why checks 1 and 2 are done by reading.

### Limits of this check

- It is a read-and-scan comparison, not a legal opinion or a clean-room audit.
- The scan finds copied text and close translations. A very loose paraphrase would not be found,
  and the adapted-design classification above rests on reading, not on the scan.
- Only the largest overlaps in clones other than Kilroy were opened; the many smaller pairs were
  not read one by one.
- warpdotdev-demos/cloud-factory-demo and DUBSOpenHub/shadow-score-spec were not cloned here, so
  they are covered only by the design record that says the ideas were read; the scan did not include
  them.
- Licenses of projects without a local clone (Argo Rollouts, Flagger, E2B, k6) come from the design
  record and were not re-read.
- arc has no LICENSE file; its README says MIT, with no copyright holder. OMF therefore treats it as
  ideas only, which is the safe reading.

## When this changes

If source text from a project above is ever copied, or another design is closely adapted:

1. Add that project's license text and copyright line, verbatim, to `THIRD_PARTY_NOTICES.md`
   (it already carries Kilroy's).
2. Keep the file in `package.json` `files` so it ships in the package.
3. Note the project in the source comment and in the Sources table.
4. Update the Result paragraph above to say which files are derived or adapted.
