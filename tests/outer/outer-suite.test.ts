import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { confirmByTyping } from "../../src/cli/confirm.js";
import { sha256Hex } from "../../src/core/canonical-json.js";
import { hashEvent, Ledger, type LedgerEvent } from "../../src/core/ledger.js";
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

  it("strips locations and credentials from what a contract's child inherits, and nothing else it can name", () => {
    const script = `import { cleanEnv } from ${JSON.stringify(pathToFileURL(HARNESS).href)};
console.log(JSON.stringify(Object.keys(cleanEnv(process.env)).sort()));`;
    const scrubbed = [
      "GIT_DIR",
      "GIT_AUTHOR_NAME",
      "OMF_HOME",
      "OMF_OUTER_BIN",
      "XDG_CONFIG_HOME",
      "CODEX_HOME",
      "CLAUDE_CONFIG_DIR",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "OPENAI_API_KEY",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "AWS_ACCESS_KEY_ID",
      "AWS_REGION",
      "DOCKER_HOST",
      "FOO_API_KEY",
      "FOO_TOKEN",
      "FOO_SECRET",
      "SOME_SECRET",
    ];
    // Names that merely contain a scrubbed word, but do not start or end like one, stay.
    const kept = ["HOME", "PATH", "KEEP_ME", "X_OMF_Y", "MY_GIT_THING", "NOT_GH_X", "TOKENS", "API_KEYS"];
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...Object.fromEntries([...scrubbed, ...kept].map((name) => [name, "v"])), PATH: process.env.PATH ?? "" },
    });
    expect(result.status, result.stderr).toBe(0);
    const left = JSON.parse(result.stdout) as string[];
    expect(left.filter((name) => scrubbed.includes(name))).toEqual([]);
    expect(kept.filter((name) => !left.includes(name))).toEqual([]);
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

  it("fails when one contract fails among passing ones, and when a contract runs nothing", { timeout: 120_000 }, () => {
    const shebang = "#!/usr/bin/env node\n";
    const write = `${shebang}import { mkdirSync as outerBreak } from "node:fs";\nouterBreak(\`\${process.env.HOME}/.claude\`, { recursive: true });\n`;
    const omf = brokenBuild([["cli/main.js", shebang, write]]);
    const mixed = runSuite(omf, ["--only", "K02,K09"]);
    expect(failedIds(mixed)).toEqual(["K02"]);
    expect(mixed.report.contracts.find((c) => c.id === "K09")).toMatchObject({ fail: 0, exit: 0 });
    expect(mixed.report.ok).toBe(false);
    expect(mixed.status).toBe(1);

    // A copy of the runner with one contract that holds no test: an empty contract proves nothing and fails.
    const copy = join(makeTempDir("omf-outer-copy-"), "outer");
    cpSync(join(ROOT, "outer"), copy, { recursive: true, dereference: true });
    writeFileSync(
      join(copy, "contracts", "K10-empty.mjs"),
      '// K10: only a skipped test, with no reason\nimport { it } from "node:test";\nit.skip("nothing ran");\n',
    );
    const empty = spawnSync(process.execPath, [join(copy, "run.mjs"), "--omf", BUILT, "--json", "--only", "K10"], {
      encoding: "utf8",
    });
    expect(empty.status, empty.stderr).toBe(1);
    const report = JSON.parse(empty.stdout) as { ok: boolean; contracts: Contract[] };
    expect(report.contracts).toMatchObject([{ id: "K10", pass: 0, fail: 0, skipped: 1, skip_reasons: [], exit: 0 }]);
    expect(report.ok).toBe(false);
  });
});

describe("kernel promises the contracts lean on", () => {
  it("a ledger event whose hash is right but whose shape is wrong fails verification naming the schema", () => {
    const ledger = new Ledger(makeTempDir("omf-outer-ledger-"));
    ledger.append({ actor: "omf", type: "project.initialized", payload: {} });
    const [line = ""] = readFileSync(ledger.file, "utf8").trimEnd().split("\n");
    const event = JSON.parse(line) as LedgerEvent;
    const { hash: _old, ...body } = { ...event, actor: "Not A Valid Actor" };
    writeFileSync(ledger.file, `${JSON.stringify({ ...body, hash: hashEvent(body) })}\n`);
    const verdict = ledger.verify();
    expect(verdict.ok).toBe(false);
    expect(verdict).toMatchObject({ seq: 1 });
    expect((verdict as { reason: string }).reason).toMatch(/^schema: /);
    expect(sha256Hex("x")).toHaveLength(64);
  });

  it("typing the id confirms, and an answer that merely contains or starts with it does not", async () => {
    const answer = async (typed: string): Promise<boolean> => {
      const input = new PassThrough();
      const output = new PassThrough();
      const pending = confirmByTyping("w-abc123", "retype: ", { input, output });
      input.write(`${typed}\n`);
      return await pending;
    };
    expect(await answer("w-abc123")).toBe(true);
    expect(await answer("  w-abc123  ")).toBe(true);
    for (const wrong of ["w-abc123x", "xw-abc123", "w-abc12", "w-abc123 w-abc123", "", "yes"]) {
      expect(await answer(wrong), wrong).toBe(false);
    }
  });
});
