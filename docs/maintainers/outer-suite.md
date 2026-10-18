# The outer contract suite

`outer/` holds a test suite that checks the kernel's promises from the outside: it runs the built `omf` and reads files,
and imports no code from this repository. It exists for one reason. The tests under `tests/` are written with the code
they test, so a change that weakens a promise can weaken its test in the same pull request. The outer suite is run by
a different release of itself, so a promise that was true in the previous release is checked by the previous release.

## What it promises today

The nine contracts and the way to run them are in [`outer/README.md`](../../outer/README.md). They cover the ledger
tamper stop, the no-writes-outside-state rule, no approval without a terminal, the exit codes, state outside the
repository, unknown items, out-of-order refusals, no sealing without a runtime, and the usage text.

## What it cannot see yet

Two promises need a documented container protocol that does not exist yet: "empty output means fail" through a whole
run, and "a canary that passes stops the run". They stay in the in-repo tests (`E7*`, `W-null-impl-fails`, the S4
canary tests) until that protocol is frozen.

## How it is used

- `tests/outer/outer-suite.test.ts` runs this checkout's copy against its own `dist/`, and proves the suite can
  fail by running it against builds with one promise broken on purpose.
- An advisory CI job runs the stage0 release's copy of the suite against the pull request's build. The stage0
  release is the tag named in `docs/maintainers/stage0.txt`; the job never uses the pull request's own copy. It is not a
  required check.
- Changing a contract on purpose, or the stage0 tag, is a kernel-path pull request. The owner merges it after reading
  the diff. Agents do not merge it.

## Adding a contract

1. Write it in `outer/contracts/Knn-name.mjs`. Open the file with `// Knn: <the promise>`.
2. Use only `node:` modules and `outer/lib/harness.mjs`. Spawn `omf` through `world.omf(...)`; read the ledger and the
   tree as bytes.
3. Run `node outer/run.mjs --omf dist/cli/main.js --only Knn`, then break the promise in a copy of `dist/` and see the
   contract fail. If it cannot fail, it is not a contract.
4. Add the broken-build case to `tests/outer/outer-suite.test.ts` when the promise can be broken by a one-line patch.
