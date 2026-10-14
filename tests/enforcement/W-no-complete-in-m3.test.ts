import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMarkdownStore } from "../../src/adapters/state-markdown.js";
import { OUTCOME_ROWS } from "../../src/work/outcome.js";
import { W_EVENT_TYPES, targetOf } from "../../src/work/w-events.js";
import { omf } from "../helpers/cli.js";
import { TICK_GOAL, seedWorkItem, setupTick } from "../helpers/tick.js";
import { inputFor, runWhole, stateOf, wTrail } from "../helpers/w-flow.js";
import { makeTempDir } from "../helpers/tmp.js";

// Spec §6.2: no silent approval. `done` means a person accepted the evidence, so in M3 nothing writes it:
// no store verb, no outcome row, no repair target, no W event, no CLI verb. M4 adds the one human path.
const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [],
  );
}

const isComment = (line: string): boolean => /^\s*(\/\/|\/\*|\*)/.test(line);

/** Files (relative to src/, POSIX separators) with the string literal "done" on a line of code. */
function filesMentioningDone(): string[] {
  return sourceFiles(SRC)
    .filter((file) => readFileSync(file, "utf8").split("\n").some((line) => !isComment(line) && /["'`]done["'`]/.test(line)))
    .map((file) => relative(SRC, file).split(sep).join("/"))
    .sort();
}

/**
 * The files that may name the state: its type and the transition table, the verifier (it refuses a
 * hand-edited `done`) and the reconciler's outcome counts. If this test names another file, read it: it
 * may compare against "done", never assign it. Then add it here with the reason.
 */
const MAY_NAME_DONE = ["goal/reconcile.ts", "work/ledger-verify.ts", "work/transitions.ts", "work/types.ts"];

function commandNames(help: string): string[] {
  const lines = help.split("\n");
  const start = lines.indexOf("Commands:");
  if (start === -1) return [];
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") break;
    const match = /^ {2}([a-z][a-z-]*)(?: |$)/.exec(line);
    if (match?.[1] !== undefined && match[1] !== "help") names.push(match[1]);
  }
  return names;
}

describe("W-no-complete-in-m3", () => {
  it("the store has no completing method and refuses done as a repair target", () => {
    const names = Object.keys(createMarkdownStore(makeTempDir()));
    expect(names).toContain("startWorkItem"); // control: the W verbs are there
    expect(names.filter((name) => /complet|done|ship|finish|merge/i.test(name))).toEqual([]);

    const fx = setupTick();
    const workId = seedWorkItem(fx, { title: "Review me" });
    runWhole(fx, workId, { outcome: "success", exhausted: false, reason_code: null });
    expect(stateOf(fx, workId)).toBe("awaiting_review");
    expect(() => fx.store.repairWorkItem(workId, "done" as never, fx.clock.now())).toThrow();
    expect(stateOf(fx, workId)).toBe("awaiting_review");
  });

  it("no outcome row and no W event type leads to done", () => {
    expect(OUTCOME_ROWS.map((row) => row.disposition.item_state)).not.toContain("done");
    expect(W_EVENT_TYPES.map((type) => targetOf(type))).not.toContain("done");
    expect(W_EVENT_TYPES as readonly string[]).not.toContain("work.completed");
  });

  it("the source tree never writes the done state", () => {
    const files = filesMentioningDone();
    expect(files, "the scan must see the files that define the state").toContain("work/types.ts");
    expect(files.filter((file) => !MAY_NAME_DONE.includes(file))).toEqual([]);

    const writes = sourceFiles(SRC).filter((file) =>
      readFileSync(file, "utf8").split("\n").some((line) => !isComment(line) && /\b(state|to)\s*[:=]\s*["'`]done["'`]/.test(line)),
    );
    expect(writes.map((file) => relative(SRC, file))).toEqual([]);
  });

  it("omf --help and its command groups list no complete, ship or done verb", () => {
    const cwd = makeTempDir();
    const home = makeTempDir("omf-home-");
    const top = commandNames(omf(["--help"], cwd, home).stdout);
    const all = [...top];
    for (const group of ["goal", "work", "decide", "budget", "metric", "ledger"]) {
      if (top.includes(group)) all.push(...commandNames(omf([group, "--help"], cwd, home).stdout));
    }
    expect(all.length).toBeGreaterThan(top.length); // control: the groups were read
    expect(all.filter((name) => /^(complete|ship|done|finish|merge|accept)$/.test(name))).toEqual([]);
  });

  it("a W run over every outcome row never produces a done item or a done target", () => {
    const fx = setupTick();
    OUTCOME_ROWS.forEach((row, index) => {
      const workId = seedWorkItem(fx, { title: `Outcome walk ${index}` });
      expect(runWhole(fx, workId, inputFor(row))).toMatchObject({ applied: true });
      for (const event of wTrail(fx, workId)) expect(targetOf(event.type as (typeof W_EVENT_TYPES)[number])).not.toBe("done");
    });

    const states = fx.store.fetchAllWorkItems(TICK_GOAL).map((item) => item.front.state);
    expect(states).toHaveLength(OUTCOME_ROWS.length);
    expect(states).not.toContain("done");
  });
});
