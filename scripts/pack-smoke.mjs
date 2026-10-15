#!/usr/bin/env node
// Package smoke test: pack the project, install the tarball into a throwaway
// prefix, and check that the installed `omf` binary actually runs.
//
// `npm pack` accepts `private: true` packages (only `npm publish` refuses
// them), so this works while the package is still private. `prepack` runs the
// build; do not pass --ignore-scripts or the tarball ships without dist/.
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
// npm always bundles README.* files, so README.ko.md ships even though package.json
// "files" does not list it. It is allowed, but not required.
const REQUIRED_TOP = ["dist", "schemas", "fixtures", "LICENSE", "THIRD_PARTY_NOTICES.md", "README.md", "package.json"];
const ALLOWED_TOP = new Set([...REQUIRED_TOP, "README.ko.md"]);

const tmp = mkdtempSync(join(tmpdir(), "omf-pack-smoke-"));
const failures = [];
const fail = (msg) => failures.push(msg);

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    // Never inherit model credentials or the real HOME.
    env: {
      ...process.env,
      HOME: join(tmp, "home"),
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
    },
    ...opts,
  });
}

try {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  // 1. Pack into the temp dir and read the file list from npm's JSON report.
  const packOut = run("npm", ["pack", "--json", "--pack-destination", tmp], { cwd: root });
  const report = JSON.parse(packOut.slice(packOut.indexOf("[")))[0];
  const tarball = join(tmp, report.filename);

  // 2. Allowlist check on top-level entries.
  const files = report.files.map((f) => f.path);
  if (files.length === 0) fail("tarball is empty");
  for (const p of files) {
    const top = p.split("/")[0];
    if (!ALLOWED_TOP.has(top)) fail(`unexpected file in tarball: ${p}`);
  }
  for (const required of REQUIRED_TOP) {
    if (!files.some((p) => p === required || p.startsWith(`${required}/`))) {
      // LICENSE and README.md are matched by name; dist, schemas and fixtures by prefix.
      fail(`allowlisted entry missing from tarball: ${required}`);
    }
  }
  const binRel = pkg.bin?.omf;
  if (!binRel || !files.includes(binRel)) fail(`bin target ${binRel} is not in the tarball`);

  // 3. Install into a temporary prefix, from the tarball only.
  const prefix = join(tmp, "prefix");
  run("npm", ["install", "--prefix", prefix, "--no-audit", "--no-fund", tarball], { cwd: tmp });
  const bin = join(prefix, "node_modules", ".bin", "omf");

  // 4. The bin must be executable and run.
  accessSync(bin, constants.X_OK);
  if ((statSync(join(prefix, "node_modules", pkg.name, binRel)).mode & 0o111) === 0) {
    fail("installed bin target is not executable");
  }
  const version = run(bin, ["--version"], { cwd: tmp }).trim();
  if (version !== pkg.version) fail(`omf --version printed "${version}", expected "${pkg.version}"`);
  const help = run(bin, ["--help"], { cwd: tmp });
  if (!/omf/i.test(help) || !/Usage:/i.test(help)) fail("omf --help output looks wrong");

  // 5. Schema lookup from the installed location: init + ledger verify in a
  // throwaway git repo with an isolated HOME.
  const repo = join(tmp, "repo");
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(tmp, "home"), { recursive: true });
  const git = (...args) =>
    run(
      "git",
      ["-c", "user.name=Smoke Test", "-c", "user.email=smoke@example.invalid", "-c", "commit.gpgsign=false", ...args],
      { cwd: repo },
    );
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "init");
  // run() throws on a non-zero exit, so reaching the regex means exit 0.
  for (const [args, expected] of [[["init"], /initialized/i], [["ledger", "verify"], /ok:/i]]) {
    const out = run(bin, args, { cwd: repo });
    if (!expected.test(out)) fail(`omf ${args.join(" ")} output unexpected: ${out.trim()}`);
  }
} catch (err) {
  fail(`smoke run threw: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures.length > 0) {
  for (const f of failures) console.error(`pack-smoke FAIL: ${f}`);
  process.exit(1);
}
console.log("pack-smoke OK");
