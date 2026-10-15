import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ProcessResult, runProcessGroup } from "../../src/adapters/process-group.js";
import { createHostFixtureRunner } from "../../src/scenario/fixtures.js";
import { observationOf } from "../../src/scenario/observe.js";
import { DEFAULT_STEP_LIMITS } from "../../src/scenario/runner.js";
import type { StepObservation } from "../../src/scenario/types.js";
import { makeTempDir } from "../helpers/tmp.js";

const exited = (status: number | null, signal: NodeJS.Signals | null, stdout: string): ProcessResult => ({
  kind: "exited",
  status,
  signal,
  stdout,
  stderr: "",
});

const TABLE: ReadonlyArray<{ name: string; result: ProcessResult; observation: StepObservation }> = [
  {
    name: "exit 0 with output",
    result: exited(0, null, "ok\n"),
    observation: { outcome: "exited", exit_code: 0, stdout: "ok\n" },
  },
  {
    name: "exit 3 with no output",
    result: exited(3, null, ""),
    observation: { outcome: "exited", exit_code: 3, stdout: "" },
  },
  {
    name: "ended by a signal",
    result: exited(null, "SIGKILL", ""),
    observation: { outcome: "signaled", signal: "SIGKILL" },
  },
  {
    name: "no status and no signal",
    result: exited(null, null, ""),
    observation: { outcome: "signaled", signal: "unknown" },
  },
  { name: "invalid UTF-8 (U+FFFD)", result: exited(0, null, "a�b"), observation: { outcome: "error" } },
  { name: "timeout", result: { kind: "timeout", stdout: "", stderr: "" }, observation: { outcome: "timeout" } },
  {
    name: "output limit",
    result: { kind: "output_limit", stdout: "", stderr: "" },
    observation: { outcome: "output_limit" },
  },
  { name: "spawn error", result: { kind: "error", code: "ENOENT", message: "x" }, observation: { outcome: "error" } },
];

describe("observationOf", () => {
  it("maps each ProcessResult to one observation", () => {
    for (const row of TABLE) expect(observationOf(row.result), row.name).toEqual(row.observation);
  });

  it("is the mapping the host fixture runner uses", async () => {
    for (const row of TABLE) {
      const exec: typeof runProcessGroup = async () => row.result;
      const runner = createHostFixtureRunner({ exec, scratchRoot: makeTempDir("omf-scratch-") });
      const session = await runner.openScenario({ kind: "fixture", id: "echo-everything" });
      try {
        expect(await session.runStep({ argv: [], stdin: "" }, DEFAULT_STEP_LIMITS), row.name).toEqual(row.observation);
      } finally {
        await session.close();
      }
    }
  });

  it("is defined once: fixtures.ts holds no mapping of its own", () => {
    const text = readFileSync(new URL("../../src/scenario/fixtures.ts", import.meta.url), "utf8");
    expect(text).toContain('from "./observe.js"');
    expect(text).not.toContain('case "timeout"');
  });
});
