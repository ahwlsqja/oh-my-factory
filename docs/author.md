# The sealing author container

How OMF runs the sealing author (Codex) in a container whose isolation it measures first, what crosses the boundary in each direction, what the key exposes, and what none of it proves. `omf seal <work-id>` runs it (`src/author/`). Every claim below about a real container or a real model is not enforced until the gated suites in the table are recorded in `docs/evidence/gated-runs.json`.

## Status

| Claim                                                                                                                                                                                                                                       | Gated suite              | Status                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | --------------------------- |
| A real author container measures L2 with the real probe: no `claude` binary, no `~/.codex`, tmpfs mounts only, the answer path writable, the secret absent from `docker inspect`                                                            | `G-author-boundary-real` | not enforced until recorded |
| A real Codex author, given a canary in the worktree and in the vault, answers with neither, and the key appears nowhere OMF scans                                                                                                           | `G-author-canary`        | not enforced until recorded |
| decide, `omf seal`, `omf run` and `omf report` end to end with a real Codex author and a real Claude implementer, ending in outcome `success` with recommendation `human_needed` (the noise check is not evaluated, so that is the ceiling) | `G-skeleton-real`        | not enforced until recorded |

Offline tests cover the code paths against a fake Docker and call no model and no daemon. The offline walk through the shipped CLI plants a stub-authored seal and ends `blocked` at GATE-3 with the run's isolation level `unmeasured`: it shows the line refuses to claim what it did not measure, not that a real container is isolated. A skipped gated suite is not evidence.

## What the author gets

In: a tmpfs `/in` with three files, `intent.md`, `spec.md` and `contract.json` (the interface contract), a tmpfs `/out` for one answer file, and `/tmp` and `/agent` (an OMF-owned `CODEX_HOME`). The files are written by `tar -x` on stdin. The container has no bind mount, so no host path can reach it, and it holds no repository, worktree, vault, host state, plan or report.

Out: `/out/answer.json`, one JSON object `{ "scenarios_yaml": "<the YAML stream>" }`, read back with `cat`, capped in size and parsed by OMF. The string then goes through the same intake as any author's answer. Nothing else leaves the container and its output is never returned. A credential value found in the answer, in one of the spellings the scan searches, drops the answer (`credential_in_output`). A key in a spelling the scan does not search is stored with the scenarios in the vault and is seen by the harness container (network none), which is why the key must be dedicated and spend-limited.

Codex runs as one-shot `codex exec --ephemeral`. OMF refuses an argument list that is not a one-shot ephemeral exec, so there is no interactive path.

## The image

You build the image. OMF never builds the image and never pulls by tag. A digest reference (`name@sha256:...`) that is not present locally is pulled by that digest, and a local image id (`sha256:...`) is never pulled. It needs `sh`, `tar`, `cat`, `sleep` and `codex`, and a passwd entry for uid 65532 with home `/agent`. It must hold no `claude` binary, no credential file under `~/.claude`, `~/.codex` or `~/.aws`, and no baked credential name; an image that does is measured with a violation and the author does not start (`not_golden`).

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

The key is `OMF_AUTHOR_API_KEY`, set for the one command: `OMF_AUTHOR_API_KEY="$(security find-generic-password -a "$USER" -s omf-gated-openai -w)" omf seal <work-id>` (the keychain form keeps the key out of the shell history). OMF never reads `OPENAI_API_KEY`, `CODEX_API_KEY` or the implementer's variable, and a key is handed only to the exec that starts Codex, under the in-container name `CODEX_API_KEY`. That name is unverified against the pinned Codex until the first gated run. An author exec cannot carry the implementer's key, and the reverse.

The author's own tool calls in the container can read and use the key. The bound is a dedicated, spend-limited provider key; do not reuse a key that has no spend limit. `omf doctor --json` names the variable and whether it is set, never the value.

