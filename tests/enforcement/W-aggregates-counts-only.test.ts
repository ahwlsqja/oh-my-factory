import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMarkdownStore } from "../../src/adapters/state-markdown.js";
import { sha256Hex } from "../../src/core/canonical-json.js";
import type { WorkItem } from "../../src/work/types.js";
import {
  ledgerEvents,
  payloadText,
  reconcileInputs,
  reconcileTexts,
  setupEnforcementGoal,
  tickCli,
  useCleanModel,
} from "../helpers/enforcement-goal.js";
import { joinTree, readTree } from "../helpers/tree.js";
import { createRecorded, makeNewItem, recordW, rewriteItem } from "../helpers/work.js";

// Spec §4.6, M3d-D14: the goal loop learns how recent work ended as four counts. Finished items are planted with
// titles and paths that exist nowhere else, then the real tick runs against the stub model; none of it may show
// in the input, the prompt, the ledger event about the call or the CLI output.

const FLAWED = { title: "Rework the narwhal cache layer", path: "src/narwhal" };
const BLOCKED = { title: "Retire the pangolin lookup", path: "src/pangolin" };

describe("W-aggregates-counts-only", () => {
  it("shows the reconciler four counts about finished work and nothing else about those items", () => {
    const fx = setupEnforcementGoal();
    useCleanModel(fx);
    const store = createMarkdownStore(fx.location.dir);
    const make = (title: string, path: string): WorkItem =>
      createRecorded(fx.ledger, store, makeNewItem({ goalId: fx.goalId, title, paths: [path] }));

    const flawed = make(FLAWED.title, FLAWED.path);
    recordW(fx.ledger, "work.started", flawed);
    recordW(fx.ledger, "work.failed", flawed, { outcome: "flawed", reason_code: "station_error" });
    rewriteItem(flawed, { state: "failed" });
    const blocked = make(BLOCKED.title, BLOCKED.path);
    recordW(fx.ledger, "work.started", blocked);
    recordW(fx.ledger, "work.failed", blocked, { outcome: "blocked", reason_code: "infra_failure" });
    rewriteItem(blocked, { state: "failed" });
    // These two stay open, so open_items lists them as before; their titles are clean.
    const reviewed = make("Tidy the render path", "src/render");
    recordW(fx.ledger, "work.started", reviewed);
    recordW(fx.ledger, "work.submitted", reviewed);
    rewriteItem(reviewed, { state: "awaiting_review" });
    const parked = make("Hold the manual one", "src/hold");
    recordW(fx.ledger, "work.parked", parked, { outcome: "manual", reason_code: "manual_required" });

    const run = tickCli(fx, ["--json"]);
    expect(run.code, run.stderr).toBe(0);
    const inputs = reconcileInputs(fx);
    expect(inputs).toHaveLength(1);
    const input = inputs[0] ?? {};

    // Four integers, and the serialized field holds no letters but the four key names.
    expect(input.recent_outcomes).toEqual({ success: 1, flawed: 1, blocked: 1, manual: 1 });
    const field = JSON.stringify(input.recent_outcomes);
    expect(field.replace(/"(success|flawed|blocked|manual)"/g, "")).toMatch(/^[{}:,0-9]*$/);

    // Nothing else about the finished items reaches the model, the event about the call or the log.
    const secrets = [FLAWED.title, FLAWED.path, BLOCKED.title, BLOCKED.path];
    const ids = [flawed.front.work_id, blocked.front.work_id];
    const model: Record<string, string> = {
      "reconciler stdin": readFileSync(join(fx.record, "stdin.txt"), "utf8"),
      "reconcile input files": reconcileTexts(fx, "input").join("\n"),
      "reconcile.requested payload": payloadText(fx, "reconcile.requested"),
    };
    for (const [name, text] of Object.entries(model)) {
      for (const secret of [...secrets, ...ids]) expect(text, `${name} / ${secret}`).not.toContain(secret);
    }
    for (const [name, text] of Object.entries({ "cli stdout": run.stdout, "cli stderr": run.stderr })) {
      for (const secret of secrets) expect(text, `${name} / ${secret}`).not.toContain(secret);
    }

    // The call event gained no field; it is tied to the stored input by its hash.
    const requested = ledgerEvents(fx, "reconcile.requested");
    expect(requested).toHaveLength(1);
    expect(Object.keys(requested[0]?.payload ?? {}).sort()).toEqual([
      "disclosed",
      "goal_id",
      "input_sha256",
      "isolation",
      "max_candidates",
      "reconciler",
      "tick_id",
      "trigger",
    ]);
    expect(requested[0]?.payload.input_sha256).toBe(sha256Hex(reconcileTexts(fx, "input")[0] ?? ""));

    // Positive controls: the planted values exist on the host, and open work is still listed as before.
    const tree = joinTree(readTree(join(fx.goalPath, "work")));
    for (const secret of secrets) expect(tree, `item files hold ${secret}`).toContain(secret);
    expect(payloadText(fx, "work.created", "work.failed")).toContain(ids[0]);
    const titles = (input.open_items as { title: string }[]).map((entry) => entry.title).sort();
    expect(titles).toEqual(["Hold the manual one", "Tidy the render path"]);
  });
});
