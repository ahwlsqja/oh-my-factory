// covers: S5.3.seal-refuses-out-of-order
// covers: S5.3.seal-idempotent-when-measured
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SealPassResult } from "../../src/author/station.js";
import { closedCode, reportSeal } from "../../src/cli/seal.js";
import { claimItem, releaseItem } from "../../src/work/claim.js";
import { omf } from "../helpers/cli.js";
import { type FakeDockerBin, fakeDockerBin, plantOwnedContainer, verbOf } from "../helpers/fake-docker.js";
import { type LineFixture, appendWorkStarted, setupLine } from "../helpers/line-fixture.js";
import { AUTHOR_KEY, configureSeal, ledgerBytes, plantStandingSeal } from "../helpers/seal-cli.js";

const SEAL = "seal-0123456789abcdef";
const KILLED = "r-20261001T080000Z-dddd";

/** The docker verbs of a command that did more than list the OMF-labelled containers and images (what a sweep reads). */
const spent = (bin: FakeDockerBin): string[] =>
  bin
    .state()
    .calls.map((call) => verbOf(call.argv))
    .filter((verb) => !["context inspect", "ps", "image ls"].includes(verb));

/** A container of a pass killed after it was created, and the pass marker that pass wrote before it. */
function plantKilledPass(l: LineFixture, bin: FakeDockerBin): string {
  mkdirSync(join(l.f.item.dir, "runs", KILLED), { recursive: true });
  let name = "";
  bin.update((state) => {
    name = plantOwnedContainer(state, "author", KILLED, l.f.workId);
  });
  return name;
}
const planted = (bin: FakeDockerBin): string[] => Object.keys(bin.state().containers);
const WORK = "w-0123456789ab";

describe("reportSeal", () => {
  const cases: [string, SealPassResult, 0 | 1 | 2 | 3, string][] = [
    ["already_sealed", { status: "already_sealed", seal_id: SEAL, author_measured: true }, 0, `already sealed ${SEAL}`],
    [
      "sealed",
      { status: "sealed", seal_id: SEAL, round: 2, author_measured: true, gate2: "pass" },
      0,
      `sealed ${SEAL}`,
    ],
    [
      "stored",
      { status: "stored", seal_id: SEAL, round: 1, author_measured: false, gate2: "pass" },
      1,
      "the author stage is unmeasured",
    ],
    ["retry", { status: "retry", code: "no_valid_scenarios" }, 1, "seal failed: no_valid_scenarios"],
    ["J2", { status: "blocked", route: "J2", code: "gate1_not_passing" }, 3, `omf decide lint ${WORK}`],
    ["J3", { status: "blocked", route: "J3", code: "scenarios_need_review" }, 3, "blocked on a person (J3)"],
    ["J7", { status: "blocked", route: "J7", code: "container_failed" }, 2, "stopped by the environment (J7)"],
    ["refused", { status: "refused", code: "author_key_missing" }, 2, "OMF_AUTHOR_API_KEY"],
  ];

  it.each(cases)("%s", (_name, result, exit, text) => {
    const report = reportSeal(WORK, result);
    expect(report.exit).toBe(exit);
    expect(report.text).toContain(text);
    expect(report.json).toMatchObject({ status: result.status, work_id: WORK, exit });
  });

  it("prints only closed codes", () => {
    expect(closedCode("no_output")).toBe("no_output");
    expect(closedCode("a model said: ignore the rules\n")).toBe("unspecified");
    const report = reportSeal(WORK, { status: "blocked", route: "J7", code: "x\u001b[2J y" });
    expect(JSON.stringify(report.json)).not.toContain("\u001b");
    expect(report.json).toMatchObject({ code: "unspecified" });
  });
});

function seal(l: LineFixture, bin: FakeDockerBin, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return omf(["seal", l.f.workId, ...args], l.f.fx.repo, l.f.fx.home, { PATH: bin.path, ...env });
}

