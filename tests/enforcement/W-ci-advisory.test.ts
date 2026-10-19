import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { commitAll, gitIn, makeGitRepo, makeTempDir } from "../helpers/tmp.js";

// M3h-D14, M3h-D15, owner decisions 2 and 3 of 2026-10-19: the stage0 outer-suite job and the kernel-path report are
// advisory. They run with a read-only token, sit outside the `ci` aggregate, use the stage0 release's suite (never the
// pull request's copy) and the base commit's report script. Each workflow step's shell is executed here, not grepped.

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Job {
  needs?: string | string[];
  permissions?: unknown;
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const KERNEL_SCRIPT = join(ROOT, "scripts/kernel-paths.mjs");
const NOTICE = "kernel paths touched: the owner merges this after reading the diff; agents do not merge it";

function load(file: string): { text: string; wf: Workflow } {
  const text = readFileSync(join(ROOT, ".github/workflows", file), "utf8");
  return { text, wf: parse(text) as Workflow };
}

const OUTER = load("outer-suite.yml");
const KERNEL = load("kernel-paths.yml");
const CI = load("ci.yml");

const stepsOf = (wf: Workflow): Step[] => Object.values(wf.jobs).flatMap((job) => job.steps);

function runOf(wf: Workflow, name: string): string {
  const step = stepsOf(wf).find((s) => s.name === name);
  if (step?.run === undefined) throw new Error(`no run step named ${JSON.stringify(name)}`);
  return step.run;
}

interface Space {
  dir: string;
  summary: string;
  output: string;
}

function space(): Space {
  const dir = realpathSync(makeTempDir("omf-ci-"));
  const summary = join(dir, "summary.md");
  const output = join(dir, "output.txt");
  writeFileSync(summary, "");
  writeFileSync(output, "");
  return { dir, summary, output };
}

/** Runs one workflow step's shell the way the runner does (bash -e), in a temp workspace with the runner's file variables. */
function runStep(wf: Workflow, name: string, ws: Space, env: Record<string, string> = {}) {
  return spawnSync("bash", ["-e", "-c", runOf(wf, name)], {
    cwd: ws.dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", GITHUB_STEP_SUMMARY: ws.summary, GITHUB_OUTPUT: ws.output, ...env },
  });
}

function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

describe("W-ci-advisory: shape", () => {
  it("both jobs run on pull_request only, with a read-only token, outside the ci aggregate", () => {
    const needs = CI.wf.jobs.ci?.needs;
    expect(Array.isArray(needs)).toBe(true);
    for (const { text, wf } of [OUTER, KERNEL]) {
      expect(Object.keys(wf.on)).toEqual(["pull_request"]);
      expect(text).not.toContain("pull_request_target");
      expect(wf.permissions).toEqual({ contents: "read" });
      for (const [key, job] of Object.entries(wf.jobs)) {
        expect(job.permissions).toBeUndefined();
        expect(needs, key).not.toContain(key);
      }
    }
  });

  it("uses the action commits ci.yml pins, keeps no checkout credentials and puts no expression in a run step", () => {
    const pins = new Map<string, string>();
    for (const m of CI.text.matchAll(/uses:\s+([\w.-]+\/[\w.-]+)@([0-9a-f]{40})/g)) pins.set(m[1] ?? "", m[2] ?? "");
    for (const { wf } of [OUTER, KERNEL]) {
      for (const step of stepsOf(wf)) {
        if (step.uses !== undefined) {
          const [, action, sha] = /^(.+)@([0-9a-f]{40})$/.exec(step.uses) ?? [];
          expect(action, step.uses).toBeDefined();
          expect(pins.get(action ?? ""), step.uses).toBe(sha);
          if (step.uses.startsWith("actions/checkout")) expect(step.with?.["persist-credentials"]).toBe(false);
        }
        if (step.run !== undefined) expect(step.run).not.toContain("${{");
      }
    }
  });

  it("checks out the pull request, the base commit's pin and the stage0 tag separately, and never runs the PR's outer/", () => {
    const steps = stepsOf(OUTER.wf);
    const checkouts = steps.filter((s) => s.uses?.startsWith("actions/checkout"));
    expect(checkouts.map((s) => s.with?.path)).toEqual(["pr", "base", "stage0"]);
    expect(checkouts[1]?.with?.ref).toBe("${{ github.event.pull_request.base.sha }}");
    expect(checkouts[2]?.with?.ref).toBe("${{ steps.tag.outputs.tag }}");
    for (const step of steps) expect(step.run ?? "").not.toContain("pr/outer");
    expect(runOf(OUTER.wf, "Run the stage0 outer suite")).toContain("node stage0/outer/run.mjs");
    expect(runOf(KERNEL.wf, "Report kernel paths")).not.toContain("pr/scripts");
  });
});

describe("W-ci-advisory: the stage0 tag step", () => {
  it.each([
    ["v0.0.3\n", "v0.0.3"],
    ["  v12.3.45  \n", "v12.3.45"],
  ])("accepts %j as the tag %s", (pin, tag) => {
    const ws = space();
    put(ws.dir, "base/docs/maintainers/stage0.txt", pin);
    const out = runStep(OUTER.wf, "Read the stage0 tag", ws);
    expect(out.status).toBe(0);
    expect(readFileSync(ws.output, "utf8")).toBe(`tag=${tag}\n`);
  });

  it.each(["main\n", "v1.0\n", "v0.0.3-rc.1\n", "v0.0.3\nv0.0.4\n", "v0.0.3 && echo hi\n", "../v0.0.3\n", ""])(
    "refuses %j and sets no output",
    (pin) => {
      const ws = space();
      put(ws.dir, "base/docs/maintainers/stage0.txt", pin);
      const out = runStep(OUTER.wf, "Read the stage0 tag", ws);
      expect(out.status).toBe(1);
      expect(out.stdout).toContain("::error");
      expect(readFileSync(ws.output, "utf8")).toBe("");
    },
  );

  it("skips with a summary and exit 0 when the base commit has no pin", () => {
    const ws = space();
    const out = runStep(OUTER.wf, "Read the stage0 tag", ws);
    expect(out.status).toBe(0);
    expect(readFileSync(ws.output, "utf8")).toBe("");
    expect(readFileSync(ws.summary, "utf8")).toContain("skipped");
  });
});

describe("W-ci-advisory: the stage0 run step", () => {
  const env = { STAGE0_TAG: "v0.0.3" };

  it("reports that stage0 predates the suite and succeeds when stage0 has no outer/run.mjs", () => {
    const ws = space();
    const out = runStep(OUTER.wf, "Run the stage0 outer suite", ws, env);
    expect(out.status).toBe(0);
    expect(readFileSync(ws.summary, "utf8")).toContain("has no outer suite");
  });

  it("runs stage0's suite, never the pull request's, against the pull request's built executable, and keeps its exit code", () => {
    const ws = space();
    put(
      ws.dir,
      "stage0/outer/run.mjs",
      'console.log("STAGE0 " + process.argv.slice(2).join(" "));\nprocess.exit(3);\n',
    );
    put(ws.dir, "pr/outer/run.mjs", 'console.log("PR COPY");\nprocess.exit(0);\n');
    const out = runStep(OUTER.wf, "Run the stage0 outer suite", ws, env);
    expect(out.status).toBe(3);
    const summary = readFileSync(ws.summary, "utf8");
    expect(summary).toContain(`STAGE0 --omf ${ws.dir}/pr/dist/cli/main.js --require-tty`);
    expect(summary).not.toContain("PR COPY");
  });
});

describe("W-ci-advisory: the kernel-path step", () => {
  it("skips with a notice and exit 0 when the base commit has no report script (the PR that adds it)", () => {
    const ws = space();
    const out = runStep(KERNEL.wf, "Report kernel paths", ws, { BASE_SHA: "0".repeat(40), HEAD_SHA: "1".repeat(40) });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("::notice");
    expect(readFileSync(ws.summary, "utf8")).toContain("skipped");
  });

  it("runs the base commit's script over base...head: names touched kernel files, notices only then, always exits 0", () => {
    const repo = makeGitRepo();
    put(repo, "src/decision/a.ts", "export const a = 1;\n");
    commitAll(repo, "base");
    const base = gitIn(repo, "rev-parse", "HEAD").trim();
    put(repo, "docs/z.md", "# z\n");
    commitAll(repo, "docs only");
    const docsOnly = gitIn(repo, "rev-parse", "HEAD").trim();
    put(repo, "src/decision/a.ts", "export const a = 2;\n");
    commitAll(repo, "kernel edit");
    const kernel = gitIn(repo, "rev-parse", "HEAD").trim();

    const ws = space();
    symlinkSync(repo, join(ws.dir, "pr"));
    mkdirSync(join(ws.dir, "base/scripts"), { recursive: true });
    copyFileSync(KERNEL_SCRIPT, join(ws.dir, "base/scripts/kernel-paths.mjs"));
    put(ws.dir, "base/docs/maintainers/kernel-paths.txt", "src/decision/**\n");

    const quiet = runStep(KERNEL.wf, "Report kernel paths", ws, { BASE_SHA: base, HEAD_SHA: docsOnly });
    expect(quiet.status).toBe(0);
    expect(quiet.stdout).not.toContain("touches kernel paths");
    expect(readFileSync(ws.summary, "utf8")).toContain("No kernel path touched.");

    writeFileSync(ws.summary, "");
    const loud = runStep(KERNEL.wf, "Report kernel paths", ws, { BASE_SHA: base, HEAD_SHA: kernel });
    expect(loud.status).toBe(0);
    expect(loud.stdout).toContain("::notice title=kernel paths::this pull request touches kernel paths");
    const summary = readFileSync(ws.summary, "utf8");
    expect(summary).toContain("`src/decision/a.ts`");
    expect(summary).toContain(NOTICE);
    expect(summary).not.toContain("docs/z.md");
  });
});
