// covers: S5.5.null-implementation-fails
import { describe, expect, it } from "vitest";
import { createHostFixtureRunner } from "../../src/scenario/fixtures.js";
import { runGate2 } from "../../src/scenario/gate2.js";
import { intakeAuthored, type Ids } from "../../src/scenario/intake.js";
import {
  CANARY_SPEC,
  FAKE_AUTHOR,
  STRONG_EXPECT,
  type SealedItem,
  type SeedExpect,
  type SeedSpec,
  gate2Reasons,
  sealedCtx,
  seedSealedItem,
} from "../helpers/scenario-fixture.js";

// Spec §5.3 and the kill criterion: a seeded weak judge is rejected. A behavior scenario that the null implementation
// passes (a program that exits 1 with no output, or exits 0 with no output) proves nothing, so GATE-2 sends the item
// back to S2 with the count. Everything here runs through the real host fixture runner (M3c-D6): the two nulls are the
// OMF fixtures, spawned as node with verified bytes.

const real = (s: SealedItem) => sealedCtx(s, { runner: createHostFixtureRunner() });

const WEAK: { name: string; expect: SeedExpect }[] = [
  {
    name: "exit 1 with an exact empty stdout (passes null-error)",
    expect: { exit_code: 1, stdout_matches: { kind: "exact", text: "" } },
  },
  { name: "only exit 0 (passes null-empty)", expect: { exit_code: 0 } },
  { name: "only an exact empty stdout (passes both)", expect: { stdout_matches: { kind: "exact", text: "" } } },
  { name: "only the anchored ^$ (passes both)", expect: { stdout_matches: { kind: "anchored", pattern: "^$" } } },
];
const strong = (split: "train" | "test", ref: string): SeedSpec => ({ split, refs: [ref], expect: STRONG_EXPECT });

describe("W-null-impl-fails", () => {
  it("passes a strong set: every behavior scenario fails both nulls and the canary fails all three", async () => {
    const result = await runGate2(real(seedSealedItem()));
    expect(result.status, JSON.stringify(gate2Reasons(result))).toBe("pass");
  });

  it.each(WEAK)("rejects a weak scenario that expects $name", async ({ expect: weak }) => {
    const specs: SeedSpec[] = [
      { split: "train", refs: ["d-interface"], expect: weak },
      strong("test", "d-cache"),
      CANARY_SPEC,
    ];
    const result = await runGate2(real(seedSealedItem(specs)));
    expect(result.status).toBe("fail");
    expect(result.status === "fail" ? result.route : null).toBe("back_to_S2");
    expect(gate2Reasons(result)).toContainEqual(expect.objectContaining({ code: "null_impl_passes", count: 1 }));
  });

  it("one weak scenario among many still fails, and every weak one is counted", async () => {
    const specs: SeedSpec[] = [
      strong("train", "d-interface"),
      strong("train", "d-interface"),
      strong("train", "d-interface"),
      strong("test", "d-cache"),
      strong("test", "d-cache"),
      { split: "test", refs: ["d-cache"], expect: { exit_code: 0 } },
      { split: "train", refs: ["d-interface"], expect: { stdout_matches: { kind: "anchored", pattern: "^$" } } },
      CANARY_SPEC,
    ];
    const result = await runGate2(real(seedSealedItem(specs)));
    expect(result.status).toBe("fail");
    expect(gate2Reasons(result)).toContainEqual(expect.objectContaining({ code: "null_impl_passes", count: 2 }));
  });

  it("a canary that null-empty passes is judge_broken_or_gamed and goes to a person", async () => {
    const weakCanary: SeedSpec = { kind: "contradiction_canary", split: "train", expect: { exit_code: 0 } };
    const specs: SeedSpec[] = [strong("train", "d-interface"), strong("test", "d-cache"), weakCanary];
    const result = await runGate2(real(seedSealedItem(specs)));
    expect(result.status === "fail" ? result.route : null).toBe("J3");
    expect(gate2Reasons(result).map((reason) => reason.code)).toContain("judge_broken_or_gamed");
  });

  it("an expectation with only a note is refused at intake, so it never reaches the vault", () => {
    let n = 0;
    const ids: Ids = {
      scenarioId: () => `s-${(++n).toString(16).padStart(32, "0")}`,
      canary: () => `omf-canary-${n.toString(16).padStart(32, "0")}`,
      sealId: () => "seal-0000000000000001",
    };
    const authored = [
      "decision_refs: [d-interface]",
      "kind: behavior",
      "split: train",
      "interface: cli",
      "steps:",
      "  - invoke: { argv: [cache, get, a] }",
      "    expect: { note: nothing is asserted }",
      "",
    ].join("\n");
    const out = intakeAuthored(authored, { workId: "w-intake", author: FAKE_AUTHOR, ids });
    expect(out.stored).toEqual([]);
    expect(out.rejected.expect_empty).toBe(1);
  });
});
