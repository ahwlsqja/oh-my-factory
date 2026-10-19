import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readEvidence, renderEvidenceMd } from "../../src/work/evidence.js";
import { omf } from "../helpers/cli.js";
import { cleanStations, finished, passGates, setupLine, station } from "../helpers/line.js";

// covers: S5.0.run-report-idempotent
// M3h-D17: a second `omf run` on an item that already ran and any number of `omf report` calls change nothing, and a report
// prints only what the verified ledger vouches for, rendered from the validated evidence.json (never the bytes of evidence.md).
const JUDGE_LINE = "judge: deterministic checks only (model judge not available)";

/**
 * `unmeasured`: the fixture ledger holds no isolation measurements, so "unmeasured" is the one level it supports and
 * the run parks. `report` must print such a run, and must refuse the same file once it claims a higher level.
 */
async function reviewed(options: { unmeasured?: boolean } = {}) {
  const l = setupLine();
  const s5 = station("S5", (ctx) => {
    if (options.unmeasured === true) ctx.inputs.isolation_level = "unmeasured";
    return { kind: "ok" };
  });
  const result = await l.go({ gates: passGates(), stations: cleanStations({ override: { S5: s5 } }) });
  if (options.unmeasured !== true) finished(result);
  if (options.unmeasured !== true) expect(l.stateOf()).toBe("awaiting_review");
  const read = readEvidence(l.itemDir);
  if (!read.ok) throw new Error("the finished line wrote no evidence");
  const snapshot = (): { ledger: string; files: string[]; evidence: string } => ({
    ledger: readFileSync(l.fx.ledger.file, "utf8"),
    files: l.files(),
    evidence: readFileSync(join(l.itemDir, "evidence.json"), "utf8"),
  });
  return { l, doc: read.doc, snapshot };
}

describe("W-cli-idempotent (run and report)", () => {
  it("omf run on an item that already ran says so, exits 0 and changes nothing", async () => {
    const { l, snapshot } = await reviewed();
    const before = snapshot();
    const out = omf(["run", l.workId], l.fx.repo, l.fx.home);
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).toContain(`already ran and awaits review; see omf report ${l.workId}`);
    expect(snapshot()).toEqual(before);
  });

  it("omf report prints the evidence rendered from evidence.json, twice with the same bytes, and writes nothing", async () => {
    const { l, doc, snapshot } = await reviewed({ unmeasured: true });
    const before = snapshot();
    const first = omf(["report", l.workId], l.fx.repo, l.fx.home);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout.startsWith(renderEvidenceMd(doc))).toBe(true);
    expect(first.stdout).toContain(JUDGE_LINE);
    expect(first.stderr).toBe("");
    const second = omf(["report", l.workId], l.fx.repo, l.fx.home);
    expect(second.stdout).toBe(first.stdout);
    expect(snapshot()).toEqual(before);
  });

  it("a hand-edited evidence.md is never printed", async () => {
    const { l, doc } = await reviewed({ unmeasured: true });
    writeFileSync(join(l.itemDir, "evidence.md"), "planted-md-8842\n- isolation level: L2\n");
    const out = omf(["report", l.workId], l.fx.repo, l.fx.home);
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).not.toContain("planted-md-8842");
    expect(out.stdout.startsWith(renderEvidenceMd(doc))).toBe(true);
    expect(out.stderr).toContain("evidence.md differs from evidence.json");
  });

  it("a hand-edited evidence.json is untrusted: exit 2, nothing printed", async () => {
    const { l } = await reviewed();
    const file = join(l.itemDir, "evidence.json");
    const edited = { ...JSON.parse(readFileSync(file, "utf8")), recommendation: "merge_recommended" };
    writeFileSync(file, JSON.stringify(edited, null, 2));
    const out = omf(["report", l.workId], l.fx.repo, l.fx.home);
    expect(out.code, out.stderr).toBe(2);
    expect(out.stderr).toContain("no trusted evidence");
    expect(out.stdout).toBe("");
  });

  it("an evidence.json that claims a higher isolation level than the ledger measured is untrusted", async () => {
    const { l, doc } = await reviewed({ unmeasured: true });
    expect(doc.isolation_level).toBe("unmeasured");
    const edited = { ...doc, isolation_level: "L2" } as typeof doc;
    writeFileSync(join(l.itemDir, "evidence.json"), JSON.stringify(edited, null, 2));
    writeFileSync(join(l.itemDir, "evidence.md"), renderEvidenceMd(edited));
    const out = omf(["report", l.workId], l.fx.repo, l.fx.home);
    expect(out.code, out.stderr).toBe(2);
    expect(out.stderr).toContain("no trusted evidence");
    expect(out.stdout).toBe("");
  });
});
