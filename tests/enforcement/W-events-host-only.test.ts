import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runDecideAdd } from "../../src/cli/decide.js";
import { omf } from "../helpers/cli.js";
import { setupDecisionItem } from "../helpers/decision-fixture.js";
import { payloadText, reconcileInputs, reconcileTexts, tickCli, useCleanModel } from "../helpers/enforcement-goal.js";
import { entryFiles, hostOnlyViolations, reachableModules } from "../helpers/import-graph.js";
import { makeTempDir } from "../helpers/tmp.js";
import { joinTree, readTree } from "../helpers/tree.js";
import { FIXTURE_RUN_ID } from "../helpers/work.js";

// M3-D1, M3d-D14: the goal loop (G) never reads `decision.*` or `feedback.*` events. Static half: nothing under
// src/decision or src/feedback is reachable from src/goal or src/cli/goal.ts, and no reachable module quotes an
// event type of those families. Dynamic half: planted canaries stay out of everything G sees or prints.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const relOf = (file: string, root: string = ROOT): string => relative(root, file).split(sep).join("/");

function plant(root: string, path: string, text: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

describe("W-events-host-only: import graph", () => {
  it("catches a host-only module reached through a W module and a quoted event type", () => {
    const root = makeTempDir("omf-graph-");
    plant(root, "src/goal/a.ts", `import { b } from "../work/b.js";\nexport const a = b;\n`);
    plant(root, "src/cli/goal.ts", `export {};\n`);
    plant(root, "src/work/b.ts", `export { c } from "../feedback/c.js";\nexport const b = 1;\n`);
    plant(root, "src/feedback/c.ts", `export const c = "feedback.released";\n`);
    const modules = reachableModules(entryFiles(root));
    expect(modules.map((file) => relOf(file, root))).toEqual([
      "src/cli/goal.ts",
      "src/feedback/c.ts",
      "src/goal/a.ts",
      "src/work/b.ts",
    ]);
    expect(hostOnlyViolations(root, modules)).toEqual([
      "src/feedback/c.ts: reachable host-only module",
      "src/feedback/c.ts:1: quoted host-only event type",
    ]);
  });

  it("does not mistake prose or a bare word for an event type, and fails loudly on an unresolvable import", () => {
    const root = makeTempDir("omf-graph-");
    plant(
      root,
      "src/goal/a.ts",
      `// J8 is a person's decision. Re-approval is separate.\nexport const word = "decision";\n`,
    );
    plant(root, "src/cli/goal.ts", `export {};\n`);
    expect(hostOnlyViolations(root, reachableModules(entryFiles(root)))).toEqual([]);
    plant(root, "src/goal/a.ts", `import "./missing.js";\n`);
    expect(() => reachableModules(entryFiles(root))).toThrow("missing.ts");
  });

  it("finds nothing host-only from src/goal or src/cli/goal.ts", () => {
    const modules = reachableModules(entryFiles(ROOT));
    const names = modules.map((file) => relOf(file));
    // Not vacuous: the walk is transitive and saw the goal loop, including the module that reads W events for it.
    expect(names).toEqual(
      expect.arrayContaining(["src/goal/reconcile.ts", "src/work/recent-outcomes.ts", "src/core/ledger.ts"]),
    );
    expect(names.length).toBeGreaterThan(30);
    expect(hostOnlyViolations(ROOT, modules)).toEqual([]);
  });
});

const DECISION_CANARY = "velociraptor-umbrella";
const FEEDBACK_CANARY = "marmalade-probe-signal";

describe("W-events-host-only: planted events", () => {
  it("keeps a decision question and a feedback event out of everything G sees or prints", () => {
    const f = setupDecisionItem();
    const { fx } = f;
    runDecideAdd(
      fx.location,
      f.workId,
      { id: "d-interface", class: "interface", question: `Which ${DECISION_CANARY} do callers use?` },
      "omf",
    );
    fx.ledger.append({
      actor: "omf",
      type: "feedback.released",
      payload: { goal_id: fx.goalId, work_id: f.workId, run_id: FIXTURE_RUN_ID, note: FEEDBACK_CANARY },
    });
    useCleanModel(fx);

    const tick = tickCli(fx, ["--json"]);
    expect(tick.code, tick.stderr).toBe(0);
    const status = omf(["goal", "status", fx.goalId, "--json"], fx.repo, fx.home);
    const list = omf(["work", "list", fx.goalId, "--json"], fx.repo, fx.home);
    const itemFiles = [...readTree(join(fx.goalPath, "work"))]
      .filter(([name]) => /(^|\/)(item|intent)\.md$/.test(name))
      .map(([, text]) => text)
      .join("\n");
    const surfaces: Record<string, string> = {
      "tick stdout": tick.stdout,
      "tick stderr": tick.stderr,
      "goal status": `${status.stdout}\n${status.stderr}`,
      "work list": `${list.stdout}\n${list.stderr}`,
      "reconciler stdin": readFileSync(join(fx.record, "stdin.txt"), "utf8"),
      "reconcile input files": reconcileTexts(fx, "input").join("\n"),
      "item and intent files": itemFiles,
    };
    for (const [name, text] of Object.entries(surfaces)) {
      for (const canary of [DECISION_CANARY, FEEDBACK_CANARY])
        expect(text, `${name} / ${canary}`).not.toContain(canary);
    }

    // Positive controls: both canaries are in the ledger, the decision one is in spec.md, the model was called and
    // the item it was shown is the one the canaries belong to.
    const stored = payloadText(fx, "decision.added", "feedback.released");
    expect(stored).toContain(DECISION_CANARY);
    expect(stored).toContain(FEEDBACK_CANARY);
    expect(joinTree(readTree(join(fx.goalPath, "work")))).toContain(DECISION_CANARY);
    const inputs = reconcileInputs(fx);
    expect(inputs).toHaveLength(1);
    expect((inputs[0]?.open_items as { work_id: string }[]).map((entry) => entry.work_id)).toEqual([f.workId]);
  });
});
