# UI snapshot baseline

This is the reproducible, offline baseline for [issue #59](https://github.com/ahwlsqja/oh-my-factory/issues/59),
measured against UI #58 revision `2cff37d6f86deadac41ab9afc6d1407edd320e67`.
It adds no optimization and does not complete the issue's optimization or post-delivery acceptance.
The issue remains open for that work.

## Repeat the measurement

From a checkout containing the benchmark and its dependencies:

```sh
npm run build
mkdir -p docs/plans
node scripts/bench-ui-snapshot.mjs > docs/plans/ui-snapshot-baseline.json
```

The default is 1, 5 and 20 goals, one warmup followed by seven timed snapshots for each cardinality,
first with a watched path and then with an empty-watch control. Optional bounded arguments are
`--goals 1,5,20,50 --samples 7`; 50 was not measured in the run below. JSON goes to stdout, progress
to stderr, and any failed fixture/invariant assertion exits unsuccessfully. Raw JSON stays local in
ignored `docs/plans/`; do not commit it.
Goal counts must be distinct integers from 1 through 50; the list is limited to 50 entries.

Each case creates a separate temporary Git repository and initialized OMF project. It uses
`createGoal`, `proposeMetric` and `lockGoal` from the freshly built library, with distinct goal IDs,
one shared metric proposal and one metric lock per goal. Approvals are valid synthetic records
created by the existing APIs; no approval/lock files are copied. There are no work items, ticks,
measurements, bands, or long ledger histories. The declared metric command is never executed.

The process replaces its environment with temporary `HOME`, `OMF_HOME`, XDG directories and `TMPDIR`,
a synthetic Git identity and a controlled `PATH`. Credentials are not inherited. Git uses an absolute
executable selected from the first executable `git` on PATH, resolving symlinks, with system/global
configuration disabled. Metadata commands disable optional Git locks; model and Docker commands have
failing shims. No real model, Docker, private benchmark, or existing OMF state is used. Temporary
fixtures are removed on normal completion or an exception.

A PATH shim appends the Git subcommand to a counter file and delegates with the original argument
boundaries. Each timed interval surrounds only `readUiSnapshot`; setup, build, counter reads, fixture
validation and invariance checks are excluded. Counting overhead **is included**, so timings are
instrumented observations, not uninstrumented UI latency. The harness verifies every warmup and
sample returns exactly the requested IDs, all with `audit_state: approved`.

Before and after every read, the harness compares file/directory names, modes, modification times,
file sizes and content hashes for the synthetic repository, including `.git/index`, and the isolated
home, including the complete OMF state and ledger. Access times are excluded because reads may update
them. These comparisons also run for invalidation observations. The JSON records per-snapshot Git
counts and subcommand breakdowns, raw timings, returned goal states, ledger heads, event/file sizes,
source/build/benchmark hashes, toolchain, machine and timestamps.

## Observed baseline

Measured on 2026-10-19, `03:19:05.294Z`–`03:20:01.522Z`, on Darwin 25.4.0 / arm64, Apple M5 Pro,
15 logical CPUs, 48 GiB memory. Node was `v25.9.0`; Git was Homebrew `2.53.0`, selected from
`/opt/homebrew/bin/git` and resolved to `/opt/homebrew/Cellar/git/2.53.0_1/bin/git`.
Initial load averages were 50.23 / 27.89 / 16.51.
The machine was not reserved exclusively for the benchmark and was heavily contended; the timings
are observations under that load, not an isolated estimate of UI latency.

This run supersedes the initial Apple Git 2.50.1 run, whose discovery incorrectly skipped a symlinked
PATH executable. Its raw local evidence is retained with the `initial-apple-git` suffix. The Git
version and machine load differ, so elapsed times should not be compared as an optimization result.

| Watched paths | Approved goals | Git calls per snapshot | Median (ms) | p95 (ms) | Ledger events | Ledger bytes | State bytes, including ledger |
|---|---:|---:|---:|---:|---:|---:|---:|
| `bench/value.sh` | 1 | 7 | 216.783 | 303.164 | 5 | 2,109 | 6,468 |
| `bench/value.sh` | 5 | 23 | 685.031 | 760.204 | 17 | 7,421 | 20,068 |
| `bench/value.sh` | 20 | 83 | 2,823.992 | 3,830.535 | 62 | 27,357 | 71,084 |
| Empty | 1 | 3 | 225.712 | 343.159 | 5 | 2,107 | 6,418 |
| Empty | 5 | 3 | 235.586 | 362.534 | 17 | 7,419 | 19,922 |
| Empty | 20 | 3 | 438.699 | 525.179 | 62 | 27,355 | 70,578 |

All seven samples in each case had the count shown. p95 uses nearest rank
`sorted[ceil(0.95 * samples) - 1]`, which is the maximum of seven samples here. The median excludes
the warmup. Byte counts include generated configuration, proposals, goal files and locks; ledger
paths and timestamps make exact bytes run-dependent.

The measured watched-path breakdown was three `worktree` invocations plus, per goal, one `diff`,
one `ls-files` and two `rev-parse` invocations: `3 + 4N`. Empty-watch snapshots made only the three
`worktree` invocations. This agrees with the source path: `readUiSnapshot` resolves the project once
and calls `requireProject` twice; each watched `auditGoal` checks changed paths using `diff` and
`ls-files`, each of which first resolves the index path. These are measured subprocess counts on
the named revision, rather than a count inferred solely from source inspection.

For provenance, the measured source had no tracked modifications and used these SHA-256 hashes:

| Input | SHA-256 |
|---|---|
| Benchmark file | `de4022216915bdea0f778361b497ad518ad2047c4c3e8c521549f900fbd264a7` |
| `src/` content manifest | `80ff43baa40a794f11735343bb3653edde9a1fdc2a58376020ec3c0862a02ead` |
| `schemas/` content manifest | `f575c78a62015631a290fba4bb5248082fc173f4789663610dc0ce4889be6640` |
| Built `dist/` content manifest | `afe9cfa25fefead25a60b05826dba551e16bc66442b3254bf106ff23d04353e5` |

Directory hashes are the SHA-256 of the JSON array of sorted recursive `{path, sha256}` entries,
including directory entries with a null content hash. They exclude timestamps and modes.

## Bounded invalidation observations

After the one-goal watched case, each mutation was read immediately and then restored. There was no
rebuild, reapproval or commit between reads:

| Mutation | Next snapshot audit state | State after restoring original content |
|---|---|---|
| Same-size edit to tracked watched file, without a commit | `needs_reapproval` | `approved` |
| Change goal semantic target value | `needs_reapproval` | `approved` |
| Change metric lock unit without its integrity hash | `tampered` | `approved` |
| Change proposal definition unit | `needs_reapproval` | `approved` |

Every observation also passed repository/home/ledger read-only comparisons. These are baseline
observations for a small synthetic state, not a comprehensive cache invalidation test suite or
evidence that a future optimization preserves all trust boundaries.

## Limits and next observation

These are warm repeated reads without an OS cache flush. A fresh repository/state is used per case,
but cold reads, large source trees, long ledgers, work projections, concurrent writers, linked
worktrees, browser/render/SSE costs and production workloads are not covered. Goal count also grows
ledger length and state size, so the timing slope does not isolate Git alone. The empty-watch case
is a control, not a semantics-preserving optimization candidate.

Future optimization work should rerun this command at its exact revision, compare subprocess counts
and timing distributions with the baseline, and run the relevant integrity/concurrency regressions.
Its acceptance and outcome observation remain pending under #59.
