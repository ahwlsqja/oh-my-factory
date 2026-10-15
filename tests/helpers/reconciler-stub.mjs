// Stand-in for a reconciler process.
//   node reconciler-stub.mjs <mode> <recordDir> [fixtureFile] [-- <argv the caller passed>]
// Modes: print (stdout = fixtureFile), exit3, empty, big (2 MiB on stdout), sleep (background child + hang).
// It records stdin (byte-exact), the argv after "--", its whole environment and its cwd into recordDir.
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const split = args.indexOf("--");
const own = split === -1 ? args : args.slice(0, split);
const passed = split === -1 ? [] : args.slice(split + 1);
const [mode, dir, fixture] = own;

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
writeFileSync(join(dir, "stdin.txt"), Buffer.concat(chunks));
writeFileSync(join(dir, "argv.json"), JSON.stringify(passed));
writeFileSync(join(dir, "env.json"), JSON.stringify(process.env));
writeFileSync(
  join(dir, "cwd.json"),
  JSON.stringify({ cwd: process.cwd(), entries: readdirSync(process.cwd()).sort() }),
);

if (mode === "print") {
  process.stdout.write(readFileSync(fixture));
} else if (mode === "exit3") {
  process.stderr.write("SECRET-STDERR");
  process.exit(3);
} else if (mode === "leaky") {
  // A model that already knows what it must not know. `fixture` is a JSON file with the strings to plant
  // (value, target, metric_id); the fourth argument picks the channel they travel in.
  const candidates = leakyCandidates(JSON.parse(readFileSync(fixture, "utf8")), own[3]);
  if (candidates === null) {
    process.stderr.write("unknown leak channel");
    process.exit(4);
  }
  process.stdout.write(JSON.stringify({ candidates }));
} else if (mode === "big") {
  process.stdout.write("x".repeat(2 * 1024 * 1024));
} else if (mode === "sleep") {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  writeFileSync(join(dir, "child.pid"), String(child.pid));
  setInterval(() => {}, 1000);
}
// mode "empty": print nothing and exit 0.

/** One candidate that passes every filter. `over` replaces fields, so each leak is the only fault of its candidate. */
function candidate(title, over = {}) {
  return {
    title,
    problem: "The page does extra work before it can answer.",
    proposed_outcome: "Do that work later so the first answer goes out sooner.",
    affected_users_systems: "Shoppers on the checkout page and the render service.",
    constraints: "",
    open_questions: [],
    rationale: "Deferring the work removes it from the path every request takes.",
    affected_paths: ["src/render"],
    ...over,
  };
}

/** The candidates for one leak channel (a clean control first), or null for a channel that does not exist. */
function leakyCandidates(canary, channel) {
  const control = candidate("Defer work on the checkout render path");
  if (channel === "text") {
    return [
      control,
      candidate(`Bring the reading under ${canary.target} ms`),
      candidate("Cut render work, second pass", { rationale: `It measured ${canary.value} last time.` }),
      candidate("Cut render work, third pass", { proposed_outcome: `Lower ${canary.metric_id} across the page.` }),
      candidate("Cut render work, fourth pass", {
        problem: `The reading is ${String(canary.value).split(".")[0]} right now.`,
      }),
    ];
  }
  if (channel === "paths") {
    return [
      control,
      candidate("Edit the metric notes", { affected_paths: [`docs/${canary.metric_id}.md`] }),
      candidate("Edit the numbered script", { affected_paths: [`bench/p${canary.value}.sh`] }),
    ];
  }
  if (channel === "threshold") {
    return [control, { ...candidate("Tighten the budget"), threshold: Number(canary.target) }];
  }
  if (channel === "nested-query") {
    const query = `SELECT * FROM metrics WHERE value > ${canary.target}`;
    return [control, candidate("Look at the data", { affected_users_systems: { query } })];
  }
  return null;
}
