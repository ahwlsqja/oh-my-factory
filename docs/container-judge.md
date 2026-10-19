# The container judge (M3f)

How a candidate commit is judged in two disposable containers, how every container is measured before candidate code runs in it, and what none of that proves. Offline tests use a fake Docker. Runs against a real container are gated (`npm run test:gated`), and a claim here is enforced against a real container only where `docs/evidence/gated-runs.json` records a passing run of a suite that covers it. Otherwise it is not enforced.

## What exists

| Piece | Where | What it does |
|---|---|---|
| Argv builder | `src/container/argv.ts` | The one place `docker create`, `exec`, `build` and `rm` arguments are built. Its spec type cannot express a bind or volume, a privilege, a capability, a device, a PID or IPC share, a network other than `none`, or an env value. |
| Docker runtime | `src/container/docker-cli.ts` | The only new spawner of `docker`. It passes `PATH` and an explicit `DOCKER_CONFIG` and accepts only a local `unix://` daemon endpoint. |
| Measurement | `src/container/measure.ts` | Creates a container, reads `docker inspect`, judges the facts before the container starts, starts it only if they are golden, probes inside, and records the stage. |
| SUT image | `src/container/sut-build.ts` | Builds from `git archive` of the candidate commit in the quarantine repository, with `--network none` and a digest-pinned base. |
| Work copy | `src/container/work-copy.ts` | Runs gate commands and prove-test in a container; the tree arrives as a tar on stdin. |
| Harness | `harness/main.mjs`, `src/judge/harness-protocol.ts` | An OMF-owned container that holds the scenarios (loaded over stdin) and judges what the host relays. The SUT never sees an expectation. |
| Round | `src/judge/round.ts`, `src/judge/relay.ts` | k repetitions, one fresh measured SUT container per scenario repetition, flaky counting, and a host cross-check of the harness verdict. |
| Stations | `src/judge/stations.ts` | S4 (train split and the contradiction canaries of both splits), S5 (gates, prove-test, audit, canary attribution), S6 (the test split, once). |
| GATE-3 adapter | `src/gate/gate3-gate.ts` | Registered in `defaultGates()`; reads only ledger events and the item directory. |

## How a round runs

1. S4 builds the SUT image from the candidate commit and the harness image (cached by the hash of its context).
2. The harness container is created, measured and started, and the round's scenarios are loaded into it over stdin with a per-round nonce. No path is ever mounted into any container.
3. For every repetition and scenario a fresh SUT container is created, measured and started. The host relays each step to it as `docker exec` argv and stdin and hands the observation to the harness, which answers pass or fail and the next step.
4. The host checks the harness verdict against what it relayed. A missing, malformed or foreign verdict, an `error` scenario or an empty set ends the round; none of them is a pass.
5. Containers are removed in `finally`, on a signal by name, and by a sweep at the next S4 start. The SUT image lives until the line ends so S6 can use it.
5a. If the host is killed, each judge container stops itself: its entrypoint is `sleep` for a bound, counted from the container start in the daemon's clock (none sleeps for ever). The bound is wall-clock time, so it covers every call the host makes while the container is alive, each at its cap; the worst case is multiplied by a safety factor of 1.5 and a 60 second margin is added. Docker calls (create, inspect, start, remove) are capped at 60 seconds, the probe at 15, a step, an `observe`, a `begin`, `load` and `verdict` at `judge.step_timeout_ms`. The calls counted:
    - Per step: the step `exec` and the harness `observe` (two calls at the step cap) and the state check (an inspect, 60 seconds) the relay makes after a non-zero exit, counted for every step.
    - Per SUT container, from its start: the probe, at most 12 steps as above, and two removes (the one a cut step triggers and the one `close` makes). 1703 seconds with the default step cap.
    - Harness container, for the whole round: the probe, `load`, `verdict` and its own create, start and remove, and for each of `judge.k` repetitions of at most 100 scenarios a `begin`, the SUT's create, inspect and start, and everything a SUT container is counted for above. 578633 seconds with the defaults.
    - Work copy container: the probe, the 120 second upload and 600 second build, and 32 gate execs at 600 seconds each, every one followed by a state check, and the remove. 32933 seconds. Every gate exec is clamped to 600 seconds whatever timeout the caller passes (the default of the gates and of the test command is 600 seconds as well). The lifetime is a budget: the copy counts the execs of its container and replaces it with a fresh one (a new lifetime, extracted and built again) when the 32nd has run.
    A round is refused (`set_invalid`) when it has more than 100 scenarios or a scenario has more than 12 steps, the numbers the bounds are sized from, so a caller cannot outgrow them silently. A container's own create and inspect come before `docker start` and so fall outside its lifetime, which counts from the start; the margin covers them. A bound never exceeds what `sleep` accepts. The bounds are sized above what the configured caps allow, not measured on a real daemon. A container that is gone (its bound ran out, or it was removed) ends the round or the gate as an infrastructure error, never as a candidate failure: after any non-zero exit, or an exec client error, from a SUT step or a work copy exec the host asks the daemon whether the container still runs (running, gone or unknown, where a failed inspect is unknown), and a container that is not running is a round error (`round_error`) or an error result (`container_gone`: a gate `skip`, a test command that could not run), whatever the exit status (1, 125 and up, 137). One rule covers both: a candidate cannot end its own container from inside, because PID 1 is the idle `sleep`, which installs no signal handlers, and the kernel drops signals sent to a namespace init from inside that namespace when it has no handler (SIGKILL and SIGSTOP included); the candidate has no docker socket. A non-zero exit from a container that is still running stays the candidate's or the gate's result. A stopped container is only removed by a sweep.
