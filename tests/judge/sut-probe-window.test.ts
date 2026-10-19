import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessResult } from "../../src/adapters/process-group.js";
import { createDockerRuntime, type DockerRunner } from "../../src/container/docker-cli.js";
import { markHostEnded, resetLifecycle } from "../../src/container/lifecycle.js";
import { CONTAINER_PROBE_ARGV } from "../../src/container/measure.js";
import type { ContainerRuntime } from "../../src/container/runtime.js";
import { Ledger } from "../../src/core/ledger.js";
import type { HarnessRequest } from "../../src/judge/harness-protocol.js";
import { runJudgeRound } from "../../src/judge/round.js";
import { HarnessDouble } from "../helpers/sut-double.js";
import { BASE, AT, CONTEXT, CLEAN_PROBE, RUN, WORK } from "../helpers/measure-fixture.js";
import { FakeDocker, verbOf } from "../helpers/fake-docker.js";
import { addImage } from "../helpers/fake-docker-core.mjs";
import { judgeConfig, LABELS, RUN as RUN_ARGV, scenarioOf, stepOf } from "../helpers/judge-fixture.js";
import { makeTempDir } from "../helpers/tmp.js";

afterEach(resetLifecycle);

const exited = (stdout: string, status = 0): ProcessResult => ({
  kind: "exited",
  status,
  signal: null,
  stdout,
  stderr: "",
});

/** What the first SUT container's probe does; every other probe, step and harness call is clean. */
type ProbeBehavior = "sleep_exits" | "sh_exit_1" | "sh_hangs" | "sh_garbage" | "sh_vendor" | "host_removed";

async function rig(behavior: ProbeBehavior) {
  const harness = new HarnessDouble();
  const fake = new FakeDocker({
    exec: (call: { name: string; stdin: Buffer | null }) => {
      if (call.name.startsWith("omf-sut-")) return { status: 0, stdout: "", stderr: "" };
      const reply = harness.answer(JSON.parse(call.stdin?.toString("utf8") ?? "{}") as HarnessRequest);
      return { status: 0, stdout: `${JSON.stringify(reply)}\n`, stderr: "" };
    },
  });
  addImage(fake.state, BASE, {});
  let suts = 0;
  const run: DockerRunner = async (argv, options) => {
    if (verbOf(argv) !== "exec") return fake.run(argv, options);
    const name = argv.find((arg) => arg.startsWith("omf-sut-"));
    const probing = argv.slice(-CONTAINER_PROBE_ARGV.length).join("\0") === CONTAINER_PROBE_ARGV.join("\0");
    if (name === undefined) return probing ? exited(CLEAN_PROBE) : fake.run(argv, options);
    if (!probing) return fake.run(argv, options);
    suts += 1;
    if (suts > 1) return exited(CLEAN_PROBE);
    switch (behavior) {
      case "sleep_exits": {
        const container = fake.state.containers[name];
        if (container !== undefined) container.running = false;
        return exited("", 1);
      }
      case "sh_exit_1":
        return exited("", 1);
      case "sh_hangs":
        return { kind: "timeout", stdout: "", stderr: "" };
      case "sh_garbage":
        return exited("not the grammar\n");
      case "sh_vendor":
        return exited("vendor:claude\nsocket:0\nend\n");
      case "host_removed": {
        const container = fake.state.containers[name];
        if (container !== undefined) container.running = false;
        markHostEnded(name);
        return exited("", 1);
      }
    }
  };
  const runtime: ContainerRuntime = createDockerRuntime({ context: CONTEXT, run });
  const image = await runtime.ensureImage(BASE);
  const dir = makeTempDir("omf-probe-window-");
  const ledger = new Ledger(dir, () => AT);
  const scope = { goal_id: "g-fast", work_id: WORK, run_id: RUN };
  const round = () =>
    runJudgeRound({
      runtime,
      measure: { runtime, sink: ledger, scope, itemDir: join(dir, "items", WORK), now: () => AT },
      config: judgeConfig({ k: 2, docker_context: CONTEXT }),
      images: {
        sut: image,
        harness: image,
        harness_context_sha256: "d".repeat(64),
        sut_base: await_pinned(),
        harness_base: await_pinned(),
        labels: LABELS,
      },
      scenarios: [scenarioOf(1, [stepOf(["a"], 0)]), scenarioOf(2, [stepOf(["b"], 0)])],
      phase: "train",
      candidate_sha: "c".repeat(40),
      run: RUN_ARGV,
      stageRoot: "/nonexistent/stage",
      forbidden: [],
      round: 1,
      now: () => AT,
    });
  return { fake, round };
}

import { pinnedImage } from "../../src/container/image-ref.js";
const await_pinned = () => pinnedImage(BASE);

describe("the probe window of a SUT container belongs to the candidate", () => {
  it.each([
    ["its sleep exits right after docker start", "sleep_exits"],
    ["its probe sh exits non-zero", "sh_exit_1"],
    ["its probe sh hangs past the cap", "sh_hangs"],
    ["its probe sh prints something unreadable", "sh_garbage"],
    ["its probe reports a vendor binary", "sh_vendor"],
  ] as const)("%s: that (scenario, rep) fails and the round goes on", async (_title, behavior) => {
    const { fake, round } = await rig(behavior);
    const verdict = await round();
    expect(verdict.tallies.map((tally) => [tally.scenario_ref, tally.outcomes])).toEqual([
      ["0000000000000001", ["fail", "pass"]],
      ["0000000000000002", ["pass", "pass"]],
    ]);
    expect(Object.keys(fake.state.containers)).toEqual([]);
  });

  it("negative guard: a SUT removed by the host during the probe stays a round error", async () => {
    const { round } = await rig("host_removed");
    await expect(round()).rejects.toMatchObject({ name: "JudgeRoundError", code: "round_error" });
  });
});
