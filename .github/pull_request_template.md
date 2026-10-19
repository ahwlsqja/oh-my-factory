## Summary

<!-- Problem and resulting behavior. Link the parent goal/intended outcome and canonical issue.
Use Closes #N only for full issue acceptance; use Refs #N for partial work.
For a tiny non-policy typo/link fix: Issue exception: trivial docs — reason.
Follow docs/maintainers/development-workflow.md. Keep security reports private. -->

## Acceptance and outcome

<!-- Map the bounded deliverable to the issue acceptance. Explain the contribution to the goal,
the evidence for it, and the outcome observation needed after delivery. Task Done is not goal achieved. -->

## Test plan

<!-- Checked revision/diff, actual commands/results, required review and unresolved findings.
List skipped checks, limitations and remaining risks. Apply the workflow's change-specific checks;
mark inapplicable items with a reason rather than claiming they ran. -->

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run lint` and `npm run format:check`, or documented docs-only validation

## Checklist

- [ ] One change per pull request
- [ ] Kernel paths checked against the base manifest; any kernel PR is reserved for current-diff human inspection and personal human merge
- [ ] Issue acceptance and required validation/review are accounted for; incomplete evidence is not Done
- [ ] Commit messages follow Conventional Commits
- [ ] New or changed behavior has a test (written first)
- [ ] Default/offline tests call no real model; tests use temporary homes, and any gated runs are authorized and recorded
- [ ] Docs updated, English and Korean where a translation exists
- [ ] Design change discussed first, if behavior in `docs/design` changes
- [ ] If an AI tool wrote much of this, I say so above and can explain it
