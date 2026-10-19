# Releases

This page is for maintainers. It describes how versions and the changelog are produced today, what is
deliberately not automated, and how to cut `0.1.0` when the time comes.

## Status

- `package.json` has `"private": true`, so `npm publish` refuses to run. That is intentional.
- No workflow in this repository publishes to npm. `release-please.yml` only opens and updates a
  release pull request and, when that pull request is merged, creates a git tag and a GitHub Release.
- The version for this checkout is recorded in the [release manifest](../../.release-please-manifest.json)
  and [package metadata](../../package.json). Check the repository's
  [tags](https://github.com/ahwlsqja/oh-my-factory/tags) and
  [GitHub Releases](https://github.com/ahwlsqja/oh-my-factory/releases) for released versions.
- release-please maintains [CHANGELOG.md](../../CHANGELOG.md) through release pull requests.
- **The release job is opt-in.** The [workflow](../../.github/workflows/release-please.yml) runs only when
  the repository variable
  `RELEASE_PLEASE_ENABLED` is set to `true` (Settings > Secrets and variables > Actions > Variables).
  If the variable is unset or has another value, the release job is skipped on pushes to `main`.
  Check the repository settings for its current value. Set it only after the token decision below is
  made.

Publishing is a separate decision for the owner. When it is made, it needs its own workflow (trusted
publishing with provenance is the intended route), and removing `"private": true` is part of that change.

## How a release works

1. Changes land on `main` with Conventional Commit messages (`type(scope): subject`).
2. On every push to `main` (when enabled), `.github/workflows/release-please.yml` runs
   [release-please](https://github.com/googleapis/release-please-action). It reads the commits since
   the last release and opens (or updates) one pull request titled like `chore(main): release 0.0.2`.
   That pull request changes `package.json`, `.release-please-manifest.json` and `CHANGELOG.md`.
   (The node release type also updates `package-lock.json` when it can.)
3. A maintainer reviews the release pull request, gets the required `ci` check green (see the caveat
   below) and merges it.
4. On that merge release-please creates the tag `vX.Y.Z` and a GitHub Release with the changelog entry.

Configuration lives in [release-please-config.json](../../release-please-config.json). Notes on the
choices:

- Pre-1.0 policy: `bump-minor-pre-major` and `bump-patch-for-minor-pre-major` are both on. While the
  major version is `0`, a breaking change bumps the minor version and a feature bumps only the patch
  version, so versions stay `0.0.x` until `0.1.0` is cut deliberately with a `Release-As` footer
  (see below).
- `bootstrap-sha` is pinned to the `main` head at the time this was set up, so the first run does not
  walk the whole history. It can be removed after the first release.
- The job has top-level `permissions: {}` and, on the job only, `contents`, `pull-requests` and
  `issues` write. `issues: write` is needed because release-please creates its `autorelease:` labels.
- Changelog sections: Features, Bug Fixes, Performance, Refactoring and Documentation are shown.
  `test`, `ci` and `chore` commits are hidden from the changelog but still count as history.
- Only the commit type decides the section. Under merge commits release-please reads the commit
  messages on `main`, not pull request titles, so keep commit messages accurate. The
  `.github/workflows/pr-title.yml` title check is a style aid only. It runs the pull request's own copy
  of `scripts/lint-pr-title.mjs`, so a pull request can change the rule that checks it; it must stay
  advisory (not required) until it runs the base branch's copy of the script.

## Owner decision: how the release PR is opened

release-please must be able to create a pull request. Choose one before setting
`RELEASE_PLEASE_ENABLED`. This repository does not add any secret or change any setting for either
option.

- **Option 1: `GITHUB_TOKEN` (no secret).** Requires the repository setting "Allow GitHub Actions to
  create and approve pull requests" (Settings > Actions > General > Workflow permissions) to be enabled.
  Check that setting before using this option; without it release-please fails to open the release pull
  request.
- **Option 2: a GitHub App token.** Create a GitHub App with Contents, Pull requests and Issues
  write access, install it on this repository, store the App id and private key as repository
  secrets, and mint a token in the workflow with `actions/create-github-app-token`, passing it to the
  release-please step as `token:`. Prefer an App over a personal token because it has no expiry tied
  to a person.

## The CI-trigger caveat

Pull requests opened with `GITHUB_TOKEN` do not trigger other workflows. GitHub does this on purpose to
prevent workflow loops. With option 1, `ci.yml` does not run on the release pull request, the required
`ci` check never reports, and the branch ruleset blocks the merge. A token from option 2 does trigger CI.

With option 1, nudge the release pull request by hand (you need write access). Events caused by a
person trigger CI normally:

```sh
# Close and reopen
gh pr close <number> -R ahwlsqja/oh-my-factory && gh pr reopen <number> -R ahwlsqja/oh-my-factory

# Or push an empty commit to the release branch
gh pr checkout <number> -R ahwlsqja/oh-my-factory
git commit --allow-empty -m "chore: trigger CI"
git push
```

The release branch is named by release-please (for example `release-please--branches--main`);
`gh pr checkout` finds it without you having to know the name. The empty `chore` commit does not
appear in the changelog because `chore` is hidden.

## Cutting 0.1.0 later

When the owner decides it is time to cut `0.1.0`:

1. Make sure `main` is green and the release pull request, if one is open, is understood.
2. Force the version with a `Release-As` footer on any commit that lands on `main` (an empty commit works):

   ```sh
   git commit --allow-empty -m "chore: release 0.1.0" -m "Release-As: 0.1.0"
   ```

   Push it through a normal pull request. release-please then retitles the release pull request to
   `release 0.1.0`.
3. If the release pull request was opened with `GITHUB_TOKEN`, nudge CI (caveat above), review the changelog and merge it.
4. Release-please tags `v0.1.0` and creates the GitHub Release. Nothing is published to npm.

If the owner also wants an npm package at that point, that is a separate change: drop `"private": true`,
add a publish workflow, and update this page.
