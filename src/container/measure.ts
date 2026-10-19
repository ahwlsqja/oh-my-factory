import type { ProcessResult } from "../adapters/process-group.js";
import type { RecordSink, RunScope } from "../audit/work-audit.js";
import { type StageGolden, evaluateStage, measurementHash } from "../isolation/evaluate.js";
import { InspectParseError, containerFactsFromInspect } from "../isolation/inspect.js";
import { recordStageMeasurement } from "../isolation/record.js";
import type {
  ContainerChecks,
  ContainerFacts,
  IsolationStage,
  StageMeasurement,
  ViolationCode,
} from "../isolation/types.js";
import { recordStarted } from "./lifecycle.js";
import { markMeasured } from "./measured-handles.js";
import { stopCause } from "./running.js";
import type { ContainerHandle, ContainerRuntime } from "./runtime.js";
import { type ContainerSpec, ROLE_STAGE } from "./spec.js";
import { PROBE_TIMEOUT_MS } from "./probe-timeout.js";

/** The cap of the isolation probe, milliseconds; `judgeLifetimeSeconds` derives `JUDGE_PROBE_S` from it. */
export { PROBE_TIMEOUT_MS };

/**
 * `inspect_unparseable`: the daemon's document lacked an isolation field (absence is never a pass). `probe_failed` and
 * `probe_malformed`: the in-container probe did not answer in the fixed grammar. `create_failed`: the container was made
 * but could not be started. None records a measurement; the stage stays unmeasured.
 */
export type MeasureErrorCode = "inspect_unparseable" | "probe_failed" | "probe_malformed" | "create_failed";

export class MeasureError extends Error {
  constructor(readonly code: MeasureErrorCode) {
    super(code);
    this.name = "MeasureError";
  }
}

/** The container was measured below its golden. The L1 is already recorded and the container removed. */
export class NotGoldenError extends Error {
  constructor(readonly violations: readonly ViolationCode[]) {
    super(violations.join(","));
    this.name = "NotGoldenError";
  }
}

/**
 * The SUT container runs from the candidate-built round image, so what its `sleep` and the probe `sh` do is the candidate's
 * doing. `probe_unanswered`: the probe did not answer (or its container had stopped) and the container was not removed or
 * stopped by the host. `probe_flagged`: the probe found a vendor binary, a credential path or a socket in the candidate-built
 * image. Either is a failure of that (scenario, rep), never a `NotGoldenError` and never an infrastructure fault. The
 * container is already removed when this is thrown. Only the `sut` role throws it.
 */
export type CandidateContainerFailureCode = "probe_unanswered" | "probe_flagged";

export class CandidateContainerFailure extends Error {
  constructor(readonly code: CandidateContainerFailureCode) {
    super(code);
    this.name = "CandidateContainerFailure";
  }
}

/** The violations only the in-container probe can produce: for a candidate-built image they are the candidate's. */
const PROBE_VIOLATIONS: ReadonlySet<ViolationCode> = new Set([
  "vendor_binary_present",
  "credential_present",
  "docker_socket_present",
]);

/**
 * Whether a probe that did not answer is the candidate's. Same attribution as a failed step (`relay.ts`): an exit with no status
 * is the client's; otherwise `stopCause` decides, and a container the host removed or stopped, or that the daemon would not
 * describe, stays infrastructure. A client error against a container that still runs is the client's too.
 */
async function candidateEndedProbe(
  runtime: ContainerRuntime,
  handle: ContainerHandle,
  answer: ProcessResult,
): Promise<boolean> {
  if (answer.kind === "exited" && answer.status === null) return false;
  const { cause } = await stopCause(runtime, handle);
  if (cause === "host" || cause === "unknown") return false;
  return !(answer.kind === "error" && cause === "running");
}

/**
 * One line per finding, always ending in `end`, so a truncated answer is malformed and never clean. A constant: nothing
 * from the host, a scenario or the candidate is ever interpolated into it. A tripwire for base images that ship a vendor
 * CLI, a credential file or a socket; the daemon's `docker inspect` stays the authority.
 */
