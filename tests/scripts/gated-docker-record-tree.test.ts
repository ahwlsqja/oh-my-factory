import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../helpers/tmp.js";

// Consecutive --record runs: the first one leaves docs/evidence/gated-runs.json modified, and the next run must still start.
// Any other change in the tree is still refused, because a record names the commit that was tested.
const SCRIPT = fileURLToPath(new URL("../../scripts/gated-docker.mjs", import.meta.url));

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}
interface Deps {
  run: (command: string, args: string[], options?: { cwd?: string; env?: Record<string, string> }) => RunResult;
  makeTempDir: (prefix: string) => string;
  log: (message: string) => void;
  now: () => Date;
  root: string;
  evidenceFile: string;
}
const script = (await import(SCRIPT)) as {
  EXIT: { ok: number; refused: number };
  main: (argv: string[], env: Record<string, string | undefined>, deps: Deps) => number;
};

const COMMIT = "b".repeat(40);
const OK: RunResult = { status: 0, stdout: "", stderr: "" };
const REPORT = {
  testResults: [{ assertionResults: [{ ancestorTitles: ["G-inspect-parser-real"], status: "passed" }] }],
};

function run(porcelain: string) {
  const logs: string[] = [];
  const root = makeTempDir("omf-gated-tree-");
  const evidenceFile = join(root, "gated-runs.json");
  writeFileSync(evidenceFile, `${JSON.stringify({ schema_version: 1, runs: [] })}\n`);
  const deps: Deps = {
    run: (command, args) => {
      if (command === "git" && args[0] === "status") return { ...OK, stdout: porcelain };
      if (command === "git" && args[0] === "rev-parse") return { ...OK, stdout: `${COMMIT}\n` };
      if (command === "docker" && args[0] === "context" && args[1] === "inspect")
        return { ...OK, stdout: "unix:///home/dev/.colima/omf-m3f/docker.sock\n" };
      if (command === "docker" && args[0] === "context" && args[1] === "show") return { ...OK, stdout: "default\n" };
      if (command === "docker" && args[0] === "--context") return { ...OK, stdout: "29.0.0 aarch64\n" };
      const out = args.find((arg) => arg.startsWith("--outputFile.json="));
      if (out !== undefined) writeFileSync(out.slice("--outputFile.json=".length), JSON.stringify(REPORT));
      return OK;
    },
    makeTempDir,
    log: (message) => logs.push(message),
    now: () => new Date(Date.UTC(2026, 9, 19)),
    root,
    evidenceFile,
  };
  return { status: script.main(["--record"], {}, deps), logs };
}

describe("--record on a tree that holds earlier records", () => {
  it("runs when the only change is the evidence file, and says the earlier records are not committed", () => {
    const { status, logs } = run(" M docs/evidence/gated-runs.json\n");
    expect(status).toBe(script.EXIT.ok);
    expect(logs.join("\n")).toContain("records pending");
    expect(logs.join("\n")).toContain(COMMIT);
  });

  it("runs on a clean tree and says the new record is not committed yet", () => {
    const { status, logs } = run("");
    expect(status).toBe(script.EXIT.ok);
    expect(logs.join("\n")).toContain("records pending");
  });

  it("still refuses when anything besides the evidence file changed", () => {
    for (const porcelain of [
      " M src/core/doctor.ts\n",
      " M docs/evidence/gated-runs.json\n M README.md\n",
      "?? docs/evidence/gated-runs.json.bak\n",
      "?? scratch.txt\n",
    ]) {
      const { status, logs } = run(porcelain);
      expect(status, porcelain).toBe(script.EXIT.refused);
      expect(logs.join("\n")).toContain("--record needs a clean working tree");
    }
  });
});
