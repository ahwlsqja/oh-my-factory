# The sealing author container

How OMF runs the sealing author (Codex) in a container whose isolation it measures first, what crosses the boundary in each direction, what the key exposes, and what none of it proves. `omf seal <work-id>` runs it (`src/author/`). Every claim below about a real container or a real model is not enforced until the planned gated suites in the table are written and recorded in `docs/evidence/gated-runs.json`.

## Status

| Claim | Gated suite | Status |
|---|---|---|
| A real author container measures L2 with the real probe: no `claude` binary, no `~/.codex`, tmpfs mounts only, the answer path writable, the secret absent from `docker inspect` | `G-author-boundary-real` | not enforced until recorded |
| A real Codex author, given a canary in the worktree and in the vault, answers with neither, and the key appears nowhere OMF scans | `G-author-canary` | not enforced until recorded |
| decide, `omf seal`, `omf run` and `omf report` end to end with a real Codex author and a real Claude implementer, ending in outcome `success` with recommendation `human_needed` (the noise check is not evaluated, so that is the ceiling) | `G-skeleton-real` | not enforced until recorded |

Offline tests cover the code paths against a fake Docker and call no model and no daemon. The offline walk through the shipped CLI plants a stub-authored seal and ends `blocked` at GATE-3 with the run's isolation level `unmeasured`: it shows the line refuses to claim what it did not measure, not that a real container is isolated. A skipped gated suite is not evidence.

## What the author gets

In: a tmpfs `/in` with three files, `intent.md`, `spec.md` and `contract.json` (the interface contract), a tmpfs `/out` for one answer file, and `/tmp` and `/agent` (an OMF-owned `CODEX_HOME`). The files are written by `tar -x` on stdin. The container has no bind mount, so no host path can reach it, and it holds no repository, worktree, vault, host state, plan or report.

Out: `/out/answer.json`, one JSON object `{ "scenarios_yaml": "<the YAML stream>" }`, read back with `cat`, capped in size and parsed by OMF. The string then goes through the same intake as any author's answer. Nothing else leaves the container and its output is never returned. A credential value found in the answer drops the answer (`credential_in_output`).

Codex runs as one-shot `codex exec --ephemeral`. OMF refuses an argument list that is not a one-shot ephemeral exec, so there is no interactive path.

## The image

You build the image; OMF never pulls or builds it. It needs `sh`, `tar`, `cat`, `sleep` and `codex`, and a passwd entry for uid 65532 with home `/agent`. It must hold no `claude` binary, no credential file under `~/.claude`, `~/.codex` or `~/.aws`, and no baked credential name; an image that does is measured with a violation and the author does not start (`not_golden`).

```dockerfile
ARG BASE
FROM ${BASE}
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @openai/codex \
 && echo "omf-author:x:65532:65532:omf author:/agent:/bin/sh" >> /etc/passwd \
 && echo "omf-author:x:65532:" >> /etc/group
```

## Configuration

```toml
[judge]
docker_context = "colima-omf-m3f"   # one context serves every container, the author's included

[author]
image = "omf-author@sha256:<64 hex digits>"   # a digest, or a local image id; a tag is refused
# timeout_ms = 600000   memory_mb = 1024   cpus = 1   pids_limit = 256
# tmp_tmpfs_mb = 64   in_tmpfs_mb = 16   out_tmpfs_mb = 16   agent_tmpfs_mb = 128
```

The four tmpfs sizes are charged to the container's memory, so their sum must fit in `memory_mb`. `roles.author` (default vendor `codex`, optional `model`) picks the author. `roles.judge` is read and checked and starts nothing: the judge is deterministic checks only, and `omf run` and `omf report` say so. An author and an implementer on the same vendor are refused with exit 2 before a key is read, and `[seal] same_vendor` in `config.toml` is refused too, because no same vendor pairing can run in this release.

## The key

The key is `OMF_AUTHOR_API_KEY`, set for the one command: `OMF_AUTHOR_API_KEY=... omf seal <work-id>`. OMF never reads `OPENAI_API_KEY`, `CODEX_API_KEY` or the implementer's variable, and a key is handed only to the exec that starts Codex, under the in-container name `CODEX_API_KEY`. That name is unverified against the pinned Codex until the first gated run. An author exec cannot carry the implementer's key, and the reverse.

The author's own tool calls in the container can read and use the key. The bound is a dedicated, spend-limited provider key; do not reuse a key that has no spend limit. `omf doctor --json` names the variable and whether it is set, never the value.

## What the measurement trusts

OMF measures the author container with `docker inspect` before the key reaches it. That measurement trusts the `docker` client found on PATH and the configured docker context. A replaced client, or a shim that answers the probe, can make every stage, the author's included, measure L2 through the shipped command. The offline acceptance avoids this only by its fixture choice. This is not enforced. [not enforced: S7.docker-client-trusted]

## What it costs

OMF neither records nor bounds the spend of an author call. The only bound is the spend limit you set on the provider key.

## Limits

- The container runs on Docker's default bridge network: open egress to the model API and to everything else, since an egress allowlist does not exist yet. The default bridge also reaches other containers on that bridge and services on the host gateway of the docker context in use. Use a dedicated docker context or colima profile.
- A seal whose author stage is unmeasured is stored and reported as `stored`, and the run's isolation level reads `unmeasured`. For a work item that already started, `omf seal` cannot replace it yet and exits 2 saying so.
- `omf seal` on a seal that is current for the decisions and whose author stage is measured exits 0 as `already_sealed` and needs no key, no daemon and no model.
- A killed `omf seal` can leave an author container behind. The next `omf seal` on the same work item removes the author containers that its earlier seal passes left behind, and never the container of the current pass.

## Running the gated suites

The three suites above are planned and not written yet: `tests/gated/` holds none of them and `scripts/gated-docker.mjs` does not know them. Once they exist they will follow the procedure of `docs/implementer.md` (the dedicated colima profile `omf-m3f`, an image built inside it) and be run by the owner, never by an agent. See `docs/container-judge.md` for how the driver confines the Docker context.
