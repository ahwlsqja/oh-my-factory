import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { textSurface } from "../../src/audit/canary-scan.js";
import { CONTAINER_PROBE_ARGV } from "../../src/container/measure.js";
import type { ContainerRuntime } from "../../src/container/runtime.js";
import { declareBudget } from "../../src/core/budget.js";
import type { ProjectLocation } from "../../src/core/paths.js";
import { type ImplementerStations, combineLineEnd } from "../../src/implementer/station.js";
import type { CandidateRef } from "../../src/judge/candidate.js";
import { HARNESS_EXEC_ARGV, type HarnessRequest } from "../../src/judge/harness-protocol.js";
import { type FeedbackSlot, createFeedbackSlot } from "../../src/judge/round-state.js";
import { judgeStations } from "../../src/judge/stations.js";
import { foldSeals } from "../../src/scenario/events.js";
import { s2Station } from "../../src/seal/s2-station.js";
import { listVaultCanaryIndex } from "../../src/vault/vault.js";
import type { StationId } from "../../src/work/line-types.js";
import type { Station } from "../../src/work/sequencer.js";
import { HARNESS_BASE, SUT_BASE } from "./container-fixture.js";
import { HUMAN } from "./decision-fixture.js";
import { FakeDocker } from "./fake-docker.js";
import type { FakeExecCall, FakeResult } from "./fake-docker-core.mjs";
import { fakeRuntime } from "./fake-runtime.js";
import { gitFixture } from "./git-fixture.js";
import { type LineFixture, ROUND2, sealDeps, setupLine, writeYaml } from "./line-fixture.js";
import { station } from "./line.js";
import { BUGGY, FIXED, testFile } from "./prove-fixture.js";
import { HarnessDouble } from "./sut-double.js";

export type JudgeLineCandidate = "good" | "null_impl" | "edits_test" | "canary_in_prompt" | "red_gate";
export interface JudgeLineOptions {
  candidate?: JudgeLineCandidate;
  /** The harness double also scores the contradiction canary a pass. */
  acceptsContradiction?: boolean;
  /** The stamp the stub author puts on its seal. */
  authorIsolation?: "host_command" | "container";
  /** Answers a `docker exec` before the judge roles do; null falls through. How a real S3 sits behind the same daemon. */
  preExec?: (call: FakeExecCall) => FakeResult | null;
  /** Builds the real S3 and its candidate source over this fixture's runtime and feedback slot; replaces the stub S3 and the fixed candidate. */
  implementer?: (parts: ImplementerParts) => ImplementerStations;
}
export interface ImplementerParts {
  location: ProjectLocation;
  runtime: ContainerRuntime;
  feedback: FeedbackSlot;
  workId: string;
}
export interface JudgeLineFixture {
  l: LineFixture;
  /** Stub S1, S3, S7; the real S2 (the `ROUND2` yaml), S4, S5 and S6 over the fake docker. */
  stations: Record<StationId, Station>;
  /** Every argv, stdin and printed byte the SUT double saw or sent, as JSON lines. */
  sutRecording(): string;
  /** The containers still in the fake daemon. */
  liveContainers(): string[];
  /** The fake daemon and the runtime over it: tests read its recorded calls and add images to it. */
  fake: FakeDocker;
  runtime: ContainerRuntime;
  /** Passed to `runLine` as `onLineEnd`; with `implementer` it is `combineLineEnd(judge, implementer)`. Idempotent. */
  dispose(): Promise<void>;
}

const CONTEXT = "colima-omf-m3f";
/** The declared contract's run argv; the SUT is exec'd with it followed by the step argv. */
const CONTRACT_RUN: readonly string[] = ["node", "dist/cache.js"];
const FIX_MARK = "=> a + b";

const startsWith = (argv: readonly string[], prefix: readonly string[]): boolean =>
  prefix.every((part, index) => argv[index] === part);
const equal = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && startsWith(a, b);
const reply = (status: number, stdout = ""): FakeResult => ({ status, stdout, stderr: "" });

