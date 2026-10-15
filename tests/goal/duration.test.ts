import { describe, expect, it } from "vitest";
import { parseDuration } from "../../src/goal/duration.js";

describe("parseDuration", () => {
  it("reads minutes, hours and days", () => {
    expect(parseDuration("30m")).toBe(30 * 60_000);
    expect(parseDuration("72h")).toBe(72 * 3_600_000);
    expect(parseDuration("7d")).toBe(7 * 86_400_000);
  });

  it("rejects anything else", () => {
    for (const bad of ["", "0d", "7", "1w", "1.5h", "-1d"])
      expect(() => parseDuration(bad)).toThrow(/invalid duration/);
  });
});
