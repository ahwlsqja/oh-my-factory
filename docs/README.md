# Documentation index

OMF is pre-alpha. The documents below are the whole documentation set; there is no documentation site yet.
Start with the top-level [README](../README.md) for what OMF is and the command reference.

- [Local read-only dashboard](ui.md): optional browser observation with `omf ui`, its privacy boundary and unavailable states.
- [Dashboard design contract](../DESIGN.md): information hierarchy, visual language, accessibility and implementation constraints.

## Design

- [v0 design](design/2026-10-12-omf-v0-design.md): the specification. Canonical language is English.
- [M2b addendum: the goal loop](design/2026-10-12-omf-m2b-addendum.md): decisions D1 to D30 taken while building
  `omf goal tick`. It describes the loop as built where it differs from spec §4.4.

## Korean mirror

- [v0 설계](ko/design/2026-10-12-omf-v0-design.md): Korean translation of the v0 design. If the two differ, the
  English document is correct.
- [한국어 README](../README.ko.md): Korean version of the top-level README.

## References

- [References and read status](design/references.md): the sources behind the design and how closely each was read.

## Contributing

- [Development workflow](maintainers/development-workflow.md): goals, GitHub contributor issues, agent roles,
  review and verification. These contributor rules do not require product users to use an external tracker.
  English is canonical; a Korean mirror of this new workflow is pending.

## Enforcement

- [Enforcement tests](../tests/enforcement/README.md): which test backs each control claim in the spec. A claim
  without a test is labelled "not enforced" in the spec.
- [Conformance matrix](conformance-matrix.md): every control claim by id, with its state (covered, unproven, deferred,
  missing) and the date of the gated run behind it. Generated from `docs/requirements.json`.

## Verification line

- [The container judge](container-judge.md): the two-container judge, how its containers are measured, and its limits.
- [The implementer container](implementer.md): how the implementer runs in a measured container with one vendor key, what crosses the boundary, the exposure of the key, and the gated suites that are not enforced until recorded.
- [The sealing author container](author.md): how the sealing author runs in a measured container with one key, what crosses
  the boundary, what the measurement trusts, and the gated suites that are not enforced until recorded.
- [Command usage](cli-usage.md): the exact `--help` text of every command, generated and checked against the built CLI.
- [Gates, audit and isolation](isolation-and-gates.md): what the integrity line is, what it proves and what is not
  enforced yet.
- [Where the contract differs from the spec](m3c-spec-deviations.md): where the scenario and seal contract is more exact
  than the spec's examples, and how it joins the line.

## Examples

- [hello-goal](../examples/hello-goal/README.md): the goal loop end to end, offline, with a stand-in for the model.

## Conventions

- **Output policy.** OMF writes plain text only: no ANSI colour or other escape bytes, in a terminal or not, and
  with or without `FORCE_COLOR`. `tests/cli/no-ansi.test.ts` enforces it. If colour is ever added, it needs one
  helper that honours `NO_COLOR`, `FORCE_COLOR` and whether the stream is a terminal, and the test grows cases for
  those settings.
- **Links.** Relative links and heading anchors in every tracked Markdown file are checked by
  `tests/docs/links.test.ts`. External URLs are not fetched. `docs/plans/` is local only (gitignored) and is not
  checked; do not link to it from a tracked file.
- **First-run journey.** `tests/e2e/journey.test.ts` runs the README quick start against the built CLI in a
  temporary home and repository.

## Scope of this PR

The first-run journey (`tests/e2e/journey.test.ts`) and the no-ANSI test cover part of the planned work. Deferred
and tracked here:

- A journey that runs the packed tarball (`npm pack` then install) instead of the repository build.
- A `tick` step in the journey.
- Recovery from a corrupted ledger.
- Uploading journey timings and logs as a CI artifact.
- A real pty case for approval (J1 typed id) and for the no-ANSI test.
- `docs/ko/README.md`.
- A `check-docs` script.
