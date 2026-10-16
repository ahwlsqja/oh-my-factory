import { describe, expect, it } from "vitest";
import { type RequestRead, readConflictRequest, requestPath } from "../../src/implementer/request.js";
import { buildChain, type Step, WORK_ID } from "../helpers/implementer-chain.js";

const REQUEST = requestPath(WORK_ID);
const BASE: Step = { "tests/a.test.ts": "t\n", "SPEC.md": "s\n", "src/a.ts": "x\n" };
const NOTE = "planted-note-7731 the failing test contradicts the spec";
const file = (doc: unknown): Step => ({ [REQUEST]: JSON.stringify(doc) });

async function read(work: Step[]): Promise<RequestRead> {
  const chain = await buildChain({ base: BASE, work });
  return readConflictRequest(chain.quarantine, WORK_ID, chain.head, chain.basePaths);
}

describe("readConflictRequest", () => {
  it("lives in the per-item directory, and reads none when the head tree has no request, even if an earlier commit had one", async () => {
    expect(REQUEST).toBe(".omf/w-0123456789ab/request.json");
    expect(await read([{ "src/a.ts": "y\n" }])).toEqual({ status: "none" });
    expect(await read([file({ kind: "test_conflict", paths: [] }), { [REQUEST]: null }])).toEqual({ status: "none" });
  });

  it("raises a request with the base-tree paths only, deduplicated and sorted, and never the note", async () => {
    const result = await read([
      file({
        kind: "test_conflict",
        paths: ["tests/a.test.ts", "src/missing.ts", "tests/a.test.ts", "SPEC.md"],
        note: NOTE,
      }),
    ]);
    expect(result).toEqual({
      status: "raised",
      request: { kind: "test_conflict", paths: ["SPEC.md", "tests/a.test.ts"], note_present: true },
    });
    expect(JSON.stringify(result)).not.toContain("planted-note");
    expect(await read([file({ kind: "spec_conflict", paths: [], note: "  \n" })])).toMatchObject({
      request: { note_present: false },
    });
  });

  const INVALID: [string, Step][] = [
    ["unparsable JSON", { [REQUEST]: "{nope" }],
    ["a kind outside the closed set", file({ kind: "other", paths: [] })],
    ["an extra key", file({ kind: "test_conflict", paths: [], extra: 1 })],
    ["eleven paths", file({ kind: "test_conflict", paths: Array.from({ length: 11 }, (_v, i) => `p${i}`) })],
    ["a file over the size cap", { [REQUEST]: `{"kind":"test_conflict","paths":[],"note":"${"x".repeat(17_000)}"}` }],
    ["bytes that are not UTF-8", { [REQUEST]: Buffer.from([0x7b, 0xff, 0x7d]) }],
    ["a directory in its place", { [`${REQUEST}/inner.txt`]: "x" }],
  ];
  it.each(INVALID)("reads %s as invalid", async (_name, step) => {
    expect(await read([step])).toEqual({ status: "invalid" });
  });
});
