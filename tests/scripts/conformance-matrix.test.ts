import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../helpers/tmp.js";

// The conformance matrix script (M3h). The fixtures below build a tiny repository per case, so every state
// and every document rule is exercised without touching the real requirements.
const SCRIPT = fileURLToPath(new URL("../../scripts/conformance-matrix.mjs", import.meta.url));

interface Row {
  id: string;
  state: "covered" | "unproven" | "deferred" | "missing";
  last_recorded: string | null;
}
interface Matrix {
  rows: Row[];
  problems: string[];
}
const { computeMatrix } = (await import(SCRIPT)) as { computeMatrix: (options: { root: string }) => Matrix };

const README =
  "# Enforcement tests\n\n<!-- requirements:start -->\n<!-- requirements:end -->\n\n| Test | Claim | Spec |\n";

interface Fixture {
  requirements: object[];
  files?: Record<string, string>;
  records?: { test: string; at: string }[];
}

function fixture(input: Fixture): string {
  const root = makeTempDir("omf-matrix-");
  const put = (rel: string, text: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  put("docs/requirements.json", JSON.stringify({ schema_version: 1, requirements: input.requirements }));
  const runs = (input.records ?? []).map((record) => ({
    ...record,
    result: "pass",
    omf_commit: "0".repeat(40),
    docker: { server_version: "29.2.1", context: "colima-omf-m3f", arch: "aarch64" },
  }));
  put("docs/evidence/gated-runs.json", JSON.stringify({ schema_version: 1, runs }));
  put("tests/enforcement/README.md", README);
  for (const [rel, text] of Object.entries(input.files ?? {})) put(rel, text);
  return root;
}

const req = (id: string, extra: object = {}): object => ({ id, source: "spec test", claim: "A claim.", ...extra });
const marked = (...ids: string[]): string =>
  `${ids.map((id) => `// covers: ${id}`).join("\n")}\nimport { it } from "vitest";\n`;
const stateOf = (matrix: Matrix, id: string): string | undefined => matrix.rows.find((row) => row.id === id)?.state;

function cli(root: string, ...args: string[]): { status: number | null; out: string; err: string } {
  const result = spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], { encoding: "utf8" });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

describe("computeMatrix", () => {
  it("calls a mapped file that is absent, or has no marker, missing and reports why", () => {
    const root = fixture({
      requirements: [
        req("F1.absent-file", { tests: [{ path: "tests/enforcement/gone.test.ts" }] }),
        req("F1.no-marker", { tests: [{ path: "tests/enforcement/plain.test.ts" }] }),
      ],
      files: { "tests/enforcement/plain.test.ts": 'import { it } from "vitest";\n' },
    });
    const matrix = computeMatrix({ root });
    expect(matrix.rows.map((row) => row.state)).toEqual(["missing", "missing"]);
    expect(matrix.problems).toEqual([
      "F1.absent-file: tests/enforcement/gone.test.ts does not exist",
      'F1.no-marker: tests/enforcement/plain.test.ts has no "// covers: F1.no-marker" marker',
    ]);
  });

  it("never counts a wiring_only entry, and asks it for no marker", () => {
    const root = fixture({
      requirements: [
        req("F2.only-wiring", { tests: [{ path: "tests/enforcement/wire.test.ts", proves: "wiring_only" }] }),
        req("F2.has-behavior", {
          tests: [
            { path: "tests/enforcement/wire.test.ts", proves: "wiring_only" },
            { path: "tests/enforcement/real.test.ts" },
          ],
        }),
      ],
      files: {
        "tests/enforcement/wire.test.ts": 'import { it } from "vitest";\n',
        "tests/enforcement/real.test.ts": marked("F2.has-behavior"),
      },
    });
    const matrix = computeMatrix({ root });
    expect(stateOf(matrix, "F2.only-wiring")).toBe("missing");
    expect(stateOf(matrix, "F2.has-behavior")).toBe("covered");
    expect(matrix.problems).toEqual(["F2.only-wiring: no test that counts (wiring_only entries never count)"]);
  });

  it("covers a real-world requirement only with a gated record, and shows the latest date", () => {
    const root = fixture({
      requirements: [
        req("F6.offline-only", {
          real_world: true,
          surfaces: ["docs/a.md"],
          tests: [{ path: "tests/enforcement/o.test.ts" }],
        }),
        req("F6.gated-no-record", {
          real_world: true,
          surfaces: ["docs/a.md"],
          tests: [{ path: "tests/gated/a.test.ts", gated: "G-no-record" }],
        }),
        req("F6.gated-recorded", { real_world: true, tests: [{ path: "tests/gated/b.test.ts", gated: "G-recorded" }] }),
      ],
      files: {
        "tests/enforcement/o.test.ts": marked("F6.offline-only"),
        "tests/gated/a.test.ts": marked("F6.gated-no-record"),
        "tests/gated/b.test.ts": marked("F6.gated-recorded"),
        "docs/a.md": "[not enforced: F6.offline-only]\n[not enforced: F6.gated-no-record]\n",
      },
      records: [
        { test: "G-recorded", at: "2026-10-01T08:00:00.000Z" },
        { test: "G-recorded", at: "2026-10-15T10:18:45.012Z" },
      ],
    });
    const matrix = computeMatrix({ root });
    expect(matrix.problems).toEqual([]);
    expect(matrix.rows.map((row) => [row.id, row.state, row.last_recorded])).toEqual([
      ["F6.offline-only", "unproven", null],
      ["F6.gated-no-record", "unproven", null],
      ["F6.gated-recorded", "covered", "2026-10-15"],
    ]);
  });

  it("lists a deferred requirement without failing, and makes its surfaces say so", () => {
    const ok = fixture({
      requirements: [req("F4.deferred-ok", { deferred_to: "M4", surfaces: ["docs/x.md"] })],
      files: { "docs/x.md": "F4.deferred-ok: not implemented (deferred to M4)\n" },
    });
    const good = computeMatrix({ root: ok });
    expect(stateOf(good, "F4.deferred-ok")).toBe("deferred");
    expect(good.problems).toEqual([]);

    const bad = fixture({
      requirements: [
        req("F4.deferred-silent", { deferred_to: "M4", surfaces: ["docs/y.md"] }),
        req("F4.deferred-tests", {
          deferred_to: "M4",
          surfaces: ["docs/y.md"],
          tests: [{ path: "tests/enforcement/t.test.ts" }],
        }),
      ],
      files: {
        "docs/y.md": "F4.deferred-tests: not implemented (deferred to M4)\n",
        "tests/enforcement/t.test.ts": marked("F4.deferred-tests"),
      },
    });
    expect(computeMatrix({ root: bad }).problems).toEqual([
      'F4.deferred-silent: docs/y.md does not say "F4.deferred-silent: not implemented (deferred to M4)"',
      "F4.deferred-tests: a deferred requirement must list no tests",
    ]);
  });

  it("wants the not-enforced marker exactly in the surfaces of unproven requirements", () => {
    const root = fixture({
      requirements: [
        req("F6.unproven-ok", {
          real_world: true,
          surfaces: ["docs/a.md"],
          tests: [{ path: "tests/enforcement/m.test.ts" }],
        }),
        req("F6.stale", { surfaces: ["docs/b.md"], tests: [{ path: "tests/enforcement/m.test.ts" }] }),
        req("F6.hidden", { real_world: true, tests: [{ path: "tests/enforcement/m.test.ts" }] }),
        req("F6.silent", {
          real_world: true,
          surfaces: ["docs/c.md"],
          tests: [{ path: "tests/enforcement/m.test.ts" }],
        }),
      ],
      files: {
        "tests/enforcement/m.test.ts": marked("F6.unproven-ok", "F6.stale", "F6.hidden", "F6.silent"),
        "docs/a.md": "[not enforced: F6.unproven-ok]\n",
        "docs/b.md": "[not enforced: F6.stale]\n",
        "docs/c.md": "nothing here\n",
      },
    });
    expect(computeMatrix({ root }).problems).toEqual([
      "F6.stale: docs/b.md still says [not enforced: F6.stale] but the requirement is covered",
      "F6.hidden: an unproven requirement lists no surface",
      "F6.silent: docs/c.md lacks [not enforced: F6.silent]",
    ]);
  });

  it("reports a document that breaks the schema or repeats an id instead of throwing", () => {
    const invalid = computeMatrix({ root: fixture({ requirements: [{ id: "nope", source: "s", claim: "c" }] }) });
    expect(invalid.rows).toEqual([]);
    expect(invalid.problems.join("\n")).toContain(
      "docs/requirements.json does not match schemas/requirements.schema.json",
    );

    const twice = fixture({
      requirements: [req("F1.twice", { deferred_to: "M4" }), req("F1.twice", { deferred_to: "M4" })],
    });
    expect(computeMatrix({ root: twice }).problems).toContain("F1.twice appears twice in docs/requirements.json");
  });
});

