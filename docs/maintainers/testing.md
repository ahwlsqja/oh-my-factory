# Testing, coverage and lint tooling

Maintainer notes for the test suite and its quality tooling.

## Running the suite

```sh
npm run typecheck && npm test
```

`tests/global-setup.ts` deletes `dist/` and rebuilds it before every run, and also puts `claude`/`codex` shims that
exit 97 first on `PATH`, so a test that reaches for a real model fails loudly.

On a busy or small machine, cap the parallel test files and keep the generous timeouts:

```sh
OMF_TEST_MAX_WORKERS=2 npm test
```

`OMF_TEST_MAX_WORKERS` is read by `vitest.config.ts`. Unset, vitest uses its default (about one worker per core).
For a one-off you can also pass `--maxWorkers=2 --hookTimeout=60000 --testTimeout=60000` on the command line.

## Load flakiness: root cause and fix

Symptom: runs at load average 45 or more failed with `Hook timed out in 10000ms` in unrelated files (for example
`tests/goal/reconcile.test.ts`, `tests/core/doctor.test.ts`) and passed when run alone.

Findings (15-core macOS machine, load average about 5 to 10, `vitest run --reporter=json`):

- Only one hook runs in every test file: the `afterAll` in `tests/setup/cleanup.ts`, which called `removeTempDirs()`,
  a synchronous recursive `rmSync` of every directory the file made. No test file defines its own hooks, so this
  was the hook that timed out.
- Its cost is large for the heaviest files: 1.5 s for `enforcement/W-outcome-state-table`, 1.46 s for
  `goal/reconcile`, 0.5 to 0.8 s for several others; 14.0 s summed over the 102 files. File-system work stretches
  roughly ten-fold under heavy load, which crosses vitest's default `hookTimeout` of 10 s.
- The slowest tests are real process work, not waiting: `goal/tick` 20.7 s per file, `goal/reconcile` 16.5 s,
  `cli/goal-tick-cli` 14.1 s, `work/w-run` 10.8 s. The slowest single test is about 5.4 s.

Fixes (no test logic changed):

1. `tests/helpers/tmp.ts` gains `removeTempDirsAsync()`, which deletes the directories concurrently with
   `fs/promises.rm`; `tests/setup/cleanup.ts` uses it. The synchronous `removeTempDirs()` is kept.
2. `vitest.config.ts` sets `hookTimeout: 30000` next to the existing `testTimeout: 30000`, with a comment.
3. `OMF_TEST_MAX_WORKERS` caps parallel files.

Timings (same machine, full suite, wall clock, 102 files / 1358 tests):

| run | duration |
|---|---|
| before, idle (load about 5 to 10) | 26.8 s |
| after, idle | 30 to 32 s (within run-to-run noise; load varied) |
| after, 40 busy-loop processes added (load about 75) | 63 s, all green |

The after-under-load run is the meaningful one: it passes at a load that previously produced hook timeouts. I did not
reproduce the old failure on demand, because the old code under synthetic load was not re-run; treat the
before/after as evidence of headroom, not a proof.

## Coverage (report only)

```sh
npm run test:coverage
```

`@vitest/coverage-v8` is pinned to exactly the installed vitest version (5.0.2); bump them together. The report
lands in `coverage/` (text summary, `coverage-summary.json`, `lcov.info`, HTML) and is git-ignored. CI runs the
`coverage (report only)` job on ubuntu with Node 24, writes a table to the job summary and uploads `coverage/` as
the `coverage-report` artifact. The job is not in the aggregate `ci` job's `needs`, so it cannot block a merge.

Baseline, measured on this branch (`src/**/*.ts`):

| metric | covered | pct |
|---|---|---|
| statements | 3425 / 4043 | 84.71% |
| branches | 2180 / 2635 | 82.73% |
| functions | 651 / 737 | 88.33% |
| lines | 2911 / 3398 | 85.66% |

Known undercount: CLI tests run `dist/cli/main.js` as a child process, which v8 coverage in the test process cannot
see, so `src/cli/*` numbers are low. Merging child-process coverage is future work. No thresholds are set yet; add them
below the measured numbers and only ever raise them.

## Flake soak

`.github/workflows/flake-soak.yml` runs weekly (Mondays) and on `workflow_dispatch`. It runs the full suite three
times with `--sequence.shuffle --sequence.seed=<n>`, prints each seed in the job summary, and fails if any run failed.
Reproduce locally with `npm test -- --sequence.shuffle --sequence.seed=<seed>`. Model credentials are set to empty
strings and no secret is mapped. Permissions are `contents: read`.

## Lint and format (Biome)

`biome.json`, `.editorconfig` and `.gitattributes` are in place, and `npm run lint` and `npm run format:check` run
Biome 2.5.15. The CI `biome` job runs both and is part of the aggregate `ci` job, so a formatting difference or a lint
error fails the pull request. Run `npx biome format --write .` before committing.

- Lint rules: `recommended` preset. The five rules that reported errors when Biome was adopted are set to `warn`;
  warnings and infos are reported but do not fail the job. Promote a rule back to `error` once its count reaches zero.
- Format: the whole repository was formatted in one commit, which is listed in `.git-blame-ignore-revs`. Run
  `git config blame.ignoreRevsFile .git-blame-ignore-revs` once so `git blame` skips it.
