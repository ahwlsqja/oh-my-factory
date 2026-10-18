import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sealFailedEvent } from "../../src/scenario/events.js";
import { buildSealPrompt } from "../../src/seal/prompt.js";
import { type SealedPass, runSealStage, sealLockFile } from "../../src/seal/seal.js";
import { runS2Station } from "../../src/seal/station.js";
import {
  authoredDoc,
  commandAuthor,
  countingSession,
  depsFor,
  sealFixture,
  startWork,
  stored,
} from "../helpers/seal-fixture.js";
import { makeTempDir } from "../helpers/tmp.js";

/** A stub author that prints one train and one test scenario, so the stage reaches `seal.completed`. */
function printingAuthor() {
  const dir = makeTempDir("omf-rec-");
  const fixture = join(dir, "authored.yaml");
  writeFileSync(fixture, `${authoredDoc({ split: "train" })}\n---\n${authoredDoc({ split: "test" })}\n`);
  return commandAuthor("print", dir, fixture);
}

describe("runSealStage hands the session its closed inputs", () => {
  it("passes the SealInputs the prompt was built from", async () => {
    const s = sealFixture();
    const session = countingSession();
    await runSealStage(depsFor(s, session));
    const call = session.calls[0];
    expect(call?.inputs).toBeDefined();
    if (call === undefined) throw new Error("the session was not called");
    expect(buildSealPrompt(call.inputs)).toBe(call.prompt);
    expect(Object.keys(call.inputs).sort()).toEqual([
      "contract",
      "intent",
      "linkable_decision_ids",
      "quantitative_decision_ids",
      "spec",
    ]);
  });
});

describe("SealDeps.afterSealCompleted", () => {
  it("is called once, after seal.completed is in the ledger and while seal.lock is held", async () => {
    const s = sealFixture();
    const told: Array<{ sealed: SealedPass; lockHeld: boolean; inLedger: boolean }> = [];
    const result = stored(
      await runSealStage(
        depsFor(s, printingAuthor(), {
          afterSealCompleted: (sealed) => {
            const completed = s.f.fx.ledger.readVerified().filter((event) => event.type === "seal.completed");
            told.push({
              sealed,
              lockHeld: existsSync(sealLockFile(s.f.item.dir)),
              inLedger: completed.some((event) => event.seq === sealed.seq && event.payload.seal_id === sealed.seal_id),
            });
          },
        }),
      ),
    );
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ lockHeld: true, inLedger: true });
    expect(told[0]?.sealed).toMatchObject({ seal_id: result.seal_id, set_sha256: result.set_sha256, round: 1 });
    expect(existsSync(sealLockFile(s.f.item.dir))).toBe(false);
  });

  it("is not called when the author fails, GATE-1 blocks, or a started item reuses its seal", async () => {
    const told: SealedPass[] = [];
    const hook = { afterSealCompleted: (sealed: SealedPass): void => void told.push(sealed) };
    expect((await runSealStage(depsFor(sealFixture(), countingSession(), hook))).status).toBe("failed");
    expect((await runSealStage(depsFor(sealFixture("open"), countingSession(), hook))).status).toBe("blocked_gate1");
    const reused = sealFixture();
    stored(await runSealStage(depsFor(reused, printingAuthor())));
    startWork(reused);
    expect((await runSealStage(depsFor(reused, countingSession(), hook))).status).toBe("reused");
    expect(told).toHaveLength(0);
  });

  it("lets a throwing hook end the stage with its error, leaving the seal completed and the lock released", async () => {
    const s = sealFixture();
    const throwing = {
      afterSealCompleted: () => {
        throw new Error("record failed");
      },
    };
    await expect(runSealStage(depsFor(s, printingAuthor(), throwing))).rejects.toThrow("record failed");
    expect(s.f.fx.ledger.readVerified().filter((event) => event.type === "seal.completed")).toHaveLength(1);
    expect(existsSync(sealLockFile(s.f.item.dir))).toBe(false);
  });
});

describe("failure codes of a container author", () => {
  const CODES = ["not_golden", "container_failed", "credential_in_output"] as const;

  it.each(CODES)("%s is a valid seal.failed code", (code) => {
    const scope = { goal_id: "g-checkout", work_id: "w-0123456789ab" };
    expect(sealFailedEvent(scope, { round: 1, code, duration_ms: 5 })).toMatchObject({ payload: { code } });
  });

  it.each(CODES)("%s stops the line at J7 and is recorded once, never retried", async (code) => {
    const s = sealFixture();
    const out = await runS2Station(depsFor(s, countingSession({ ok: false, code, durationMs: 3 })));
    expect(out.step).toEqual({ next: "stop", route: "J7", code });
    expect(s.f.fx.ledger.readVerified().filter((event) => event.type === "seal.failed")).toHaveLength(1);
  });
});
