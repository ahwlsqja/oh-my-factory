// argv: <repo> <work_id>. Runs the line with one station, S3, that announces its run id and never returns, so the
// parent can kill the process in the middle of a station. It imports the built code (dist/), like every other
// child process test, and must be started with `harnessEnv(home, {})`, never with the real HOME.
const { resolveProject } = await import(new URL("../../dist/core/paths.js", import.meta.url).href);
const { runLine } = await import(new URL("../../dist/work/sequencer.js", import.meta.url).href);

const [repo, workId] = process.argv.slice(2);
const location = resolveProject(repo, process.env);
const pass = (id) => ({ id, evaluate: async () => ({ gate: id, verdict: "pass", reasons: [] }) });

await runLine({
  location,
  workId,
  gates: { "GATE-2": pass("GATE-2"), "GATE-3": pass("GATE-3") },
  stations: {
    S3: {
      id: "S3",
      run: (ctx) => {
        process.stdout.write(`in S3 ${ctx.runId}\n`);
        setInterval(() => {}, 60_000); // keeps the process alive until it is killed
        return new Promise(() => {});
      },
    },
  },
});
