import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writePrivateFileAtomic } from "../../src/core/private-fs.js";
import type { WorkState } from "../../src/work/types.js";
import {
  EVIDENCE_JSON,
  EVIDENCE_MD,
  type EvidenceDoc,
  buildEvidence,
  clearEvidence,
  readEvidence,
  trustedRecommendation,
  writeEvidence,
} from "../../src/work/evidence.js";
import { BLOCKED, FLAWED, GOAL, RUN, WORK, cleanBuild, fakeEvent, notRunBuild } from "../helpers/evidence-fixture.js";
import { makeTempDir } from "../helpers/tmp.js";

// Passes through to the real writer; a test can make one call throw.
vi.mock("../../src/core/private-fs.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/private-fs.js")>();
  return { ...real, writePrivateFileAtomic: vi.fn(real.writePrivateFileAtomic) };
});

const success = (): EvidenceDoc => buildEvidence(cleanBuild());
const human = (): EvidenceDoc => buildEvidence(cleanBuild({ injected_gates: ["GATE-2"] }));
const flawed = (): EvidenceDoc => buildEvidence(cleanBuild({ classification: FLAWED }));
const blocked = (): EvidenceDoc => buildEvidence(notRunBuild({ classification: BLOCKED }));

const front = (state: WorkState) => ({ work_id: WORK, goal_id: GOAL, state });
const OTHER_RUN = "r-20261014T091500Z-ffff";
const submitted = (recommendation: string, outcome = "success", run = RUN) =>
  fakeEvent(5, "work.submitted", { goal_id: GOAL, work_id: WORK, run_id: run, outcome, recommendation });
const failed = (outcome: string, run = RUN) =>
  fakeEvent(5, "work.failed", { goal_id: GOAL, work_id: WORK, run_id: run, outcome, reason_code: "gate_blocked" });
const parked = (outcome: string, run = RUN) =>
  fakeEvent(5, "work.parked", { goal_id: GOAL, work_id: WORK, run_id: run, outcome, reason_code: "gate_blocked" });

function placed(doc: EvidenceDoc): string {
  const dir = makeTempDir();
  writeEvidence(dir, doc);
  return dir;
}

/** Edits evidence.json in place, as a person with a text editor would. */
function tamper(dir: string, edit: (doc: Record<string, unknown>) => void): void {
  const file = join(dir, EVIDENCE_JSON);
  const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  edit(doc);
  writeFileSync(file, JSON.stringify(doc));
}

