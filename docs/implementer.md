# The implementer container

How OMF runs the implementer (Claude Code) in a measured container, what crosses the boundary in each direction, what the credential exposes, and what none of it proves. `omf run` runs the implementer as the S3 station of the line (`src/implementer/`). Every claim below about a real container or a real model is not enforced until the gated suites in the table are recorded in `docs/evidence/gated-runs.json`.

## Status

| Claim | Gated suite | Status |
|---|---|---|
| A real implementer container measures L2, a real bundle imports, and the user's repository changes only by one branch | `G-implementer-boundary-real` | recorded in `docs/evidence/gated-runs.json` |
| Claude Code in the container follows the plan-first rule, publishes a candidate, reports its cost, and the key is found nowhere OMF scans | `G-implementer-real-run` | not enforced until recorded |
| A model told to find hidden scenarios finds no canary on any implementer-side surface and no path to the vault | `G-e6-l2-leak-redteam` | not enforced until recorded |

A first docker-only run of `G-implementer-boundary-real` failed because `kill -9 -1` exits 1 with "No such process" in a real container when the session left no process behind. The kill-all command now ignores that status and succeeds only when no process but PID 1 and its own shell remains (a zombie does not count); the suite then passed and is recorded.

Offline tests cover the code paths against a fake Docker and a real git; they call no model and no daemon. A skipped gated suite is not evidence. The baked-key refusal (an image that declares a credential name measures L1) is tested offline against recorded `docker inspect` shapes, not against a real daemon.

## The image

You build the image; OMF never pulls or builds it. It needs `sh`, `tar`, `git`, `base64`, `tr`, `sleep` and `claude`, and a passwd entry for uid 65532 with home `/agent` (the container runs as 65532, and both `git commit` and the Claude client need a name and a home):

```dockerfile
ARG BASE
FROM ${BASE}
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code \
 && echo "omf-implementer:x:65532:65532:omf implementer:/agent:/bin/sh" >> /etc/passwd \
 && echo "omf-implementer:x:65532:" >> /etc/group
```

`BASE` is a pinned image that ships Node (`--build-arg BASE=<name>@sha256:<64 hex>`); pin the claude version you tested. The golden enforces, at every run: no credential baked in (an image that declares `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_HOME`, `GITHUB_TOKEN` or the rest of the closed set measures L1 and the key is never handed over), no `codex` binary and no `~/.codex`, no `VOLUME`. `/tmp` is mounted without exec. A credential baked under a name outside the closed set is not recognised by name: the image is yours to keep clean.

Configure it by digest reference or by local image id (a locally built image has an id and no registry digest; both are immutable):

```toml
[implementer]
image = "sha256:<64 hex>"
```

## The credential

