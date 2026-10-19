import { describe, expect, it } from "vitest";
import { formatDuration, parseDuration } from "../../src/goal/duration.js";

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

describe("formatDuration", () => {
  it("uses days from a week up, then hours, then minutes", () => {
    expect(formatDuration(7 * 86_400_000)).toBe("7d");
    expect(formatDuration(72 * 3_600_000)).toBe("72h");
    expect(formatDuration(90 * 60_000)).toBe("90m");
    expect(formatDuration(14 * 86_400_000)).toBe("14d");
  });
});
