import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// argv[2] is a directory holding plan.json (written by the test). Every call appends a line to `calls`.
const dir = process.argv[2];
const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));

// The prompt arrives on stdin; drain it so the parent never sees EPIPE.
for await (const chunk of process.stdin) void chunk;

appendFileSync(join(dir, "calls"), "call\n");
if (plan.delay_ms) await new Promise((resolve) => setTimeout(resolve, plan.delay_ms));
if (plan.mode === "fail") process.exit(1);

// Titles are taken from plan.titles in order across calls, so every candidate has a new fingerprint.
const madeFile = join(dir, "made");
const made = existsSync(madeFile) ? Number(readFileSync(madeFile, "utf8")) : 0;
const count = plan.mode === "empty" ? 0 : (plan.count ?? 1);
const candidates = [];
for (let i = 0; i < count; i += 1) {
  candidates.push({
    title: plan.titles[(made + i) % plan.titles.length],
    problem: "The render path repeats work that does not need to happen.",
    proposed_outcome: "The path does the minimum work on each request.",
    affected_users_systems: "Everyone who loads a page.",
    constraints: "",
    open_questions: [],
    rationale: "Less repeated work should make pages faster.",
    affected_paths: plan.paths ?? ["src/render"],
  });
}
writeFileSync(madeFile, String(made + count));
process.stdout.write(JSON.stringify({ candidates }));