const PROBE_SCRIPT = [
  'for b in claude codex docker gh aws gcloud az kubectl; do command -v "$b" >/dev/null 2>&1 && echo "vendor:$b"; done',
  'for h in "$HOME" /root; do for f in .claude .claude.json .codex .aws .ssh .netrc .config/gh .docker/config.json; do [ -e "$h/$f" ] && echo "cred:$f"; done; done',
  's=0; for p in /var/run/docker.sock /run/docker.sock; do [ -S "$p" ] && s=1; done; echo "socket:$s"',
  "echo end",
].join("\n");

export const CONTAINER_PROBE_ARGV: readonly string[] = Object.freeze(["sh", "-c", PROBE_SCRIPT]);

const PROBE_MAX_BYTES = 16 * 1024;
const MAX_PROBE_LINES = 64;
const VENDOR_LINE = /^vendor:([a-z0-9-]{1,32})$/;
const CRED_LINE = /^cred:([A-Za-z0-9._/-]{1,64})$/;

/** Anything but the fixed lines ending in `end` is `probe_malformed`: an answer that cannot be read is not a clean one. */
export function parseProbe(stdout: string): ContainerChecks {
  const lines = stdout.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length > MAX_PROBE_LINES || lines.at(-1) !== "end") throw new MeasureError("probe_malformed");
  lines.pop();
  const vendors = new Set<string>();
  const credentials = new Set<string>();
  let socket: boolean | null = null;
  for (const line of lines) {
    const vendor = VENDOR_LINE.exec(line)?.[1];
    const credential = CRED_LINE.exec(line)?.[1];
    if (vendor !== undefined) vendors.add(vendor);
    else if (credential !== undefined) credentials.add(credential);
    else if ((line === "socket:0" || line === "socket:1") && socket === null) socket = line === "socket:1";
    else throw new MeasureError("probe_malformed");
  }
  if (socket === null) throw new MeasureError("probe_malformed");
  return {
    vendor_binaries: [...vendors].sort(),
    credential_paths: [...credentials].sort(),
    docker_socket_present: socket,
  };
}

/** A probe that did not exit 0 (timeout, output limit, runner error, non-zero status) did not answer. */
export function probeChecks(result: ProcessResult): ContainerChecks {
  if (result.kind !== "exited" || result.status !== 0) throw new MeasureError("probe_failed");
  return parseProbe(result.stdout);
}

const NO_CHECKS: ContainerChecks = { vendor_binaries: [], credential_paths: [], docker_socket_present: false };

/** The PRE-GATE: the daemon's facts alone, before the container starts. The checks were never observed, so the record holds `checks: null` and a hash over `null`. */
export function judgeFacts(
  stage: IsolationStage,
  facts: ContainerFacts,
  golden: StageGolden,
  at: Date,
): StageMeasurement {
  const judged = evaluateStage(stage, { facts, checks: NO_CHECKS }, golden, at);
  return { ...judged, checks: null, facts_sha256: measurementHash(stage, "container", facts, null) };
}

/** The full judgment once the in-container probe has answered. */
export function judgeObserved(
  stage: IsolationStage,
  facts: ContainerFacts,
  checks: ContainerChecks,
  golden: StageGolden,
  at: Date,
): StageMeasurement {
  return evaluateStage(stage, { facts, checks }, golden, at);
}

interface MeasureBase {
  runtime: ContainerRuntime;
  now: () => Date;
}

/** The default: the judgment is written to the ledger and the item's `isolation.json` as soon as it is made. */
export interface RecordingMeasureDeps extends MeasureBase {
  sink: RecordSink;
  scope: RunScope;
  itemDir: string;
}

/**
 * The judgment of a golden container goes to `defer` instead of the ledger. The sealing author is measured before it may
 * receive its key, but its measurement is bound to the seal it produces, and that seal does not exist yet; the caller records it
 * once it does. A container that is not golden is never handed over: it is not recorded either (there is no seal to bind it to),
 * and `NotGoldenError` carries the violation codes for the caller to report.
 */
