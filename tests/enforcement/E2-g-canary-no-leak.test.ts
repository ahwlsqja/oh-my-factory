import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lockFile } from "../../src/goal/metrics.js";
import type { TickResult } from "../../src/goal/tick.js";
import { CANARY, CLEAN_CANDIDATE, CLEAN_TITLE, canaryHits } from "../helpers/canary.js";
import { omf } from "../helpers/cli.js";
import {
  type EnforcementFixture,
  type EnforcementOptions,
  type LeakChannel,
  ledgerEvents,
  payloadText,
  reconcileInputs,
  reconcileTexts,
  setReading,
  setupEnforcementGoal,
  tickCli,
  useCandidates,
  useCleanModel,
  useLeakyModel,
} from "../helpers/enforcement-goal.js";
import { joinTree, readTree } from "../helpers/tree.js";

// Spec §4.6, F6: the goal loop (G) receives aggregates only. The reconciler is shown a direction and a size
// bucket, never a value, a threshold, a metric id, a command or a path of a metric. These tests plant
// canaries in every place a leak could start and look for them everywhere a tick may carry them: the model
// input, the stored work items, the ledger events about the model, and the output of the CLI. The W side
// (verifier and implementer) is M3.

/** Fails with the surface's name and the canaries found in it, so a leak says where it went. */
function expectNoCanary(surfaces: Record<string, string>): void {
  for (const [name, text] of Object.entries(surfaces)) expect(canaryHits(text), name).toEqual([]);
}

type Run = { stdout: string; stderr: string };

/** Everything a tick showed to the model, stored for a person to read, or printed to a log. */
function surfacesOf(fx: EnforcementFixture, run: Run): Record<string, string> {
  return {
    "cli stdout": run.stdout,
    "cli stderr": run.stderr,
    "reconciler stdin": readFileSync(join(fx.record, "stdin.txt"), "utf8"),
    "reconcile input files": reconcileTexts(fx, "input").join("\n"),
    "work items": joinTree(readTree(join(fx.goalPath, "work"))),
    "ledger payloads about the model": payloadText(
      fx,
      "reconcile.requested",
      "reconcile.responded",
      "reconcile.failed",
      "candidate.rejected",
      "work.created",
    ),
  };
}

