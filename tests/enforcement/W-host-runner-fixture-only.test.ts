import { copyFileSync, existsSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProcessOptions, ProcessResult, runProcessGroup } from "../../src/adapters/process-group.js";
import { FIXTURE_ALLOWLIST, createHostFixtureRunner, fixturesDir, verifyFixture } from "../../src/scenario/fixtures.js";
import { DEFAULT_STEP_LIMITS } from "../../src/scenario/runner.js";
import type { FixtureId, RunTarget } from "../../src/scenario/runner.js";
import { makeTempDir } from "../helpers/tmp.js";

// Spec §5.3 and M3-D5: the judge never runs repository code on the host. The host adapter executes the bytes of
// an OMF-shipped fixture whose sha256 is on a committed allowlist, and scenario argv and stdin reach it as data.
const OK: ProcessResult = { kind: "exited", status: 0, signal: null, stdout: "", stderr: "" };
const STEP = { argv: ["x"], stdin: "" };

function recordingExec() {
  const calls: { argv: string[]; options: ProcessOptions }[] = [];
  const exec: typeof runProcessGroup = async (argv, options) => {
    calls.push({ argv: [...argv], options });
    return OK;
  };
  return { exec, calls };
}

function sourceOf(id: FixtureId): string {
  const check = verifyFixture(id);
  if (!check.ok) throw new Error(`fixture ${id} not verified: ${check.code}`);
  return check.source;
}

/** What the first step of a session on `target` reports, with a recording exec; `calls` shows whether anything was spawned. */
async function firstStep(target: RunTarget, fixturesOverride?: string) {
  const { exec, calls } = recordingExec();
  const runner = createHostFixtureRunner({ exec, scratchRoot: makeTempDir("omf-scratch-"), fixturesDir: fixturesOverride });
  const session = await runner.openScenario(target);
  const observation = await session.runStep(STEP, DEFAULT_STEP_LIMITS);
  await session.close();
  return { observation, calls };
}

