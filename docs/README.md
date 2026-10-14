# Documentation index

OMF is pre-alpha. The documents below are the whole documentation set; there is no documentation site yet.
Start with the top-level [README](../README.md) for what OMF is and the command reference.

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

## Enforcement

- [Enforcement tests](../tests/enforcement/README.md): which test backs each control claim in the spec. A claim
  without a test is labelled "not enforced" in the spec.

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
