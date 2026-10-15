import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CanaryIndexEntry, attributeCanaryHits } from "../../src/audit/attribute.js";
import { type AuditSurface, textSurface } from "../../src/audit/canary-scan.js";
import { scenarioRef } from "../../src/scenario/types.js";
import type { StoredScenario } from "../../src/scenario/types.js";
import { listVaultCanaryIndex, setDir, writeScenarioSet } from "../../src/vault/vault.js";
import { WORK_ID, digest, hex, sealId, sealRecord, storedScenario } from "../helpers/stored-scenario.js";
import { setupVault } from "../helpers/vault-project.js";

const entryOf = (scenario: StoredScenario, seal: number): CanaryIndexEntry => ({
  canary: scenario.canary,
  scenario_ref: scenarioRef(scenario.scenario_id),
  seal_id: sealId(seal),
  scenario_id: scenario.scenario_id,
});

describe("listVaultCanaryIndex", () => {
  it("names the scenario behind every canary of a verified set and keeps a mismatching set apart", () => {
    const v = setupVault();
    const first = [storedScenario(1), storedScenario(2, { split: "test" })];
    const second = [storedScenario(3)];
    const a = writeScenarioSet(v.vault, { work_id: WORK_ID, seal_id: sealId(1) }, first);
    const b = writeScenarioSet(v.vault, { work_id: WORK_ID, seal_id: sealId(2) }, second);
    const seals = [sealRecord(1, a.set_sha256), sealRecord(2, b.set_sha256)];

    expect(listVaultCanaryIndex(v.vault, WORK_ID, seals)).toEqual({
      index: [entryOf(first[0]!, 1), entryOf(first[1]!, 1), entryOf(second[0]!, 2)],
      unverified: [],
      unverified_canaries: [],
    });

    // A hand edit changes the digest: the set marks nothing, but its canary-shaped strings are still scanned for.
    const file = join(setDir(v.vault, { work_id: WORK_ID, seal_id: sealId(2) }), `${second[0]!.scenario_id}.yaml`);
    writeFileSync(file, readFileSync(file, "utf8").replace("adding item 3", "adding item three"));
    expect(listVaultCanaryIndex(v.vault, WORK_ID, [...seals, sealRecord(3, digest("c"))])).toEqual({
      index: [entryOf(first[0]!, 1), entryOf(first[1]!, 1)],
      unverified: [sealId(2), sealId(3)],
      unverified_canaries: [second[0]!.canary],
    });
  });
});

const index: CanaryIndexEntry[] = Array.from({ length: 32 }, (_, i) => ({
  canary: `omf-canary-${hex(i + 1, 32)}`,
  scenario_ref: hex(i + 1, 16),
  seal_id: sealId(1),
  scenario_id: `s-${hex(i + 1, 32)}`,
}));

function countingSurface(text: string) {
  let reads = 0;
  const surface: AuditSurface = {
    kind: "implementer_log",
    async *read() {
      reads += 1;
      yield Buffer.from(text);
    },
  };
  return { surface, reads: () => reads };
}

describe("attributeCanaryHits", () => {
  it("names exactly the canaries that are on a surface, in index order", async () => {
    const log = textSurface("implementer_log", `x ${index[2]!.canary} y ${index[29]!.canary} z`);
    const clean = textSurface("prompt", "nothing to see");
    expect(await attributeCanaryHits(index, [clean, log])).toEqual([index[2], index[29]]);
    expect(await attributeCanaryHits(index, [clean])).toEqual([]);
    expect(await attributeCanaryHits([], [log])).toEqual([]);
  });

  it("narrows down by halves instead of scanning each canary", async () => {
    const counted = countingSurface(`x ${index[7]!.canary} y`);
    expect(await attributeCanaryHits(index, [counted.surface])).toEqual([index[7]]);
    expect(counted.reads()).toBeLessThan(index.length);
  });
});
