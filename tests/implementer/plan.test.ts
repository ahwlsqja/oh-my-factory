import { describe, expect, it } from "vitest";
import {
  checkPlanFirst,
  PLAN_MAX_BYTES,
  PLAN_SUMMARY_CHARS,
  type PlanCheck,
  type PlanWhy,
  planPath,
} from "../../src/implementer/plan.js";
import { buildChain, type Chain, type Step, WORK_ID } from "../helpers/implementer-chain.js";

const PLAN = planPath(WORK_ID);
const BASE: Step = { "src/a.ts": "export {};\n" };
const check = (chain: Chain): Promise<PlanCheck> =>
  checkPlanFirst(chain.quarantine, WORK_ID, chain.context, chain.work);

describe("planPath", () => {
  it("lives in the per-item directory, and refuses a work id that is not one", () => {
    expect(PLAN).toBe(".omf/w-0123456789ab/plan.md");
    expect(() => planPath("../x")).toThrow();
  });
});

describe("checkPlanFirst", () => {
  it("accepts a first commit that adds only the plan, whatever the later commits do, and returns its text", async () => {
    const chain = await buildChain({
      base: BASE,
      work: [{ [PLAN]: "Step 1\nStep 2\n" }, { "src/a.ts": "export const a = 1;\n" }],
    });
    expect(await check(chain)).toEqual({ status: "ok", summary: "Step 1\nStep 2\n" });
  });

  it("accepts a plan of exactly the size limit and rejects one byte more", async () => {
    const exact = await buildChain({ base: BASE, work: [{ [PLAN]: "a".repeat(PLAN_MAX_BYTES) }] });
    expect(await check(exact)).toMatchObject({ status: "ok" });
    const over = await buildChain({ base: BASE, work: [{ [PLAN]: "a".repeat(PLAN_MAX_BYTES + 1) }] });
    expect(await check(over)).toEqual({ status: "missing", why: "plan_not_text" });
  });

  it("strips control characters from the summary and cuts it at the limit", async () => {
    const text = `\u001b[31mred\u001b[0m\u0007 ok\n${"x".repeat(3000)}`;
    const chain = await buildChain({ base: BASE, work: [{ [PLAN]: text }] });
    const result = await check(chain);
    if (result.status !== "ok") throw new Error("expected an ok plan");
    expect(result.summary.startsWith("[31mred[0m ok\nxxx")).toBe(true);
    expect(result.summary.includes("\u001b") || result.summary.includes("\u0007")).toBe(false);
    expect([...result.summary]).toHaveLength(PLAN_SUMMARY_CHARS);
  });

  const MISSING: [string, Step[], PlanWhy][] = [
    ["no commits at all", [], "no_commits"],
    [
      "a first commit that also touches code",
      [{ [PLAN]: "p\n", "src/a.ts": "changed\n" }],
      "first_commit_not_plan_only",
    ],
    [
      "a plan that arrives only in the second commit",
      [{ "src/a.ts": "changed\n" }, { [PLAN]: "p\n" }],
      "first_commit_not_plan_only",
    ],
    ["a plan for another item", [{ ".omf/w-aaaaaaaaaaaa/plan.md": "p\n" }], "first_commit_not_plan_only"],
    ["an empty plan", [{ [PLAN]: "" }], "plan_empty"],
    ["a blank plan", [{ [PLAN]: " \n\t\n" }], "plan_empty"],
    ["a plan with a NUL byte", [{ [PLAN]: Buffer.from([0x61, 0x00, 0x62]) }], "plan_not_text"],
    ["a plan that is not UTF-8", [{ [PLAN]: Buffer.from([0xff, 0xfe, 0x41]) }], "plan_not_text"],
    ["a symlink named plan.md", [{ [PLAN]: { link: "../../src/a.ts" } }], "plan_not_text"],
  ];
  it.each(MISSING)("is missing for %s", async (_name, work, why) => {
    const chain = await buildChain({ base: BASE, work });
    expect(await check(chain)).toEqual({ status: "missing", why });
  });
});
