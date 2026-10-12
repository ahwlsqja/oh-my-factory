import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectDir } from "../../src/core/paths.js";
import { omf } from "../helpers/cli.js";
import { makeGitRepo, makeTempDir } from "../helpers/tmp.js";

// Spec §8: every command verifies the hash chain before acting; a broken chain stops OMF.
describe("ledger-tamper-stops", () => {
  it("verify, doctor and init all refuse a tampered ledger", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    expect(omf(["init"], repo, home).code).toBe(0);

    const file = join(projectDir(repo, { HOME: home }), "ledger.jsonl");
    const event = JSON.parse(readFileSync(file, "utf8")) as { payload: Record<string, unknown> };
    event.payload.repo = "/somewhere/else";
    writeFileSync(file, `${JSON.stringify(event)}\n`);

    const verify = omf(["ledger", "verify"], repo, home);
    expect(verify.code).toBe(1);
    expect(verify.stderr).toContain("corrupt at seq 1: hash mismatch");

    const doctor = omf(["doctor", "--json"], repo, home);
    expect(doctor.code).toBe(1);
    expect(JSON.parse(doctor.stdout).problems).toContain("ledger corrupt at seq 1: hash mismatch");

    const init = omf(["init"], repo, home);
    expect(init.code).toBe(2);
    expect(init.stderr).toContain("ledger corrupt at seq 1: hash mismatch");
  });
});
