import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runDecideDefer, runDecideNa } from "../../src/cli/decide.js";
import { renderSpec, specFile } from "../../src/decision/spec-md.js";
import { findDecision, foldDecisions } from "../../src/decision/state.js";
import { loadLeakContext } from "../../src/decision/leak-lint.js";
import { omfAsync } from "../helpers/cli.js";
import {
  HUMAN,
  NOW,
  addInterface,
  addOpen,
  closeInterface,
  decideCli,
  expectedSpec,
  reportAt,
  resolveInterface,
  setupDecisionItem,
  writeJson,
} from "../helpers/decision-fixture.js";

// Spec §5.1/§5.2: `spec.md` is a projection of the decision ledger. The ledger is the only input; the file is
// output that a person may read and may damage. These tests pin that it is rendered, compared and rewritten,
// and never read back.
describe("W-spec-projection", () => {
  it("equals the render of the ledger after every verb, byte for byte", () => {
    const f = setupDecisionItem();
    const steps: Array<[string, () => unknown]> = [
      ["add interface", () => addInterface(f)],
      ["resolve interface", () => resolveInterface(f)],
      ["add d-cache", () => addOpen(f, "d-cache")],
      [
        "defer d-cache",
        () =>
          runDecideDefer(
            f.fx.location,
            f.workId,
            "d-cache",
            {
              owner: "dev",
              reason: "Waiting on a benchmark.",
              revisit_trigger: "After the benchmark.",
              default: "Keep the current behavior.",
              expires_at: "2099-01-01T00:00:00.000Z",
            },
            HUMAN,
            NOW,
          ),
      ],
      ["add d-flag", () => addOpen(f, "d-flag")],
      [
        "n/a d-flag",
        () => runDecideNa(f.fx.location, f.workId, "d-flag", { rationale: "Nothing to decide here." }, HUMAN),
      ],
    ];
    for (const [name, step] of steps) {
      step();
      expect(readFileSync(specFile(f.item.dir), "utf8"), name).toBe(expectedSpec(f));
    }
    // An expectation written out by hand, not derived from renderSpec: the file on disk must carry these exact lines.
    const onDisk = readFileSync(specFile(f.item.dir), "utf8");
    expect(onDisk.split("\n")).toEqual(
      expect.arrayContaining([
        "# Cache the render path",
        "## Interface",
        "### d-interface (interface)",
        "- Choice: A command line program",
        '- Build: ["npm","run","build"]',
        "## Resolved",
        "## Deferred",
        "### d-cache (other)",
        "- Reason: Waiting on a benchmark.",
        "- Expires: 2099-01-01T00:00:00.000Z",
        "## Open (these block sealing)",
        "## Not applicable",
        "### d-flag (other)",
        "- Rationale: Nothing to decide here.",
      ]),
    );
  });

  it("reports a hand edit as spec_drift (lint exits 1) and overwrites it on lint --render and on the next write", () => {
    const f = setupDecisionItem();
    closeInterface(f);
    const file = specFile(f.item.dir);
    writeFileSync(file, `${readFileSync(file, "utf8")}\nA hand edit.\n`);

    expect(reportAt(f, NOW).spec).toBe("drift");
    const lint = decideCli(f, ["lint", f.workId, "--json"]);
    expect(lint.code, lint.stderr).toBe(1);
    expect(lint.stdout).toContain("spec_drift");

    decideCli(f, ["lint", f.workId, "--render"]);
    expect(readFileSync(file, "utf8")).toBe(expectedSpec(f));
    const clean = decideCli(f, ["lint", f.workId]);
    expect(clean.code, clean.stdout + clean.stderr).toBe(0);

    writeFileSync(file, "overwritten by the next write\n");
    addOpen(f, "d-more");
    expect(readFileSync(file, "utf8")).toBe(expectedSpec(f));
  });

  it("never reads spec.md back: a forged file changes no state, no verdict and no output", () => {
    const f = setupDecisionItem();
    closeInterface(f);
    const before = reportAt(f, NOW);
    const file = specFile(f.item.dir);
    writeFileSync(file, "# forged\n\n## Resolved\n\n### d-forged\n\nchoice: Anything\n");

    const after = reportAt(f, NOW);
    expect(after.state).toEqual(before.state);
    expect(after.gate).toEqual(before.gate);
    expect(findDecision(after.state, "d-forged")).toBeNull();

    const ledgerBytes = readFileSync(f.fx.ledger.file, "utf8");
    const show = decideCli(f, ["show", f.workId, "--json"]);
    expect(show.code, show.stderr).toBe(0);
    expect(show.stdout).not.toContain("d-forged");
    expect(readFileSync(f.fx.ledger.file, "utf8"), "show writes no event").toBe(ledgerBytes);
    expect(readFileSync(file, "utf8"), "show does not rewrite the projection").toContain("d-forged");

    const events = f.fx.ledger.readVerified();
    const render = renderSpec(
      foldDecisions(events, f.scope),
      { title: f.item.front.title },
      loadLeakContext(f.fx.location.dir, f.fx.goalId, events),
    );
    expect(render).not.toContain("d-forged");
  });

  it("two concurrent writers leave the render of the final ledger", async () => {
    const f = setupDecisionItem();
    closeInterface(f);
    const ids = ["d-a", "d-b", "d-c", "d-d"];
    const runs = await Promise.all(
      ids.map((id) =>
        omfAsync(
          [
            "decide",
            "add",
            f.workId,
            "--file",
            writeJson(f, `${id}.json`, { id, class: "other", question: `Is ${id} needed?` }),
          ],
          f.fx.repo,
          f.fx.home,
        ),
      ),
    );
    for (const [index, run] of runs.entries()) expect(run.code, `${ids[index]}: ${run.stderr}`).toBe(0);

    expect(f.fx.ledger.verify().ok).toBe(true);
    const added = f.fx.ledger
      .readVerified()
      .filter((e) => e.type === "decision.added")
      .map((e) => e.payload.decision_id);
    expect(added).toEqual(expect.arrayContaining(ids));
    expect(readFileSync(specFile(f.item.dir), "utf8")).toBe(expectedSpec(f));
  }, 30_000);
});