describe("W-host-runner-fixture-only", () => {
  it("only executes OMF fixtures: it says so, and refuses a candidate and every id outside the allowlist without spawning", async () => {
    expect(createHostFixtureRunner().executes).toBe("omf_fixture");
    const candidate = await firstStep({ kind: "candidate", handle: "image:abc" });
    expect(candidate.observation).toEqual({ outcome: "refused", code: "candidate_needs_container" });
    expect(candidate.calls).toEqual([]);
    for (const id of ["/bin/sh", "rm", "../fixtures/null-error", "null-error.mjs", ""]) {
      const refused = await firstStep({ kind: "fixture", id: id as FixtureId });
      expect(refused.observation).toEqual({ outcome: "refused", code: "unknown_fixture" });
      expect(refused.calls).toEqual([]);
    }
  });

  it("refuses a modified fixture on its hash, and a copy with the right bytes still runs (positive control)", async () => {
    const dir = makeTempDir("omf-fixtures-");
    for (const entry of FIXTURE_ALLOWLIST) copyFileSync(join(fixturesDir(), entry.file), join(dir, entry.file));
    const control = await firstStep({ kind: "fixture", id: "echo-everything" }, dir);
    expect(control.calls).toHaveLength(1);

    writeFileSync(join(dir, "null-error.mjs"), `${readFileSync(join(dir, "null-error.mjs"), "utf8")}process.exit(0);\n`);
    const modified = await firstStep({ kind: "fixture", id: "null-error" }, dir);
    expect(modified.observation).toEqual({ outcome: "refused", code: "fixture_hash_mismatch" });
    expect(modified.calls).toEqual([]);
  });

  it("refuses a symlinked fixture and one whose realpath leaves the fixtures directory, without spawning", async () => {
    const outside = makeTempDir("omf-fixtures-");
    symlinkSync(join(fixturesDir(), "null-error.mjs"), join(outside, "null-error.mjs"));
    const left = await firstStep({ kind: "fixture", id: "null-error" }, outside);
    expect(left.observation).toEqual({ outcome: "refused", code: "fixture_outside_dir" });

    const inside = makeTempDir("omf-fixtures-");
    copyFileSync(join(fixturesDir(), "null-empty.mjs"), join(inside, "sibling.mjs"));
    symlinkSync(join(inside, "sibling.mjs"), join(inside, "null-empty.mjs"));
    const linked = await firstStep({ kind: "fixture", id: "null-empty" }, inside);
    expect(linked.observation).toEqual({ outcome: "refused", code: "fixture_not_regular_file" });
    expect(left.calls).toEqual([]);
    expect(linked.calls).toEqual([]);
  });

  it("always spawns the node binary with the verified bytes: scenario argv is data, never a program", async () => {
    const hostile = [join(fixturesDir(), "null-error.mjs"), "/bin/sh", "rm", "-rf", "--input-type=commonjs"];
    const { exec, calls } = recordingExec();
    const runner = createHostFixtureRunner({ exec, scratchRoot: makeTempDir("omf-scratch-") });
    const session = await runner.openScenario({ kind: "fixture", id: "echo-everything" });
    await session.runStep({ argv: hostile, stdin: "" }, DEFAULT_STEP_LIMITS);
    await session.close();
    expect(calls[0]?.argv).toEqual([process.execPath, "--input-type=module", "-e", sourceOf("echo-everything"), "--", ...hostile]);
  });

  it("does not run a payload argv: with the real process a shell command and rm are only echoed", async () => {
    const scratchRoot = makeTempDir("omf-scratch-");
    const marker = join(makeTempDir("omf-marker-"), "marker");
    const keep = join(makeTempDir("omf-marker-"), "keep");
    writeFileSync(keep, "still here");
    const runner = createHostFixtureRunner({ scratchRoot });
    const session = await runner.openScenario({ kind: "fixture", id: "echo-everything" });
    for (const argv of [["/bin/sh", "-c", `touch ${marker}`], ["rm", "-f", keep]]) {
      expect(await session.runStep({ argv, stdin: "" }, DEFAULT_STEP_LIMITS)).toEqual({
        outcome: "exited",
        exit_code: 0,
        stdout: `${argv.join(" ")}\n`,
      });
    }
    await session.close();
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(keep)).toBe(true);
  });

  it("gives every step of a scenario one scratch directory, a new one to the next scenario, and removes it on close()", async () => {
    const scratchRoot = makeTempDir("omf-scratch-");
    const { exec, calls } = recordingExec();
    const runner = createHostFixtureRunner({ exec, scratchRoot });
    const first = await runner.openScenario({ kind: "fixture", id: "null-empty" });
    await first.runStep({ argv: ["a"], stdin: "one" }, DEFAULT_STEP_LIMITS);
    await first.runStep({ argv: ["b"], stdin: "two" }, DEFAULT_STEP_LIMITS);
    const second = await runner.openScenario({ kind: "fixture", id: "null-empty" });
    await second.runStep(STEP, DEFAULT_STEP_LIMITS);

    const [a, b, c] = calls.map((call) => call.options);
    expect(a?.cwd).toBe(b?.cwd);
    expect(c?.cwd).not.toBe(a?.cwd);
    expect(a?.cwd.startsWith(scratchRoot)).toBe(true);
    expect(existsSync(a?.cwd ?? "")).toBe(true);
    expect(Object.keys(a?.env ?? {}).sort()).toEqual(["HOME", "LC_ALL", "TMPDIR"]);
    expect(a?.env).toEqual({ LC_ALL: "C", HOME: a?.cwd, TMPDIR: a?.cwd });
    expect(a?.stdin).toBe("one");

    await first.close();
    expect(existsSync(a?.cwd ?? "")).toBe(false);
    expect(existsSync(c?.cwd ?? "")).toBe(true);
    await second.close();
    expect(readdirSync(scratchRoot)).toEqual([]);
  });

  it("has no other way to start a process: the adapter source imports no child_process and sets no shell option", () => {
    const source = readFileSync(new URL("../../src/scenario/fixtures.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/child_process|shell:|execSync|execFile|spawn\(/);
  });

  it("ships the fixtures: package.json lists fixtures/ and the directory holds exactly the allowlisted files", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { files: string[] };
    expect(pkg.files).toContain("fixtures");
    expect(readdirSync(fixturesDir()).sort()).toEqual(FIXTURE_ALLOWLIST.map((entry) => entry.file).sort());
  });
});
