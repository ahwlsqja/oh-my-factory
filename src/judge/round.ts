import { containerSpecFor, goldenFor } from "../container/golden.js";
import { digestOf, ImageRefError, type PinnedImage, pinnedImage } from "../container/image-ref.js";
import { createMeasured, type MeasureDeps, NotGoldenError } from "../container/measure.js";
import type { ContainerRuntime, ImageInfo } from "../container/runtime.js";
import type { OwnedLabels } from "../container/spec.js";
import { buildSutImage } from "../container/sut-build.js";
import type { JudgeConfig } from "../core/config.js";
import type { DecisionClass, InterfaceContract } from "../decision/types.js";
import type { GitTarget } from "../git/hardened.js";
import type { ScenarioRunner, StepLimits } from "../scenario/runner.js";
import type { ScenarioSplit, StoredKind } from "../scenario/types.js";
import { ensureHarnessImage } from "./harness-context.js";
import { createHarnessClient, type HarnessSet, type HarnessVerdict } from "./harness-protocol.js";
import { createContainerScenarioRunner } from "./relay.js";
import { trackRuntime } from "./state.js";

/** The lease's SUT image is removed by `disposeImages`, which lives with the line's other cleanup. */
export { disposeImages } from "./state.js";

const MAX_OUTPUT_BYTES = 1024 * 1024;
type Outcome = "pass" | "fail" | "error";
/**
 * Observation outcomes the harness scores `error`: a refused or faulty step is never evidence about the candidate. A signal, a
 * timeout and the output limit are the candidate's doing, so the harness scores them `fail`; this list must agree with it.
 */
export const FAULTS: ReadonlySet<string> = new Set(["error", "refused"]);

export interface RoundScenario {
  scenario_ref: string;
  split: ScenarioSplit;
  kind: StoredKind;
  category: DecisionClass;
  set: HarnessSet["scenarios"][number];
}

/** The images one round runs on, built by `buildRoundImages`. */
export interface ImageLease {
  sut: ImageInfo;
  harness: ImageInfo;
  harness_context_sha256: string;
  sut_base: PinnedImage;
  harness_base: PinnedImage;
  labels: OwnedLabels;
}

/** A round's image builds run the candidate's declared build: the same ten minutes the work copy gives its build. */
const IMAGE_BUILD_TIMEOUT_MS = 600_000;

/** An unset base is refused like an empty reference; a tag is refused by `pinnedImage`. */
function configuredBase(ref: string | null): PinnedImage {
  if (ref === null) throw new ImageRefError("image_invalid");
  return pinnedImage(ref);
}

/**
 * Builds the two images a round runs on from the judge config's digest-pinned bases, both checked before anything is
 * built and both made local through the reviewed pull. The harness image comes first and is reused when the image named
 * by its full context hash exists; the SUT image is then built from the candidate commit in the quarantine. A failed SUT
 * build therefore leaves only the cached harness image, and the SUT image is the one image the lease owns. `contract.run`
 * is not baked in: the round hands it to the relay.
 */
export async function buildRoundImages(input: {
  runtime: Pick<ContainerRuntime, "build" | "imageInfo" | "ensureImage">;
  config: JudgeConfig;
  contract: Pick<InterfaceContract, "build" | "run">;
  candidate: { quarantine: GitTarget; sha: string };
  labels: OwnedLabels;
  contextRoot: string;
}): Promise<ImageLease> {
  const sutBase = configuredBase(input.config.sut_base_image);
  const harnessBase = configuredBase(input.config.harness_base_image);
  // The build runs with --pull=false, but BuildKit would still fetch a missing base itself. Both bases are made local
  // through the reviewed pull first (digest-pinned, local endpoint only), so a build never reaches the network.
  await input.runtime.ensureImage(harnessBase);
  await input.runtime.ensureImage(sutBase);
  const harness = await ensureHarnessImage({
    runtime: input.runtime,
    base: harnessBase,
    labels: { ...input.labels, role: "harness" },
    contextRoot: input.contextRoot,
    timeoutMs: IMAGE_BUILD_TIMEOUT_MS,
  });
  const sut = await buildSutImage({
    runtime: input.runtime,
    quarantine: input.candidate.quarantine,
    sha: input.candidate.sha,
    base: sutBase,
    build: input.contract.build,
    labels: { ...input.labels, role: "sut" },
    contextRoot: input.contextRoot,
    timeoutMs: IMAGE_BUILD_TIMEOUT_MS,
  });
  return {
    sut,
    harness: harness.image,
    harness_context_sha256: harness.context_sha256,
    sut_base: sutBase,
    harness_base: harnessBase,
    labels: input.labels,
  };
}

export interface ScenarioTally {
  scenario_ref: string;
  category: DecisionClass;
  kind: StoredKind;
  outcomes: Outcome[];
  verdict: "pass" | "fail" | "flaky" | "error";
}

