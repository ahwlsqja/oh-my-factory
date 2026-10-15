import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pinnedImage } from "../../src/container/image-ref.js";
import type { ContainerRuntime, ImageInfo, OwnedResource } from "../../src/container/runtime.js";
import type { ImageId } from "../../src/container/spec.js";
import type { CandidateRef } from "../../src/judge/candidate.js";
import type { JudgeEngine } from "../../src/judge/engine.js";
import { RoundHolder, createFeedbackSlot } from "../../src/judge/round-state.js";
import type { RoundScenario, RoundVerdict, ScenarioTally } from "../../src/judge/round.js";
import type { DisposableLease } from "../../src/judge/state.js";
import { s4Station } from "../../src/judge/s4-station.js";
import type { Station, StationContext } from "../../src/work/sequencer.js";
import { type CandidateDouble, SHA_A, candidateDouble, candidateRef, stationCtx } from "./judge-seed.js";
import { CANARY_SPEC, STRONG_EXPECT, type SealedItem, type SeedSpec, seedSealedItem } from "./scenario-fixture.js";

export const SUT_BASE = `docker.io/library/node@sha256:${"a".repeat(64)}`;
export const HARNESS_BASE = `docker.io/library/node@sha256:${"b".repeat(64)}`;
/** The `[judge]` table the real S4 reads from config.toml. */
export const JUDGE_TABLE = `[judge]\nk = 3\nsut_base_image = "${SUT_BASE}"\nharness_base_image = "${HARNESS_BASE}"\ndocker_context = "colima-omf-m3f"\n`;

/** Scenarios 0 to 2 are train behavior (two linked to d-interface, one to d-cache), 3 is the test one, 4 the canary. */
export const SPECS: readonly SeedSpec[] = [
  { split: "train", refs: ["d-interface"], expect: STRONG_EXPECT },
  { split: "train", refs: ["d-interface"], expect: STRONG_EXPECT },
  { split: "train", refs: ["d-cache"], expect: STRONG_EXPECT },
  { split: "test", refs: ["d-cache"], expect: STRONG_EXPECT },
  CANARY_SPEC,
];

export type Outcome = ScenarioTally["outcomes"][number];
export const PASSES: readonly Outcome[] = ["pass", "pass", "pass"];
export const FAILS: readonly Outcome[] = ["fail", "fail", "fail"];
/** What the engine double reports for a scenario, given its position in the judged list. */
export type OutcomePlan = (scenario: RoundScenario, position: number) => Outcome[];
const DEFAULT_PLAN: OutcomePlan = (scenario) => [...(scenario.kind === "contradiction_canary" ? FAILS : PASSES)];

export type RoundInput = Parameters<JudgeEngine["runJudgeRound"]>[0];
type BuildInput = Parameters<JudgeEngine["buildRoundImages"]>[0];

const imageInfo = (digit: string): ImageInfo => ({
  id: `sha256:${digit.repeat(64)}` as ImageId,
  env_names: [],
  user: "65532:65532",
  volumes: [],
});

function verdictFor(input: RoundInput, plan: OutcomePlan): RoundVerdict {
  const tallies = input.scenarios.map((scenario, position): ScenarioTally => {
    const outcomes = plan(scenario, position);
    const passes = outcomes.filter((outcome) => outcome === "pass").length;
    const verdict = outcomes.includes("error")
      ? "error"
      : passes === outcomes.length
        ? "pass"
        : passes === 0
          ? "fail"
          : "flaky";
    return { scenario_ref: scenario.scenario_ref, category: scenario.category, kind: scenario.kind, outcomes, verdict };
  });
  const behavior = tallies.filter((tally) => tally.kind === "behavior");
  const canaries = tallies.filter((tally) => tally.kind === "contradiction_canary");
  const count = (verdict: ScenarioTally["verdict"]): number => behavior.filter((t) => t.verdict === verdict).length;
  return {
    phase: input.phase,
    k: 3,
    candidate_sha: input.candidate_sha,
    tallies,
    counts: {
      total: behavior.length,
      pass: count("pass"),
      fail: count("fail"),
      flaky: count("flaky"),
      error: count("error"),
    },
    contradiction: { scenarios: canaries.length, rejected: canaries.filter((t) => t.verdict === "fail").length },
    harness_context_sha256: "c".repeat(64),
    sut_base_digest: `sha256:${"a".repeat(64)}`,
    harness_base_digest: `sha256:${"b".repeat(64)}`,
  };
}

