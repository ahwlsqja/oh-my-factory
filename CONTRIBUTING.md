# Contributing to oh-my-factory

OMF is pre-alpha. Follow the [development workflow](docs/maintainers/development-workflow.md): start
from an agreed goal and evidence, scope meaningful work in a GitHub issue, then implement and verify a
bounded PR. Task completion does not establish goal achievement. The workflow defines readiness,
completion, review, worktrees, permissions and the trivial-docs/private-security exceptions.

Security problems do not go in issues or pull requests. Follow [`SECURITY.md`](SECURITY.md).

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). OMF has no telemetry,
and contributions must not add any.

## Pre-1.0 policy

OMF is 0.x. Any minor release may change commands, file formats or ledger events. Breaking changes will
be listed in the changelog once release automation lands.

## Platforms

macOS and Linux with Node.js 22.12 or newer are supported and tested in CI. Windows is not supported
yet.

## Setup

You need Node.js 22.12 or newer and npm.

```sh
git clone https://github.com/ahwlsqja/oh-my-factory.git
cd oh-my-factory
npm ci
```

## Checks

Run these for code or behavior changes before committing. Documentation/templates-only changes use
the workflow's [lightweight checks](docs/maintainers/development-workflow.md#validation-and-review-evidence).
Full CI still applies.

```sh
npm run typecheck   # source and tests
npm test            # builds dist/ from scratch and runs the whole suite
npm run build       # production build
npm run lint
npm run format:check
```

## Output and colour

OMF prints no ANSI colour or other control sequences. Tests enforce this (`tests/cli/no-ansi.test.ts`,
which lands in a sibling pull request), so do not add colour output.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): subject`, for example
  `fix(ledger): report a missing seq`. Common types are `feat`, `fix`, `docs`, `test`, `refactor` and
  `chore`.
- One bounded issue/change per pull request; follow the workflow for parent/child splits and exceptions.
  Use `Closes #N` only when the PR completes the issue's full acceptance; partial work uses `Refs #N`.
- Add relevant [Lore decision trailers](docs/maintainers/development-workflow.md#commits-and-handoff)
  to Conventional Commit subjects. Do not mix a refactor, a feature and a docs sweep.
- Say in the pull request how you checked the change, using the commands above.
- If an AI tool wrote much of the change, say so in the description. You must be able to explain every
  line you submit.

## Tests

Every behavior change needs a test, and we expect test-driven development: write a failing test,
make it pass, then clean up. A bug fix starts with a test that reproduces the bug.

The default offline test suite never calls a real model; tests never touch your real home directory:

- The global setup puts `claude` and `codex` shims first on `PATH`
  (`tests/helpers/bin-shims`). They exit with an error, so a test that reaches for a real agent CLI
  fails loudly instead of spending money. A test that needs a working agent puts its own stub first on
  `PATH` (`tests/helpers/agent-stubs.ts`).
- Use a temporary directory for `HOME` and `OMF_HOME` (see `tests/helpers/tmp.ts`), never the real
  ones.
- `scripts/smoke-reconciler.sh` runs a real model once. It costs tokens, is not part of `npm test`, and
  is run by hand only.

The tests under `tests/enforcement` back the safety claims in the design. If you weaken one, update
its row in `tests/enforcement/README.md` in the same commit and explain why in the pull request.

## Documentation

Docs are written in English and have a Korean translation. English is canonical. If you change a page
that has a Korean counterpart under `docs/ko`, update both, or say in the pull request that the
translation is still to do.

## Design changes

Behavior that the design describes changes through `docs/design`. Propose the design change first (an
issue or a pull request that edits the design document), get agreement, then change the code. Code
that disagrees with the design is a bug in one of the two.

## Plans

Working plans and scratch notes stay on your own machine. Do not commit them. What is worth keeping
goes into the design documents or the pull request description.
