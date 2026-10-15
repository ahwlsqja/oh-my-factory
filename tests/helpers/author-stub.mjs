// Stand-in for an author session.
//   node author-stub.mjs <mode> <recordDir> [fixtureFile] [delayMs]
// Modes: print (stdout = fixtureFile), from_feedback (two documents that link the ids named by the prompt's
// "- unlinked decision: <id>" lines, else d-interface), exit3, empty, big (2 MiB on stdout), sleep (background child + hang).
// It records stdin (byte-exact), its argv, its whole environment and its cwd into recordDir. delayMs holds the
// output back, so two processes can be made to overlap.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [mode, dir, fixture, delay] = process.argv.slice(2);

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const stdin = Buffer.concat(chunks).toString("utf8");
writeFileSync(join(dir, "stdin.txt"), stdin);
writeFileSync(join(dir, "argv.json"), JSON.stringify(process.argv.slice(2)));
writeFileSync(join(dir, "env.json"), JSON.stringify(process.env));
writeFileSync(join(dir, "cwd.json"), JSON.stringify({ cwd: process.cwd() }));

await new Promise((done) => setTimeout(done, Number(delay ?? 0)));

if (mode === "print") {
  process.stdout.write(readFileSync(fixture));
} else if (mode === "from_feedback") {
  const ids = [...stdin.matchAll(/^- unlinked decision: (d-[a-z0-9-]+)$/gm)].map((match) => match[1]);
  const refs = ids.length > 0 ? ids : ["d-interface"];
  const document = (split) =>
    [
      "decision_refs:",
      ...refs.map((ref) => `  - ${ref}`),
      "kind: behavior",
      `split: ${split}`,
      "interface: cli",
      "steps:",
      "  - invoke:",
      "      argv: [status]",
      '      stdin: ""',
      "    expect:",
      "      exit_code: 0",
      "      stdout_matches:",
      "        kind: exact",
      '        text: "ok\\n"',
      "      note: the status command reports ok",
    ].join("\n");
  process.stdout.write(`${document("train")}\n---\n${document("test")}\n`);
} else if (mode === "exit3") {
  process.stderr.write("SECRET-STDERR");
  process.exit(3);
} else if (mode === "big") {
  process.stdout.write("x".repeat(2 * 1024 * 1024));
} else if (mode === "sleep") {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  writeFileSync(join(dir, "child.pid"), String(child.pid));
  setInterval(() => {}, 1000);
}
// mode "empty": print nothing and exit 0.
