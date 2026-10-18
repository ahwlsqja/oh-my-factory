import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// M3h: every control claim has an id and an honest state. This runs the real requirements.json against the real
// tests, documents and gated record, so a claim that loses its test, or a document that overstates one, fails here.
const SCRIPT = fileURLToPath(new URL("../../scripts/conformance-matrix.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

interface Row {
  id: string;
  state: string;
  last_recorded: string | null;
  tests: { path: string; gated: string | null; proves: string; counts: boolean }[];
}
const { computeMatrix } = (await import(SCRIPT)) as {
  computeMatrix: (options: { root: string }) => { rows: Row[]; problems: string[] };
};
const matrix = computeMatrix({ root: ROOT });
const row = (id: string): Row | undefined => matrix.rows.find((candidate) => candidate.id === id);

describe("W-conformance-matrix", () => {
  it("has no problem: nothing is missing and every document says what the state is", () => {
    expect(matrix.problems).toEqual([]);
    expect(matrix.rows.filter((candidate) => candidate.state === "missing")).toEqual([]);
  });

  it("gives every F1-F11, every section 11 rule and the gate, seal, verification and isolation sections an id", () => {
    const ids = matrix.rows.map((candidate) => candidate.id);
    const prefixes = [
      ...Array.from({ length: 11 }, (_, i) => `F${i + 1}.`),
      ...Array.from({ length: 6 }, (_, i) => `S11.${i + 1}.`),
      ...["S5.0.", "S5.2.", "S5.3.", "S5.4.", "S5.5.", "S5.7.", "S5.8.", "S7."],
    ];
    expect(prefixes.filter((prefix) => !ids.some((id) => id.startsWith(prefix)))).toEqual([]);
  });

  it("does not let the station smoke test, or an offline run, stand in for a real container", () => {
    const f6 = row("F6.vault-host-only");
    const smoke = f6?.tests.find((test) => test.path.endsWith("E6-station-smoke.test.ts"));
    expect(smoke).toMatchObject({ proves: "wiring_only", counts: false });
    // The claim is a known limit that only a real run can show; its offline test does not count without a gated record, so it stays unproven.
    expect(row("S7.docker-client-trusted")?.state).toBe("unproven");
  });

  it("shows the date of the recorded gated run behind a covered real-world requirement", () => {
    const judge = row("S5.5.judge-two-container");
    expect(judge?.state).toBe("covered");
    expect(judge?.last_recorded).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("keeps docs/conformance-matrix.md and the block in tests/enforcement/README.md current", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "--check"], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
