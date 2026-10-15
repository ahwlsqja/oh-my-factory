import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURE_ALLOWLIST, fixturesDir, verifyFixture } from "../../src/scenario/fixtures.js";
import { makeTempDir } from "../helpers/tmp.js";

const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

/** A temp directory holding byte-identical copies of the three shipped fixtures. */
function copyOfFixtures(): string {
  const dir = makeTempDir("omf-fixtures-");
  for (const entry of FIXTURE_ALLOWLIST) copyFileSync(join(fixturesDir(), entry.file), join(dir, entry.file));
  return dir;
}

describe("fixture allowlist", () => {
  it("names exactly the three shipped fixtures", () => {
    expect(FIXTURE_ALLOWLIST.map((entry) => entry.id).sort()).toEqual(["echo-everything", "null-empty", "null-error"]);
    for (const entry of FIXTURE_ALLOWLIST) expect(entry.file).toBe(`${entry.id}.mjs`);
  });

  it("equals the hashes recomputed from fixtures/ (drift test)", () => {
    for (const entry of FIXTURE_ALLOWLIST) {
      expect(sha256(readFileSync(join(fixturesDir(), entry.file)))).toBe(entry.sha256);
    }
  });

  it("holds no file the list does not name", () => {
    expect(readdirSync(fixturesDir()).sort()).toEqual(FIXTURE_ALLOWLIST.map((entry) => entry.file).sort());
  });
});

describe("verifyFixture", () => {
  it("returns the verified bytes and the real path of an allowlisted fixture", () => {
    const check = verifyFixture("null-error");
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.id).toBe("null-error");
    expect(check.realPath).toBe(join(realpathSync(fixturesDir()), "null-error.mjs"));
    expect(sha256(check.source)).toBe(FIXTURE_ALLOWLIST.find((entry) => entry.id === "null-error")?.sha256);
  });

  it.each(["rm", "/bin/sh", "../fixtures/null-error", "null-error.mjs", "__proto__", ""])("refuses the unknown id %j", (id) => {
    expect(verifyFixture(id)).toEqual({ ok: false, code: "unknown_fixture" });
  });

  it("accepts a byte-identical copy in another directory and refuses a modified one on hash", () => {
    const dir = copyOfFixtures();
    expect(verifyFixture("echo-everything", dir).ok).toBe(true);
    writeFileSync(join(dir, "null-error.mjs"), `${readFileSync(join(dir, "null-error.mjs"), "utf8")}process.exit(0);\n`);
    expect(verifyFixture("null-error", dir)).toEqual({ ok: false, code: "fixture_hash_mismatch" });
  });

  it("refuses a missing file, a missing directory and a dangling link as fixture_missing", () => {
    const empty = makeTempDir("omf-fixtures-");
    expect(verifyFixture("null-empty", empty)).toEqual({ ok: false, code: "fixture_missing" });
    expect(verifyFixture("null-empty", join(empty, "nope"))).toEqual({ ok: false, code: "fixture_missing" });
    symlinkSync(join(empty, "gone.mjs"), join(empty, "null-empty.mjs"));
    expect(verifyFixture("null-empty", empty)).toEqual({ ok: false, code: "fixture_missing" });
  });

  it("refuses a link that leaves the directory, a link inside it, and a directory", () => {
    const outside = makeTempDir("omf-fixtures-");
    symlinkSync(join(fixturesDir(), "null-error.mjs"), join(outside, "null-error.mjs"));
    expect(verifyFixture("null-error", outside)).toEqual({ ok: false, code: "fixture_outside_dir" });

    const inside = makeTempDir("omf-fixtures-");
    copyFileSync(join(fixturesDir(), "null-empty.mjs"), join(inside, "sibling.mjs"));
    symlinkSync(join(inside, "sibling.mjs"), join(inside, "null-empty.mjs"));
    expect(verifyFixture("null-empty", inside)).toEqual({ ok: false, code: "fixture_not_regular_file" });

    const asDirectory = makeTempDir("omf-fixtures-");
    mkdirSync(join(asDirectory, "echo-everything.mjs"));
    expect(verifyFixture("echo-everything", asDirectory)).toEqual({ ok: false, code: "fixture_not_regular_file" });
  });
});
