// argv: <mode> <logFile> <markerFile> <stageRoot> [<gitDir> <base> <head>]
// mode "tracked": makes two containers through trackRuntime, announces itself and waits.
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

if (mode === "tracked") {
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