describe("E2 canary-no-leak, goal-loop side", () => {
  it("shows the model a direction and a size bucket and nothing else, and keeps every canary out of storage and logs", () => {
    const fx = setupEnforcementGoal();
    useCleanModel(fx);

    const first = tickCli(fx);
    expect(first.code, first.stderr).toBe(0);
    expectNoCanary(surfacesOf(fx, first));

    // Not vacuous: the canaries exist on the host, the model was called, and the permitted summary was sent.
    const reports = joinTree(readTree(join(fx.goalPath, "reports")));
    expect(canaryHits(reports), "host reports hold the real values").toEqual(expect.arrayContaining(["reading", "target"]));
    expect(readTree(join(fx.goalPath, "work")).size, "a work item was written").toBeGreaterThanOrEqual(2);
    const inputs = reconcileInputs(fx);
    expect(inputs).toHaveLength(1);
    const input = inputs[0] ?? {};
    expect(Object.keys(input).sort()).toEqual([
      "approach",
      "breach",
      "gap",
      "goal_id",
      "max_candidates",
      "objective",
      "open_items",
      "outcomes",
      "repo_layout",
      "trigger",
    ]);
    expect(input.trigger).toBe("gap");
    expect(input.gap).toEqual({ direction: "decrease", size: "medium" });
    expect(input.breach).toBeNull();
    expect((input.repo_layout as string[]).length).toBeGreaterThan(0);
    const prompt = readFileSync(join(fx.record, "stdin.txt"), "utf8");
    expect(prompt).toMatch(/"direction":\s*"decrease"/);
    expect(prompt).toMatch(/"size":\s*"medium"/);
    const requested = ledgerEvents(fx, "reconcile.requested");
    expect(requested).toHaveLength(1);
    expect(requested[0]?.payload.disclosed).toEqual({ gap: { direction: "decrease", size: "medium" }, breach: null });

    // A second tick on a different reading: the item from the first tick now appears in the input, still without canaries.
    setReading(fx, CANARY.nextReading);
    const second = tickCli(fx, ["--json"]);
    expect(second.code, second.stderr).toBe(0);
    const result = JSON.parse(second.stdout) as TickResult;
    expect(result.outcome).toBe("no_candidates");
    expect(result.rejected.map((r) => r.filter)).toEqual(["fingerprint"]);
    expectNoCanary(surfacesOf(fx, second));
    const inputsAfter = reconcileInputs(fx);
    expect(inputsAfter.map((i) => (i.open_items as unknown[]).length).sort()).toEqual([0, 1]);
    const withItem = inputsAfter.find((i) => (i.open_items as unknown[]).length === 1);
    const listed = (withItem?.open_items as Record<string, unknown>[] | undefined)?.[0] ?? {};
    expect(Object.keys(listed).sort()).toEqual(["affected_paths", "state", "title", "work_id"]);

    // The read-only commands print no canary either.
    for (const args of [
      ["goal", "status", fx.goalId, "--json"],
      ["work", "list", fx.goalId, "--json"],
    ]) {
      const out = omf(args, fx.repo, fx.home);
      expect(out.code, args.join(" ")).toBe(0);
      expectNoCanary({ [args.join(" ")]: `${out.stdout}\n${out.stderr}` });
    }
  });

  it.each<[string, EnforcementOptions]>([
    ["a threshold in the approach", { approach: `Get the reading under ${CANARY.target} ms.` }],
    ["the metric id in the approach", { approach: `Improve ${CANARY.metricId} by caching.` }],
    ["a value in the objective", { objective: `Reach ${CANARY.target} ms on the checkout page` }],
  ])("%s stops the tick with J1 approach_unusable and the model is never called", (_name, options) => {
    const fx = setupEnforcementGoal(options);
    useCleanModel(fx);

    const run = tickCli(fx, ["--json"]);
    expect(run.code, run.stderr).toBe(1);
    const result = JSON.parse(run.stdout) as TickResult;
    expect(result.status).toBe("blocked_on_user");
    expect(result.escalation).toMatchObject({ j: "J1", reason_code: "approach_unusable" });
    expect(result.next_steps.join("\n")).toContain(`omf goal resume ${fx.goalId}`);
    expect(existsSync(join(fx.record, "stdin.txt")), "the stub never ran").toBe(false);
    expect(ledgerEvents(fx, "reconcile.requested")).toHaveLength(0);
    expect(ledgerEvents(fx, "budget.consumed")).toHaveLength(0);
    expectNoCanary({
      "cli stdout": run.stdout,
      "cli stderr": run.stderr,
      "escalation event": payloadText(fx, "goal.escalated", "goal.terminated"),
    });
  });

  it("keeps the metric id out of `omf goal tick --json` when the audit stops on a tampered metric lock", () => {
    const fx = setupEnforcementGoal();
    useCleanModel(fx);
    // Edit the locked command in place; the lock hash no longer matches the ledger, so the tick stops at the audit.
    const file = lockFile(fx.location.dir, fx.goalId, CANARY.metricId);
    const lock = JSON.parse(readFileSync(file, "utf8")) as { command: string[] };
    lock.command = ["sh", "-c", "echo 1"];
    writeFileSync(file, JSON.stringify(lock));

    const run = tickCli(fx, ["--json"]);
    expect(run.code, run.stderr).toBe(1);
    const result = JSON.parse(run.stdout) as TickResult;
    expect(result.outcome).toBe("stopped");
    expect(existsSync(join(fx.record, "stdin.txt")), "the stub never ran").toBe(false);
    expectNoCanary({ "cli stdout": run.stdout, "cli stderr": run.stderr });
  });

  describe("a model that leaks the canaries on its own", () => {
    it("plants them in four text fields: each candidate is rejected and none of it is stored", () => {
      const fx = setupEnforcementGoal();
      useLeakyModel(fx, "text");

      const run = tickCli(fx, ["--json"]);
      expect(run.code, run.stderr).toBe(0);
      const result = JSON.parse(run.stdout) as TickResult;
      // The CLI strips titles from its JSON (D29), so the created item is checked by id and by what is stored.
      expect(result.created).toHaveLength(1);
      expect(joinTree(readTree(join(fx.goalPath, "work")))).toContain(CLEAN_TITLE);
      expect(result.rejected.map((r) => r.index)).toEqual([1, 2, 3, 4]);
      for (const rejection of result.rejected) expect(["schema", "seed_lint"], `candidate ${rejection.index}`).toContain(rejection.filter);

      // Positive control: the model really said them, and the raw output is kept on the host.
      expect(canaryHits(reconcileTexts(fx, "output").join("\n"))).toEqual(
        expect.arrayContaining(["reading", "target", "metric id", "reading digits"]),
      );
      expectNoCanary(surfacesOf(fx, run));

      // The events carry labels, never text.
      const created = ledgerEvents(fx, "work.created");
      expect(created).toHaveLength(1);
      expect(Object.keys(created[0]?.payload ?? {}).sort()).toEqual([
        "fingerprint",
        "goal_id",
        "item",
        "risk_class",
        "risk_rules",
        "state",
        "tick_id",
        "work_id",
      ]);
      const rejected = ledgerEvents(fx, "candidate.rejected");
      expect(rejected).toHaveLength(4);
      for (const event of rejected) {
        expect(Object.keys(event.payload).sort()).toEqual(["filter", "fingerprint", "goal_id", "index", "reason_code", "tick_id"]);
      }
    });

    it("plants them in candidate paths: both candidates are rejected and none of it is stored", () => {
      const fx = setupEnforcementGoal();
      useLeakyModel(fx, "paths");

      const run = tickCli(fx, ["--json"]);
      expect(run.code, run.stderr).toBe(0);
      const result = JSON.parse(run.stdout) as TickResult;
      // The CLI strips titles from its JSON (D29), so the created item is checked by id and by what is stored.
      expect(result.created).toHaveLength(1);
      expect(joinTree(readTree(join(fx.goalPath, "work")))).toContain(CLEAN_TITLE);
      expect(result.rejected.map((r) => r.index)).toEqual([1, 2]);
      for (const rejection of result.rejected) expect(["schema", "seed_lint"], `candidate ${rejection.index}`).toContain(rejection.filter);
      expect(canaryHits(reconcileTexts(fx, "output").join("\n"))).toEqual(expect.arrayContaining(["reading", "metric id"]));
      expectNoCanary(surfacesOf(fx, run));
    });

    it.each<[LeakChannel, string]>([
      ["threshold", "a threshold key"],
      ["nested-query", "a query key inside a text field"],
    ])("%s (%s) voids the whole response, the clean candidate included", (channel) => {
      const fx = setupEnforcementGoal();
      useLeakyModel(fx, channel);

      const run = tickCli(fx, ["--json"]);
      expect(run.code, `${run.stderr}${run.stdout}`).toBeLessThanOrEqual(1);
      expect(ledgerEvents(fx, "reconcile.requested")).toHaveLength(1);
      const failed = ledgerEvents(fx, "reconcile.failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]?.payload.code).toBe("schema_error");
      expect(ledgerEvents(fx, "work.created")).toHaveLength(0);
      expect(readTree(join(fx.goalPath, "work")).size, "no item was written").toBe(0);
      // The call happened, so it cost a round (D18): a model cannot probe for free.
      expect(ledgerEvents(fx, "budget.consumed")).toHaveLength(1);
      expectNoCanary(surfacesOf(fx, run));
    });

    it("holds a candidate aimed at the watched path for a person; the event names the rule, not the path", () => {
      const fx = setupEnforcementGoal();
      useCandidates(fx, [{ ...CLEAN_CANDIDATE, title: "Rewrite the measurement script", affected_paths: [CANARY.watchedPath] }]);

      const run = tickCli(fx, ["--json"]);
      expect(run.code, run.stderr).toBe(1);
      const result = JSON.parse(run.stdout) as TickResult;
      expect(result.created).toHaveLength(1);
      expect(result.created[0]).toMatchObject({ state: "awaiting_approval", risk: "high" });
      expect(result.awaiting_approval).toEqual(result.created.map((c) => c.work_id));
      expect(result.next_steps.join("\n")).toContain(`omf work approve ${result.created[0]?.work_id}`);

      const created = ledgerEvents(fx, "work.created");
      expect(created).toHaveLength(1);
      expect(created[0]?.payload).toMatchObject({ state: "awaiting_approval", risk_class: "high", risk_rules: ["watched-path"] });
      expectNoCanary({
        "cli stdout": run.stdout,
        "cli stderr": run.stderr,
        "reconciler stdin": readFileSync(join(fx.record, "stdin.txt"), "utf8"),
        "reconcile input files": reconcileTexts(fx, "input").join("\n"),
        "work.created payload": payloadText(fx, "work.created", "reconcile.requested"),
      });
    });
  });
});