OMF searches for the key as text and in these other spellings: JSON-escaped, base64 with and without padding, base64url, hex in either case, and URL-encoded. It searches four places:

- What Codex printed on stdout and stderr. A key found there is counted in `credential_hits` on `author.session_completed` and the printed text is dropped: it is never stored and the pass goes on.
- The raw bytes of `answer.json`.
- The decoded answer: the `scenarios_yaml` string after the JSON decode, so a key written as JSON `\uXXXX` escapes is found.
- The scenarios intake would store. OMF searches the scenario files it would write, rendered by the vault renderer with throwaway ids, work id and time; as a second net it also decodes each YAML document of the answer on its own, so a key spelled with YAML double-quoted `\x` or `\u` escapes, or joined by a double-quoted line continuation, is found. One bad document (an unresolved alias, a circular anchor) never stops the scan of the others.

A hit in `answer.json`, the decoded answer or the scenarios intake would store ends the pass as `credential_in_output`, with `credential_hits` above 0 and nothing written to the vault. Still not found: a key that was reversed, shifted or otherwise computed from; a key split across two fields or with other characters between the pieces (a YAML folded scalar joins its lines with a space, so a key split over folded lines is not joined); and base64 of a longer string that merely contains the key at another alignment. So use a dedicated key that is capped in spend and short-lived (expiring within days, or revoked after the gated runs), and revoke it if a run ends in `credential_in_output`.

## What the measurement trusts

OMF measures the author container with `docker inspect` before the key reaches it. That measurement trusts the `docker` client found on PATH and the configured docker context. A replaced client, or a shim that answers the probe, can make every stage, the author's included, measure L2 through the shipped command. The offline acceptance avoids this only by its fixture choice. This is not enforced. [not enforced: S7.docker-client-trusted]

## What it costs

OMF neither records nor bounds the spend of an author call: money is not metered. It reads no usage or price numbers from Codex, so there is no dollar cap like the implementer's `max_model_usd`. What it caps instead, in the `[author]` table of `config.toml`:

- `timeout_ms`: wall time of one call (default 10 minutes).
- `max_output_bytes`: bytes Codex may print on stdout plus stderr in one call (default 1 MiB, 65536 to 16777216); past it the call stops as `output_limit`.
- `max_calls`: author calls one work item may use over its life (default 10, 1 to 100), counted from the ledger, one call per seal pass that reaches the model run. A pass takes its call under `seal.lock`, right before the model run and after GATE-1, the started-item check and the seal inputs have cleared, by appending `author.session_started`; the cap is checked under that same lock, so two passes racing for the last call let exactly one start. A pass whose author container then fails to start, fails a put or measures not_golden has still spent its call. A pass refused earlier (GATE-1 not passing, an item that already started, unusable seal inputs, a refusal before the lock) spends no call. A refused request (at the cap, or setup failed in the hook) leaves its `seal.requested` event open in the ledger, which changes no state. A pass killed mid-call, or one that throws before it records its end, is counted. When the count is reached `omf seal` is refused with `author_call_cap` before any container is made; raise the value to allow more.

Each `author.session_started` event records the pass, the round and `calls_before`. Each `author.session_completed` event records the caps in force (`limit_timeout_ms`, `limit_output_bytes`, `limit_calls`), the call's `output_bytes` and `calls_before`. The only bound on money remains the spend limit you set on the provider key.

## Limits

