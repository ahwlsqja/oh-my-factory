# Security policy

oh-my-factory (OMF) is pre-alpha software. It runs coding agents, keeps state on your machine and
handles credentials, so we take security reports seriously even at this stage.

## Supported versions

| Version | Supported |
|---|---|
| `main` (pre-alpha) | Yes |
| Anything else (old commits, forks, unreleased branches) | No |

There are no published releases yet. Fixes land on `main` only and are not backported.

## Reporting a vulnerability

Please do not open a public issue, pull request or discussion for a security problem.

Use GitHub private vulnerability reporting instead:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Describe the problem, the affected commit, and how to reproduce it.

Note for the maintainer: private vulnerability reporting is a repository setting and must be enabled
(Settings, Code security, Private vulnerability reporting). If the "Report a vulnerability" button is
missing, the setting is not on yet. In that case open a public issue that says only "I need a private
channel for a security report", with no technical details, and the maintainer will arrange one.

Please mask paths that contain your user name, e-mail addresses, tokens and any other credential in
what you send. Never include a real secret.

## Response goals

These are goals for a one-person project, not promises or a service-level agreement.

- Acknowledge a report within about 7 days.
- Give a first assessment (accepted, needs more information, or out of scope) within about 14 days.
- Aim to fix accepted issues on `main` within about 90 days, sooner for serious ones.
- Publish a short advisory after the fix, crediting the reporter unless they prefer otherwise.

## Threat model summary

The full model is in [`docs/design/2026-10-12-omf-v0-design.md`](docs/design/2026-10-12-omf-v0-design.md),
section 7 (execution and isolation) and section 11 (non-pollution and safety rules). In short:

- **Trusted:** the user's own machine and account, and the governance files they wrote and approved.
- **Not trusted:** issue bodies, channel messages, metric output, repository content that an agent
  reads, and anything an agent produces. Triggers pass identifiers only, and OMF reads the content
  itself.
- **Isolation is measured, not declared.** `omf doctor` reports the isolation actually in effect, and
  permission-bypass flags are allowed only inside an isolated container, never on the host or in your
  checkout.
- **Credentials:** only the implementer vendor's credential enters the implementer environment. OMF
  never stores or brokers subscription tokens. Code running inside that environment can read the
  credential it was given; an egress allowlist reduces exfiltration but does not remove it.
- **Non-pollution:** OMF keeps its own state outside the repository and outside the agent CLIs'
  config homes, never auto-commits to your branches and never merges. It refuses to run if sealed
  material appears inside the repository.

The controls that tests enforce are listed in [`tests/enforcement/README.md`](tests/enforcement/README.md).
A claim without a test there is not enforced.

## In scope

- Host state under `~/.omf` (or `OMF_HOME`): reading, writing or tampering with it in ways the design
  says OMF prevents, including file permissions and path handling.
- Credentials: any path that leaks a credential into logs, ledgers, reports, the repository, or an
  environment that should not have it, or that copies one with looser permissions than designed.
- Isolation and non-pollution: writes to the repository, `~/.claude` or `~/.codex` that the design
  forbids, and sealed material reaching a place it should not.
- The decision and goal ledgers: bypasses of the human-only rule for closing a decision, of budget
  accounting, of metric locks, or of the metric-leak protections.
- Untrusted input handling: command or path injection from issue text, metric output or repository
  content.

## Known limits (reports about these alone are out of scope)

- The ledger is a hash chain. It detects edits to earlier entries but does not protect against
  someone who can write to `~/.omf` and recomputes the chain. Truncating the end of the ledger is not
  detected.
- Actor signatures in v0.1 are not cryptographic.
- Anyone with write access to your account or home directory is already trusted.
- Vulnerabilities in Claude Code, Codex CLI, Node.js or other dependencies belong to those projects,
  though a way OMF makes them exploitable is in scope.
- Reports that need physical access, a compromised host, or social engineering of the maintainer.