export interface RoundVerdict {
  phase: "train" | "test";
  k: number;
  candidate_sha: string;
  tallies: ScenarioTally[];
  /** Behavior scenarios only. */
  counts: { total: number; pass: number; fail: number; flaky: number; error: number };
  /** Contradiction canaries only: `rejected` counts the canaries the candidate failed in every rep (the good outcome). */
  contradiction: { scenarios: number; rejected: number };
  harness_context_sha256: string;
  sut_base_digest: string;
  harness_base_digest: string;
}

export type JudgeRoundCode = "set_invalid" | "no_scenarios" | "round_error" | "verdict_mismatch";
/** The message is the code only: no scenario text, path or container output can reach a log through it. */
export class JudgeRoundError extends Error {
  constructor(
    readonly code: JudgeRoundCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "JudgeRoundError";
  }
}

/**
 * All reps agree: pass or fail. Both seen: flaky (the scenario is not a verdict, spec 5.5). Any `error` rep, and no rep at all,
 * is `error`: an empty list never reads as a pass.
 */
export function scenarioVerdict(outcomes: readonly Outcome[]): ScenarioTally["verdict"] {
  if (outcomes.length === 0 || outcomes.includes("error")) return "error";
  const passes = outcomes.filter((outcome) => outcome === "pass").length;
  if (passes === outcomes.length) return "pass";
  return passes === 0 ? "fail" : "flaky";
}

function assertSet(scenarios: readonly RoundScenario[]): void {
  const refs = new Set(scenarios.map((scenario) => scenario.scenario_ref));
  const consistent = scenarios.every(
    (scenario) => scenario.set.scenario_ref === scenario.scenario_ref && scenario.set.steps.length > 0,
  );
  if (refs.size !== scenarios.length || !consistent) throw new JudgeRoundError("set_invalid");
}

const sameInvoke = (
  a: { argv: readonly string[]; stdin: string },
  b: { argv: readonly string[]; stdin: string },
): boolean =>
  a.stdin === b.stdin && a.argv.length === b.argv.length && a.argv.every((element, index) => element === b.argv[index]);

interface RunRecord {
  scenario_ref: string;
  rep: number;
  outcome: Outcome;
  steps_passed: number;
  steps_total: number;
}

type Harness = ReturnType<typeof createHarnessClient>;

/**
 * One (scenario, rep): ask the harness for the first step, relay it to a fresh SUT container, give the observation back
 * and follow what the harness says. The host keeps its own record of the result from the `step_pass` replies it saw, so the
 * final verdict can be checked against it. Anything the harness says that the host's own set contradicts (a different step,
 * a step after a failure, a missing next step) is `verdict_mismatch`.
 */
async function relayOne(
  client: Harness,
  runner: ScenarioRunner,
  scenario: RoundScenario,
  rep: number,
  limits: StepLimits,
): Promise<RunRecord> {
  const { steps } = scenario.set;
  const ref = scenario.scenario_ref;
  const begin = await client.begin(ref, rep);
  const first = steps[0];
  if (begin.steps_total !== steps.length || first === undefined || !sameInvoke(begin.invoke, first.invoke)) {
    throw new JudgeRoundError("verdict_mismatch");
  }
  const session = await runner.openScenario({ kind: "candidate", handle: ref });
  let invoke = begin.invoke;
  let index = 0;
  let passed = 0;
  let outcome: Outcome = "pass";
  try {
    for (;;) {
      const observation = await session.runStep({ argv: invoke.argv, stdin: invoke.stdin }, limits);
      const reply = await client.observe(ref, rep, index, observation);
      if (reply.step_pass) passed += 1;
      else outcome = FAULTS.has(observation.outcome) ? "error" : "fail";
      const wanted = steps[index + 1];
      if (!reply.step_pass || wanted === undefined) {
        if (reply.next !== null) throw new JudgeRoundError("verdict_mismatch");
        break;
      }
      if (reply.next === null || !sameInvoke(reply.next, wanted.invoke)) throw new JudgeRoundError("verdict_mismatch");
      invoke = reply.next;
      index += 1;
    }
  } finally {
    await session.close();
  }
  return { scenario_ref: ref, rep, outcome, steps_passed: passed, steps_total: steps.length };
}

/** E7d: the verdict is evidence only when it matches, run for run, what the host saw. No verdict, or a different one, is never a pass. */
function crossCheck(verdict: HarnessVerdict, expected: readonly RunRecord[]): void {
  if (verdict.runs.length !== expected.length) throw new JudgeRoundError("verdict_mismatch");
  for (const want of expected) {
    const got = verdict.runs.find((run) => run.scenario_ref === want.scenario_ref && run.rep === want.rep);
    if (
      got === undefined ||
      got.outcome !== want.outcome ||
      got.steps_passed !== want.steps_passed ||
      got.steps_total !== want.steps_total
    ) {
      throw new JudgeRoundError("verdict_mismatch");
    }
  }
}

