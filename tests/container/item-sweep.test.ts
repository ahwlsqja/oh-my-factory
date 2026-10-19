import { describe, expect, it } from "vitest";
import { sweepItemOrphans } from "../../src/container/item-sweep.js";
import { MemoryRuntime } from "../helpers/memory-runtime.js";
import { put, realTempDir } from "../helpers/ops-fixture.js";

const SHARED_RUN = "r-20261001T090000Z-aaaa";
const X = "w-0123456789ab";
const Y = "w-ba9876543210";

describe("the item sweep selects by item, not by run id alone", () => {
  it("never removes the container of item X when item Y is swept and both planted the same run id", async () => {
    const itemY = realTempDir("omf-sweep-y-");
    put(itemY, `runs/${SHARED_RUN}/marker`, "x");
    const memory = new MemoryRuntime();
    memory.owned = [
      { kind: "container", name: `omf-author-${SHARED_RUN}-1-1`, run_id: SHARED_RUN, work_id: X },
      { kind: "container", name: `omf-implementer-${SHARED_RUN}-1-2`, run_id: SHARED_RUN, work_id: X },
      { kind: "container", name: `omf-author-${SHARED_RUN}-2-1`, run_id: SHARED_RUN, work_id: Y },
      { kind: "container", name: `omf-implementer-${SHARED_RUN}-2-2`, run_id: SHARED_RUN, work_id: Y },
    ];
    expect(await sweepItemOrphans({ runtime: memory, itemDir: itemY, workId: Y })).toBe(2);
    expect(memory.owned.map((resource) => resource.name).sort()).toEqual(
      [`omf-author-${SHARED_RUN}-1-1`, `omf-implementer-${SHARED_RUN}-1-2`].sort(),
    );
  });
});
