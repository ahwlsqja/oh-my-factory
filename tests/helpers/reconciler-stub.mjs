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
} else if (mode === "big") {
  process.stdout.write("x".repeat(2 * 1024 * 1024));
} else if (mode === "sleep") {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  writeFileSync(join(dir, "child.pid"), String(child.pid));
  setInterval(() => {}, 1000);
}
// mode "empty": print nothing and exit 0.