- The container runs on Docker's default bridge network: open egress to the model API and to everything else, since an egress allowlist does not exist yet. The default bridge also reaches other containers on that bridge and services on the host gateway of the docker context in use. Use a dedicated docker context or colima profile.
- A seal whose author stage is unmeasured is stored and reported as `stored`, and the run's isolation level reads `unmeasured`. For a work item that already started, `omf seal` cannot replace it yet and exits 2 saying so.
- `omf seal` on a seal that is current for the decisions and whose author stage is measured exits 0 as `already_sealed` and needs no key and no model. It does list the item's leftover containers to remove them, and answers the same when the daemon does not respond.
- If the host dies, the author container stops itself: its entrypoint is `sleep` for `ceil(author.timeout_ms / 1000)` seconds plus the caps of the other commands the container serves (the isolation probe, two uploads and the answer read, 105 seconds in all) plus a 60 second margin, 765 seconds with the default `timeout_ms`, counted from the container start in the daemon's clock. The image needs `sleep` and nothing else for this; OMF does not assume `timeout`. A stopped container is only removed by a sweep, so it stays listed (and holds no process) until one runs.
- Signals: SIGINT, SIGTERM, SIGHUP (a closed terminal) and SIGQUIT make OMF remove the containers it created before it exits with that signal. SIGKILL and a power cut run nothing, so the lifetime above is the only bound then.
- What sweeps an author container: these commands also remove the item author containers, only while no live process holds the item's `seal.lock`: `omf seal` and `omf run` (on the outcomes listed), `omf veto`, and `omf goal cancel` for the items it cancels. No other command sweeps; `omf report` only reads. `omf seal` sweeps at the start whatever it answers (a new seal, `already_sealed`, a refusal, a started item, GATE-1 not passing); `omf run` sweeps before it refuses (GATE-1 failing, no seal, awaiting review, a held claim, a stopped or finished goal, a repository guard refusal (sealed material in the repository), the GATE-4 entry stop (the same park reason or a kill three times, rounds or spend used up, limits missing, a ledger anomaly), a vetoed or cancelled item) and at the start of the line; `omf veto` and `omf goal cancel` print their result first and sweep the items they close afterwards. An unreadable `item.md`, a corrupt ledger, a symlink in the state tree, an invalid `config.toml` or an unset `docker_context` sweeps nothing until repaired. Each removes the author containers the item's earlier passes left, never the current pass's, never another item's (the `omf.work` label must be this item), and never one while the item's `seal.lock` is held. The sweep reads the item's `runs/` first, then checks the lock, then lists the daemon, so a pass that starts in between is not touched. It is best effort: when the daemon does not answer, it is repeated by the next command. The sweeps are proven offline with a docker double only; against a real daemon they are not proven.

## Gated runs

Three suites in `tests/gated` check the author container against a real Docker daemon on the `omf-m3f` colima profile. They are written and not recorded. Until `docs/evidence/gated-runs.json` holds a passing record for a suite, what it backs is not enforced, and this page says so. The owner runs them, never an agent; `docs/container-judge.md` says how the driver confines the Docker context.

| Suite                    | Needs                                          | What it checks                                                                                                                                                                                                                                               | Status                                                                                            |
| ------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `G-author-boundary-real` | Docker, the author image                       | A real author container measures L2 with the real probe, mounts only the four tmpfs paths, has no `claude` binary and no `.codex` directory, shows the secret to one exec only and never to `docker inspect`, and has a writable answer path                 | not enforced [not enforced: S5.3.author-boundary-real]                                            |
| `G-author-canary`        | Docker, the author image, `OMF_AUTHOR_API_KEY` | The real Codex author answers through `omf seal`; the answer holds no goal canary, no marker planted in the worktree or the vault and not the key; the daemon's document of the container names no host path; no file OMF writes holds the key               | not enforced [not enforced: S5.3.author-answer-no-leak] [not enforced: F6.author-vault-host-only] |
| `G-skeleton-real`        | Docker, the three images, both keys            | `omf seal`, `omf run` and `omf report` on a staged item with a real author and a real implementer: one rework round, outcome `success`, recommendation `human_needed`, run isolation level `L2`, and `noise_check_not_evaluated` as the only unverified area | not enforced [not enforced: S5.0.skeleton-real-line]                                              |

Under the noise-check decision of the container judge a run never reaches `merge_recommended`, so the strongest result a recorded run can show is `success` with `human_needed`.

### Running them

