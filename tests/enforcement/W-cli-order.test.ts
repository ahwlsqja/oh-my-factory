import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runS2ThenGate2 } from "../../src/seal/station.js";
import { omf } from "../helpers/cli.js";
import { addOpen, resolveOpen } from "../helpers/decision-fixture.js";
import { setupLine } from "../helpers/line.js";
import { passDeps, ROUND2, setupLine as setupSealLine, writeYaml } from "../helpers/line-fixture.js";

// covers: S5.0.run-refuses-out-of-order
// M3h: the verbs refuse out of order and name the missing gate (spec §5.0). A refusal writes nothing, so the ledger
// is byte-identical afterwards. Exit 3 is "a person is needed" (GATE-1 open), exit 2 is "the command cannot run past this".

describe("W-cli-order", () => {
  it("omf run before GATE-1 passes exits 3 and names GATE-1", () => {
    const l = setupLine({ interface: false });
    const before = readFileSync(l.fx.ledger.file);
    const out = omf(["run", l.workId], l.fx.repo, l.fx.home);
    expect(out.code, out.stderr).toBe(3);
    expect(out.stderr).toContain("GATE-1 is not passing (J2)");
    expect(out.stderr).toContain(`omf decide lint ${l.workId}`);
    expect(readFileSync(l.fx.ledger.file).equals(before)).toBe(true);
  });

  it("omf run with GATE-1 passing and no seal exits 2 and names GATE-2 and omf seal", () => {
    const l = setupLine();
    const before = readFileSync(l.fx.ledger.file);
    const out = omf(["run", l.workId], l.fx.repo, l.fx.home);
    expect(out.code, out.stderr).toBe(2);
    expect(out.stderr).toContain("GATE-2 has no passing seal for the current decisions");
    expect(out.stderr).toContain(`omf seal ${l.workId}`);
    expect(readFileSync(l.fx.ledger.file).equals(before)).toBe(true);
  });

  it("omf run on an unknown item exits 2 and names the id", () => {
    const l = setupLine();
    const before = readFileSync(l.fx.ledger.file);
    const out = omf(["run", "w-ffffffffffff"], l.fx.repo, l.fx.home);
    expect(out.code, out.stderr).toBe(2);
    expect(out.stderr).toContain("unknown work item w-ffffffffffff");
    expect(out.stdout).toBe("");
    expect(readFileSync(l.fx.ledger.file).equals(before)).toBe(true);
  });

  it("a malformed id with control characters is refused with exit 2 and printed escaped, never raw", () => {
    const l = setupLine();
    const before = readFileSync(l.fx.ledger.file);
    const out = omf(["run", "w-\u001b[31mred\u0007"], l.fx.repo, l.fx.home);
    expect(out.code, out.stderr).toBe(2);
    expect(out.stderr).toContain("invalid work id w-\\u001b[31mred\\u0007");
    expect(out.stderr).not.toContain("\u001b");
    expect(out.stderr).not.toContain("\u0007");
    expect(readFileSync(l.fx.ledger.file).equals(before)).toBe(true);
  });

  it("an item.md that cannot be read as a work item exits 2 with its reason, in every verb, and writes nothing", () => {
    const l = setupLine();
    writeFileSync(join(l.itemDir, "item.md"), "no front matter here\n");
    const before = readFileSync(l.fx.ledger.file);
    for (const verb of ["run", "report"]) {
      const out = omf([verb, l.workId], l.fx.repo, l.fx.home);
      expect(out.code, `${verb}: ${out.stderr}`).toBe(2);
      expect(out.stderr, verb).toContain("item.md must start with a --- front matter block");
      expect(out.stdout, verb).toBe("");
    }
    expect(readFileSync(l.fx.ledger.file).equals(before)).toBe(true);
  });

  it("a standing seal passes the order check and warns first; a decision change refuses it again, naming GATE-2", async () => {
    const l = setupSealLine();
    const { workId } = l.f;
    const { repo, home, ledger } = l.f.fx;
    const sealed = await runS2ThenGate2(passDeps(l, writeYaml(l, "round2.yaml", ROUND2)));
    expect(sealed.status).toBe("pass");

    // The project has no judge.docker_context, so a run that got past the order check stops at the missing runtime. The
    // warning about the unmeasured author comes first, before anything is opened or run.
    const before = readFileSync(ledger.file);
    const standing = omf(["run", workId], repo, home);
    expect(standing.code, standing.stderr).toBe(2);
    expect(standing.stderr).not.toContain("GATE-2");
    expect(standing.stderr).toContain("warning: the author stage is unmeasured");
    expect(standing.stderr.indexOf("warning:")).toBeLessThan(standing.stderr.indexOf("judge.docker_context"));
    expect(readFileSync(ledger.file).equals(before)).toBe(true);

    addOpen(l.f, "d-extra");
    resolveOpen(l.f, "d-extra");
    const changed = omf(["run", workId], repo, home);
    expect(changed.code, changed.stderr).toBe(2);
    expect(changed.stderr).toContain("GATE-2 has no passing seal for the current decisions");
    expect(changed.stderr).toContain(`omf seal ${workId}`);
  });

  it("a passing GATE-2 record that names another seal id or another set hash is not a standing seal", async () => {
    const l = setupSealLine();
    const { workId } = l.f;
    const { repo, home, ledger } = l.f.fx;
    const sealed = await runS2ThenGate2(passDeps(l, writeYaml(l, "round2.yaml", ROUND2)));
    expect(sealed.status).toBe("pass");
    const gate2 = ledger
      .readVerified()
      .filter((event) => event.type === "gate2.evaluated")
      .at(-1);
    expect(gate2?.payload.status).toBe("pass");
    const mismatches: Array<[string, Record<string, unknown>]> = [
      ["seal id", { seal_id: `seal-${"e".repeat(16)}` }],
      ["set hash", { set_sha256: "e".repeat(64) }],
    ];
    for (const [name, change] of mismatches) {
      ledger.append({ actor: "omf", type: "gate2.evaluated", payload: { ...gate2?.payload, ...change } });
      const out = omf(["run", workId], repo, home);
      expect(out.code, `${name}: ${out.stderr}`).toBe(2);
      expect(out.stderr, name).toContain("GATE-2 has no passing seal for the current decisions");
      expect(out.stderr, name).toContain(`omf seal ${workId}`);
      // Restore the matching record as the latest one before the next variant.
      ledger.append({ actor: "omf", type: "gate2.evaluated", payload: { ...gate2?.payload } });
    }
    const again = omf(["run", workId], repo, home);
    expect(again.stderr).not.toContain("GATE-2");
  });

  it("omf report before any run exits 2 and names S7", () => {
    const l = setupLine();
    const before = readFileSync(l.fx.ledger.file);
    const out = omf(["report", l.workId], l.fx.repo, l.fx.home);
    expect(out.code, out.stderr).toBe(2);
    expect(out.stderr).toContain("S7");
    expect(out.stderr).toContain(`omf run ${l.workId}`);
    expect(out.stdout).toBe("");
    expect(readFileSync(l.fx.ledger.file).equals(before)).toBe(true);
  });
});