5b. A killed run's leftovers are swept by item. The run-start sweep (S1, the implementer station and S4) removes the item's judge containers, round images and host staging of earlier runs under the claim. `omf seal`, `omf run` (on every outcome it sweeps on), `omf veto` and `omf goal cancel` also remove them, for any item, while no live process holds the item claim. Selection is by the `omf.work` label and the run id (a round image's label is read by inspecting it; an image whose label cannot be read is never selected); the cached harness image is kept, and so is the current run. `docs/implementer.md` lists the staging directories and the other rules.
6. A container that deviates from its golden values is recorded as L1 and removed without ever starting, so the candidate never runs in it.

## The digest rule

Images the judge runs are `name@sha256:<64 hex>` and are refused as a tag when the config is read. `omf metric propose --image` refuses a tag. A metric lock created before this rule keeps its tag, is still measured, and prints one warning per tick. The harness context hash and both base digests are recorded in `judge.round_completed`; the first judged round of a run sets the pin and a later difference inside the run makes GATE-3 fail with `judge_config_changed`.

## Configuration

```toml
[judge]
k = 3                                  # 2 to 10 repetitions per scenario
sut_base_image = "<name>@sha256:<64 hex>"
harness_base_image = "<name>@sha256:<64 hex>"
docker_context = "<a local unix-socket context>"
# step_timeout_ms, memory_mb, cpus, pids_limit and the tmpfs sizes have defaults and ranges in schemas/config.schema.json
```

With `docker_context` unset every container operation is refused. `omf doctor` reports an advisory probe (a throwaway golden container) or `unmeasurable` with the exact reason; it appends no ledger event.

## Gated runs

`npm run test:gated` starts the colima profile `omf-m3f` (2 CPU, 4 GiB), runs `tests/gated` with `OMF_GATED=docker` against the `colima-omf-m3f` context only, and stops the profile. `--record` appends one record per fully passed suite to `docs/evidence/gated-runs.json`. The script is `scripts/gated-docker.mjs`. A skipped gated test is not evidence. Both `G-real-isolation-probe` and `G-two-container-roundtrip` are recorded in `docs/evidence/gated-runs.json`; a claim on this page that no recorded suite covers is still not enforced against a real container.

## Limits

- With the implementer stubbed and the `author` and `implementer` stages unmeasured, no real line reaches a sealing label: GATE-3 stops it at `isolation_unmeasured` until a command runs the implementer (the author container is started by `omf seal`; the implementer container is described in `docs/implementer.md`). The full-line test appends those two measurements itself and says so.
- **The image build step is unmeasured candidate execution.** `docker build` runs the candidate's declared build argv as root, with BuildKit's default build capabilities, `--network none` and no mounts, in a BuildKit container OMF never inspects. OMF measures the SUT, harness and work-copy containers before candidate code runs in them, and the build is the stated exception.
- The build must be self-contained (dependencies vendored). The base image must provide `sleep`, `sh` and `tar` and must not declare `VOLUME` (refused).
- The in-container probe is a tripwire, not proof: the daemon's `docker inspect` is the authority. A compromised daemon, colima VM or pinned base image is out of scope. Only a local `unix://` endpoint is accepted.
- The harness and base digests are pinned per run, at the run's first judged round, and they trust the installed package at that moment. Drift between two runs of one item is not detected.
- Judging is slow: one `docker exec` per operation and one container per scenario repetition. `http` interfaces are refused, so no network exists between containers.
- A candidate can read its base image and its own tree. It cannot reach the network, the scenarios, the vault, host state, a credential or another repetition's state. It can still burn the container's memory, CPU and PID limits until the step timeout.
- Stops that are candidate-controlled: a failing declared build ends the item `blocked` with `infra_failure`. Timeouts, output limits, invalid UTF-8 and a dead container are scored as `fail`, not as an environment error.
- Contradiction canaries of the test split are judged in S4, before S6; that run is not the test split's single use. The cheap deterministic gates run after the k-repetition judge, not before it as the design orders them.
- The test split is consumed once per digest. A flaky test scenario reads as `sealed_failed`, not `flaky_scenario`; a flaky train scenario reads `flaky_scenario` and the test split is not spent.
- `noise_check` stays `not_evaluated`, so no line ends `merge_recommended`.