Name the images once, as digest references or local image ids. The harness image must ship Node: the staged item runs `node app/search-cli.mjs` in the judge's container.

```sh
npm run build
export OMF_GATED_AUTHOR_IMAGE=<author image: digest reference or local image id>
export OMF_GATED_IMPLEMENTER_IMAGE=<implementer image: digest reference or local image id>
export OMF_GATED_HARNESS_IMAGE=<digest reference of a base image with Node>
npm run test:gated -- --only G-author-boundary-real
OMF_AUTHOR_API_KEY=<dedicated, spend-limited key> npm run test:gated -- --model --only G-author-canary
OMF_AUTHOR_API_KEY=<dedicated, spend-limited key> OMF_IMPLEMENTER_API_KEY=<dedicated, spend-limited key> npm run test:gated -- --model --only G-skeleton-real
```

Type the two key lines with the keychain form instead of the placeholder, so no key text enters the shell history (type the lines as shown in bash or zsh, without a leading `!`, which in those shells negates the exit status and is only a Claude Code prompt shortcut; `omf-gated-openai` and `omf-gated-anthropic` are the keychain service names to store the keys under):

```console
OMF_AUTHOR_API_KEY="$(security find-generic-password -a "$USER" -s omf-gated-openai -w)" npm run test:gated -- --model --only G-author-canary
OMF_AUTHOR_API_KEY="$(security find-generic-password -a "$USER" -s omf-gated-openai -w)" OMF_IMPLEMENTER_API_KEY="$(security find-generic-password -a "$USER" -s omf-gated-anthropic -w)" npm run test:gated -- --model --only G-skeleton-real
```

The driver starts the `omf-m3f` profile, passes the test process the union of the keys that the suites matched by `--only` read (all of them without `--only`), each under its own name, so one vitest process holds every key of every matched suite and runs the output through a redactor. A key is passed on the command line of the one command that needs it and is never written to a file; the suites print nothing, and a failure message is a fixed string. Use dedicated keys with a provider-side spend limit: code in the container can read the key it is given, and author spend is not recorded or bounded by OMF in money (see What it costs for the wall-time, output and call caps it does enforce).

To record a passing suite, add `--record` on a clean working tree; the evidence file `docs/evidence/gated-runs.json` may differ from an earlier `--record` run, and the driver says the records are pending until you commit it. Then:

1. Delete that suite's `[not enforced: ...]` marker in the table above; `tests/docs/m3h-gated-claims.test.ts` fails until you do.
2. A recorded `G-author-boundary-real` also covers `S5.3.author-measured-before-key`: delete its `[not enforced: S5.3.author-measured-before-key]` marker in `docs/isolation-and-gates.md` too.
3. Regenerate `docs/conformance-matrix.md` with `node scripts/conformance-matrix.mjs --write` and commit it with the evidence file.

The item of `G-skeleton-real` is staged on purpose: its constraints tell the implementer to leave the missing-value case for the feedback round, so the rework path is exercised without depending on a model error. If the implementer ignores that instruction the suite fails with the message `the line finished without a rework round`; that points at the fixture, not at the line. It also tells the implementer to change only `app/search-cli.mjs` and add no test file: a test file added anyway is a high-risk path, and the suite then fails with `the unverified areas are not only the noise check`.

One known risk to check on the first `G-author-canary` run: the Codex exec's stdout and stderr together are capped at 1 MiB. They are only scanned for the key (the answer leaves through `/out/answer.json`), but a longer transcript is stopped as `output_limit` and the seal pass asks for a rerun that spends again. If the canary run stops that way, the Codex exec needs its own larger cap.

`scripts/smoke-w.sh` is a cheaper check. In a throwaway repository, home and Docker config limited to the `omf-m3f` context, it runs the three verbs against an item that does not exist and checks that each refuses in order, names the item and prints no key. It spends nothing and needs both keys in its environment only so it can prove they are never printed.
