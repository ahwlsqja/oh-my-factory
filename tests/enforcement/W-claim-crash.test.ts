import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claimStatus } from "../../src/work/claim.js";
import { harnessEnv } from "../helpers/cli.js";
import { waitForLine } from "../helpers/child.js";
import { waitDead } from "../helpers/process.js";
import { ledgerEvents, seedWorkItem, setupTick } from "../helpers/tick.js";
import { begin, itemDirOf, stateOf, wCode, wTrail } from "../helpers/w-flow.js";

const CHILD = fileURLToPath(new URL("../helpers/w-run-child.mjs", import.meta.url));

// Spec §8 and §11 rule 1: a run holds claim.lock for its whole length, a killed run releases nothing, and
// the next run recovers from the ledger and the stale lock alone. The child is a real process, killed with
// SIGKILL so no cleanup code runs. Its environment comes from `harnessEnv(home, {})`: `auditGoal` runs git,
// which reads ~/.gitconfig, so the child must never see the real HOME.
describe("W-claim-crash", () => {
  it("a live run blocks a second one; after SIGKILL the next run reclaims, resumes, and starts the item once", async () => {
    const fx = setupTick();
    const workId = seedWorkItem(fx, { title: "Crash in the middle" });
    const child = spawn(process.execPath, [CHILD, fx.repo, workId], {
      env: harnessEnv(fx.home, {}),
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => void (out += chunk.toString()));
    try {
      await waitForLine(child, "started r-");
      const childRunId = /started (r-\S+)/.exec(out)?.[1];
      expect(childRunId).toBeDefined();
      const childPid = child.pid as number;
      expect(stateOf(fx, workId)).toBe("in_progress");

      // While the child lives its claim is held: a second run is refused and writes nothing.
      expect(claimStatus(itemDirOf(fx, workId))).toMatchObject({ held: true, owner: { pid: childPid } });
      const before = ledgerEvents(fx).length;
      expect(wCode(() => begin(fx, workId))).toBe("claim_held");
      expect(ledgerEvents(fx).length).toBe(before);

      // Kill it and wait for the exit itself, so the pid cannot be mistaken for alive.
      const exited = new Promise<void>((done) => child.on("exit", () => done()));
      child.kill("SIGKILL");
      await exited;
      expect(await waitDead(childPid)).toBe(true);
      expect(claimStatus(itemDirOf(fx, workId))).toMatchObject({ held: false, stale: true });
      expect(wTrail(fx, workId).map((event) => event.type)).toEqual(["work.started"]);

      // The next run takes the stale claim over and says so in the ledger.
      const run = begin(fx, workId);
      expect(run.reclaimed).toEqual({ pid: childPid });
      expect(run.resumed).toBe(true);
      expect(run.runId).not.toBe(childRunId);
      const trail = wTrail(fx, workId);
      expect(trail.map((event) => event.type)).toEqual(["work.started", "work.claim_reclaimed", "work.resumed"]);
      expect(trail[0]?.payload.run_id).toBe(childRunId);
      expect(trail[1]?.payload).toMatchObject({ run_id: run.runId, previous_pid: childPid });
      expect(trail[2]?.payload.run_id).toBe(run.runId);
      expect(stateOf(fx, workId)).toBe("in_progress");
      run.abandon();
      expect(claimStatus(itemDirOf(fx, workId)).held).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  });
});
