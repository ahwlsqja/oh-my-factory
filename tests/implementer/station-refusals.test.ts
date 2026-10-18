import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  clearImplementerRequest,
  readImplementerRequest,
  writeImplementerRequest,
} from "../../src/decision/needs-human.js";
import { FINALIZE_SCRIPT } from "../../src/implementer/workspace.js";
import { NOT_RUN } from "../../src/work/line-types.js";
import { FAKE_KEY, type ImplementerRig, setupImplementer } from "../helpers/implementer-fixture.js";
import {
  FAILED,
  codeCommit,
  commitStaged,
  diskHolds,
  eventsOf,
  execScripts,
  failingSession,
  faultOn,
  filesNamed,
  isCapture,
  itemDirOf,
  nonOmfRefs,
  omfRefs,
  planned,
  quietSession,
  refsOf,
  stageLeftovers,
  startedAnything,
  workIdOf,
} from "../helpers/implementer-matrix.js";
import { gitIn } from "../helpers/tmp.js";

const commit = (rig: ImplementerRig, files: Record<string, string>): void => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(rig.repo, path)), { recursive: true });
    writeFileSync(join(rig.repo, path), text);
  }
  gitIn(rig.repo, "add", "-A");
  commitStaged(rig.repo, "arrange");
};
const BLOCKED = { kind: "blocked", reason_code: "gate_blocked" } as const;

describe("a session that fails", () => {
  it.each(["timeout", "spawn_failed", "nonzero_exit", "output_limit", "misconfigured"] as const)(
    "%s: infra_failure, the container is removed at once, no bundle is made, the spend is recorded as unknown",
    async (code) => {
      const rig = setupImplementer({ session: failingSession(code) });
      const recordSpend = vi.fn();
      const result = await rig.stations.S3.run(rig.ctx({ recordSpend }));
      expect(result).toEqual({ kind: "blocked", reason_code: "infra_failure" });
      expect(Object.keys(rig.fake.state.containers)).toEqual([]); // before dispose(): removed by the station itself
      const scripts = execScripts(rig).join("\n");
      expect(scripts).not.toContain(FINALIZE_SCRIPT);
      expect(scripts).not.toContain("kill -9 -1");
      expect(stageLeftovers(rig)).toEqual([]);
      expect(omfRefs(rig.repo)).toEqual([]);
      expect(recordSpend).toHaveBeenCalledExactlyOnceWith(null);
      expect(eventsOf(rig, "implementer.session_completed")[0]?.payload.outcome).toBe(code);
    },
  );

  it("a session that finishes without a cost records the spend as unknown, and one that reports a cost records it", async () => {
    for (const cost of [null, 1234]) {
      const rig = setupImplementer({ session: quietSession(cost) });
      const recordSpend = vi.fn();
      await rig.stations.S3.run(rig.ctx({ recordSpend }));
      expect(recordSpend).toHaveBeenCalledExactlyOnceWith(cost);
      await rig.stations.dispose();
    }
  });
});

interface Leak {
  name: string;
  scan: "credential" | "canary";
  behavior: NonNullable<NonNullable<Parameters<typeof setupImplementer>[0]>["behavior"]>;
}
const LEAKS: Leak[] = [
  {
    name: "the key in a file of the head tree",
    scan: "credential",
    behavior: (id) => planned([codeCommit({ "src/a.ts": `export const k = "${FAKE_KEY}";\n` })])(id),
  },
  {
    name: "a canary in a file of the head tree",
    scan: "canary",
    behavior: (id, canary) => planned([codeCommit({ "src/a.ts": `// ${canary}\n` })])(id),
  },
  {
    name: "the key in a commit that a later commit removes",
    scan: "credential",
    behavior: (id) =>
      planned([
        codeCommit({ "src/leak.txt": FAKE_KEY }),
        codeCommit({ "src/leak.txt": null }),
        codeCommit({ "src/ok.ts": "export const ok = 1;\n" }),
      ])(id),
  },
  {
    name: "a canary in a commit message",
    scan: "canary",
    behavior: (id, canary) => planned([codeCommit({ "src/a.ts": "export const a = 1;\n" }, `note ${canary}`)])(id),
  },
  {
    name: "the key in a commit message",
    scan: "credential",
    behavior: (id) => planned([codeCommit({ "src/a.ts": "export const a = 1;\n" }, `note ${FAKE_KEY}`)])(id),
  },
  {
    name: "the key only in an uncommitted file under /tmp",
    scan: "credential",
    behavior: (id) =>
      planned([codeCommit({ "src/a.ts": "export const a = 1;\n" })], { tmpFiles: { "leak.txt": FAKE_KEY } })(id),
  },
  {
    name: "a canary only in an uncommitted file under /tmp",
    scan: "canary",
    behavior: (id, canary) =>
      planned([codeCommit({ "src/a.ts": "export const a = 1;\n" })], { tmpFiles: { "leak.txt": canary } })(id),
  },
];

