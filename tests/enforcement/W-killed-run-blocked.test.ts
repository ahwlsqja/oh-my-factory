import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validate } from "../../src/core/schema.js";
import { claimStatus } from "../../src/work/claim.js";
import { EVIDENCE_JSON, EVIDENCE_MD, readEvidence } from "../../src/work/evidence.js";
import { type HandoffRecord, handoffFile, owedPredecessors } from "../../src/work/handoff.js";
import { runVeto } from "../../src/cli/work.js";
import { harnessEnv } from "../helpers/cli.js";
import { waitForLine } from "../helpers/child.js";
import { finished, injectedGates, setupLine } from "../helpers/line-enforce.js";
import { waitDead } from "../helpers/process.js";
import { readTree } from "../helpers/tree.js";

const CHILD = fileURLToPath(new URL("../helpers/line-kill-child.mjs", import.meta.url));

// Spec §8 and §6.3: a run killed mid-station leaves a stale claim and no outcome file, never a half-written
// one. The next entry records the kill as `blocked` with a handoff (written once), clears whatever evidence
// is lying around and goes on from S1 under the ledger's round count. The child is a real process killed
// with SIGKILL, so no cleanup code runs; its environment comes from `harnessEnv(home, {})` because
// `auditGoal` runs git, which reads ~/.gitconfig.
describe("W-killed-run-blocked", () => {
  it("leaves no evidence, is reclaimed by the next entry, and gets one killed_predecessor handoff", async () => {
    const line = setupLine();
    const child = spawn(process.execPath, [CHILD, line.f.fx.repo, line.workId], {
      env: harnessEnv(line.f.fx.home, {}),
      stdio: ["ignore", "pipe", "inherit"],
    });
    try {
      await waitForLine(child, "in S3");
      const childPid = child.pid as number;

      // While it lives: the claim is held, a second run is refused, and nothing outcome-like exists.
      expect(claimStatus(line.itemDir)).toMatchObject({ held: true, owner: { pid: childPid } });
      expect(existsSync(join(line.itemDir, EVIDENCE_JSON))).toBe(false);
      expect(existsSync(join(line.itemDir, EVIDENCE_MD))).toBe(false);
      expect([...readTree(line.itemDir).keys()].filter((name) => name.endsWith(".tmp"))).toEqual([]);
      await expect(line.exec({ gates: injectedGates() })).rejects.toMatchObject({ code: "claim_held" });
      expect(line.rounds()).toEqual([1]);

      const exited = new Promise<void>((done) => child.on("exit", () => done()));
      child.kill("SIGKILL");
      await exited;
      expect(await waitDead(childPid)).toBe(true);
      expect(claimStatus(line.itemDir)).toMatchObject({ held: false, stale: true });

      // A stale file from anywhere is never current: the next entry clears it.
      writeFileSync(join(line.itemDir, EVIDENCE_JSON), "{}");
      writeFileSync(join(line.itemDir, EVIDENCE_MD), "stale\n");

      const { result, ran } = await line.exec({ gates: injectedGates() });
      const done = finished(result);
      expect(ran[0]).toBe("S1");
      expect(line.rounds()).toEqual([1, 2]);
      expect(readEvidence(line.itemDir)).toMatchObject({ ok: true, doc: { run_id: done.run_id } });
      expect(readFileSync(join(line.itemDir, EVIDENCE_MD), "utf8")).not.toContain("stale");

      const reclaimed = line.events().filter((e) => e.type === "work.claim_reclaimed" && e.payload.work_id === line.workId);
      expect(reclaimed).toHaveLength(1);
      const record = JSON.parse(readFileSync(handoffFile(line.itemDir, done.run_id, "killed_predecessor"), "utf8")) as HandoffRecord;
      expect(validate("handoff.schema.json", record)).toEqual({ ok: true });
      expect(record).toMatchObject({
        kind: "killed_predecessor",
        outcome: "blocked",
        reason_code: "run_killed",
        run_id: done.run_id,
        predecessor_seq: reclaimed[0]?.seq,
        decision_required: { j: "J6" },
        resume: "not_available_until_m4",
      });
      expect(record.ran.map((entry) => entry.node)).toEqual(["S3"]);
      expect(owedPredecessors(line.itemDir, line.events(), line.workId)).toEqual([]);
      expect(readdirSync(join(line.itemDir, "handoffs")).filter((name) => name.endsWith(".predecessor.json"))).toHaveLength(1);
    } finally {
      child.kill("SIGKILL");
    }
  });

  // The first test cannot tell the entry clear from the atomic write that replaces both files on success, so
  // this one stops the entry before it writes evidence: a veto during S1 aborts at the recheck before GATE-1.
  it("clears planted evidence and temp files on entry even when the run then aborts before writing its own", async () => {
    const line = setupLine();
    const planted = [EVIDENCE_JSON, EVIDENCE_MD, "evidence.json.1.dead.tmp"];
    for (const name of planted) writeFileSync(join(line.itemDir, name), "stale\n");

    const { result } = await line.exec({
      gates: injectedGates(),
      scripts: {
        S1: () => {
          runVeto(line.location, line.workId, "human:dev@example.com", "stop");
          return { kind: "ok" };
        },
      },
    });

    expect(result).toMatchObject({ kind: "aborted", reason: "vetoed" });
    for (const name of planted) expect(existsSync(join(line.itemDir, name))).toBe(false);
  });
});
