import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { requireProject } from "../../src/core/project.js";
import { approveGoal } from "../../src/goal/approve.js";
import { omf } from "../helpers/cli.js";
import { gitIn, makeGitRepo, makeTempDir } from "../helpers/tmp.js";

// The README walkthrough "Measure without Docker" is run here as written: its fixture files are cut out of the
// fenced blocks, its commands are read from the console block, and the host measurement is compared with what the
// tool itself prints. The human approval is the one step a test cannot type, so it calls approveGoal in-process
// (the terminal path is covered in tests/cli/confirm.test.ts). No Docker and no model are involved.
const ROOT = new URL("../../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, ROOT), "utf8");
const BIOME_BIN_DIR = fileURLToPath(new URL("node_modules/", ROOT));

const section = (text: string, heading: string): string => {
  const start = text.indexOf(`\n${heading}\n`);
  expect(start, `missing heading ${heading}`).toBeGreaterThan(-1);
  const next = text.indexOf("\n## ", start + heading.length + 2);
  return text.slice(start, next === -1 ? undefined : next);
};

/** Fenced blocks whose info string is `<lang> <path>`: the fixture files of the walkthrough. */
const fixtureFiles = (body: string): Map<string, string> =>
  new Map([...body.matchAll(/```\w+ (\S+)\n([\s\S]*?)```/g)].map((m) => [m[1] ?? "", m[2] ?? ""]));

const consoleLines = (body: string): string[] => {
  const blocks = [...body.matchAll(/```console\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  return blocks.flatMap((block) => block.split("\n")).filter((l) => l.startsWith("$ "));
};

const EN = section(read("README.md"), "## Measure without Docker");
const KO = section(read("README.ko.md"), "## Docker 없이 측정하기");

describe("README: Measure without Docker", () => {
  const files = fixtureFiles(EN);
  const lines = consoleLines(EN);
  const propose = lines.find((l) => l.startsWith("$ omf metric propose "));
  const measure = lines.find((l) => l.startsWith("$ omf goal measure "));

  it("ships the fixture, the script, matching commands and the Korean twin", () => {
    expect([...files.keys()].sort()).toEqual(["biome.json", "scripts/count-biome-warnings.mjs", "src/app.js"]);
    expect(propose).toBeDefined();
    expect(measure).toBeDefined();
    expect(propose).toContain("m-biome-warnings --unit warnings");
    expect(propose).toContain("--watch scripts/count-biome-warnings.mjs");
    expect(propose).toContain("--watch biome.json");
    expect(propose).toContain("-- node scripts/count-biome-warnings.mjs");
    expect(measure).toContain("--runner host");
    expect(fixtureFiles(KO)).toEqual(files);
    expect(consoleLines(KO)).toEqual(lines);
  });

  it("states the final-line contract, failure handling and the missing isolation", () => {
    for (const phrase of [
      "last non-empty line",
      "warnings",
      "infos",
      "no isolation",
      "package.json",
      "re-approval",
      "exits non-zero",
      "if Biome exits non-zero",
      "uncommitted",
    ]) {
      expect(EN.toLowerCase(), phrase).toContain(phrase.toLowerCase());
    }
    // The Korean twin carries the same claims: the contract line, the failure handling and the missing isolation.
    for (const phrase of [
      "last non-empty line",
      "warnings",
      "infos",
      "no isolation",
      "package.json",
      "재승인",
      "exits non-zero",
      "Biome 가 0 이 아닌 코드로",
      "값을 보고하지 않습니다",
      "커밋하지 않은",
    ]) {
      expect(KO, phrase).toContain(phrase);
    }
  });

  it("runs end to end without Docker and measures the warnings, not the infos", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    gitIn(repo, "config", "user.email", "docs@example.invalid");
    gitIn(repo, "config", "user.name", "docs");
    for (const [name, body] of files) {
      mkdirSync(dirname(join(repo, name)), { recursive: true });
      writeFileSync(join(repo, name), body);
    }
    symlinkSync(BIOME_BIN_DIR, join(repo, "node_modules"));
    // J1 refuses watched paths with uncommitted changes, so the walkthrough commits the fixture.
    gitIn(repo, "add", "biome.json", "scripts", "src");
    gitIn(repo, "-c", "user.email=dev@example.com", "-c", "user.name=Dev", "commit", "-m", "Add the Biome fixture");

    // The tool's own numbers, from its JSON summary.
    const direct = spawnSync(
      "npx",
      ["--no-install", "biome", "lint", "--max-diagnostics=none", "--reporter=json", "."],
      {
        cwd: repo,
        encoding: "utf8",
      },
    );
    const summary = (JSON.parse(direct.stdout) as { summary: { warnings: number; infos: number } }).summary;
    expect(summary).toMatchObject({ warnings: 3, infos: 1 });

    // The script prints a human line first and the number last.
    const script = spawnSync(process.execPath, ["scripts/count-biome-warnings.mjs"], { cwd: repo, encoding: "utf8" });
    expect(script.status, script.stderr).toBe(0);
    const outLines = script.stdout.split("\n").filter((l) => l.trim() !== "");
    expect(outLines.length).toBeGreaterThan(1);
    expect(Number(outLines.at(-1))).toBe(summary.warnings);

    // The documented sequence, with the ids, unit and watches taken from the README.
    const must = (args: string[], code = 0) => {
      const result = omf(args, repo, home);
      expect(result.code, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`).toBe(code);
      return result;
    };
    must(["init"]);
    const created = must(["goal", "new", "g-biome-zero"]);
    const goalFile = /created (.*goal\.md)/.exec(created.stdout)?.[1] as string;
    writeFileSync(
      goalFile,
      readFileSync(goalFile, "utf8")
        .replace(/m-replace-me/g, "m-biome-warnings")
        .replace("unit: ms", "unit: warnings"),
    );
    const args = (propose as string).slice(2).split(" ").slice(1);
    must(args);
    must(["goal", "audit", "g-biome-zero"]);
    approveGoal(requireProject(repo, { HOME: home }), "g-biome-zero", "human:docs@example.invalid");
    const measured = must((measure as string).slice(2).split(" ").slice(1));
    // The README quotes this line as printed, including the direction and size at the end.
    const gapLine = `target m-biome-warnings: ${summary.warnings} warnings; target <= 0 warnings; gap ${summary.warnings} (decrease, large)`;
    expect(measured.stdout).toContain(gapLine);
    expect(EN).toContain(gapLine);
    expect(KO).toContain(gapLine);
    expect(measured.stderr).toContain("measured on the host without isolation");
  }, 90_000);

  it("fails loudly when the tool is missing, so the metric fails instead of reporting a number", () => {
    const repo = makeTempDir("omf-script-");
    for (const [name, body] of files) {
      mkdirSync(dirname(join(repo, name)), { recursive: true });
      writeFileSync(join(repo, name), body);
    }
    // A PATH that is a fresh directory holding only a symlink to the node binary: no Biome can be found there,
    // even if the directory node was installed in also holds a global Biome.
    const bin = makeTempDir("omf-bin-");
    symlinkSync(process.execPath, join(bin, "node"));
    const env = { PATH: bin, HOME: makeTempDir("omf-home-") };
    const script = spawnSync(process.execPath, ["scripts/count-biome-warnings.mjs"], {
      cwd: repo,
      encoding: "utf8",
      env,
    });
    expect(script.status).not.toBe(0);
    expect(script.stdout.trim()).toBe("");
  }, 60_000);

  it("fails with no value when biome exits non-zero, even though it still prints a summary", () => {
    const repo = makeTempDir("omf-script-");
    for (const [name, body] of files) {
      mkdirSync(dirname(join(repo, name)), { recursive: true });
      writeFileSync(join(repo, name), body);
    }
    writeFileSync(join(repo, "src/bad.js"), "debugger;\n");
    symlinkSync(BIOME_BIN_DIR, join(repo, "node_modules"));
    const script = spawnSync(process.execPath, ["scripts/count-biome-warnings.mjs"], { cwd: repo, encoding: "utf8" });
    expect(script.status).toBe(1);
    expect(script.stdout.trim()).toBe("");
    expect(script.stderr).toContain("biome exited with");
  }, 60_000);
});