// The log is not a surface that blocks (a benign `env` call prints the key); everything that outlives the session is.
describe("a credential or a canary in what the container returns", () => {
  it.each(LEAKS)("$name: gate_blocked, nothing published, nothing left on disk", async ({ behavior, scan }) => {
    const rig = setupImplementer({ behavior });
    const before = refsOf(rig.repo);
    const result = await rig.stations.S3.run(rig.ctx());
    expect(result).toEqual(BLOCKED);
    expect(refsOf(rig.repo)).toBe(before);
    expect(stageLeftovers(rig)).toEqual([]);
    expect(diskHolds(rig, FAKE_KEY)).toEqual([]);
    const checked = eventsOf(rig, "implementer.candidate_checked");
    expect(checked).toHaveLength(1);
    expect(checked[0]?.payload).toMatchObject({ scan, published: false });
    await rig.stations.dispose();
  });

  it("an incomplete capture fails closed", async () => {
    const rig = setupImplementer({ execFault: faultOn(isCapture, FAILED) });
    const before = refsOf(rig.repo);
    expect(await rig.stations.S3.run(rig.ctx())).toEqual(BLOCKED);
    expect(refsOf(rig.repo)).toBe(before);
    expect(stageLeftovers(rig)).toEqual([]);
    expect(eventsOf(rig, "implementer.candidate_checked")[0]?.payload).toMatchObject({ scan: "incomplete" });
    await rig.stations.dispose();
  });

  it("a key only in the raw log is counted and redacted and does not block", async () => {
    const rig = setupImplementer({
      behavior: planned([codeCommit({ "src/a.ts": "export const a = 1;\n" })], {
        log: `env: ANTHROPIC_API_KEY=${FAKE_KEY}\n`,
      }),
    });
    const ctx = rig.ctx();
    expect(await rig.stations.S3.run(ctx)).toEqual({ kind: "ok", progress_digest: expect.any(String) });
    const payload = eventsOf(rig, "implementer.session_completed")[0]?.payload;
    expect(payload?.log_credential_hits).toBeGreaterThanOrEqual(1);
    const [log] = filesNamed(rig, "implementer.log");
    expect(readFileSync(log ?? "", "utf8")).toContain("[redacted]");
    expect(diskHolds(rig, FAKE_KEY)).toEqual([]);
    await rig.stations.dispose();
  });
});

const REQUEST_PATH = (id: string): string => `.omf/${id}/request.json`;

describe("a conflict request", () => {
  it("raised: blocked implementer_request, the record is written, nothing is published, the note text is stored nowhere", async () => {
    const rig = setupImplementer({
      behavior: (id) =>
        planned([
          codeCommit({
            [REQUEST_PATH(id)]: JSON.stringify({
              kind: "test_conflict",
              paths: ["tests/old.test.ts", "tests/not-in-base.test.ts"],
              note: "NOTE-TEXT-9921",
            }),
          }),
        ])(id),
    });
    commit(rig, { "tests/old.test.ts": "export {};\n" });
    const before = refsOf(rig.repo);
    expect(await rig.stations.S3.run(rig.ctx())).toEqual({ kind: "blocked", reason_code: "implementer_request" });
    expect(refsOf(rig.repo)).toBe(before);
    const record = readImplementerRequest(itemDirOf(rig));
    expect(record).toMatchObject({ work_id: workIdOf(rig), kind: "test_conflict", paths: ["tests/old.test.ts"] });
    expect(diskHolds(rig, "NOTE-TEXT-9921")).toEqual([]);
    expect(stageLeftovers(rig)).toEqual([]);
    await rig.stations.dispose();
  });

  it("invalid: blocked gate_blocked, no record, nothing is published", async () => {
    const rig = setupImplementer({ behavior: (id) => planned([codeCommit({ [REQUEST_PATH(id)]: "{not json" })])(id) });
    const before = refsOf(rig.repo);
    expect(await rig.stations.S3.run(rig.ctx())).toEqual(BLOCKED);
    expect(refsOf(rig.repo)).toBe(before);
    expect(readImplementerRequest(itemDirOf(rig))).toBeNull();
    await rig.stations.dispose();
  });

  it("an earlier request's record is cleared at the next S3", async () => {
    const rig = setupImplementer();
    const scope = { goal_id: rig.l.f.scope.goal_id, work_id: workIdOf(rig) };
    writeImplementerRequest(
      itemDirOf(rig),
      scope,
      { kind: "spec_conflict", paths: [], note_present: false },
      new Date(),
    );
    expect(readImplementerRequest(itemDirOf(rig))).not.toBeNull();
    expect((await rig.stations.S3.run(rig.ctx())).kind).toBe("ok");
    expect(readImplementerRequest(itemDirOf(rig))).toBeNull();
    clearImplementerRequest(itemDirOf(rig)); // idempotent
    await rig.stations.dispose();
  });
});

describe("a missing plan", () => {
  it("publishes the branch for review and then stops with plan_missing", async () => {
    const rig = setupImplementer({
      behavior: () => ({ commits: [codeCommit({ "src/a.ts": "export const a = 1;\n" })] }),
    });
    const mainBefore = nonOmfRefs(rig.repo);
    const ctx = rig.ctx();
    expect(await rig.stations.S3.run(ctx)).toEqual({ kind: "blocked", reason_code: "plan_missing" });
    expect(omfRefs(rig.repo)).toHaveLength(1);
    expect(omfRefs(rig.repo)[0]).toMatch(new RegExp(`^refs/heads/omf/${workIdOf(rig)} [0-9a-f]{40}$`));
    expect(nonOmfRefs(rig.repo)).toBe(mainBefore); // the station never writes the user's own branches
    expect(eventsOf(rig, "implementer.candidate_checked")[0]?.payload).toMatchObject({
      plan: "missing",
      published: true,
    });
    expect(ctx.inputs.plan_summary).toBe(NOT_RUN);
    expect(stageLeftovers(rig)).toEqual([]);
    expect(startedAnything(rig)).toBe(true);
    await rig.stations.dispose();
  });

  it("a plan commit that also changes code is a missing plan", async () => {
    const rig = setupImplementer({
      behavior: (id) => ({
        commits: [
          {
            message: "plan and code",
            files: { [`.omf/${id}/plan.md`]: "Plan.\n", "src/a.ts": "export const a = 1;\n" },
          },
        ],
      }),
    });
    expect(await rig.stations.S3.run(rig.ctx())).toEqual({ kind: "blocked", reason_code: "plan_missing" });
    await rig.stations.dispose();
  });
});
