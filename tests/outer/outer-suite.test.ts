import { spawnSync } from "node:child_process";
import { cpSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../helpers/tmp.js";

// covers: S11.5.outer-contracts-hold
// The outer contract suite (outer/) checks kernel promises through the built executable and files on disk only.
// This file is the in-repo wrapper: it runs the PR's own copy against dist and proves the suite can fail. The
// stage0 job (a release's suite against this build) is a separate, advisory workflow.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RUNNER = join(ROOT, "outer", "run.mjs");
const HARNESS = join(ROOT, "outer", "lib", "harness.mjs");
const BUILT = join(ROOT, "dist", "cli", "main.js");
const IDS = ["K01", "K02", "K03", "K04", "K05", "K06", "K07", "K08", "K09"];
const PY = process.env.OMF_OUTER_PYTHON ?? "python3";
const HAS_PYTHON = spawnSync(PY, ["-c", "import pty"], { stdio: "ignore" }).status === 0;

interface Contract {
  id: string;
  pass: number;
  fail: number;
  skipped: number;
  skip_reasons: string[];
  exit: number | null;
}

interface Suite {
  status: number | null;
  report: { ok: boolean; contracts: Contract[] };
}

function runSuite(omf: string, args: readonly string[] = [], env: NodeJS.ProcessEnv = {}): Suite {
  const result = spawnSync(process.execPath, [RUNNER, "--omf", omf, "--json", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.stdout === "") throw new Error(`outer/run.mjs printed nothing (exit ${result.status}): ${result.stderr}`);
  return { status: result.status, report: JSON.parse(result.stdout) as Suite["report"] };
}

type Patch = readonly [file: string, from: string, to: string];

/** A copy of the build with its text patched, so a contract can be shown to fail against a broken kernel. */
function brokenBuild(patches: readonly Patch[]): string {
  const dir = makeTempDir("omf-outer-broken-");
  cpSync(join(ROOT, "dist"), join(dir, "dist"), { recursive: true, dereference: true });
  for (const name of ["package.json", "schemas", "fixtures", "harness"]) {
    cpSync(join(ROOT, name), join(dir, name), { recursive: true, dereference: true });
  }
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  for (const [file, from, to] of patches) {
    const path = join(dir, "dist", file);
    const text = readFileSync(path, "utf8");
    expect(text, `dist/${file} no longer contains the patch target; update this test`).toContain(from);
    writeFileSync(path, text.replace(from, to));
  }
  return join(dir, "dist", "cli", "main.js");
}

function failedIds(suite: Suite): string[] {
  return suite.report.contracts.filter((c) => c.fail > 0 || c.exit !== 0).map((c) => c.id);
}

describe("outer contract suite", () => {
  it("passes against the built CLI, with no unexplained skip", { timeout: 240_000 }, () => {
    const suite = runSuite(BUILT);
    expect(suite.report.contracts.map((c) => c.id)).toEqual(IDS);
    expect(failedIds(suite)).toEqual([]);
    expect(suite.status).toBe(0);
    // A skip is allowed only for the missing terminal driver; with python3 present nothing may be skipped.
    if (HAS_PYTHON) expect(suite.report.contracts.filter((c) => c.skipped > 0)).toEqual([]);
  });

  it("reports a missing terminal driver as a skip with its reason, and --require-tty as a failure", {
    timeout: 120_000,
  }, () => {
    const env = { OMF_OUTER_PYTHON: "/nonexistent/python3" };
    const skipped = runSuite(BUILT, ["--only", "K07"], env);
    expect(skipped.status).toBe(0);
    expect(skipped.report.contracts.map((c) => c.skipped)).toEqual([1]);
    expect(skipped.report.contracts.flatMap((c) => c.skip_reasons).join(" ")).toContain("python3");

    const required = runSuite(BUILT, ["--only", "K07", "--require-tty"], env);
    expect(required.status).toBe(1);
    expect(failedIds(required)).toEqual(["K07"]);
  });

  it("strips locations and credentials from what a contract's child inherits", () => {
    const script = `import { cleanEnv } from ${JSON.stringify(pathToFileURL(HARNESS).href)};
console.log(JSON.stringify(Object.keys(cleanEnv(process.env)).sort()));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: "/home/someone",
        KEEP_ME: "yes",
        GIT_DIR: "/x",
        GIT_AUTHOR_NAME: "n",
        OMF_HOME: "/o",
        XDG_CONFIG_HOME: "/x",
        CODEX_HOME: "/c",
        CLAUDE_CONFIG_DIR: "/c",
        ANTHROPIC_API_KEY: "k",
        OPENAI_API_KEY: "k",
        GITHUB_TOKEN: "t",
        SOME_SECRET: "s",
        DOCKER_HOST: "tcp://x",
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const kept = JSON.parse(result.stdout) as string[];
    expect(kept).toEqual(expect.arrayContaining(["HOME", "KEEP_ME", "PATH"]));
    // Whatever else the operating system adds (macOS adds __CF_USER_TEXT_ENCODING), none of the planted names survives.
    expect(
      kept.filter((name) => /^(GIT_|OMF_|XDG_|CODEX|CLAUDE|ANTHROPIC_|OPENAI_|GITHUB_|DOCKER_)|SECRET$/.test(name)),
    ).toEqual([]);
  });

  // K01's fixture drives a terminal, so without python3 and pty the proof is skipped with its reason; with
  // OMF_OUTER_REQUIRE_TTY=1 the missing driver fails the test instead.
  it("K01 fails against a build whose ledger verification is patched out", { timeout: 240_000 }, (context) => {
    if (!HAS_PYTHON) {
      if (process.env.OMF_OUTER_REQUIRE_TTY === "1") {
        throw new Error("K01 needs python3 with pty and OMF_OUTER_REQUIRE_TTY=1 forbids skipping it");
      }
      context.skip("no python3 with pty: the K01 broken-build proof did not run");
    }
    const omf = brokenBuild([["core/ledger.js", "if (hashEvent(body) !== hash)", "if (false)"]]);
    const suite = runSuite(omf, ["--only", "K01"]);
    expect(suite.status).toBe(1);
    expect(failedIds(suite)).toEqual(["K01"]);
  });

  // K03 drives a terminal. Without python3 and pty the proof is skipped with its reason, never silently; with
  // OMF_OUTER_REQUIRE_TTY=1 (what a CI job will set once one exists, like the runner's --require-tty) the missing driver fails the test instead.
  it("K03 fails against a build that approves without a terminal", { timeout: 240_000 }, (context) => {
    if (!HAS_PYTHON) {
      if (process.env.OMF_OUTER_REQUIRE_TTY === "1") {
        throw new Error("K03 needs python3 with pty and OMF_OUTER_REQUIRE_TTY=1 forbids skipping it");
      }
      context.skip("no python3 with pty: the K03 broken-build proof did not run");
    }
    const omf = brokenBuild([
      ["cli/confirm.js", "if (!streams.stdin.isTTY || !streams.stdout.isTTY) {", "if (false) {"],
      ["cli/confirm.js", "return answer.trim() === expected;", "return true;"],
    ]);
    const suite = runSuite(omf, ["--only", "K03"]);
    expect(suite.status).toBe(1);
    expect(failedIds(suite)).toEqual(["K03"]);
  });

  it("K02 fails against a build that writes into ~/.claude", { timeout: 120_000 }, () => {
    const shebang = "#!/usr/bin/env node\n";
    const write = `${shebang}import { mkdirSync as outerBreak } from "node:fs";\nouterBreak(\`\${process.env.HOME}/.claude\`, { recursive: true });\n`;
    const omf = brokenBuild([["cli/main.js", shebang, write]]);
    const suite = runSuite(omf, ["--only", "K02"]);
    expect(suite.status).toBe(1);
    expect(failedIds(suite)).toEqual(["K02"]);
  });
});
