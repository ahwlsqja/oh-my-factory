import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadLeakContext } from "../../src/decision/leak-lint.js";
import { specFile } from "../../src/decision/spec-md.js";
import { foldDecisions } from "../../src/decision/state.js";
import { type SealInputs, SealInputError, buildSealPrompt, sealInputsFor } from "../../src/seal/prompt.js";
import { runSealStage } from "../../src/seal/seal.js";
import { CANARY } from "../helpers/canary.js";
import { countingSession, depsFor, sealFixture } from "../helpers/seal-fixture.js";

// Spec §5.3 and §4.6: the author sees a closed set of inputs. This test proves what OMF writes into the seal prompt.
// It does not prove that an author cannot reach anything else: the stub author is a host process, and independent
// sealing is M3h.

function inputsOf(s: ReturnType<typeof sealFixture>): SealInputs {
  const events = s.f.fx.ledger.readVerified();
  return sealInputsFor(s.f.item, foldDecisions(events, s.f.scope), loadLeakContext(s.f.fx.location.dir, s.f.fx.goalId, events));
}

describe("W-seal-inputs-closed", () => {
  it("has no plan, code, diff or path field, and the builder refuses any extra key", () => {
    const base = inputsOf(sealFixture());
    // @ts-expect-error SealInputs has no plan field
    const withPlan: SealInputs = { ...base, plan: "step 1: edit src/render" };
    expect(Object.keys(withPlan)).toContain("plan");
    for (const key of ["plan", "diff", "files", "paths", "worktree"]) {
      const widened = { ...base, [key]: "x" } as unknown as SealInputs;
      let code = "no error";
      try {
        buildSealPrompt(widened);
      } catch (err) {
        code = err instanceof SealInputError ? err.code : `other: ${String(err)}`;
      }
      expect(code, key).toBe("forbidden_input");
    }
  });

  it("is byte-stable, states every rule the judge applies, and names no path, goal or work item", () => {
    const s = sealFixture();
    const inputs = inputsOf(s);
    const prompt = buildSealPrompt(inputs);
    expect(buildSealPrompt({ ...inputs })).toBe(prompt);
    for (const rule of [
      "share one scratch directory",
      "including the trailing newline",
      "killed by a signal never satisfies any expectation",
      "must come from the linkable list",
      "statically unsatisfiable",
      "json_path entries that the exact text",
      "at least one contradiction_canary in every set",
    ]) {
      expect(prompt, rule).toContain(rule);
    }
    expect(prompt).toContain("- d-interface");
    for (const hidden of [s.f.fx.repo, s.f.fx.location.dir, s.f.workId, s.f.fx.goalId]) expect(prompt).not.toContain(hidden);
  });

  it("renders the spec from the ledger: a forged spec.md and a plan.md change nothing", () => {
    const s = sealFixture();
    const before = buildSealPrompt(inputsOf(s));
    writeFileSync(specFile(s.f.item.dir), "FORGED-SPEC-SENTINEL\n");
    writeFileSync(join(s.f.item.dir, "plan.md"), "PLAN-SENTINEL-17: edit src/render\n");
    const after = buildSealPrompt(inputsOf(s));
    expect(after).toBe(before);
    expect(after).not.toContain("SENTINEL");
  });

  it("an http interface and a leaking intent end in blocked_input with the author never called", async () => {
    const http = sealFixture("http");
    const httpSession = countingSession();
    expect(await runSealStage(depsFor(http, httpSession))).toEqual({ status: "blocked_input", code: "interface_not_supported" });

    const leaky = sealFixture();
    const item = { ...leaky.f.item, intent: { ...leaky.f.item.intent, candidate: { ...leaky.f.item.intent.candidate, problem: `Lower ${CANARY.metricId} across the page.` } } };
    const leakySession = countingSession();
    expect(await runSealStage(depsFor(leaky, leakySession, { item }))).toEqual({ status: "blocked_input", code: "intent_leak" });

    for (const [s, session] of [[http, httpSession], [leaky, leakySession]] as const) {
      expect(session.calls).toHaveLength(0);
      expect(s.f.fx.ledger.readVerified().filter((event) => event.type.startsWith("seal."))).toEqual([]);
    }
  });
});
