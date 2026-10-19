import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMarkdownStore } from "../../src/adapters/state-markdown.js";
import { Ledger } from "../../src/core/ledger.js";
import { resolveProject } from "../../src/core/paths.js";
import { initProject } from "../../src/core/project.js";
import * as audit from "../../src/goal/audit.js";
import { createGoal } from "../../src/goal/goal-file.js";
import { readUiSnapshot } from "../../src/ui/read-model.js";
import { buildEvidence, writeEvidence } from "../../src/work/evidence.js";
import { workIdOf } from "../../src/work/fingerprint.js";
import * as workProjection from "../../src/work/ledger-verify.js";
import { cleanBuild, cleanInputs } from "../helpers/evidence-fixture.js";
import { approveLegacy, setupGoal } from "../helpers/goal.js";
import { makeGitRepo, makeTempDir } from "../helpers/tmp.js";
import { createRecorded, FIXTURE_RUN_ID, makeNewItem, recordW, rewriteItem } from "../helpers/work.js";

const SECRET = "PRIVATE_CANARY_987654321";
const TICK = "t-20261012T100000Z-ab12";

function fixture(approved = false) {
  const fx = setupGoal();
  if (approved) approveLegacy(fx);
  return { ...fx, store: createMarkdownStore(fx.location.dir) };
}

function disclose(fx: ReturnType<typeof fixture>, gap: unknown = { direction: "decrease", size: "medium" }) {
  return fx.ledger.append({
    actor: "omf",
    type: "reconcile.requested",
    payload: {
      goal_id: "g-fast",
      tick_id: TICK,
      trigger: "gap",
      disclosed: { gap, breach: null },
      private_notes: SECRET,
    },
  });
}

function files(root: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      result[path] = {
        mode: stat.mode,
        mtime: stat.mtimeMs,
        text: stat.isFile() ? readFileSync(path).toString("base64") : null,
      };
      if (stat.isDirectory()) walk(path);
    }
  }
  walk(root);
  return result;
}

afterEach(() => vi.restoreAllMocks());