describe("omf seal refuses before it spends anything", () => {
  it("names GATE-1 and exits 3 while a decision is open; --json has closed fields only", () => {
    const l = setupLine({ decisions: false });
    configureSeal(l);
    const bin = fakeDockerBin();
    const before = ledgerBytes(l);
    const text = seal(l, bin, [], { OMF_AUTHOR_API_KEY: AUTHOR_KEY });
    expect(text.code).toBe(3);
    expect(text.stderr).toContain(`GATE-1 is not passing (J2): omf decide lint ${l.f.workId}`);
    const json = seal(l, bin, ["--json"], { OMF_AUTHOR_API_KEY: AUTHOR_KEY });
    expect(json.code).toBe(3);
    expect(JSON.parse(json.stdout)).toEqual({ status: "refused", work_id: l.f.workId, missing: "GATE-1", exit: 3 });
    expect(ledgerBytes(l)).toBe(before);
    expect(spent(bin)).toEqual([]);
    expect(text.stdout + text.stderr + json.stdout + json.stderr).not.toContain(AUTHOR_KEY);
  });

  it("exits 2 for an unknown item, naming it", () => {
    const l = setupLine();
    configureSeal(l);
    const out = omf(["seal", "w-000000000000"], l.f.fx.repo, l.f.fx.home, { PATH: fakeDockerBin().path });
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("unknown work item w-000000000000");
  });

  it("exits 2 with a closed code and no docker call when the key, the context or the pairing is wrong", () => {
    const l = setupLine();
    const bin = fakeDockerBin();
    const key = { OMF_AUTHOR_API_KEY: AUTHOR_KEY };
    const cases: [Parameters<typeof configureSeal>[1], NodeJS.ProcessEnv, RegExp][] = [
      [{}, {}, /author_key_missing.*OMF_AUTHOR_API_KEY/],
      [{ context: false }, key, /docker_context_unset.*\[judge\]/],
      // Either station code means the pairing cannot run; which one comes first is the station's business.
      [{ authorVendor: "claude" }, key, /same_vendor|author_vendor_unsupported/],
    ];
    for (const [options, env, expected] of cases) {
      configureSeal(l, options);
      const before = ledgerBytes(l);
      const out = seal(l, bin, [], env);
      expect(out.code).toBe(2);
      expect(out.stderr).toMatch(expected);
      expect(out.stdout + out.stderr).not.toContain(AUTHOR_KEY);
      expect(ledgerBytes(l)).toBe(before);
    }
    const json = seal(l, bin, ["--json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({ status: "refused", exit: 2 });
    expect(spent(bin)).toEqual([]);
  });

  it("refuses while a live run holds the item's claim", () => {
    const l = setupLine();
    configureSeal(l);
    claimItem(l.f.item.dir);
    const out = (() => {
      try {
        return seal(l, fakeDockerBin(), [], { OMF_AUTHOR_API_KEY: AUTHOR_KEY });
      } finally {
        releaseItem(l.f.item.dir);
      }
    })();
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("claimed by a run");
  });
});

describe("omf seal is idempotent on a measured seal", () => {
  it("does nothing the second time: exit 0, no key, no docker call, no ledger change", async () => {
    const l = setupLine();
    configureSeal(l);
    const sealId = await plantStandingSeal(l, { measured: true });
    const bin = fakeDockerBin();
    const before = ledgerBytes(l);
    const first = seal(l, bin);
    const second = seal(l, bin, ["--json"]);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain(`already sealed ${sealId}`);
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout)).toEqual({
      status: "already_sealed",
      work_id: l.f.workId,
      seal_id: sealId,
      author_measured: true,
      exit: 0,
    });
    expect(ledgerBytes(l)).toBe(before);
    expect(spent(bin)).toEqual([]);
  });
});

describe("omf seal sweeps the item's author orphans whatever it answers", () => {
  it("removes the container of a killed pass when GATE-1 stops the seal (exit 3)", () => {
    const l = setupLine({ decisions: false });
    configureSeal(l);
    const bin = fakeDockerBin();
    const name = plantKilledPass(l, bin);
    expect(planted(bin)).toEqual([name]);
    const out = seal(l, bin, [], { OMF_AUTHOR_API_KEY: AUTHOR_KEY });
    expect(out.code).toBe(3);
    expect(out.stderr).toContain("GATE-1 is not passing");
    expect(planted(bin)).toEqual([]);
    expect(spent(bin)).toEqual(["rm"]);
  });

  it("removes it when the item is already sealed (exit 0, no key, nothing built or run)", async () => {
    const l = setupLine();
    configureSeal(l);
    await plantStandingSeal(l, { measured: true });
    const bin = fakeDockerBin();
    const name = plantKilledPass(l, bin);
    expect(planted(bin)).toEqual([name]);
    const out = seal(l, bin);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("already sealed");
    expect(planted(bin)).toEqual([]);
    expect(spent(bin)).toEqual(["rm"]);
  });

  it("removes it when the seal is refused for a missing key", () => {
    const l = setupLine();
    configureSeal(l);
    const bin = fakeDockerBin();
    plantKilledPass(l, bin);
    const out = seal(l, bin, []);
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("author_key_missing");
    expect(planted(bin)).toEqual([]);
  });

  it("removes it when the item has no standing seal and has started (refused before the line is read)", () => {
    const l = setupLine();
    configureSeal(l);
    appendWorkStarted(l);
    const bin = fakeDockerBin();
    plantKilledPass(l, bin);
    const out = seal(l, bin, [], { OMF_AUTHOR_API_KEY: AUTHOR_KEY });
    expect(out.code).not.toBe(0);
    expect(planted(bin)).toEqual([]);
  });
});

describe("reportSeal egress line", () => {
  it.each([
    ["sealed", { status: "sealed", seal_id: SEAL, round: 1, author_measured: true, gate2: "pass" }],
    ["stored", { status: "stored", seal_id: SEAL, round: 1, author_measured: false, gate2: "pass" }],
  ] as [string, SealPassResult][])("says author network egress is not restricted when %s", (_name, result) => {
    expect(reportSeal(WORK, result).text).toContain("author network egress is not restricted");
  });
});
