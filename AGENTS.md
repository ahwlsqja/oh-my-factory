# OMF contributor instructions

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the canonical
[development workflow](docs/maintainers/development-workflow.md) before changing this repository.
Product contracts remain in [docs/design](docs/design/); this file routes contributor work.

- Start from the agreed goal and evidence, identify the gap, then scope a GitHub issue and a small PR.
  A completed task does not establish goal achievement. Observe the outcome after delivery.
- Follow the workflow's issue/security exceptions, state transitions, isolated worktrees, validation,
  review freshness and completion rules. Do not duplicate their detailed definitions here.
- Execute clear, authorized local inspection, edits and tests without per-step permission handoffs.
  Continue independent safe work when a review or validation is blocked; report the missing evidence.
  Goal/acceptance or product/security boundary changes need a human decision. Merge, release, deployment
  and destructive actions require existing user authority; do not ask again when it already covers them.
- Kernel PRs are an exception to agent merge authority: a human must inspect the current diff and
  personally merge. Agents must not merge them; follow the workflow's protected path manifest.
  This is contributor policy, not an implemented GitHub gate; record the inspected head SHA in human evidence.
- Maintainer agent-led roles: **Builder** leads, plans, writes code/tests, integrates and owns task state;
  **Explorer** performs scoped, independent, read-only searches in parallel when useful; **Reviewer**
  reviews important plans, recurring errors and final omissions in substantive changes, not routine writing.
  Select the session/request's [model profile](docs/maintainers/development-workflow.md#execution-and-roles);
  the Codex aliases Sol 6.1 / Luna 6 / Astra map to `gpt-6.1-sol` / `gpt-6-luna` / `gpt-6-astra`.
  Claude uses Sonnet / Haiku / Opus families at the already-selected session/maintainer versions.
  External contributors follow the ordinary issue/PR/evidence rules; maintainers arrange required reviews.
  Contributors do not need to purchase or run these models.
- Give reviewers the goal/acceptance, revision/diff, relevant contracts, validation and specific questions,
  not the whole conversation. Report unavailable requested models; never silently substitute them or
  providers, or claim an incomplete required review passed. Apply the workflow's existing-authority/waiver rule.
- Preserve others' edits and keep each write lane isolated. No new dependency without explicit request.
  Use Conventional Commit subjects expressing intent and relevant Lore decision trailers.
- GitHub Issues tracks development of OMF. It does not require OMF product users to use GitHub, Linear,
  Notion or any other external tracker, and does not change product runtime providers or state storage.

These rules apply prospectively after adoption. Do not fabricate issue-first history for existing work.
