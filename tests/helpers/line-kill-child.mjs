// argv: <repo> <work_id>. Runs the line with stations S1 and S2 ok and an S3 that announces itself and never
// returns, so the parent can SIGKILL it mid-station. GATE-2 and GATE-3 are stand-ins. It imports the built
// code (dist/), like every other child process test. The parent gives it harnessEnv(home, {}): never the real HOME.
const { resolveProject } = await import(new URL("../../dist/core/paths.js", import.meta.url).href);
const { runLine } = await import(new URL("../../dist/work/sequencer.js", import.meta.url).href);

const [repo, workId] = process.argv.slice(2);
const location = resolveProject(repo, process.env);
const ok = (id) => ({ id, run: () => ({ kind: "ok" }) });
const pass = (id) => ({ id, evaluate: () => ({ gate: id, verdict: "pass", reasons: [] }) });
const stations = {
  S1: ok("S1"),
  S2: ok("S2"),
  S3: {
    id: "S3",
    run: () => {
      process.stdout.write("in S3\n");
      setInterval(() => {}, 60_000);
      return new Promise(() => {});
    },
  },
};
await runLine({ location, workId, stations, gates: { "GATE-2": pass("GATE-2"), "GATE-3": pass("GATE-3") } });
