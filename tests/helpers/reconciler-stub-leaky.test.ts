import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CANARY, CLEAN_CANDIDATE, canaryHits } from "./canary.js";
import { makeTempDir } from "./tmp.js";

const STUB = fileURLToPath(new URL("./reconciler-stub.mjs", import.meta.url));

type Candidate = Record<string, unknown>;

/** Runs the stub in leaky mode as a command reconciler would: prompt on stdin, JSON on stdout. */
function leak(channel: string): { status: number | null; candidates: Candidate[]; stdout: string } {
  const record = makeTempDir("omf-rec-");
  const canaries = join(record, "canaries.json");
  writeFileSync(canaries, JSON.stringify({ value: CANARY.reading, target: CANARY.target, metric_id: CANARY.metricId }));
  const result = spawnSync(process.execPath, [STUB, "leaky", record, canaries, channel], { input: "prompt", encoding: "utf8" });
  const candidates = result.stdout === "" ? [] : (JSON.parse(result.stdout) as { candidates: Candidate[] }).candidates;
  return { status: result.status, candidates, stdout: result.stdout };
}

describe("reconciler-stub leaky mode", () => {
  it("text: a clean control first, then four candidates that each leak a different canary", () => {
    const { status, candidates } = leak("text");
    expect(status).toBe(0);
    expect(candidates).toHaveLength(5);
    expect(candidates[0]).toEqual(CLEAN_CANDIDATE);
    expect(canaryHits(JSON.stringify(candidates[0]))).toEqual([]);
    for (const leaky of candidates.slice(1)) expect(canaryHits(JSON.stringify(leaky)).length, JSON.stringify(leaky)).toBeGreaterThan(0);
    expect(canaryHits(JSON.stringify(candidates.slice(1)))).toEqual(
      expect.arrayContaining(["reading", "target", "reading digits", "metric id"]),
    );
  });

  it("paths: a clean control, then two candidates whose only fault is their path", () => {
    const { status, candidates } = leak("paths");
    expect(status).toBe(0);
    expect(candidates).toHaveLength(3);
    expect(candidates[0]).toEqual(CLEAN_CANDIDATE);
    expect(candidates[1]?.affected_paths).toEqual([`docs/${CANARY.metricId}.md`]);
    expect(candidates[2]?.affected_paths).toEqual([`bench/p${CANARY.reading}.sh`]);
  });

  it("threshold: a forbidden top-level key on the second candidate", () => {
    const { status, candidates } = leak("threshold");
    expect(status).toBe(0);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toEqual(CLEAN_CANDIDATE);
    expect(candidates[1]?.threshold).toBe(Number(CANARY.target));
  });

  it("nested-query: a forbidden key one level down in a text field", () => {
    const { status, candidates } = leak("nested-query");
    expect(status).toBe(0);
    expect(candidates).toHaveLength(2);
    const nested = candidates[1]?.affected_users_systems as { query?: string } | undefined;
    expect(nested?.query).toContain(CANARY.target);
  });

  it("refuses an unknown channel instead of printing a clean response", () => {
    const { status, stdout } = leak("typo");
    expect(status).toBe(4);
    expect(stdout).toBe("");
  });
});
