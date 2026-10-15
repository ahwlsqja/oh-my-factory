import { pinnedImage } from "../../src/container/image-ref.js";
import type { OwnedLabels } from "../../src/container/spec.js";
import type { JudgeConfig } from "../../src/core/config.js";
import { CONFIG_DEFAULTS } from "../../src/core/config.js";
import type { HarnessStep } from "../../src/judge/harness-protocol.js";
import { type ImageLease, type RoundScenario, type RoundVerdict, runJudgeRound } from "../../src/judge/round.js";
import type { RuntimeDouble } from "./sut-double.js";
import { IMAGE } from "./sut-double.js";

export const RUN = ["/work/cli"];
export const LABELS: OwnedLabels = {
  work_id: "w-0123456789ab",
  run_id: "r-20261015T000000Z-0a1b",
  round: 1,
  role: "sut",
};
const NOW = new Date("2026-10-15T00:00:00.000Z");
const SCOPE = { goal_id: "g-test", work_id: LABELS.work_id, run_id: LABELS.run_id };
const SINK = {
  appendWith(): never {
    throw new Error("judge-fixture: the round must not write the ledger");
  },
};

export const ref = (n: number): string => n.toString(16).padStart(16, "0");

export function judgeConfig(over: Partial<JudgeConfig> = {}): JudgeConfig {
  return { ...CONFIG_DEFAULTS.judge, docker_context: "colima-test", ...over };
}

export function lease(): ImageLease {
  return {
    sut: IMAGE,
    harness: IMAGE,
    harness_context_sha256: "d".repeat(64),
    sut_base: pinnedImage(`registry.example/sut-base@sha256:${"b".repeat(64)}`),
    harness_base: pinnedImage(`registry.example/harness-base@sha256:${"c".repeat(64)}`),
    labels: LABELS,
  };
}

/** One step: run the program with `argv`, expect `exitCode` (and, when given, exactly `stdout`). */
export function stepOf(argv: string[], exitCode: number | null = 0, stdout?: string): HarnessStep {
  return {
    invoke: { argv, stdin: "" },
    expect: {
      exit_code: exitCode,
      stdout_matches: stdout === undefined ? null : { kind: "exact", text: stdout },
      json_path: null,
    },
  };
}

export function scenarioOf(
  n: number,
  steps: HarnessStep[],
  over: Partial<Pick<RoundScenario, "split" | "kind">> = {},
): RoundScenario {
  return {
    scenario_ref: ref(n),
    split: over.split ?? "train",
    kind: over.kind ?? "behavior",
    category: "interface",
    set: { scenario_ref: ref(n), steps },
  };
}

export function runRound(
  runtime: RuntimeDouble,
  scenarios: readonly RoundScenario[],
  over: { k?: number; phase?: "train" | "test" } = {},
): Promise<RoundVerdict> {
  return runJudgeRound({
    runtime,
    measure: { runtime, sink: SINK, scope: SCOPE, itemDir: "/nonexistent/item", now: () => NOW },
    config: judgeConfig({ k: over.k ?? 3 }),
    images: lease(),
    scenarios,
    phase: over.phase ?? "train",
    candidate_sha: "c".repeat(40),
    run: RUN,
    stageRoot: "/nonexistent/stage",
    forbidden: [],
    round: 1,
    now: () => NOW,
  });
}
