import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  clearImplementerRequest,
  implementerRequestFile,
  readImplementerRequest,
  writeImplementerRequest,
} from "../../src/decision/needs-human.js";
import { readBlob } from "../../src/git/ops.js";
import { readConflictRequest, requestPath } from "../../src/implementer/request.js";
import { buildChain, WORK_ID } from "../helpers/implementer-chain.js";
import { finished, injectedGates, setupLine } from "../helpers/line-enforce.js";

// The implementer stops to ask a person: a committed request.json ends the run blocked (not manual) at J2, with a record
// that names the kind and the paths that exist in the base tree and never the note, and the item accepts a rerun.
const NOTE = "planted-note-7731 the failing test contradicts the spec";
const NOW = new Date("2026-10-16T09:00:00.000Z");

describe("W-implementer-request-j2", () => {
  it("a committed request becomes blocked implementer_request, a record, a J2 handoff and a rerun that works", async () => {
    const request = JSON.stringify({ kind: "test_conflict", paths: ["tests/a.test.ts", "nope.ts"], note: NOTE });
    const chain = await buildChain({
      base: { "tests/a.test.ts": "t\n", "SPEC.md": "s\n" },
      work: [{ [requestPath(WORK_ID)]: request }],
    });
    // Positive control: the note really is in the quarantine.
    const raw = await readBlob(chain.quarantine, chain.head, requestPath(WORK_ID), 4096);
    expect(raw?.toString("utf8")).toContain("planted-note-7731");
    const read = await readConflictRequest(chain.quarantine, WORK_ID, chain.head, chain.basePaths);
    if (read.status !== "raised") throw new Error("expected a raised request");

    const line = setupLine();
    const first = await line.exec({
      gates: injectedGates(),
      scripts: {
        S3: () => {
          writeImplementerRequest(line.itemDir, line.f.scope, read.request, NOW);
          return { kind: "blocked", reason_code: "implementer_request" };
        },
      },
    });
    const done = finished(first.result);
    expect(done).toMatchObject({
      outcome: "blocked",
      reason_code: "implementer_request",
      disposition: { action: "park" },
    });
    expect(line.state()).toBe("in_progress");
    expect(done.handoff?.decision_required).toEqual({
      j: "J2",
      question: "Which answer do you give to the implementer's request?",
      options: [`omf decide show ${line.workId}`, `omf veto ${line.workId}`, `after M3h: omf run ${line.workId}`],
    });
    expect(readImplementerRequest(line.itemDir)).toMatchObject({ kind: "test_conflict", paths: ["tests/a.test.ts"] });
    for (const text of [
      readFileSync(implementerRequestFile(line.itemDir), "utf8"),
      readFileSync(line.f.fx.ledger.file, "utf8"),
      JSON.stringify(done.handoff),
      JSON.stringify(done.evidence),
    ]) {
      expect(text).not.toContain("planted-note");
    }

    // A rerun is accepted (the item was parked blocked, not manual), and the next S3 clears the record.
    const second = await line.exec({
      gates: injectedGates(),
      scripts: {
        S3: () => {
          clearImplementerRequest(line.itemDir);
          return { kind: "ok" };
        },
      },
    });
    expect(second.result.kind).toBe("finished");
    expect(existsSync(implementerRequestFile(line.itemDir))).toBe(false);
    expect(line.types()).toContain("work.resumed");
  });
});
