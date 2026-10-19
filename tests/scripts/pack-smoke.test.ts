import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../helpers/tmp.js";

// scripts/pack-smoke.mjs packs the project and installs the tarball from the registry, so npm test does not run it (CI does).
// Here it runs for real, but against a fake `npm` first on PATH: `npm pack` reports a complete file list and `npm install`
// plants an `omf` whose `--help` is a fixture. What is under test is the script's own verdict on the installed binary's help.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "pack-smoke.mjs");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  name: string;
  version: string;
  bin: { omf: string };
  files: string[];
};

const FAKE_NPM = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "pack") {
  process.stdout.write(fs.readFileSync(process.env.FIXTURE_PACK_JSON, "utf8"));
} else if (args[0] === "install") {
  const prefix = args[args.indexOf("--prefix") + 1];
  const pkg = JSON.parse(process.env.FIXTURE_PKG);
  const binDir = path.join(prefix, "node_modules", ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "omf"), fs.readFileSync(process.env.FIXTURE_OMF, "utf8"), { mode: 0o755 });
  const target = path.join(prefix, "node_modules", pkg.name, pkg.bin.omf);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "", { mode: 0o755 });
} else {
  process.exit(9);
}
`;

const OMF = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2).join(" ");
if (args === "--version") console.log(process.env.FIXTURE_VERSION);
else if (args === "--help") process.stdout.write(fs.readFileSync(process.env.FIXTURE_HELP, "utf8"));
else if (args === "init") console.log("initialized /x");
else if (args === "ledger verify") console.log("ok: 0 events");
else process.exit(9);
`;

const HELP_HEAD =
  "Usage: omf [options] [command]\n\noh-my-factory\n\nOptions:\n  -h, --help  display help\n\nCommands:\n";
const line = (name: string, text = "does a thing"): string => `  ${name.padEnd(26)}${text}\n`;
const COMPLETE = `${HELP_HEAD}${[
  "init",
  "doctor",
  "seal [options] <work_id>",
  "run [options] <work_id>",
  "report [options] <work_id>",
]
  .map((name) => line(name))
  .join("")}`;

function smoke(help: string, version: string = PKG.version): { status: number | null; stdout: string; stderr: string } {
  const dir = makeTempDir("omf-pack-smoke-test-");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const shim = join(bin, "npm");
  writeFileSync(shim, FAKE_NPM);
  chmodSync(shim, 0o755);
  const files = [...PKG.files, "package.json"].map((path) => ({ path: path === "package.json" ? path : `${path}/x` }));
  files.push({ path: PKG.bin.omf });
  writeFileSync(join(dir, "pack.json"), JSON.stringify([{ filename: "omf.tgz", files }]));
  writeFileSync(join(dir, "help.txt"), help);
  writeFileSync(join(dir, "omf.js"), OMF);
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: dir,
      FIXTURE_PACK_JSON: join(dir, "pack.json"),
      FIXTURE_PKG: JSON.stringify({ name: PKG.name, bin: PKG.bin }),
      FIXTURE_OMF: join(dir, "omf.js"),
      FIXTURE_HELP: join(dir, "help.txt"),
      FIXTURE_VERSION: version,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("scripts/pack-smoke.mjs against a fake npm", () => {
  it("passes when the installed help lists seal, run and report", () => {
    const result = smoke(COMPLETE);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("pack-smoke OK");
  });

  it.each(["seal", "run", "report"])("fails when %s is not listed", (verb) => {
    const help = COMPLETE.split("\n")
      .filter((text) => !new RegExp(`^ {2}${verb}\\b`).test(text))
      .join("\n");
    const result = smoke(help);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`pack-smoke FAIL: omf --help does not list the ${verb} command`);
    for (const other of ["seal", "run", "report"].filter((name) => name !== verb)) {
      expect(result.stderr).not.toContain(`list the ${other} command`);
    }
  });

  it("does not count a verb that appears only inside a description", () => {
    const help = COMPLETE.replace(line("report [options] <work_id>"), line("doctor2", "then report on it, or run it"));
    const result = smoke(help);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not list the report command");
  });

  it("does not count a command that only starts with the verb", () => {
    const help = COMPLETE.replace(line("run [options] <work_id>"), line("runner [options]")).replace(
      line("seal [options] <work_id>"),
      line("sealed"),
    );
    const result = smoke(help);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not list the run command");
    expect(result.stderr).toContain("does not list the seal command");
  });

  it("fails when the help has no Usage line", () => {
    const result = smoke(COMPLETE.replace("Usage:", "Use:"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("omf --help output looks wrong");
  });

  it("fails when the help never names omf", () => {
    const result = smoke(COMPLETE.replaceAll("omf", "tool"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("omf --help output looks wrong");
  });

  it("fails when the installed version is not the package version", () => {
    const result = smoke(COMPLETE, "0.0.0-wrong");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('omf --version printed "0.0.0-wrong"');
  });
});
