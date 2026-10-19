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

## Coverage (thresholds)

```sh
npm run test:coverage
```

`@vitest/coverage-v8` is pinned to exactly the installed vitest version (5.0.3); bump them together. The report
lands in `coverage/` (text summary, `coverage-summary.json`, `lcov.info`, HTML) and is git-ignored. CI runs the
`coverage` job on ubuntu with Node 24, writes a table to the job summary and uploads `coverage/` as the
`coverage-report` artifact. The job fails when any metric is below its threshold in `vitest.config.ts`, and it is in
the aggregate `ci` job's `needs`, so it blocks a merge.

Baseline and thresholds (`src/**/*.ts`):

| metric | measured | threshold |
|---|---|---|
| statements | 90.59% (7252 / 8005) | 88 |
| branches | 88.74% (4866 / 5483) | 86 |
| functions | 93.49% (1323 / 1415) | 91 |
| lines | 91.66% (6118 / 6674) | 89 |

Ratchet rule: thresholds only ever go up. Raise them in the same change that improves coverage, to about two points
below the new measurement (rounded down). Never lower a threshold to make a change pass; add the missing tests
instead.

Known undercount: CLI tests run `dist/cli/main.js` as a child process, which v8 coverage in the test process cannot
see, so `src/cli/*` numbers are low. Merging child-process coverage is future work.

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

## Command usage file

`docs/cli-usage.md` holds the exact `--help` text of every leaf command and is generated. After changing a command (an
option, a description or a new verb), run `npm run build && node scripts/cli-usage.mjs --write` and commit the result.
`tests/enforcement/W-cli-usage-drift.test.ts` fails when the file and the built CLI disagree and names the verb. A new
command also needs a README row, which `tests/cli/help-drift.test.ts` checks.

## Docker-gated tests

Suites under `tests/gated` need a real Docker daemon and are skipped unless `OMF_GATED=docker`; a skipped suite is not
evidence. Nobody sets the switch by hand: `npm run test:gated` starts the dedicated colima profile `omf-m3f` (2 CPU,
4 GiB), runs `vitest run tests/gated` against the `colima-omf-m3f` context only, and stops the profile afterwards. The
test process gets a temporary `DOCKER_CONFIG` that holds only that context, a temporary `OMF_HOME`, and no `HOME`. The
script never names another profile and never removes one. It starts the profile with `--activate=false`, so the user's
current Docker context is left alone (and put back if it changed anyway).

```sh
npm run test:gated                                  # every gated suite
npm run test:gated -- --only G-inspect-parser-real  # one suite
npm run test:gated -- --record                      # also append a record per passed G- suite (clean tree; only the evidence file may differ)
```

A gated suite that calls a real model reads its own keys. `G-implementer-real-run` and `G-e6-l2-leak-redteam` read
`OMF_IMPLEMENTER_API_KEY`, `G-author-canary` reads `OMF_AUTHOR_API_KEY`, and `G-skeleton-real` reads both. Create dedicated
Anthropic workspace keys with a spend limit and pass them for that one command, for example
`OMF_IMPLEMENTER_API_KEY=... npm run test:gated -- --model --only G-<suite>`. With `--model` the driver passes the test process
only the keys that the suites matched by `--only` read (all of them when there is no `--only`), each under its own name and never
under a vendor name such as `ANTHROPIC_API_KEY`, which is the reconciler's host key; the implementer and the author never fall
back to it. It sends the output through a redactor and refuses, naming the variable, when a key is missing. Without `--model`
the keys are dropped. The author suites are described in [docs/author.md](../author.md) under "Gated runs". Do not reuse a key
that has no spend limit.

Records live in `docs/evidence/gated-runs.json` and are written only by `--record`, never from inside a test. Until a
suite has a record, the docs say the behaviour it covers is not enforced. Gated suites are never part of CI. A gated suite that calls the implementer directly (`G-implementer-real-run`, `G-e6-l2-leak-redteam`) passes its own
session timeout in the request instead of the `[implementer] timeout_ms` default (30 minutes): 20 minutes for the
session, 25 for the vitest test. Suites driven through the CLI or the author (`G-skeleton-real`, `G-author-canary`) take
their session limit from config (`implementer.timeout_ms`, and `author.timeout_ms` capped at 10 minutes), and their vitest
timeout (90 and 30 minutes) is set above it.

One older test predates this: the Docker case in `tests/adapters/measure-cmd.test.ts` runs only when
`OMF_TEST_DOCKER=1` and uses the client's current Docker context, not the `omf-m3f` profile. It is not a gated suite,
`npm run test:gated` does not run it, and it writes no record; do not set that switch for a gated run.