export interface DeferredMeasureDeps extends MeasureBase {
  defer: (measurement: StageMeasurement) => void;
}

export type MeasureDeps = RecordingMeasureDeps | DeferredMeasureDeps;

export interface MeasuredContainer {
  handle: ContainerHandle;
  measurement: StageMeasurement;
}

/**
 * create -> inspect -> parse -> PRE-GATE (facts alone) -> start -> in-container probe -> full judgment -> record.
 *
 * A facts violation records L1, removes the container and throws `NotGoldenError`; the container never started, so neither its
 * entrypoint nor the probe's `sh` ran. A probe-only violation records L1, removes and throws. A parse or probe failure removes
 * the container and records nothing. For the `sut` role the probe window belongs to the candidate (its image replaced `sleep`
 * and `sh`): a probe that did not answer while the host did not end the container, and a probe that reports a vendor binary,
 * a credential or a socket, throw `CandidateContainerFailure` instead of `MeasureError` and `NotGoldenError`. Only a golden container is returned, still running, for the caller to use and remove. An
 * error from `create` (no context, a remote endpoint) propagates as the runtime raised it: no container exists yet.
 *
 * With `defer` (see `DeferredMeasureDeps`) nothing is recorded here: a golden container's full judgment goes to the callback,
 * and an L1 outcome only throws. A callback that throws removes the container like any other failure.
 */
export async function createMeasured(
  deps: MeasureDeps,
  spec: ContainerSpec,
  golden: StageGolden,
): Promise<MeasuredContainer> {
  const stage = ROLE_STAGE[spec.labels.role];
  const { runtime } = deps;
  const handle = await runtime.create(spec);
  let keep = false;
  try {
    let facts: ContainerFacts;
    try {
      facts = containerFactsFromInspect(await runtime.inspect(handle));
    } catch (error) {
      if (error instanceof InspectParseError) throw new MeasureError("inspect_unparseable");
      throw error;
    }
    const pre = judgeFacts(stage, facts, golden, deps.now());
    if (pre.violations.length > 0) {
      if (!("defer" in deps)) recordStageMeasurement(deps.sink, deps.scope, deps.itemDir, pre);
      throw new NotGoldenError(pre.violations);
    }
    try {
      await runtime.start(handle);
    } catch {
      throw new MeasureError("create_failed");
    }
    // The sleep began no earlier than now: the reference for telling a lifetime that ran out from a container that stopped early.
    recordStarted(handle, spec.lifetime_s);
    const answer = await runtime.exec(handle, {
      argv: CONTAINER_PROBE_ARGV,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxOutputBytes: PROBE_MAX_BYTES,
    });
    let checks: ContainerChecks;
    try {
      checks = probeChecks(answer);
    } catch (error) {
      if (
        spec.labels.role === "sut" &&
        error instanceof MeasureError &&
        (await candidateEndedProbe(runtime, handle, answer))
      )
        throw new CandidateContainerFailure("probe_unanswered");
      throw error;
    }
    const measurement = judgeObserved(stage, facts, checks, golden, deps.now());
    if ("defer" in deps) {
      if (measurement.violations.length === 0) deps.defer(measurement);
    } else {
      recordStageMeasurement(deps.sink, deps.scope, deps.itemDir, measurement);
    }
    if (measurement.violations.length > 0) {
      if (spec.labels.role === "sut" && measurement.violations.every((code) => PROBE_VIOLATIONS.has(code)))
        throw new CandidateContainerFailure("probe_flagged");
      throw new NotGoldenError(measurement.violations);
    }
    keep = true;
    return { handle: markMeasured(handle), measurement };
  } finally {
    // Idempotent. A failed removal leaves an orphan that carries the omf.owner label for the owner-label sweep.
    if (!keep) await runtime.remove(handle).catch(() => undefined);
  }
}
