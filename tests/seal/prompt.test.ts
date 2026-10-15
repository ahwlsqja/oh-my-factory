import { describe, expect, it } from "vitest";
import { loadLeakContext } from "../../src/decision/leak-lint.js";
import { foldDecisions } from "../../src/decision/state.js";
import { runDecideAdd, runDecideResolve } from "../../src/cli/decide.js";
import { MAX_SEAL_INPUT_CHARS, SealInputError, buildSealPrompt, sealInputsFor } from "../../src/seal/prompt.js";
import type { WorkItem } from "../../src/work/types.js";
import { CANARY } from "../helpers/canary.js";
import {
  type DecisionFixture,
  CONTRACT,
  HUMAN,
  addInterface,
  addOpen,
  closeInterface,
  resolveOpen,
  setupDecisionItem,
} from "../helpers/decision-fixture.js";

function snapshot(f: DecisionFixture) {
  const events = f.fx.ledger.readVerified();
  return { state: foldDecisions(events, f.scope), leak: loadLeakContext(f.fx.location.dir, f.fx.goalId, events) };
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    return err instanceof SealInputError ? err.code : `other: ${String(err)}`;
  }
  return "no error";
}

/** The same item with one intent field replaced. */
function withProblem(item: WorkItem, problem: string): WorkItem {
  return { ...item, intent: { ...item.intent, candidate: { ...item.intent.candidate, problem } } };
}

describe("sealInputsFor", () => {
  it("holds exactly the five inputs, and the feedback only when there is some", () => {
    const f = setupDecisionItem();
    closeInterface(f);
    const { state, leak } = snapshot(f);
    expect(Object.keys(sealInputsFor(f.item, state, leak)).sort()).toEqual([
      "contract",
      "intent",
      "linkable_decision_ids",
      "quantitative_decision_ids",
      "spec",
    ]);
    const feedback = { unlinked_decision_ids: ["d-cache"], weak: 1, contradictions: 0, invalid: 2 };
    expect(sealInputsFor(f.item, state, leak, feedback).feedback).toEqual(feedback);
  });

  it("splits resolved decisions into linkable ids and quantitative ids, and leaves open ones out", () => {
    const f = setupDecisionItem();
    closeInterface(f);
    addOpen(f, "d-cache", "compatibility");
    resolveOpen(f, "d-cache");
    addOpen(f, "d-later");
    runDecideAdd(
      f.fx.location,
      f.workId,
      { id: "d-latency", class: "latency", question: "How fast must a lookup be?" },
      "omf",
    );
    runDecideResolve(
      f.fx.location,
      f.workId,
      "d-latency",
      {
        choice: "Bounded lookup time",
        rationale: "Callers wait on it.",
        rejected: [],
        response_measure: {
          metric: "cache lookup time",
          op: "<=",
          threshold: 40,
          unit: "ms",
          percentile: 95,
          window: null,
        },
      },
      HUMAN,
    );
    const { state, leak } = snapshot(f);
    const inputs = sealInputsFor(f.item, state, leak);
    expect(inputs.linkable_decision_ids).toEqual(["d-interface", "d-cache"]);
    expect(inputs.quantitative_decision_ids).toEqual(["d-latency"]);
    expect(inputs.contract).toEqual(CONTRACT);
    expect(
      inputs.intent,
      "the intent's front matter (goal id, work id, fingerprint, paths) is not shown",
    ).not.toContain(f.workId);
    expect(inputs.intent).toContain("# Intent: Cache the render path");
  });

  it("refuses with a code when the interface is missing, is http, or the intent leaks, or the input is too large", () => {
    const open = setupDecisionItem();
    expect(codeOf(() => sealInputsFor(open.item, snapshot(open).state, snapshot(open).leak))).toBe("interface_missing");
    addInterface(open); // added but not resolved
    expect(codeOf(() => sealInputsFor(open.item, snapshot(open).state, snapshot(open).leak))).toBe("interface_missing");

    const http = setupDecisionItem();
    addInterface(http);
    runDecideResolve(
      http.fx.location,
      http.workId,
      "d-interface",
      {
        choice: "A web service",
        rationale: "Callers use HTTP.",
        rejected: [],
        interface: { ...CONTRACT, kind: "http" },
      },
      HUMAN,
    );
    expect(codeOf(() => sealInputsFor(http.item, snapshot(http).state, snapshot(http).leak))).toBe(
      "interface_not_supported",
    );

    const f = setupDecisionItem();
    closeInterface(f);
    const { state, leak } = snapshot(f);
    expect(
      codeOf(() => sealInputsFor(withProblem(f.item, `Lower ${CANARY.metricId} across the page.`), state, leak)),
    ).toBe("intent_leak");
    expect(
      codeOf(() => sealInputsFor(withProblem(f.item, "word ".repeat(MAX_SEAL_INPUT_CHARS / 4)), state, leak)),
    ).toBe("too_large");
    expect(codeOf(() => sealInputsFor(f.item, state, leak))).toBe("no error");
  });
});

describe("buildSealPrompt feedback", () => {
  it("prints decision ids and counts, and refuses anything else as feedback", () => {
    const f = setupDecisionItem();
    closeInterface(f);
    const { state, leak } = snapshot(f);
    const feedback = { unlinked_decision_ids: ["d-cache", "d-flag"], weak: 2, contradictions: 0, invalid: 1 };
    const prompt = buildSealPrompt(sealInputsFor(f.item, state, leak, feedback));
    const lines = prompt.split("\n");
    expect(lines).toEqual(
      expect.arrayContaining([
        "- unlinked decision: d-cache",
        "- unlinked decision: d-flag",
        "- weak scenarios: 2",
        "- contradictions: 0",
        "- invalid scenarios: 1",
      ]),
    );
    expect(buildSealPrompt(sealInputsFor(f.item, state, leak))).not.toContain("unlinked decision");
    for (const bad of [
      { ...feedback, unlinked_decision_ids: ["d-cache\n- injected line"] },
      { ...feedback, weak: -1 },
      { ...feedback, invalid: 1.5 },
    ]) {
      expect(codeOf(() => buildSealPrompt(sealInputsFor(f.item, state, leak, bad)))).toBe("forbidden_input");
    }
  });

  it("states the trailing-newline rule for anchored patterns", () => {
    const f = setupDecisionItem();
    closeInterface(f);
    const { state, leak } = snapshot(f);
    const prompt = buildSealPrompt(sealInputsFor(f.item, state, leak));
    expect(prompt).toContain("An anchored pattern is matched against the whole stdout including the trailing newline");
    expect(prompt).toContain("end a line-oriented pattern with \\s*$");
  });
});
