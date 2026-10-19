import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The two suites that hold a real key may not hand anything to `expect`: a failing `expect` prints its argument, and the owner's
// command output enters the agent conversation. They assert through assertTrue and assertFalse, whose messages are fixed
// strings. The driver's redactor is the second line of defence, not the first.
const GATED = new URL("../gated/", import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, GATED), "utf8");
const MODEL_SUITES = [
  "implementer-real-run.test.ts",
  "e6-l2-leak-redteam.test.ts",
  "author-canary.test.ts",
  "skeleton-real.test.ts",
] as const;

describe("gated suites that hold a real key", () => {
  it.each([...MODEL_SUITES, "implementer-support.ts", "author-support.ts", "skeleton-kit.ts"])(
    "%s prints nothing, reads no key value and gives every assertion a fixed message",
    (name) => {
      const text = read(name);
      expect(text).not.toMatch(/\bconsole\./);
      expect(text).not.toMatch(/process\.std(?:out|err)/);
      expect(text).not.toMatch(/\.reveal\s*\(/);
      for (const call of text.matchAll(/(?<!function )\bassert(?:True|False)\(([^;]*)\);/g))
        expect(call[1]).toMatch(/,\s*"[^"`$]*",?\s*$/);
    },
  );

  it.each(MODEL_SUITES)("%s calls no expect", (name) => {
    expect(read(name)).not.toMatch(/\bexpect\s*\(/);
  });

  it("every model suite is a describeGatedModel suite and no other suite is", () => {
    const suites = readdirSync(GATED).filter((name) => name.endsWith(".test.ts") && name !== "helpers.test.ts");
    expect(suites.length).toBeGreaterThanOrEqual(7);
    for (const name of suites) {
      const model = (MODEL_SUITES as readonly string[]).includes(name);
      expect(read(name).includes("describeGatedModel(")).toBe(model);
      expect(read(name).includes("describeGated(")).toBe(!model);
    }
  });
});
