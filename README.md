# oh-my-factory

A goal-driven software factory for Claude Code and Codex CLI. People approve goals, decisions and
evidence. Agents do the work inside an isolated, sealed verification loop.

Status: pre-alpha. The design is in `docs/design/2026-10-12-omf-v0-design.md`
(Korean: `docs/ko/design/`).

License: Apache-2.0.

## Usage (M1)

    npm install
    npm run build
    node dist/cli/main.js init          # host state under ~/.omf; nothing written to the repo
    node dist/cli/main.js doctor        # tools, repo, ledger, isolation -> preflight.json
    node dist/cli/main.js ledger verify # hash-chain check
