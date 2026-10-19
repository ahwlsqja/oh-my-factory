# Outer contract suite

These tests check the promises the kernel makes, from the outside. They use two things only: the built `omf`
executable and files on disk (the ledger, the repository tree, the home directory). They import nothing from `src/`,
`dist/` or `tests/`, and they use no package. That is what lets the suite of an earlier release run against a new
build: a change to the kernel cannot also change the check that watches it.

## Run it

```sh
npm run build
node outer/run.mjs --omf dist/cli/main.js
```

| Option | Meaning |
|---|---|
| `--omf <path>` | the built entry point to check (required) |
| `--only K01,K03` | run only these contracts |
| `--json` | print one JSON document instead of the table |
| `--require-tty` | fail, instead of skipping, a contract that needs a terminal |

Exit codes: 0 every contract passed, 1 a contract failed or ran nothing, 2 a usage error.

To check a new build with the suite of an older release, check that release out into its own directory and point its
`outer/run.mjs` at the new build's `dist/cli/main.js`.

## Terminal-only steps

A ready work item needs two decisions only a person can make (J1 approving the goal, J2 resolving a decision), and OMF
refuses to make them without an interactive terminal. The contracts that need a ready item drive a pseudo terminal
with `lib/tty-run.py` (Python 3, standard library). Without `python3` those contracts are reported as skipped, with
the reason, and `--require-tty` turns the skip into a failure. The advisory CI job `.github/workflows/outer-suite.yml` passes `--require-tty` when it runs a stage0 release's copy of this suite; it reports a skip while the pinned release predates the suite.

## The contracts

| Id | Promise |
|---|---|
| K01 | an edited ledger stops every command that reads it |
| K02 | `init`, `doctor` and the read commands write nothing outside OMF host state |
| K03 | no decision of a person is taken without an interactive terminal |
| K04 | the exit codes mean what the documentation says |
| K05 | state never lives inside the repository |
| K06 | a work item the ledger does not know is refused by every verb |
| K07 | the verbs refuse out of order and name the gate that is missing |
| K08 | with no container runtime, `omf seal` never seals |
| K09 | the verbs a person is told to use exist and print their usage |

## Rules for changing it

- Add a contract only for a promise that holds in every later build. A promise that is still moving belongs in the
  in-repo tests under `tests/enforcement/`.
- Changing or removing a promise on purpose is a kernel-path pull request that edits the contract, and the owner
  merges it after reading the diff.
- The child process gets a scrubbed environment: no `GIT_*`, `XDG_*`, `OMF_*`, agent configuration, credentials or
  Docker settings, a temporary `HOME`, an `OMF_HOME` outside the repository, and `docker`, `claude` and `codex`
  stand-ins first on `PATH` that refuse to work. The only docker double in this tree is the refusing one; the stateful
  fake daemon stays with the in-repo tests.
