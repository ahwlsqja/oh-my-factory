import { describe, expect, it } from "vitest";
import { feedbackEvidenceFiles } from "./feedback-evidence.js";

const BASE = {
  goalId: "g-checkout",
  workId: "w-0123456789ab",
  runId: "r-20261014T100000Z-0001",
  events: [],
  train: { pass: 6, total: 12, flaky: 1 },
  now: new Date("2026-10-14T10:00:00.000Z"),
};

describe("feedbackEvidenceFiles", () => {
  it("writes evidence.json and evidence.md that carry the train counts and the recorded test counts", () => {
    const files = feedbackEvidenceFiles({ ...BASE, test: { pass: 6, total: 8, flaky: 1 } });
    const doc = JSON.parse(files.json) as { work_id: string; sealed: { train: unknown; test: unknown } };
    expect(doc.work_id).toBe(BASE.workId);
    expect(doc.sealed.train).toEqual(BASE.train);
    expect(doc.sealed.test).toEqual({ pass: 6, total: 8 });
    expect(files.md.trim().length).toBeGreaterThan(0);
  });

  it("says \"not run\" for a test split that was not run", () => {
    const doc = JSON.parse(feedbackEvidenceFiles({ ...BASE, test: null }).json) as { sealed: { test: unknown } };
    expect(doc.sealed.test).toBe("not run");
  });
});
