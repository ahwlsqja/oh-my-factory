import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { GitFixture } from "../helpers/git-fixture.js";
import { realTempDir } from "../helpers/ops-fixture.js";
import { waitDead, waitForPids } from "../helpers/process.js";
import { calcFixture, snapshot } from "../helpers/prove-fixture.js";
import { sweepOrphanCopies } from "../helpers/temp-work-copy.js";
import { makeTempDir } from "../helpers/tmp.js";

const CHILD = fileURLToPath(new URL("../helpers/prove-child.mjs", import.meta.url));
const LIFECYCLE_CHILD = fileURLToPath(new URL("../helpers/lifecycle-child.mjs", import.meta.url));

// Spec §5.4, M3e-D8: "restore" is "discard the copy". prove-test never changes the shared tree or the quarantine
// repository, and an interruption leaves nothing behind that a later sweep cannot remove: SIGTERM removes the copies
// before the process ends (with the signal status), SIGKILL leaves orphans for `sweepOrphanCopies`.

interface Running {
  fx: GitFixture;
  parent: string;
  before: string;
  sleeper: number;
  ended: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  signal(name: NodeJS.Signals): void;
}

async function startChild(): Promise<Running> {
  const fx = calcFixture();
  const parent = realTempDir("omf-prove-sig-");
  const marker = join(makeTempDir("omf-marker-"), "sleeper.pid");
  const before = snapshot(fx);
  const child = spawn(process.execPath, [CHILD, parent, fx.quarantine.gitDir, fx.base, fx.head, marker], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const [sleeper] = await waitForPids(marker, 30_000); // the baseline test command is running inside copy A
  return { fx, parent, before, sleeper: sleeper as number, ended, signal: (name) => child.kill(name) };
}

const copyDirs = (parent: string): string[] => readdirSync(parent).filter((name) => name.startsWith("wc-"));

describe("W-prove-test-restores", () => {
  it("SIGTERM in the middle of the baseline run removes the copies, keeps the signal status and leaves the shared repository byte-identical", async () => {
    const run = await startChild();
    expect(copyDirs(run.parent)).toHaveLength(2); // copy A and its scratch holder exist while the test runs
    run.signal("SIGTERM");
    expect(await run.ended).toEqual({ code: null, signal: "SIGTERM" });
    expect(await waitDead(run.sleeper)).toBe(true); // the command's process group was killed too
    expect(copyDirs(run.parent)).toEqual([]);
    expect(snapshot(run.fx)).toBe(run.before);
  });

  it("SIGKILL leaves the orphan copies until sweepOrphanCopies removes them, and the shared repository is still byte-identical", async () => {
    const run = await startChild();
    run.signal("SIGKILL");
    expect(await run.ended).toEqual({ code: null, signal: "SIGKILL" });
    try {
      expect(copyDirs(run.parent)).toHaveLength(2); // a handler cannot run on SIGKILL
      expect(snapshot(run.fx)).toBe(run.before);
      expect(await sweepOrphanCopies(run.parent)).toBe(2);
      expect(copyDirs(run.parent)).toEqual([]);
    } finally {
      try {
        process.kill(-run.sleeper, "SIGKILL"); // the sleeping test command outlives its killed parent
      } catch {
        // already gone
      }
    }
    expect(await waitDead(run.sleeper)).toBe(true);
  });
});

// The same property for container copies (M3f): a signal in the middle of the baseline run removes the container by name and the
// staging directory before the process ends with the signal status, and the shared repository is untouched.
describe("W-prove-test-restores, container copies", () => {
  it("SIGTERM in the middle of the baseline run removes the container and the staging directory and leaves the repository byte-identical", async () => {
    const fx = calcFixture();
    const dir = realTempDir("omf-prove-ctr-");
    const log = join(dir, "log");
    const marker = join(dir, "ready");
    const stageRoot = join(dir, "judge");
    const before = snapshot(fx);
    const child = spawn(
      process.execPath,
      [LIFECYCLE_CHILD, "prove", log, marker, stageRoot, fx.quarantine.gitDir, fx.base, fx.head],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    await waitForPids(marker, 15_000); // the baseline test command is running inside the container of copy A
    expect(readdirSync(stageRoot).filter((name) => name.startsWith("wc-"))).toHaveLength(1);
    child.kill("SIGTERM");
    expect(await ended).toEqual({ code: null, signal: "SIGTERM" });
    const lines = readFileSync(log, "utf8").trim().split("\n");
    const created = lines.filter((line) => line.startsWith("create ")).map((line) => line.slice("create ".length));
    const removed = new Set(
      lines.filter((line) => /^(remove|removeAllSync) /.test(line)).map((line) => line.replace(/^\S+ /, "")),
    );
    expect(created).toHaveLength(1);
    expect(created.every((name) => removed.has(name))).toBe(true);
    expect(readdirSync(stageRoot).filter((name) => name.startsWith("wc-"))).toEqual([]);
    expect(snapshot(fx)).toBe(before);
  });
});
