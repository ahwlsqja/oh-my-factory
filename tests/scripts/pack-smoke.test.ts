import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// scripts/pack-smoke.mjs installs the tarball and runs the installed binary. It packs and installs from the registry, so npm
// test does not run it (CI does); this only pins that it also checks the three verbs of the line against the installed --help.
const SCRIPT = fileURLToPath(new URL("../../scripts/pack-smoke.mjs", import.meta.url));

describe("scripts/pack-smoke.mjs", () => {
  it("checks that the installed binary lists seal, run and report", () => {
    const source = readFileSync(SCRIPT, "utf8");
    expect(source).toContain('const REQUIRED_VERBS = ["seal", "run", "report"];');
    expect(source).toContain("omf --help does not list the");
  });
});
