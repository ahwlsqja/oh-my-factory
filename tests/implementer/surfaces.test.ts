import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanCanaries } from "../../src/audit/canary-scan.js";
import { implementerLogSurface, promptSurface, workspaceSurface } from "../../src/implementer/surfaces.js";
import { CANARY_A } from "../helpers/scenario-fixture.js";
import { makeTempDir } from "../helpers/tmp.js";

const clean = { bytes: Buffer.from("nothing here"), complete: true };

function tree(files: Record<string, string>): string {
  const dir = makeTempDir("omf-surface-");
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

describe("workspaceSurface", () => {
  it("finds a canary in the exported tree and in the capture, each on its own", async () => {
    const inTree = workspaceSurface({ treeDir: tree({ "src/a.txt": `note ${CANARY_A}` }), capture: clean });
    const inCapture = workspaceSurface({
      treeDir: tree({ "src/a.txt": "plain" }),
      capture: { bytes: Buffer.from(`tmp file ${CANARY_A}`), complete: true },
    });
    for (const surface of [inTree, inCapture]) {
      const scan = await scanCanaries([CANARY_A], [surface], ["worktree"]);
      expect(scan.total).toBe(1);
      expect(scan.status).toBe("scanned");
    }
  });

  it("is incomplete, so the scan is not_run, when the capture was cut short", async () => {
    const surface = workspaceSurface({
      treeDir: tree({ "src/a.txt": "plain" }),
      capture: { bytes: Buffer.alloc(0), complete: false },
    });
    const scan = await scanCanaries([CANARY_A], [surface], ["worktree"]);
    expect(scan.status).toBe("not_run");
    expect(scan.truncated).toBe(true);
  });
});

describe("implementerLogSurface and promptSurface", () => {
  it("marks a truncated log incomplete and an untruncated one complete", async () => {
    const whole = await scanCanaries([CANARY_A], [implementerLogSurface("fine")], ["implementer_log"]);
    const cut = await scanCanaries(
      [CANARY_A],
      [implementerLogSurface("fine", { truncated: true })],
      ["implementer_log"],
    );
    expect([whole.status, cut.status]).toEqual(["scanned", "not_run"]);
  });

  it("separates the prompt texts, so a canary cannot be assembled across two of them", async () => {
    const halves = [CANARY_A.slice(0, 20), CANARY_A.slice(20)];
    const split = await scanCanaries([CANARY_A], [promptSurface(halves)], ["prompt"]);
    const whole = await scanCanaries([CANARY_A], [promptSurface([`text ${CANARY_A}`])], ["prompt"]);
    expect([split.total, whole.total]).toEqual([0, 1]);
  });
});
