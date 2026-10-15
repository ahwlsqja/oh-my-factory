import { describe, expect, it } from "vitest";
import { PROGRESS_MARKER_PATTERN, type RepairTarget, type StateStore } from "../../src/adapters/state-markdown.js";
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
    const gated = makeNewItem({
      title: "Update the CI workflow",
      paths: [".github/workflows/ci.yml"],
      risk: HIGH_RISK,
    });
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
      expect(store.fetchWorkItemsByIds([gatedId, readyId]).map((item) => item.front.work_id)).toEqual([
        gatedId,
        readyId,
      ]);
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
      expect(() => store.startWorkItem("w-ffffffffffff", T1)).toThrow(/unknown work item/);
      expect(() => store.submitWorkItemForReview("w-ffffffffffff", T1)).toThrow(/unknown work item/);
      expect(() => store.failWorkItem("w-ffffffffffff", T1)).toThrow(/unknown work item/);
      expect(() => store.repairWorkItem("w-ffffffffffff", "in_progress", T1)).toThrow(/unknown work item/);
      expect(() => store.setProgressMarker("w-ffffffffffff", "S3 working", T1)).toThrow(/unknown work item/);
    });

    describe("W transition verbs (M3b1)", () => {
      const T2 = new Date("2026-10-12T12:00:00.000Z");

      /** A fresh ready item with its own title, so its work id differs from every other item of the test. */
      function fresh(store: StateStore, title: string): string {
        const input = makeNewItem({ title });
        store.createWorkItem(input, T0);
        return workIdOf(input.fingerprint);
      }

      function stateOf(store: StateStore, workId: string): string | undefined {
        return store.fetchWorkItemsByIds([workId])[0]?.front.state;
      }

      it("starts only a ready item: a high-risk item waits for its approval", () => {
        const store = makeStore();
        store.createWorkItem(gated, T0);
        expect(() => store.startWorkItem(gatedId, T1)).toThrow(/only ready items can become in_progress/);
        store.approveWorkItem(gatedId, "human:dev", T1);
        const started = store.startWorkItem(gatedId, T2);
        expect(started.front.state).toBe("in_progress");
        expect(started.front.updated_at).toBe(T2.toISOString());
        expect(() => store.startWorkItem(gatedId, T2)).toThrow(/only ready items can become in_progress/);
      });

      it("submits and fails only from in_progress, and failing never leaves awaiting_review", () => {
        const store = makeStore();
        const submitted = fresh(store, "Item that is submitted");
        const failed = fresh(store, "Item that fails");
        expect(() => store.submitWorkItemForReview(submitted, T1)).toThrow(
          /only in_progress items can become awaiting_review/,
        );
        expect(() => store.failWorkItem(failed, T1)).toThrow(/only in_progress items can become failed/);

        store.startWorkItem(submitted, T1);
        store.startWorkItem(failed, T1);
        expect(store.submitWorkItemForReview(submitted, T2).front.state).toBe("awaiting_review");
        expect(store.failWorkItem(failed, T2).front.state).toBe("failed");

        // TRANSITIONS lists awaiting_review -> failed for a person at M4; no W verb may take that edge.
        expect(() => store.failWorkItem(submitted, T2)).toThrow(/only in_progress items can become failed/);
        expect(() => store.submitWorkItemForReview(submitted, T2)).toThrow(WorkItemError);
        expect(() => store.submitWorkItemForReview(failed, T2)).toThrow(WorkItemError);
        expect(() => store.failWorkItem(failed, T2)).toThrow(WorkItemError);
        expect(stateOf(store, submitted)).toBe("awaiting_review");
        expect(stateOf(store, failed)).toBe("failed");
      });

      it("leaves a terminal item alone: no W verb changes a vetoed or cancelled item", () => {
        const store = makeStore();
        const vetoed = fresh(store, "Item that is vetoed");
        const cancelled = fresh(store, "Item that is cancelled");
        store.vetoWorkItem(vetoed, "human:dev", "no", T1);
        store.cancelWorkItem(cancelled, "omf", T1);
        for (const id of [vetoed, cancelled]) {
          expect(() => store.startWorkItem(id, T2)).toThrow(WorkItemError);
          expect(() => store.submitWorkItemForReview(id, T2)).toThrow(WorkItemError);
          expect(() => store.failWorkItem(id, T2)).toThrow(WorkItemError);
          expect(() => store.repairWorkItem(id, "in_progress", T2)).toThrow(WorkItemError);
          expect(() => store.setProgressMarker(id, "S3 working", T2)).toThrow(WorkItemError);
        }
        expect(stateOf(store, vetoed)).toBe("vetoed");
        expect(stateOf(store, cancelled)).toBe("cancelled");
      });

      it("repairs exactly the three W edges and refuses every other pair", () => {
        const store = makeStore();
        const toRunning = fresh(store, "Repaired to in_progress");
        const toReview = fresh(store, "Repaired to awaiting_review");
        const toFailed = fresh(store, "Repaired to failed");
        store.startWorkItem(toReview, T1);
        store.startWorkItem(toFailed, T1);

        expect(store.repairWorkItem(toRunning, "in_progress", T2).front).toMatchObject({
          state: "in_progress",
          updated_at: T2.toISOString(),
        });
        expect(store.repairWorkItem(toReview, "awaiting_review", T2).front.state).toBe("awaiting_review");
        expect(store.repairWorkItem(toFailed, "failed", T2).front.state).toBe("failed");

        // awaiting_review -> failed is a legal TRANSITIONS edge but not a W edge.
        expect(() => store.repairWorkItem(toReview, "failed", T2)).toThrow(/only in_progress items can become failed/);
        // sideways, backward and terminal sources.
        expect(() => store.repairWorkItem(toRunning, "in_progress", T2)).toThrow(
          /only ready items can become in_progress/,
        );
        expect(() => store.repairWorkItem(toFailed, "in_progress", T2)).toThrow(WorkItemError);
        expect(() => store.repairWorkItem(toReview, "in_progress", T2)).toThrow(WorkItemError);
        // skipping an edge: ready -> awaiting_review.
        const skipped = fresh(store, "Item that must not skip");
        expect(() => store.repairWorkItem(skipped, "awaiting_review", T2)).toThrow(
          /only in_progress items can become awaiting_review/,
        );
        // targets that are not W edges at all.
        for (const target of ["done", "vetoed", "cancelled", "ready", "awaiting_approval"]) {
          expect(() => store.repairWorkItem(skipped, target as RepairTarget, T2)).toThrow(/not a W edge/);
        }
        expect(stateOf(store, skipped)).toBe("ready");
        expect(stateOf(store, toReview)).toBe("awaiting_review");
        expect(stateOf(store, toFailed)).toBe("failed");
      });

      it("takes a progress marker only in in_progress and replaces the region each time", () => {
        const store = makeStore();
        store.createWorkItem(ready, T0);
        expect(() => store.setProgressMarker(readyId, "S3 working", T1)).toThrow(
          /only in_progress items take a progress marker/,
        );
        store.startWorkItem(readyId, T1);
        const first = store.setProgressMarker(readyId, "S3 working", T2);
        expect(first.progress).toBe("S3 working\n");
        expect(first.front.updated_at).toBe(T2.toISOString());
        expect(store.setProgressMarker(readyId, "S4 handed_off", T2).progress).toBe("S4 handed_off\n");
        expect(store.fetchWorkItemsByIds([readyId])[0]?.progress).toBe("S4 handed_off\n");
        store.submitWorkItemForReview(readyId, T2);
        expect(() => store.setProgressMarker(readyId, "S5 working", T2)).toThrow(
          /only in_progress items take a progress marker/,
        );
      });

      it("refuses a progress marker outside the closed grammar", () => {
        const store = makeStore();
        store.createWorkItem(ready, T0);
        store.startWorkItem(readyId, T1);
        const refused = [
          "S3 working\nS4 working", // multi-line
          "S3 working\n", // trailing newline
          "S3 work\u0007ing", // control character
          "S3 work‮ing", // bidi override
          "S3 p95_over_40ms", // digits: a planted metric name or target
          "S3 latency 40", // free text
          "S8 working",
          "S0 working",
          "S3  working",
          "s3 working",
          "S3 ",
          `S3 ${"a".repeat(41)}`,
          "S3 <!-- /omf:progress -->", // the progress region's own markers
          "S3 <!-- omf:progress -->",
          "",
        ];
        for (const marker of refused) {
          expect(PROGRESS_MARKER_PATTERN.test(marker), JSON.stringify(marker)).toBe(false);
          expect(() => store.setProgressMarker(readyId, marker, T2), JSON.stringify(marker)).toThrow(/progress marker/);
        }
        expect(store.fetchWorkItemsByIds([readyId])[0]?.progress).toBe("");
        expect(store.setProgressMarker(readyId, `S7 ${"a".repeat(40)}`, T2).front.state).toBe("in_progress");
      });

      it("stamps updated_at on every verb and keeps the work id, fingerprint, created_at, approval and veto", () => {
        const store = makeStore();
        store.createWorkItem(gated, T0);
        store.approveWorkItem(gatedId, "human:dev", T1);
        const approval = { approved_by: "human:dev", approved_at: T1.toISOString() };
        let stamp = 0;
        for (const step of [
          () => store.startWorkItem(gatedId, new Date(T2.getTime() + 1000 * ++stamp)),
          () => store.setProgressMarker(gatedId, "S2 working", new Date(T2.getTime() + 1000 * ++stamp)),
          () => store.submitWorkItemForReview(gatedId, new Date(T2.getTime() + 1000 * ++stamp)),
        ]) {
          const changed = step();
          expect(changed.front).toMatchObject({
            work_id: gatedId,
            fingerprint: gated.fingerprint,
            created_at: T0.toISOString(),
            updated_at: new Date(T2.getTime() + 1000 * stamp).toISOString(),
            approval,
            veto: null,
          });
          expect(store.fetchWorkItemsByIds([gatedId])[0]?.front).toEqual(changed.front);
        }
      });

      it("has no method that can write done: the surface is the named verbs only", () => {
        const store = makeStore();
        const surface: string[] = [];
        for (const key in store) surface.push(key);
        expect(surface.filter((key) => /complete|done|ship|finish|setState|update/i.test(key))).toEqual([]);
        for (const verb of [
          "startWorkItem",
          "submitWorkItemForReview",
          "failWorkItem",
          "repairWorkItem",
          "setProgressMarker",
        ]) {
          expect(surface, verb).toContain(verb);
        }
        // The only parametrised verb, repair, refuses a done target (see the repair case above).
        const id = fresh(store, "Item that is never done");
        store.startWorkItem(id, T1);
        store.submitWorkItemForReview(id, T1);
        expect(() => store.repairWorkItem(id, "done" as never, T2)).toThrow(/not a W edge/);
        expect(stateOf(store, id)).toBe("awaiting_review");
      });
    });
  });
}