export interface EngineOptions {
  plan?: OutcomePlan;
  buildError?: Error;
  roundError?: Error;
}
export interface EngineDouble {
  engine: JudgeEngine;
  built: BuildInput[];
  rounds: RoundInput[];
  disposed: DisposableLease[];
  /** Read at call time, so a test may change what the next round reports. */
  plan: OutcomePlan;
}

export function engineDouble(options: EngineOptions = {}): EngineDouble {
  const double: EngineDouble = {
    built: [],
    rounds: [],
    disposed: [],
    plan: options.plan ?? DEFAULT_PLAN,
    engine: {
      async buildRoundImages(input) {
        double.built.push(input);
        if (options.buildError !== undefined) throw options.buildError;
        return {
          sut: imageInfo("1"),
          harness: imageInfo("2"),
          harness_context_sha256: "c".repeat(64),
          sut_base: pinnedImage(SUT_BASE),
          harness_base: pinnedImage(HARNESS_BASE),
          labels: input.labels,
        };
      },
      async runJudgeRound(input) {
        double.rounds.push(input);
        if (options.roundError !== undefined) throw options.roundError;
        return verdictFor(input, double.plan);
      },
      async disposeImages(_runtime, lease) {
        double.disposed.push(lease);
      },
      forbiddenPaths: () => [],
    },
  };
  return double;
}

export interface RuntimeOptions {
  context?: string | null;
  info?: Awaited<ReturnType<ContainerRuntime["info"]>>;
  local?: boolean;
  /** What `listOwned` reports per run id. */
  owned?: Readonly<Record<string, OwnedResource[]>>;
}
export interface RuntimeDouble {
  runtime: ContainerRuntime;
  /** `container:<name>` and `image:<name>`, in removal order. */
  removed: string[];
}

export function runtimeDouble(options: RuntimeOptions = {}): RuntimeDouble {
  const removed: string[] = [];
  const parts: Pick<ContainerRuntime, "context" | "endpoint" | "info" | "listOwned" | "remove" | "removeImage"> = {
    context: options.context === undefined ? "colima-omf-m3f" : options.context,
    endpoint: async () => ({ kind: options.local === false ? "tcp" : "unix", local: options.local !== false }),
    info: async () => options.info ?? { ok: true, server_version: "29.0.0" },
    listOwned: async (filter) =>
      filter.run_id === null
        ? Object.values(options.owned ?? {}).flatMap((list) => [...list])
        : [...(options.owned?.[filter.run_id] ?? [])],
    remove: async (handle) => {
      removed.push(`container:${handle.name}`);
    },
    removeImage: async (id) => {
      removed.push(`image:${id}`);
    },
  };
  return { runtime: parts as ContainerRuntime, removed };
}

export interface RigOptions extends EngineOptions, RuntimeOptions {
  specs?: readonly SeedSpec[];
  /** false: the item is ready but nothing was sealed. */
  seal?: boolean;
  /** null: the item has no candidate. */
  candidate?: CandidateRef | null;
  /** null: no `[judge]` table at all (the base images are unset). */
  judge?: string | null;
}
export interface Rig {
  s: SealedItem;
  station: Station;
  holder: RoundHolder;
  engine: EngineDouble;
  runtime: RuntimeDouble;
  candidates: CandidateDouble;
  ctx(over?: Partial<StationContext>): StationContext;
}

export function s4Rig(options: RigOptions = {}): Rig {
  const s = seedSealedItem(options.specs ?? SPECS, options.seal === false ? { seal: false } : {});
  if (options.judge !== null) {
    writeFileSync(join(s.f.fx.location.dir, "config.toml"), `${s.f.fx.baseConfig}\n${options.judge ?? JUDGE_TABLE}`);
  }
  const engine = engineDouble(options);
  const runtime = runtimeDouble(options);
  const candidates = candidateDouble(options.candidate === undefined ? candidateRef(SHA_A) : options.candidate);
  const holder = new RoundHolder();
  const deps = {
    location: s.f.fx.location,
    runtime: runtime.runtime,
    candidates,
    feedback: createFeedbackSlot(),
    engine: engine.engine,
  };
  return {
    s,
    station: s4Station(deps, holder),
    holder,
    engine,
    runtime,
    candidates,
    ctx: (over = {}) => stationCtx(s, { round: 1, ...over }),
  };
}
