import { randomBytes } from "node:crypto";
import type { AdvisoryIsolation, IsolationProbe } from "../core/doctor.js";
import type { StageGolden } from "../isolation/evaluate.js";
import { InspectParseError, containerFactsFromInspect } from "../isolation/inspect.js";
import type { ContainerFacts, ViolationCode } from "../isolation/types.js";
import { type ContainerRuntimeSync, createDockerRuntimeSync } from "./docker-sync.js";
import { containerSpecFor, forbiddenPaths, goldenFor } from "./golden.js";
import { pinnedImage } from "./image-ref.js";
import { CONTAINER_PROBE_ARGV, MeasureError, judgeFacts, judgeObserved, probeChecks } from "./measure.js";
import { type ContainerSpec, ROLE_STAGE } from "./spec.js";

export type { ContainerRuntimeSync } from "./docker-sync.js";

const PROBE_WORK_ID = "w-000000000000";
const ADVISORY =
  "isolation is measured per run from the ledger, never here; this field is advisory, not enforced, and no sealing guarantee is claimed";

/**
 * The non-recording twin of `createMeasured`: the same pre-gate, probe and judgment (the shared functions of measure.ts) with
 * no sink, no ledger event and no file. The container is removed in every case; a removal that fails is left to the
 * owner-label sweep. A parse or probe failure throws `MeasureError`, which doctor reports as unmeasurable.
 */
export function measureThrowawaySync(
  deps: { runtime: ContainerRuntimeSync; now: () => Date },
  spec: ContainerSpec,
  golden: StageGolden,
): { level: "L2" | "L1"; violations: ViolationCode[] } {
  const stage = ROLE_STAGE[spec.labels.role];
  const { runtime } = deps;
  const handle = runtime.createSync(spec);
  try {
    let facts: ContainerFacts;
    try {
      facts = containerFactsFromInspect(runtime.inspectSync(handle));
    } catch (error) {
      if (error instanceof InspectParseError) throw new MeasureError("inspect_unparseable");
      throw error;
    }
    const pre = judgeFacts(stage, facts, golden, deps.now());
    if (pre.violations.length > 0) return { level: "L1", violations: pre.violations };
    runtime.startSync(handle);
    const answer = runtime.execSync(handle, {
      argv: CONTAINER_PROBE_ARGV,
      timeoutMs: 15_000,
      maxOutputBytes: 16 * 1024,
    });
    const final = judgeObserved(stage, facts, probeChecks(answer), golden, deps.now());
    return { level: final.violations.length === 0 ? "L2" : "L1", violations: final.violations };
  } finally {
    try {
      runtime.removeSync(handle);
    } catch {
      // The container carries the omf.owner label; a later sweep removes it.
    }
  }
}

function unmeasurable(reason: string, failure: string | null = null): AdvisoryIsolation {
  return { declared: "L2", measured: "unmeasurable", advisory: true, note: `${reason}; ${ADVISORY}`, failure };
}

function freshRunId(now: Date): string {
  return `r-${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z-${randomBytes(2).toString("hex")}`;
}

export interface ProbeOptions {
  /** Tests inject a runtime; the default is the real Docker CLI twin for the configured context. */
  runtime?: ContainerRuntimeSync;
  runId?: () => string;
  now?: () => Date;
}

/**
 * The advisory probe `omf doctor` reports under `isolation`. It never pulls or builds and writes no ledger event, no
 * `isolation.json` and no file besides doctor's own `preflight.json`. With no project, an unset `judge.docker_context` or
 * `judge.sut_base_image`, a daemon that is down (the failure is the exact `docker info` text), a non-local endpoint or a base
 * image that is not already local it says `unmeasurable` and why. Otherwise it measures one throwaway golden `sut` container
 * and reports L2 or L1: "a throwaway-container probe, not a run". GATE-3 never reads it.
 */
export function containerIsolationProbe(options: ProbeOptions = {}): IsolationProbe {
  const clock = options.now ?? (() => new Date());
  return (env, _tools, project) => {
    if (project === null) return unmeasurable("project not initialized, or its config.toml is unreadable");
    const { judge, isolation } = project.config;
    if (judge.docker_context === null)
      return unmeasurable("judge.docker_context is not set, so no container runtime is used");
    if (judge.sut_base_image === null) return unmeasurable("judge.sut_base_image is not set");
    const runtime = options.runtime ?? createDockerRuntimeSync({ context: judge.docker_context, env });
    const info = runtime.infoSync();
    if (!info.ok) return unmeasurable("the docker daemon is unreachable", info.failure);
    const endpoint = runtime.endpointSync();
    if (!endpoint.local) return unmeasurable(`the docker endpoint is not a local unix socket (kind: ${endpoint.kind})`);
    const image = runtime.imageInfoSync(judge.sut_base_image);
    if (image === null) return unmeasurable("the base image is not present locally; the probe never pulls");
    if (image.volumes.length > 0) return unmeasurable("the base image declares a VOLUME, which the judge refuses");
    const spec = containerSpecFor({
      role: "sut",
      image: pinnedImage(judge.sut_base_image),
      labels: { work_id: PROBE_WORK_ID, run_id: (options.runId ?? (() => freshRunId(clock())))(), round: 0 },
      serial: 1,
      limits: { kind: "judge", judge },
    });
    const golden = goldenFor({ role: "sut", image, forbidden: forbiddenPaths(project.location, env) });
    const result = measureThrowawaySync({ runtime, now: clock }, spec, golden);
    const found = result.violations.length === 0 ? "" : `; violations: ${result.violations.join(", ")}`;
    return {
      declared: isolation.declared,
      measured: result.level,
      advisory: true,
      note: `a throwaway-container probe, not a run (endpoint: ${endpoint.kind}${found}); ${ADVISORY}`,
      failure: null,
    };
  };
}
