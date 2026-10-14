// argv: <repo> <work_id>. Takes the claim, starts the item, announces the run id and then idles until killed.
// It imports the built CLI code (dist/), like every other child process test.
const { resolveProject } = await import(new URL("../../dist/core/paths.js", import.meta.url).href);
const { beginRun } = await import(new URL("../../dist/work/w-run.js", import.meta.url).href);

const [repo, workId] = process.argv.slice(2);
const location = resolveProject(repo, process.env);
const run = beginRun({ location, workId });
run.start();
process.stdout.write(`started ${run.runId}\n`);
setInterval(() => {}, 60_000);
