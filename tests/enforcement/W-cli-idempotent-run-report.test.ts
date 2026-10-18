import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readEvidence, renderEvidenceMd } from "../../src/work/evidence.js";
import { omf } from "../helpers/cli.js";
import { finished, passGates, setupLine } from "../helpers/line.js";

// covers: S5.0.run-report-idempotent
// M3h-D17: a second `omf run` on an item that already ran and any number of `omf report` calls change nothing, and a report
// prints only what the verified ledger vouches for, rendered from the validated evidence.json (never the bytes of evidence.md).
const JUDGE_LINE = "judge: deterministic checks only (model judge not available)";

async function reviewed() {
  const l = setupLine();
  finished(await l.go({ gates: passGates() }));
  expect(l.stateOf()).toBe("awaiting_review");
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
    const { l, doc, snapshot } = await reviewed();
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
    const { l, doc } = await reviewed();
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
});