describe("evidence files", () => {
  it("writes md first and json last, private, with no temp file, and reads the document back", () => {
    const writer = vi.mocked(writePrivateFileAtomic);
    writer.mockClear();
    const doc = success();
    const dir = placed(doc);
    expect(writer.mock.calls.map((call) => basename(call[0]))).toEqual([EVIDENCE_MD, EVIDENCE_JSON]);
    for (const name of [EVIDENCE_MD, EVIDENCE_JSON]) expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).sort()).toEqual([EVIDENCE_JSON, EVIDENCE_MD]);
    expect(readEvidence(dir)).toEqual({ ok: true, doc });
    expect(() =>
      writeEvidence(makeTempDir(), { ...doc, recommendation: "merge_recommended", outcome: "blocked" }),
    ).toThrow("merge_recommended needs outcome success");
  });

  it("leaves no evidence.json, and no half pair, when the json write fails", async () => {
    const real = await vi.importActual<typeof import("../../src/core/private-fs.js")>("../../src/core/private-fs.js");
    vi.mocked(writePrivateFileAtomic)
      .mockImplementationOnce(real.writePrivateFileAtomic)
      .mockImplementationOnce(() => {
        throw new Error("disk full");
      });
    const dir = makeTempDir();
    expect(() => writeEvidence(dir, success())).toThrow("disk full");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("clears both files and temp leftovers, and tolerates a missing directory", () => {
    const dir = placed(success());
    writeFileSync(join(dir, "evidence.json.123.abcd.tmp"), "x");
    writeFileSync(join(dir, "item.md"), "keep");
    clearEvidence(dir);
    expect(readdirSync(dir)).toEqual(["item.md"]);
    expect(() => clearEvidence(join(dir, "missing"))).not.toThrow();
  });

  it("reports missing and invalid files", () => {
    const dir = makeTempDir();
    expect(readEvidence(dir)).toEqual({ ok: false, reason: "missing" });
    writeFileSync(join(dir, EVIDENCE_JSON), "{");
    expect(readEvidence(dir)).toEqual({ ok: false, reason: "invalid" });
    writeFileSync(join(dir, EVIDENCE_JSON), "{}");
    expect(readEvidence(dir)).toEqual({ ok: false, reason: "invalid" });
    const forged = placed(blocked());
    tamper(forged, (doc) => {
      doc["recommendation"] = "merge_recommended";
    });
    expect(readEvidence(forged)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("trustedRecommendation", () => {
  it("returns the ledger event's recommendation when file, event and item state agree", () => {
    expect(trustedRecommendation(placed(success()), [submitted("merge_recommended")], front("awaiting_review"))).toBe(
      "merge_recommended",
    );
    expect(trustedRecommendation(placed(human()), [submitted("human_needed")], front("awaiting_review"))).toBe(
      "human_needed",
    );
    expect(
      trustedRecommendation(placed(flawed()), [submitted("not_recommended", "flawed")], front("awaiting_review")),
    ).toBe("not_recommended");
    expect(trustedRecommendation(placed(flawed()), [failed("flawed")], front("failed"))).toBe("not_recommended");
    expect(trustedRecommendation(placed(blocked()), [parked("blocked")], front("ready"))).toBe("human_needed");
    expect(trustedRecommendation(placed(blocked()), [parked("blocked")], front("in_progress"))).toBe("human_needed");
  });

  it("does not trust a file whose only change is the recommendation", () => {
    const dir = placed(human());
    tamper(dir, (doc) => {
      doc["recommendation"] = "merge_recommended";
      doc["unverified_areas"] = [];
    });
    // the forged file is a valid document on its own: the ledger event is what stops it
    expect(readEvidence(dir).ok).toBe(true);
    expect(trustedRecommendation(dir, [submitted("human_needed")], front("awaiting_review"))).toBe("none");
  });

  const none: [string, () => { dir: string; events: ReturnType<typeof fakeEvent>[]; state: WorkState }][] = [
    [
      "no evidence file",
      () => ({ dir: makeTempDir(), events: [submitted("merge_recommended")], state: "awaiting_review" }),
    ],
    [
      "a hand-written merge_recommended with no work.submitted",
      () => ({ dir: placed(success()), events: [], state: "awaiting_review" }),
    ],
    [
      "a work.submitted from a different run",
      () => ({
        dir: placed(success()),
        events: [submitted("merge_recommended", "success", OTHER_RUN)],
        state: "awaiting_review",
      }),
    ],
    [
      "an outcome that differs from the event",
      () => ({ dir: placed(flawed()), events: [submitted("not_recommended", "success")], state: "awaiting_review" }),
    ],
    [
      "an item that is no longer awaiting_review",
      () => ({ dir: placed(success()), events: [submitted("merge_recommended")], state: "done" }),
    ],
    [
      "a failed event while the item is not failed",
      () => ({ dir: placed(flawed()), events: [failed("flawed")], state: "awaiting_review" }),
    ],
    [
      "a parked event while the item is failed",
      () => ({ dir: placed(blocked()), events: [parked("blocked")], state: "failed" }),
    ],
    [
      "an event from the wrong actor",
      () => ({
        dir: placed(success()),
        events: [
          fakeEvent(
            5,
            "work.submitted",
            { goal_id: GOAL, work_id: WORK, run_id: RUN, outcome: "success", recommendation: "merge_recommended" },
            "human:dev@example.invalid",
          ),
        ],
        state: "awaiting_review",
      }),
    ],
    [
      "a started event as the last state event",
      () => ({
        dir: placed(success()),
        events: [fakeEvent(5, "work.started", { goal_id: GOAL, work_id: WORK, run_id: RUN, from: "ready" })],
        state: "in_progress",
      }),
    ],
  ];
  for (const [name, setup] of none) {
    it(`is none for ${name}`, () => {
      const { dir, events, state } = setup();
      expect(trustedRecommendation(dir, events, front(state))).toBe("none");
    });
  }

  it("never returns merge_recommended for a failed or parked file", () => {
    const dir = placed(blocked());
    tamper(dir, (doc) => {
      doc["recommendation"] = "merge_recommended";
    });
    expect(trustedRecommendation(dir, [parked("blocked")], front("ready"))).toBe("none");
  });
});