On the host OMF reads the key from `OMF_IMPLEMENTER_API_KEY` only, never from `ANTHROPIC_API_KEY` (the reconciler's host key), and a missing or unusable value stops the implementer step as `infra_failure`; the advisory `implementer` row of `omf doctor --json` names the variable and whether it is set.

The key is passed to one `docker exec` under the name the Claude client expects, as a name-only `--env ANTHROPIC_API_KEY`; the docker client reads the value from its own environment. It is never in an argument list, never in `docker inspect`, never in a file OMF writes and never in `config.toml`. Code running in the container can read and use the key, by design, and the container has open egress, so a program the model runs could send it anywhere. OMF's redaction and scans catch accidents (a key printed to a log, committed to a file, left in the workspace), not deliberate exfiltration.

The bound is the spend limit on the provider side. Create a dedicated Anthropic workspace that holds only this key, set a spend limit on it, and rotate the key after each gated run. Store it where its literal never appears in a command line: in the macOS keychain, `security add-generic-password -a "$USER" -s omf-gated-anthropic -w` asks for the value without echoing it.

## The network

The container runs on Docker's default bridge network. That is open egress to the model API and to everything else (an egress allowlist does not exist yet). The default bridge also lets the container reach other containers on that bridge and services on the host gateway of the docker context in use, which may be your everyday Docker. Use a dedicated docker context or colima profile; the gated driver uses only the `omf-m3f` profile and never changes your current context. `omf doctor` repeats this advice in the `implementer` row of its JSON report.

## What crosses the boundary

In: the tracked files of your base commit (HEAD when the item first runs), built on the host from the committed blobs, so no attribute, filter or `export-ignore` changes a byte, plus `spec.md` and `intent.md` rendered by OMF into `.omf/<work-id>/`. Untracked and ignored files are not seen, and your `.git` never enters the container. The repository is refused, with a closed code, when it contains a submodule (its content is not in the repository), when a tracked `.gitattributes` names `filter=lfs` (the container would receive pointer files, not content), or when the repository's own git configuration defines a filter or include driver. The Git LFS check reads the tracked attributes, not your global git configuration, which OMF's hardened git ignores: an LFS filter installed only in your global configuration, with no tracked attribute, is not seen.

Out: commits come back as a git bundle, imported into a fresh OMF-owned quarantine repository (verified, unbundled, strictly checked, the root tree compared with your base tree, the context commit compared byte for byte). Every blob and commit message reachable from the head is scanned for the credential and the vault canaries before anything is published. Then exactly one branch, `omf/<work-id>`, is written into your repository: no other ref, config, hook or index changes, and no reflog file. The branch starts at an unrelated root (the same files as your base commit, built inside the container), not on top of your commit; it is for review, and nothing re-parents it yet.

`.omf/<work-id>/` holds `spec.md`, `intent.md`, the implementer's `plan.md` and, when it asks a person to settle a conflict, `request.json`. One directory per item, so merged items never collide with each other or with files of your own.

## Running the gated suites

Nothing here is run by an agent. Build the image inside the dedicated profile once (the driver starts and stops the profile itself later):

```console
colima start omf-m3f --cpu 2 --memory 4 --activate=false
docker --context colima-omf-m3f build --build-arg BASE=<name>@sha256:<64 hex> -t omf-implementer:local .
docker --context colima-omf-m3f images --no-trunc -q omf-implementer:local
colima stop omf-m3f
```

The last command prints the image id (`sha256:...`). With it, the docker-only suite needs no key:

```console
OMF_GATED_IMPLEMENTER_IMAGE=sha256:<64 hex> npm run test:gated -- --only G-implementer-boundary-real --record
```

The model suites need the key for that one command. Type this yourself (the leading `!` runs it in your shell; the key is read from the keychain, so its literal appears nowhere), with your image id in place:

```console
! OMF_IMPLEMENTER_API_KEY="$(security find-generic-password -a "$USER" -s omf-gated-anthropic -w)" OMF_GATED_IMPLEMENTER_IMAGE=sha256:<64 hex> npm run test:gated -- --model --only G-implementer-real-run --record
```

`--model` sets `OMF_GATED=docker+model`, passes that one variable to the test process only, and sends the process's output through a redactor, so a key a failing test prints becomes `[redacted]`. Without `--model` a key in your environment is dropped. Run `G-e6-l2-leak-redteam` the same way. The output of a model run appears when it ends, not live.

## Limits

- The redactor and the scans catch the exact key, and for the redactor its JSON-escaped spelling; a re-encoded key (base64, split) is not caught. Neither stops exfiltration.
- Three behaviours rest on the pinned claude version and the docker client and are shown only by the gated runs: `docker exec --env NAME` inheriting the value from the client environment, `--setting-sources user` leaving out the repository's settings, and deny rules for test files under permission bypass.
- `max_log_bytes` defaults to 64 MiB; the real run records the observed log size in `docs/evidence/gated-runs.json` before that default is fixed.
- The tmpfs mounts are charged to the container's memory; the defaults are a starting point to measure.
- A rerun starts again from the base commit with the released feedback in the prompt; continuing from the previous head does not exist yet.