export function setupJudgeLine(options: JudgeLineOptions = {}): JudgeLineFixture {
  const candidate = options.candidate ?? "good";
  const l = setupLine();
  const { fx, scope, workId } = l.f;

  // The project: the [judge] table the real stations read, and the goal's disclosure budget.
  writeFileSync(
    join(fx.location.dir, "config.toml"),
    `${fx.baseConfig}\n[judge]\nk = 3\nsut_base_image = "${SUT_BASE}"\nharness_base_image = "${HARNESS_BASE}"\ndocker_context = "${CONTEXT}"\n`,
  );
  declareBudget(fx.ledger, scope.goal_id, "disclosure", 5, HUMAN);

  // The candidate: base has the bug, head has the fix and a new test. edits_test also has a test file that head changes.
  const edits = candidate === "edits_test";
  const git = gitFixture(
    { "src/calc.mjs": BUGGY, ...(edits ? { "tests/old.test.mjs": testFile("assert.ok(true);") } : {}) },
    {
      "src/calc.mjs": FIXED,
      "tests/calc.test.mjs": testFile("assert.equal(add(1, 2), 3);"),
      ...(edits ? { "tests/old.test.mjs": testFile("assert.ok(1);") } : {}),
    },
  );
  const prompt: CandidateRef["surfaces"][number] =
    candidate === "canary_in_prompt"
      ? {
          kind: "prompt",
          async *read() {
            // Looked up when it is read, which is after S2 sealed.
            const { records } = foldSeals(fx.ledger.readVerified(), scope);
            const first = listVaultCanaryIndex(l.vault, workId, records).index[0];
            if (first === undefined) throw new Error("the sealed set has no canary");
            yield Buffer.from(`prompt: ${first.canary}`);
          },
        }
      : textSurface("prompt", "a clean prompt");
  const ref: CandidateRef = {
    quarantine: git.quarantine,
    base: git.base,
    head: git.head,
    explicitTestPaths: [],
    surfaces: [textSurface("worktree", "a clean working tree"), textSurface("implementer_log", "a clean log"), prompt],
  };
  const candidates = { current: async () => ref };

  // The fake daemon: every container measures golden; each role answers like the real one would, minus the real work.
  const recording: string[] = [];
  const treeHoldsFix = new Map<string, boolean>();
  const redGateSpent = new Set<string>();
  const harness = new HarnessDouble({ passJsonPath: options.acceptsContradiction === true });

  const exec = (call: FakeExecCall): FakeResult => {
    const pre = options.preExec?.(call) ?? null;
    if (pre !== null) return pre;
    if (equal(call.argv, CONTAINER_PROBE_ARGV)) return reply(0, "socket:0\nend\n");
    const stdin = call.stdin?.toString("utf8") ?? "";
    if (call.name.startsWith("omf-harness-")) {
      if (!equal(call.argv, HARNESS_EXEC_ARGV)) return reply(0);
      return reply(0, `${JSON.stringify(harness.answer(JSON.parse(stdin) as HarnessRequest))}\n`);
    }
    if (call.name.startsWith("omf-sut-")) {
      const step = startsWith(call.argv, CONTRACT_RUN) ? call.argv.slice(CONTRACT_RUN.length) : [];
      const stdout =
        candidate !== "null_impl" && step[0] === "cache" && step[1] === "get" ? "ok-distinct-output\n" : "";
      recording.push(JSON.stringify({ argv: call.argv, stdin, stdout }));
      return reply(0, stdout);
    }
    if (call.name.startsWith("omf-workcopy-")) {
      if (call.argv[0] === "tar") {
        treeHoldsFix.set(call.name, call.stdin?.includes(FIX_MARK) === true);
        return reply(0);
      }
      if (call.argv[0] === "npm" && call.argv[1] === "test") {
        // The name is omf-<role>-<run_id>-<round>-<serial>: the round is the second to last segment.
        const round = call.name.split("-").at(-2) ?? "?";
        if (candidate === "red_gate" && !redGateSpent.has(round)) {
          redGateSpent.add(round);
          return reply(1);
        }
        return reply(treeHoldsFix.get(call.name) === true ? 0 : 1);
      }
    }
    return reply(0);
  };
  const fake = new FakeDocker({ exec });
  const runtime = fakeRuntime(fake, CONTEXT);

  // The stations. One judgeStations() instance builds S2's entry check, S4, S5, S6 and the dispose.
  const feedback = createFeedbackSlot();
  const impl = options.implementer?.({ location: fx.location, runtime, feedback, workId });
  const js = judgeStations({ location: fx.location, runtime, candidates: impl?.candidates ?? candidates, feedback });
  const session = {
    ...sealDeps(l, writeYaml(l, "round2.yaml", ROUND2)).session,
    isolation: options.authorIsolation ?? "host_command",
  };
  const stations: Record<StationId, Station> = {
    S1: station("S1"),
    S2: js.withEntryCheck(s2Station({ location: fx.location, session, ids: l.ids })),
    S3: impl?.S3 ?? station("S3"),
    S4: js.S4,
    S5: js.S5,
    S6: js.S6,
    S7: station("S7"),
  };
  return {
    l,
    stations,
    sutRecording: () => recording.join("\n"),
    liveContainers: () => Object.keys(fake.state.containers),
    fake,
    runtime,
    dispose: impl === undefined ? () => js.dispose() : combineLineEnd(() => js.dispose(), impl.dispose),
  };
}
