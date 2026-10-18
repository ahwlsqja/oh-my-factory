#!/usr/bin/env node
// Runs the outer contract suite against a built omf.
//
//   node outer/run.mjs --omf <path to dist/cli/main.js> [--only K01,K03] [--json] [--require-tty]
//
// Exit 0: every contract passed. 1: a contract failed, or ran nothing. 2: a usage error. A contract that needs a
// terminal is reported as skipped, with the reason, when python3 is missing; --require-tty turns that skip into a
// failure, which is what CI uses. Standard library only; nothing here imports the repository it ships in.
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function usage(message) {
  console.error(message);
  console.error("usage: node outer/run.mjs --omf <dist/cli/main.js> [--only K01,K03] [--json] [--require-tty]");
  process.exit(2);
}

const options = { omf: null, only: null, json: false, requireTty: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--omf") options.omf = argv[++i] ?? usage("--omf needs a path");
  else if (arg === "--only") options.only = (argv[++i] ?? usage("--only needs ids")).split(",");
  else if (arg === "--json") options.json = true;
  else if (arg === "--require-tty") options.requireTty = true;
  else usage(`unknown argument ${arg}`);
}
if (options.omf === null) usage("--omf is required");

const files = readdirSync(join(HERE, "contracts"))
  .filter((name) => /^K\d\d-.+\.mjs$/.test(name))
  .sort()
  .filter((name) => options.only === null || options.only.includes(name.slice(0, 3)));
if (files.length === 0) usage("no contract matches");

function count(tap, name) {
  const match = new RegExp(`^# ${name} (\\d+)$`, "m").exec(tap);
  return match === null ? 0 : Number(match[1]);
}

function runContract(file) {
  return new Promise((done) => {
    const env = { ...process.env, OMF_OUTER_BIN: resolve(options.omf) };
    if (options.requireTty) env.OMF_OUTER_REQUIRE_TTY = "1";
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", join(HERE, "contracts", file)], { env });
    let tap = "";
    child.stdout.on("data", (chunk) => {
      tap += chunk;
    });
    child.stderr.on("data", (chunk) => {
      tap += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const skipLines = [...tap.matchAll(/^\s*ok \d+ - .+? # SKIP (.*)$/gm)].map((match) => match[1]);
      done({
        id: file.slice(0, 3),
        name: file.slice(4, -4).replaceAll("-", " "),
        tests: count(tap, "tests"),
        pass: count(tap, "pass"),
        fail: count(tap, "fail") + count(tap, "cancelled"),
        skipped: count(tap, "skipped") + skipLines.length,
        skip_reasons: [...new Set(skipLines)],
        exit: code,
        output: code === 0 ? "" : tap.slice(0, 4000),
      });
    });
  });
}

const contracts = await Promise.all(files.map(runContract));
// A contract that ran nothing and was not skipped with a reason is a failure: an empty contract proves nothing.
const passed = (c) => c.exit === 0 && c.fail === 0 && (c.pass > 0 || c.skip_reasons.length > 0);
const ok = contracts.every(passed);

if (options.json) {
  console.log(JSON.stringify({ ok, omf: resolve(options.omf), contracts }, null, 2));
} else {
  for (const c of contracts) {
    const mark = passed(c) ? "ok  " : "FAIL";
    console.log(`${mark} ${c.id} ${c.name}: pass ${c.pass}, fail ${c.fail}, skipped ${c.skipped}`);
    for (const reason of c.skip_reasons) console.log(`       skipped: ${reason}`);
    if (c.output !== "") console.log(c.output);
  }
  console.log(ok ? "outer contracts: ok" : "outer contracts: FAILED");
}
process.exit(ok ? 0 : 1);