describe("conformance-matrix --write and --check", () => {
  const unprovenRoot = (): string =>
    fixture({
      requirements: [
        req("F6.offline-only", {
          real_world: true,
          surfaces: ["docs/a.md"],
          tests: [{ path: "tests/enforcement/o.test.ts" }],
        }),
      ],
      files: {
        "tests/enforcement/o.test.ts": marked("F6.offline-only"),
        "docs/a.md": "[not enforced: F6.offline-only]\n",
      },
    });

  it("fails on a missing requirement, and --write then writes nothing", () => {
    const root = fixture({
      requirements: [req("F1.absent-file", { tests: [{ path: "tests/enforcement/gone.test.ts" }] })],
    });
    const check = cli(root, "--check");
    expect(check.status).toBe(1);
    expect(check.err).toContain("F1.absent-file: tests/enforcement/gone.test.ts does not exist");
    expect(cli(root, "--write").status).toBe(1);
    expect(existsSync(join(root, "docs/conformance-matrix.md"))).toBe(false);
  });

  it("accepts an unproven requirement, writes the generated files and then finds them current", () => {
    const root = unprovenRoot();
    expect(cli(root, "--check").status).toBe(1); // nothing generated yet
    const write = cli(root, "--write");
    expect(write.status).toBe(0);
    expect(write.out).toContain("0 covered, 1 unproven, 0 deferred, 0 missing");
    expect(readFileSync(join(root, "docs/conformance-matrix.md"), "utf8")).toContain(
      "| `F6.offline-only` | unproven |",
    );
    expect(readFileSync(join(root, "tests/enforcement/README.md"), "utf8")).toContain("- unproven: `F6.offline-only`");
    expect(cli(root, "--check").status).toBe(0);
  });

  it("names a generated file that drifted", () => {
    const root = unprovenRoot();
    cli(root, "--write");
    writeFileSync(join(root, "docs/conformance-matrix.md"), "stale\n");
    const check = cli(root, "--check");
    expect(check.status).toBe(1);
    expect(check.err).toContain("docs/conformance-matrix.md is out of date");
  });

  it("exits 2 with a usage line when no mode is given", () => {
    const result = cli(unprovenRoot());
    expect(result.status).toBe(2);
    expect(result.err).toContain("usage: node scripts/conformance-matrix.mjs");
  });
});
