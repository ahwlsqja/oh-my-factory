import { describe, expect, it } from "vitest";
import { CANARY, CLEAN_CANDIDATE, canaryHits } from "./canary.js";

describe("canaryHits", () => {
  it("finds the planted values, the metric name and the watched path", () => {
    expect(canaryHits(`it measured ${CANARY.reading}`)).toContain("reading");
    expect(canaryHits(`then ${CANARY.nextReading}`)).toContain("next reading");
    expect(canaryHits(`under ${CANARY.target} ms`)).toContain("target");
    expect(canaryHits(`lower ${CANARY.metricId} please`)).toEqual(["metric id", "metric word zebra", "metric word quokka"]);
    expect(canaryHits(`edit ${CANARY.watchedPath}`)).toEqual(["watched path"]);
  });

  it("finds a digit stem standing alone but not inside a longer token", () => {
    expect(canaryHits("the reading is 4817 right now")).toEqual(["reading digits"]);
    expect(canaryHits("4903, 3719.")).toEqual(["next reading digits", "target digits"]);
    // Hashes and ids are hex runs; a stem inside one is not a leak, and must not make the test flaky.
    expect(canaryHits("fingerprint a4817b0c1d2e and w-4817abcdef01 and 14817 and 48170")).toEqual([]);
  });

  it("ignores case for names and paths", () => {
    expect(canaryHits("ZEBRA")).toEqual(["metric word zebra"]);
    expect(canaryHits("Bench/Canary-Qwerty.SH")).toEqual(["watched path"]);
  });

  it("reports each label once however often it occurs", () => {
    expect(canaryHits("4817.39 4817.39 3719.25")).toEqual(["reading", "target", "reading digits", "target digits"]);
  });

  it("finds nothing in the clean control candidate", () => {
    expect(canaryHits(JSON.stringify(CLEAN_CANDIDATE))).toEqual([]);
  });
});
