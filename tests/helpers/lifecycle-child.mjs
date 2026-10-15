// argv: <mode> <logFile> <markerFile> <stageRoot> [<gitDir> <base> <head>]
// mode "tracked": makes two containers through trackRuntime, announces itself and waits.
// mode "round":   runs the real runJudgeRound against the in-memory fake docker; the first step of the candidate announces itself
//                 and never returns, so both the harness and the SUT container exist when the parent signals.
// mode "prove":   runs proveTest over ContainerWorkCopyFactory; the test command announces itself and never returns.
// It imports the built code (dist/), like every other child-process test. The inner runtime is a plain object that appends to
// <logFile>, so the parent can read what this process asked the daemon to do after the process was killed. No Docker is involved.
import { appendFileSync, writeFileSync } from "node:fs";

const dist = (path) => import(new URL(`../../dist/${path}`, import.meta.url).href);
const { trackRuntime } = await dist("judge/state.js");

const [mode, logFile, marker, stageRoot, gitDir, base, head] = process.argv.slice(2);
const RUN = "r-20261014T091500Z-ab12";
const log = (line) => appendFileSync(logFile, `${line}\n`);
const announce = () => writeFileSync(marker, `${process.pid}\n`);
const exited = { kind: "exited", status: 0, signal: null, stdout: "", stderr: "" };
setInterval(() => {}, 60_000); // keeps the process alive while a promise below never settles

const ROUND_BASE = `example.test/omf/base@sha256:${"a".repeat(64)}`;
const CLEAN_PROBE = "socket:0\nend\n";

/** The real runJudgeRound over the fake daemon. The log lists each container the daemon gained or lost, whoever asked for it. */
async function runRound() {
  const { handle, newState, addImage } = await import(new URL("./fake-docker-core.mjs", import.meta.url).href);
  const { createDockerRuntime } = await dist("container/docker-cli.js");
  const { runJudgeRound } = await dist("judge/round.js");
  const { pinnedImage } = await dist("container/image-ref.js");
  const { CONFIG_DEFAULTS } = await dist("core/config.js");
  const state = newState();
  addImage(state, ROUND_BASE);
  const scenarioRef = "0123456789abcdef";
  const step = { invoke: { argv: ["a"], stdin: "" }, expect: { exit_code: 0, stdout_matches: null, json_path: null } };
  let hang = false;
  const hooks = {
    exec(call) {
      if (call.argv[0] === "sh") return { status: 0, stdout: CLEAN_PROBE, stderr: "" };
      if (call.argv[0] === "node") {
        const request = JSON.parse(call.stdin);
        const reply =
          request.op === "load"
            ? { op: "load", nonce: request.nonce, scenarios_total: 1 }
            : { op: "begin", nonce: request.nonce, steps_total: 1, invoke: step.invoke };
        return { status: 0, stdout: JSON.stringify(reply), stderr: "" };
      }
      hang = true; // the candidate's own step
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  const watch = (before) => {
    const after = new Set(Object.keys(state.containers));
    for (const name of after) if (!before.has(name)) log(`create ${name}`);
    for (const name of before) if (!after.has(name)) log(`remove ${name}`);
  };
  const run = async (argv, options) => {
    const before = new Set(Object.keys(state.containers));
    const result = handle(state, argv.slice(argv[0] === "--context" ? 2 : 0), options.stdin ?? null, hooks);
    watch(before);
    if (hang) {
      announce();
      return new Promise(() => {});
    }
    return { kind: "exited", status: result.status, signal: null, stdout: result.stdout, stderr: result.stderr };
  };
  const runSync = (argv) => {
    const before = new Set(Object.keys(state.containers));
    const result = handle(state, argv.slice(argv[0] === "--context" ? 2 : 0), null, hooks);
    watch(before);
    return result;
  };
  const docker = createDockerRuntime({ context: "colima-omf-m3f", run, runSync });
  const image = await docker.ensureImage(pinnedImage(ROUND_BASE));
  const labels = { work_id: "w-0123456789ab", run_id: RUN, round: 1, role: "sut" };
  const now = () => new Date("2026-10-15T09:00:00Z");
  await runJudgeRound({
    runtime: docker,
    measure: {
      runtime: docker,
      sink: { appendWith: (build) => build([]) },
      scope: { goal_id: "g-fast", work_id: labels.work_id, run_id: RUN },
      itemDir: stageRoot,
      now,
    },
    config: { ...CONFIG_DEFAULTS.judge, docker_context: "colima-omf-m3f", k: 1 },
    images: {
      sut: image,
      harness: image,
      harness_context_sha256: "d".repeat(64),
      sut_base: pinnedImage(ROUND_BASE),
      harness_base: pinnedImage(ROUND_BASE),
      labels,
    },
    scenarios: [
      {
        scenario_ref: scenarioRef,
        split: "train",
        kind: "behavior",
        category: "interface",
        set: { scenario_ref: scenarioRef, steps: [step] },
      },
    ],
    phase: "train",
    candidate_sha: "c".repeat(40),
    run: ["/work/cli"],
    stageRoot,
    forbidden: [],
    round: 1,
    now,
  });
}

const inner = {
  context: "colima-omf-m3f",
  async create(spec) {
    log(`create ${spec.name}`);
    return { name: spec.name, id: spec.name, role: spec.labels.role };
  },
  async remove(handle) {
    log(`remove ${handle.name}`);
  },
  removeAllSync(names) {
    for (const name of names) log(`removeAllSync ${name}`);
  },
  async exec(_handle, spec) {
    if (spec.argv[0] === "tar") return exited;
    announce();
    return new Promise(() => {});
  },
};
const runtime = trackRuntime(inner);

if (mode === "round") {
  await runRound();
} else if (mode === "tracked") {
  const spec = (role, serial) => ({ name: `omf-${role}-${RUN}-1-${serial}`, labels: { role } });
  await runtime.create(spec("sut", 1));
  await runtime.create(spec("harness", 2));
  announce();
  await new Promise(() => {});
} else if (mode === "prove") {
  const { ContainerWorkCopyFactory } = await dist("container/work-copy.js");
  const { proveTest } = await dist("gate/prove-test.js");
  const launch = async (spec) => ({ handle: await runtime.create(spec), measurement: {} });
  const copies = new ContainerWorkCopyFactory(
    {
      runtime,
      measure: {},
      image: { id: `sha256:${"a".repeat(64)}`, env_names: [], user: "", volumes: [] },
      build: [],
      labels: { work_id: "w-0123456789ab", run_id: RUN, round: 1 },
      config: { memory_mb: 512, cpus: 1, pids_limit: 256, tmp_tmpfs_mb: 64, work_tmpfs_mb: 256 },
      stageRoot,
      forbidden: [],
    },
    launch,
  );
  const result = await proveTest({
    quarantine: { gitDir },
    base,
    head,
    testCommand: ["announce-and-hang"],
    explicitTestPaths: [],
    copies,
    timeoutMs: 120000,
  });
  console.log(JSON.stringify(result));
} else {
  throw new Error(`unknown mode ${mode}`);
}
