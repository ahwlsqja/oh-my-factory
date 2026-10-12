import { describe, expect, it } from "vitest";
import type { StateStore } from "../../src/adapters/state-markdown.js";
import { workIdOf } from "../../src/work/fingerprint.js";
import { WorkItemError } from "../../src/work/work-item.js";
import { HIGH_RISK, T0, T1, makeNewItem } from "./work.js";

/**
 * Behavior every StateStore must have, written against the interface only so M3 (or another tracker)
 * can run it on its own implementation (D13). `makeStore` returns a fresh, empty store each call.
 */
export function runStateStoreContract(name: string, makeStore: () => StateStore): void {
  describe(`StateStore contract: ${name}`, () => {
    const ready = makeNewItem({ title: "Cache the render path" });
    const gated = makeNewItem({ title: "Update the CI workflow", paths: [".github/workflows/ci.yml"], risk: HIGH_RISK });
    const readyId = workIdOf(ready.fingerprint);
    const gatedId = workIdOf(gated.fingerprint);

    it("opens normal-risk items as ready and high-risk items as awaiting_approval", () => {
      const store = makeStore();
      const normal = store.createWorkItem(ready, T0);
      const high = store.createWorkItem(gated, T0);
      expect(normal.created && normal.item.front.state).toBe("ready");
      expect(high.created && high.item.front.state).toBe("awaiting_approval");
      expect(normal.created && normal.item.front.work_id).toBe(readyId);
    });

    it("is idempotent on the fingerprint: a second create changes nothing", () => {
      const store = makeStore();
      store.createWorkItem(ready, T0);
      const again = store.createWorkItem(ready, T1);
      expect(again).toEqual({ created: false, reason: "exists", work_id: readyId });
      const items = store.fetchAllWorkItems("g-fast");
      expect(items.map((item) => item.front.updated_at)).toEqual([T0.toISOString()]);
    });

    it("fetches by state, and an empty state list gives an empty result", () => {
      const store = makeStore();
      store.createWorkItem(ready, T0);
      store.createWorkItem(gated, T0);
      expect(store.fetchWorkItemsByStates("g-fast", ["ready"]).map((item) => item.front.work_id)).toEqual([readyId]);
      expect(store.fetchWorkItemsByStates("g-fast", ["ready", "awaiting_approval"])).toHaveLength(2);
      expect(store.fetchWorkItemsByStates("g-fast", [])).toEqual([]);
      expect(store.fetchWorkItemsByStates("g-other", ["ready"])).toEqual([]);
      expect(store.fetchAllWorkItems("g-fast")).toHaveLength(2);
    });

    it("fetches by id in the order asked and throws on an id it does not hold", () => {
      const store = makeStore();
      store.createWorkItem(ready, T0);
      store.createWorkItem(gated, T0);
      expect(store.fetchWorkItemsByIds([gatedId, readyId]).map((item) => item.front.work_id)).toEqual([gatedId, readyId]);
      expect(() => store.fetchWorkItemsByIds([readyId, "w-ffffffffffff"])).toThrow(WorkItemError);
    });

    it("approves only awaiting_approval items and only for a person", () => {
      const store = makeStore();
      store.createWorkItem(ready, T0);
      store.createWorkItem(gated, T0);
      expect(() => store.approveWorkItem(gatedId, "omf", T1)).toThrow(/human actor/);
      expect(() => store.approveWorkItem(gatedId, "agent:claude", T1)).toThrow(/human actor/);
      expect(() => store.approveWorkItem(readyId, "human:dev", T1)).toThrow(/only awaiting_approval/);
      const approved = store.approveWorkItem(gatedId, "human:dev", T1);
      expect(approved.front.state).toBe("ready");
      expect(approved.front.approval).toEqual({ approved_by: "human:dev", approved_at: T1.toISOString() });
      expect(() => store.approveWorkItem(gatedId, "human:dev", T1)).toThrow(/only awaiting_approval/);
    });

    it("vetoes from ready and from awaiting_approval, records who and why, and needs a person and a reason", () => {
      const store = makeStore();
      store.createWorkItem(ready, T0);
      store.createWorkItem(gated, T0);
      expect(() => store.vetoWorkItem(readyId, "omf", "no", T1)).toThrow(/human actor/);
      expect(() => store.vetoWorkItem(readyId, "human:dev", "   ", T1)).toThrow(/1 to 500/);
      expect(() => store.vetoWorkItem(readyId, "human:dev", "x".repeat(501), T1)).toThrow(/1 to 500/);
      const vetoed = store.vetoWorkItem(readyId, "human:dev", " too risky ", T1);
      expect(vetoed.front.state).toBe("vetoed");
      expect(vetoed.front.veto).toEqual({ vetoed_by: "human:dev", vetoed_at: T1.toISOString(), reason: "too risky" });
      expect(store.vetoWorkItem(gatedId, "human:dev", "not now", T1).front.state).toBe("vetoed");
    });

    it("cancels from an open state as omf or as a person, but not as an agent", () => {
      const store = makeStore();
      store.createWorkItem(ready, T0);
      store.createWorkItem(gated, T0);
      expect(() => store.cancelWorkItem(readyId, "agent:claude", T1)).toThrow(/human actor/);
      expect(store.cancelWorkItem(readyId, "omf", T1).front.state).toBe("cancelled");
      expect(store.cancelWorkItem(gatedId, "human:dev", T1).front.state).toBe("cancelled");
    });

    it("rejects every change to a terminal item", () => {
      const store = makeStore();
      store.createWorkItem(ready, T0);
      store.vetoWorkItem(readyId, "human:dev", "no", T1);
      expect(() => store.approveWorkItem(readyId, "human:dev", T1)).toThrow(WorkItemError);
      expect(() => store.vetoWorkItem(readyId, "human:dev", "again", T1)).toThrow(WorkItemError);
      expect(() => store.cancelWorkItem(readyId, "omf", T1)).toThrow(WorkItemError);
      expect(store.fetchWorkItemsByIds([readyId])[0]?.front.state).toBe("vetoed");
    });

    it("stamps updated_at on each change and keeps the work id, fingerprint and created_at", () => {
      const store = makeStore();
      store.createWorkItem(gated, T0);
      const approved = store.approveWorkItem(gatedId, "human:dev", T1);
      const stored = store.fetchWorkItemsByIds([gatedId])[0];
      expect(stored?.front).toEqual(approved.front);
      expect(approved.front).toMatchObject({
        work_id: gatedId,
        fingerprint: gated.fingerprint,
        created_at: T0.toISOString(),
        updated_at: T1.toISOString(),
      });
    });

    it("fails an unknown id", () => {
      const store = makeStore();
      expect(() => store.approveWorkItem("w-ffffffffffff", "human:dev", T1)).toThrow(/unknown work item/);
      expect(() => store.vetoWorkItem("w-ffffffffffff", "human:dev", "no", T1)).toThrow(/unknown work item/);
      expect(() => store.cancelWorkItem("w-ffffffffffff", "omf", T1)).toThrow(/unknown work item/);
    });
  });
}