describe("readUiSnapshot", () => {
  it("reports missing state without initializing or creating files", () => {
    const repo = makeGitRepo();
    const home = makeTempDir();
    const before = files(home);
    expect(readUiSnapshot(repo, { OMF_HOME: join(home, ".omf") })).toMatchObject({
      status: "uninitialized",
      goals: [],
      events: [],
      ledger_head: null,
      warnings: ["project_uninitialized"],
    });
    expect(files(home)).toEqual(before);
  });

  it("projects safe work state and excludes payloads, actors, paths, metric values and arbitrary titles", () => {
    const fx = fixture();
    const item = createRecorded(fx.ledger, fx.store, makeNewItem({ title: SECRET, paths: [`private/${SECRET}`] }));
    writeFileSync(
      fx.goalFile,
      readFileSync(fx.goalFile, "utf8").replace("Say what this goal is in a few words", SECRET),
    );
    fx.ledger.append({
      actor: "human:private-email@example.invalid",
      type: "unknown.secret_event",
      payload: { goal_id: "g-fast", secret: SECRET, numeric: 987654321 },
    });
    fx.ledger.append({
      actor: "omf",
      type: "goal.tick_started",
      payload: { goal_id: "../../private", tick_id: TICK, notes: SECRET },
    });
    mkdirSync(join(fx.location.dir, "goals", "g-fast", "reports"));
    writeFileSync(
      join(fx.location.dir, "goals", "g-fast", "reports", "private-gap.json"),
      JSON.stringify({ secret: SECRET, metric_id: "m-private", value: 987654321 }),
    );
    const before = files(fx.home);
    const snapshot = readUiSnapshot(fx.repo, fx.env);
    expect(snapshot.status).toBe("ok");
    expect(snapshot.goals[0]).toMatchObject({
      goal_id: "g-fast",
      audit_state: "draft",
      run_state: "running",
      work_counts: { ready: 1 },
      work_items: [{ work_id: item.front.work_id, state: "ready", risk: "normal", evidence: null }],
    });
    expect(snapshot.ledger_head).toBe(fx.ledger.readVerified().at(-1)?.hash);
    const serialized = JSON.stringify(snapshot);
    for (const secret of [
      SECRET,
      "987654321",
      "m-p95",
      "m-private",
      "private-email",
      "private-gap",
      fx.location.dir,
      "unknown.secret_event",
      "../../private",
    ])
      expect(serialized).not.toContain(secret);
    expect(files(fx.home)).toEqual(before);
  });

  it("does not promote an unrecorded approval or malformed work projection", () => {
    const fx = fixture();
    const item = createRecorded(
      fx.ledger,
      fx.store,
      makeNewItem({ risk: { class: "high", rules: ["ci"], paths: [] } }),
    );
    rewriteItem(item, { state: "ready" });
    const snapshot = readUiSnapshot(fx.repo, fx.env);
    expect(snapshot.goals[0]?.work_items).toEqual([]);
    expect(snapshot.goals[0]?.work_counts.ready).toBe(0);
    expect(snapshot.goals[0]?.warnings).toContain("work_projection_invalid");
    expect(snapshot.goals[0]?.warnings).toContain("needs_human_unavailable");
  });

  it.each(["needs_reapproval", "tampered", "invalid"] as const)(
    "derives closed attention from %s goal audit state",
    (state) => {
      const fx = fixture(true);
      if (state === "needs_reapproval")
        writeFileSync(fx.goalFile, readFileSync(fx.goalFile, "utf8").replace("value: 250", "value: 987654321"));
      if (state === "tampered")
        writeFileSync(
          join(fx.location.dir, "vault", "metrics", "g-fast", "goal.lock.json"),
          JSON.stringify({ private: SECRET }),
        );
      if (state === "invalid") writeFileSync(fx.goalFile, SECRET);
      const snapshot = readUiSnapshot(fx.repo, fx.env);
      const goal = snapshot.goals[0];
      expect(goal?.audit_state).toBe(state);
      expect(goal?.needs_human).toContainEqual({
        code: state === "needs_reapproval" ? "J1" : state === "tampered" ? "goal_integrity_attention" : "goal_invalid",
        work_id: null,
      });
      if (state !== "needs_reapproval")
        expect(goal?.warnings).toContain(state === "tampered" ? "goal_integrity_attention" : "goal_invalid");
      if (state === "tampered") expect(goal?.needs_human).not.toContainEqual({ code: "J1", work_id: null });
      expect(JSON.stringify(snapshot)).not.toContain(SECRET);
      expect(JSON.stringify(snapshot)).not.toContain("987654321");
    },
  );

  it("marks the attention queue unknown when a goal audit cannot run", () => {
    const fx = fixture();
    vi.spyOn(audit, "auditGoal").mockImplementation(() => {
      throw new Error(SECRET);
    });
    const snapshot = readUiSnapshot(fx.repo, fx.env);
    expect(snapshot.goals[0]?.audit_state).toBe("unavailable");
    expect(snapshot.goals[0]?.warnings).toContain("goal_unavailable");
    expect(snapshot.goals[0]?.warnings).toContain("needs_human_unavailable");
    expect(JSON.stringify(snapshot)).not.toContain(SECRET);
  });

  it("marks the attention queue unknown for corrupt work metadata and work projection read failures", () => {
    const fx = fixture(true);
    const item = createRecorded(fx.ledger, fx.store, makeNewItem());
    writeFileSync(join(item.dir, "item.md"), SECRET);
    const malformed = readUiSnapshot(fx.repo, fx.env);
    expect(malformed.goals[0]?.work_items).toEqual([]);
    expect(malformed.goals[0]?.warnings).toContain("work_projection_invalid");
    expect(malformed.goals[0]?.warnings).toContain("needs_human_unavailable");
    expect(JSON.stringify(malformed)).not.toContain(SECRET);
    vi.spyOn(workProjection, "verifiedItems").mockImplementation(() => {
      throw new Error(SECRET);
    });
    const unavailable = readUiSnapshot(fx.repo, fx.env);
    expect(unavailable.goals[0]?.warnings).toContain("work_projection_invalid");
    expect(unavailable.goals[0]?.warnings).toContain("needs_human_unavailable");
    expect(JSON.stringify(unavailable)).not.toContain(SECRET);
  });

  it("projects the existing goal.audit_failed event without its private reasons payload", () => {
    const fx = fixture();
    const event = fx.ledger.append({
      actor: "omf",
      type: "goal.audit_failed",
      payload: { goal_id: "g-fast", reasons: [SECRET] },
    });
    const snapshot = readUiSnapshot(fx.repo, fx.env);
    expect(snapshot.events).toContainEqual({
      seq: event.seq,
      at: event.ts,
      type: "goal.audit_failed",
      goal_id: "g-fast",
      work_id: null,
    });
    expect(JSON.stringify(snapshot)).not.toContain(SECRET);
  });

  it("fails closed on a corrupt ledger and never includes error text", () => {
    const fx = fixture();
    appendFileSync(join(fx.location.dir, "ledger.jsonl"), `${SECRET}\n`);
    const before = files(fx.home);
    expect(readUiSnapshot(fx.repo, fx.env)).toMatchObject({
      status: "corrupt",
      goals: [],
      events: [],
      warnings: ["ledger_corrupt"],
    });
    expect(files(fx.home)).toEqual(before);
  });

  it("refuses state symlinks before parsing the target", () => {
    const fx = fixture();
    const outside = join(fx.home, "outside-private");
    writeFileSync(outside, SECRET);
    rmSync(join(fx.location.dir, "config.toml"));
    symlinkSync(outside, join(fx.location.dir, "config.toml"));
    const snapshot = readUiSnapshot(fx.repo, fx.env);
    expect(snapshot).toMatchObject({ status: "unavailable", goals: [], events: [], warnings: ["symlink_refused"] });
    expect(JSON.stringify(snapshot)).not.toContain(outside);
    expect(readFileSync(outside, "utf8")).toBe(SECRET);
  });

  it("shows only current approved-regime coarse disclosures and withholds a stale current gap", () => {
    const fx = fixture();
    disclose(fx);
    expect(readUiSnapshot(fx.repo, fx.env).goals[0]?.gap_history).toEqual([]);
    approveLegacy(fx);
    const event = disclose(fx);
    disclose(fx, { direction: SECRET, size: "large", value: 987654321 });
    const snapshot = readUiSnapshot(fx.repo, fx.env);
    expect(snapshot.goals[0]?.gap_history).toEqual([
      { seq: event.seq, at: event.ts, direction: "decrease", size: "medium" },
    ]);
    expect(snapshot.goals[0]?.gap?.seq).toBe(event.seq);
    fx.ledger.append({ actor: "omf", type: "goal.measured", payload: { goal_id: "g-fast", report: SECRET } });
    expect(readUiSnapshot(fx.repo, fx.env).goals[0]).toMatchObject({ gap: null, gap_history: [{ seq: event.seq }] });
    const approval = fx.ledger.readVerified().findLast((entry) => entry.type === "goal.approved");
    if (approval === undefined) throw new Error("fixture approval missing");
    fx.ledger.append({ actor: "human:dev", type: "goal.approved", payload: approval.payload });
    expect(readUiSnapshot(fx.repo, fx.env).goals[0]?.gap_history).toEqual([]);
  });

  it("derives current needs-human codes from decisions, ignoring stale or forged queue files", () => {
    const fx = fixture(true);
    const item = createRecorded(fx.ledger, fx.store, makeNewItem());
    writeFileSync(
      join(item.dir, "needs-human.json"),
      JSON.stringify({ question: SECRET, reasons: [{ code: SECRET }], options: [SECRET] }),
    );
    const before = files(fx.home);
    const snapshot = readUiSnapshot(fx.repo, fx.env);
    expect(snapshot.goals[0]?.needs_human).toContainEqual({ code: "interface_missing", work_id: item.front.work_id });
    expect(JSON.stringify(snapshot)).not.toContain(SECRET);
    expect(files(fx.home)).toEqual(before);
  });

  it("binds evidence recommendations to the ledger run and withholds report details", () => {
    const fx = fixture(true);
    const item = createRecorded(fx.ledger, fx.store, makeNewItem());
    recordW(fx.ledger, "work.started", item);
    recordW(fx.ledger, "work.submitted", item);
    rewriteItem(item, { state: "awaiting_review" });
    const doc = buildEvidence(
      cleanBuild({
        scope: { goal_id: "g-fast", work_id: item.front.work_id, run_id: FIXTURE_RUN_ID },
        inputs: { ...cleanInputs(), plan_summary: SECRET, implementer_notes: SECRET },
      }),
    );
    writeEvidence(item.dir, doc);
    const snapshot = readUiSnapshot(fx.repo, fx.env);
    expect(snapshot.goals[0]?.work_items[0]?.evidence).toEqual({
      recommendation: "merge_recommended",
    });
    expect(JSON.stringify(snapshot)).not.toContain(SECRET);
    writeEvidence(item.dir, { ...doc, run_id: "r-20261012T100000Z-abcd" });
    expect(readUiSnapshot(fx.repo, fx.env).goals[0]?.work_items[0]?.evidence).toBeNull();
  });

  it("does not change visible claims when same-run mutable evidence codes are edited", () => {
    const fx = fixture(true);
    const item = createRecorded(fx.ledger, fx.store, makeNewItem());
    recordW(fx.ledger, "work.started", item);
    recordW(fx.ledger, "work.submitted", item, { recommendation: "human_needed" });
    rewriteItem(item, { state: "awaiting_review" });
    const doc = buildEvidence(
      cleanBuild({
        scope: { goal_id: "g-fast", work_id: item.front.work_id, run_id: FIXTURE_RUN_ID },
        decisions: { list: [], masked: true },
      }),
    );
    writeEvidence(item.dir, doc);
    const before = readUiSnapshot(fx.repo, fx.env);
    writeEvidence(item.dir, {
      ...doc,
      unverified_areas: [],
      recommendation_reasons: ["noise_check_not_run"],
      implementer_notes: SECRET,
    });
    const after = readUiSnapshot(fx.repo, fx.env);
    expect(after.ledger_head).toBe(before.ledger_head);
    expect(after.goals[0]?.work_items[0]?.evidence).toEqual(before.goals[0]?.work_items[0]?.evidence);
    expect(after.goals[0]?.work_items[0]?.evidence).toEqual({ recommendation: "human_needed" });
    expect(JSON.stringify(after)).not.toContain("unverified_codes");
    expect(JSON.stringify(after)).not.toContain(SECRET);
  });

  it("rejects an oversized ledger before parsing any ledger content", () => {
    const fx = fixture();
    truncateSync(join(fx.location.dir, "ledger.jsonl"), 16 * 1024 * 1024 + 1);
    const inspect = vi.spyOn(Ledger.prototype, "inspect");
    expect(readUiSnapshot(fx.repo, fx.env)).toMatchObject({
      status: "unavailable",
      goals: [],
      events: [],
      warnings: ["resource_limit"],
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("rejects a FIFO ledger before attempting any ledger read", () => {
    const fx = fixture();
    const ledgerFile = join(fx.location.dir, "ledger.jsonl");
    rmSync(ledgerFile);
    execFileSync("mkfifo", [ledgerFile], { timeout: 1000 });
    // Throw if a regression reaches the reader, so this test can never block on the FIFO.
    const inspect = vi.spyOn(Ledger.prototype, "inspect").mockImplementation(() => {
      throw new Error("unexpected ledger read");
    });
    expect(readUiSnapshot(fx.repo, fx.env)).toMatchObject({
      status: "unavailable",
      goals: [],
      events: [],
      warnings: ["resource_limit"],
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each(["goal", "item", "evidence", "metric"])("rejects an oversized %s input before parsing state", (kind) => {
    const fx = fixture();
    const item = createRecorded(fx.ledger, fx.store, makeNewItem());
    const path =
      kind === "goal"
        ? fx.goalFile
        : kind === "metric"
          ? join(fx.location.dir, "vault", "metrics", "proposed", "m-p95.json")
          : join(item.dir, kind === "item" ? "item.md" : "evidence.json");
    if (kind === "evidence") writeFileSync(path, "");
    truncateSync(path, 1024 * 1024 + 1);
    const inspect = vi.spyOn(Ledger.prototype, "inspect");
    expect(readUiSnapshot(fx.repo, fx.env)).toMatchObject({
      status: "unavailable",
      goals: [],
      events: [],
      warnings: ["resource_limit"],
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("rejects excessive work directory entries before reading projections", () => {
    const fx = fixture();
    for (let n = 0; n < 1001; n++)
      mkdirSync(join(fx.location.dir, "goals", "g-fast", "work", `w-${n.toString(16).padStart(12, "0")}`), {
        recursive: true,
      });
    const inspect = vi.spyOn(Ledger.prototype, "inspect");
    expect(readUiSnapshot(fx.repo, fx.env)).toMatchObject({
      status: "unavailable",
      goals: [],
      events: [],
      warnings: ["resource_limit"],
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("retries an advancing ledger and returns only the new consistent revision", () => {
    const fx = fixture();
    const original = audit.auditGoal;
    let calls = 0;
    vi.spyOn(audit, "auditGoal").mockImplementation((...args) => {
      const result = original(...args);
      if (calls++ === 0)
        fx.ledger.append({ actor: "omf", type: "goal.tick_started", payload: { goal_id: "g-fast", tick_id: TICK } });
      return result;
    });
    const snapshot = readUiSnapshot(fx.repo, fx.env);
    expect(calls).toBe(2);
    expect(snapshot.status).toBe("ok");
    expect(snapshot.goals[0]?.ticks).toBe(1);
    expect(snapshot.ledger_head).toBe(fx.ledger.readVerified().at(-1)?.hash);
    expect(snapshot.warnings).toContain("concurrent_change");
  });

  it("returns an unavailable empty snapshot when both attempts cross revisions", () => {
    const fx = fixture();
    const original = audit.auditGoal;
    vi.spyOn(audit, "auditGoal").mockImplementation((...args) => {
      const result = original(...args);
      fx.ledger.append({ actor: "omf", type: "goal.tick_started", payload: { goal_id: "g-fast", tick_id: TICK } });
      return result;
    });
    expect(readUiSnapshot(fx.repo, fx.env)).toMatchObject({
      status: "unavailable",
      ledger_head: null,
      goals: [],
      events: [],
      warnings: ["concurrent_change"],
    });
  });

  it("bounds goals and the public timeline with explicit truncation", () => {
    const repo = makeGitRepo();
    const env = { OMF_HOME: join(makeTempDir(), ".omf") };
    initProject(repo, env);
    const location = resolveProject(repo, env);
    for (let n = 0; n < 52; n++) createGoal(location.dir, `g-test-${n}`);
    const ledger = new Ledger(location.dir);
    for (let n = 0; n < 105; n++)
      ledger.append({ actor: "omf", type: "goal.tick_started", payload: { goal_id: "g-test-0", tick_id: TICK } });
    const snapshot = readUiSnapshot(repo, env);
    expect(snapshot.goals).toHaveLength(50);
    expect(snapshot.events).toHaveLength(100);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.warnings).toContain("truncated");
  });

  it("caps work cards globally while retaining verified aggregate counts", () => {
    const fx = fixture();
    const inputs = Array.from({ length: 501 }, (_, n) =>
      makeNewItem({ title: `Item ${n}`, risk: { class: "high", rules: ["ci"], paths: [] } }),
    );
    fx.ledger.appendWithMany(() =>
      inputs.map((input) => ({
        actor: "omf",
        type: "work.created",
        payload: {
          goal_id: "g-fast",
          work_id: workIdOf(input.fingerprint),
          state: "awaiting_approval",
          risk_class: "high",
        },
      })),
    );
    for (const input of inputs) fx.store.createWorkItem(input, new Date("2026-10-12T10:00:00.000Z"));
    const snapshot = readUiSnapshot(fx.repo, fx.env);
    expect(snapshot.goals[0]?.work_items).toHaveLength(500);
    expect(snapshot.goals[0]?.work_counts.awaiting_approval).toBe(501);
    expect(snapshot.goals[0]?.truncated).toBe(true);
    expect(snapshot.truncated).toBe(true);
    createGoal(fx.location.dir, "g-zed");
    const withEmptyLaterGoal = readUiSnapshot(fx.repo, fx.env);
    expect(withEmptyLaterGoal.status).toBe("ok");
    expect(withEmptyLaterGoal.goals.map((goal) => goal.goal_id)).toEqual(["g-fast"]);
    expect(withEmptyLaterGoal.goals[0]?.work_items).toHaveLength(500);
    expect(withEmptyLaterGoal.truncated).toBe(true);
    expect(withEmptyLaterGoal.warnings).toContain("truncated");
    createRecorded(fx.ledger, fx.store, makeNewItem({ goalId: "g-zed", title: "Later goal work" }));
    const withNonemptyLaterGoal = readUiSnapshot(fx.repo, fx.env);
    expect(withNonemptyLaterGoal.status).toBe("ok");
    expect(withNonemptyLaterGoal.goals.map((goal) => goal.goal_id)).toEqual(["g-fast"]);
    expect(withNonemptyLaterGoal.goals[0]?.work_counts.awaiting_approval).toBe(501);
    expect(withNonemptyLaterGoal.truncated).toBe(true);
  });
});

import { execFileSync } from "node:child_process";
