import { describe, expect, it } from "vitest";
import { isAllowlistedFeedback } from "../../src/feedback/render.js";
import { setupLine } from "../helpers/line.js";
import {
  CANDIDATE,
  TRAIN_DIGEST,
  contextOf,
  declareDisclosure,
  judgeSpy,
  roundState,
  slot,
  stationOf,
} from "../helpers/s6-fixture.js";

// The one channel from the sealed train scenarios to the implementer is the value S6 hands to the feedback slot. Every other
// check looks at the ledger or at a canary string; this one reads what is delivered: the public object holds the text and
// nothing else, the text is the fixed template, and none of the host-only data (digests, run and goal ids, the candidate, the
// round and unit counts) appears in it.
describe("seam: what S6 hands to the feedback slot", () => {
  async function delivered() {
    const l = setupLine();
    declareDisclosure(l, 40);
    const feedback = slot();
    const ctx = contextOf(l);
    const result = await stationOf(
      l,
      roundState(["pass", "pass", "pass", "pass", "fail", "fail"]),
      judgeSpy(l).judge,
      feedback,
    ).run(ctx);
    return { l, ctx, feedback, result, held: feedback.take() };
  }

  it("is a value whose only own member is the text, and the text is the allowlisted template that was also put as text", async () => {
    const { feedback, result, held } = await delivered();
    expect(result.kind).toBe("rework");
    expect(feedback.puts).toHaveLength(1);
    expect(held).not.toBeNull();
    expect(Reflect.ownKeys(held ?? {})).toEqual(["text"]);
    expect(Object.getOwnPropertySymbols(held ?? {})).toEqual([]);
    expect(Object.getPrototypeOf(held)).toBe(Object.prototype);
    const text = (held as { text: string }).text;
    expect(typeof text).toBe("string");
    expect(feedback.puts[0]).toBe(text);
    expect(isAllowlistedFeedback(text)).toBe(true);
  });

  it("carries no host-only value: no digest, id, candidate, round or unit count, no scenario reference", async () => {
    const { l, ctx, feedback, held } = await delivered();
    const everything = `${JSON.stringify(held)}\n${feedback.puts.join("\n")}`;
    for (const hostOnly of [
      TRAIN_DIGEST,
      CANDIDATE,
      ctx.runId,
      ctx.workId,
      ctx.goalId,
      l.fx.goalId,
      "host_only",
      "disclosure_units",
      "train_digest",
      "scenario_ref",
      "score_pct",
    ]) {
      expect(everything, hostOnly).not.toContain(hostOnly);
    }
    expect(everything).not.toMatch(/[0-9a-f]{32}/);
    // The text holds numbers only inside the category lines ("- <class>: N% of M scenarios").
    const outsideLines = (held as { text: string }).text
      .split("\n")
      .filter((line) => !line.startsWith("- "))
      .join("\n");
    expect(outsideLines).not.toMatch(/[0-9]/);
  });
});