function summarize(
  input: {
    scenarios: readonly RoundScenario[];
    phase: "train" | "test";
    k: number;
    candidate_sha: string;
    images: ImageLease;
  },
  expected: readonly RunRecord[],
): RoundVerdict {
  const tallies: ScenarioTally[] = input.scenarios.map((scenario) => {
    const outcomes = expected
      .filter((run) => run.scenario_ref === scenario.scenario_ref)
      .sort((a, b) => a.rep - b.rep)
      .map((run) => run.outcome);
    return {
      scenario_ref: scenario.scenario_ref,
      category: scenario.category,
      kind: scenario.kind,
      outcomes,
      verdict: scenarioVerdict(outcomes),
    };
  });
  const behavior = tallies.filter((tally) => tally.kind === "behavior");
  const canaries = tallies.filter((tally) => tally.kind === "contradiction_canary");
  const count = (list: readonly ScenarioTally[], verdict: ScenarioTally["verdict"]): number =>
    list.filter((tally) => tally.verdict === verdict).length;
  return {
    phase: input.phase,
    k: input.k,
    candidate_sha: input.candidate_sha,
    tallies,
    counts: {
      total: behavior.length,
      pass: count(behavior, "pass"),
      fail: count(behavior, "fail"),
      flaky: count(behavior, "flaky"),
      error: count(behavior, "error"),
    },
    contradiction: { scenarios: canaries.length, rejected: count(canaries, "fail") },
    harness_context_sha256: input.images.harness_context_sha256,
    sut_base_digest: digestOf(input.images.sut_base),
    harness_base_digest: digestOf(input.images.harness_base),
  };
}

export interface JudgeRoundInput {
  runtime: ContainerRuntime;
  measure: MeasureDeps;
  config: JudgeConfig;
  images: ImageLease;
  scenarios: readonly RoundScenario[];
  phase: "train" | "test";
  candidate_sha: string;
  /** The contract's `run` argv (see the relay). */
  run: readonly string[];
  /** Reserved for the host-side build contexts; nothing is staged or mounted by the round itself. */
  stageRoot: string;
  forbidden: readonly string[];
  round: number;
  now: () => Date;
}

/**
 * One round of the two-container judge (spec 5.5, M3f-D4/D5/D7/D8). One harness container per round holds the scenarios
 * (loaded over stdin, so no path is mounted) and judges; for each rep and each scenario a NEW SUT container is created,
 * measured against its golden before it starts, used for the steps of that scenario only and removed before the next one is
 * created, so a candidate cannot carry a file, a background process or a dead PID 1 from one scenario or rep into another.
 * A container that is not golden is never started (NotGoldenError passes through for the station to map to J7).
 *
 * The harness verdict is then checked against the host's own record. Any scenario that ends `error` (a runtime fault) fails
 * the whole round with `round_error`; a round with no scenarios is `no_scenarios`, never a pass. Containers are removed on
 * success, on any failure and, through the shared cleanup registry, on SIGINT and SIGTERM.
 */
export async function runJudgeRound(input: JudgeRoundInput): Promise<RoundVerdict> {
  const { config, images, scenarios } = input;
  if (scenarios.length === 0) throw new JudgeRoundError("no_scenarios");
  assertSet(scenarios);
  const labels: OwnedLabels = { ...images.labels, round: input.round };
  const limits: StepLimits = { timeoutMs: config.step_timeout_ms, maxOutputBytes: MAX_OUTPUT_BYTES };
  // Every container goes through the tracked runtime, so the one shared cleanup covers a signal and the `finally` below.
  const runtime = trackRuntime(input.runtime);
  const measure: MeasureDeps = { ...input.measure, runtime };
  let serial = 0;
  const create = async (role: "sut" | "harness", image: ImageInfo) => {
    serial += 1;
    const spec = containerSpecFor({ role, image: image.id, labels, serial, judge: config });
    return createMeasured(measure, spec, goldenFor({ role, image, forbidden: input.forbidden }));
  };
  try {
    const harness = await create("harness", images.harness);
    const client = createHarnessClient(runtime, harness.handle, limits);
    await client.load({ schema_version: 1, scenarios: scenarios.map((scenario) => scenario.set) });
    const runner = createContainerScenarioRunner({
      runtime,
      run: input.run,
      acquire: async () => {
        const sut = await create("sut", images.sut);
        return {
          handle: sut.handle,
          release: async () => {
            await runtime.remove(sut.handle);
          },
        };
      },
    });
    const expected: RunRecord[] = [];
    for (let rep = 1; rep <= config.k; rep += 1) {
      for (const scenario of scenarios) expected.push(await relayOne(client, runner, scenario, rep, limits));
    }
    crossCheck(await client.verdict(), expected);
    await runtime.remove(harness.handle);
    const verdict = summarize(
      { scenarios, phase: input.phase, k: config.k, candidate_sha: input.candidate_sha, images },
      expected,
    );
    if (verdict.tallies.some((tally) => tally.verdict === "error")) throw new JudgeRoundError("round_error");
    return verdict;
  } catch (error) {
    if (error instanceof JudgeRoundError || error instanceof NotGoldenError) throw error;
    throw new JudgeRoundError("round_error", { cause: error });
  } finally {
    runtime.close();
  }
}
