import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LedgerEvent } from "../../src/core/ledger.js";
import type { Credential } from "../../src/implementer/credential.js";
import type { ImplementerFailureCode, ImplementerSession } from "../../src/implementer/session.js";
import { CAPTURE_SCRIPT, FINALIZE_SCRIPT, KILL_ALL_ARGV, PREPARE_SCRIPT } from "../../src/implementer/workspace.js";
import { MUTATING_VERBS } from "./fake-docker.js";
import type { FakeExecCall, FakeResult } from "./fake-docker-core.mjs";
import type { CommitScript, ImplementerRig, StubBehavior } from "./implementer-fixture.js";
import { gitIn } from "./tmp.js";

/** Text no real code contains; tests plant it in daemon replies and search every file and result for it. */
export const PLANTED = "planted-daemon-text-7742";

export const workIdOf = (rig: ImplementerRig): string => rig.l.f.workId;
export const itemDirOf = (rig: ImplementerRig): string => rig.l.f.item.dir;

/** The commit a well-behaved session makes first: the plan, alone, in the item's own directory. */
export const planFor = (workId: string): CommitScript => ({
  message: "plan",
  files: { [`.omf/${workId}/plan.md`]: "Plan: add the cache.\n" },
});
export const codeCommit = (files: Record<string, string | null>, message = "implement"): CommitScript => ({
  message,
  files,
});
/** A plan commit first, then `rest`: the shape of a session that follows the plan-first rule. */
export const planned =
  (rest: readonly CommitScript[], extra: Omit<StubBehavior, "commits"> = {}) =>
  (workId: string): StubBehavior => ({ commits: [planFor(workId), ...rest], ...extra });

/** A commit in the user's repository (before the run), with the gitlink and LFS cases that `commitAll` would mangle. */
export function commitStaged(repo: string, message: string): void {
  gitIn(
    repo,
    "-c",
    "user.name=omf-test",
    "-c",
    "user.email=omf-test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    message,
  );
}

/** Every ref of the user's repository with its value, for before-and-after comparison. */
export const refsOf = (repo: string): string => gitIn(repo, "for-each-ref", "--format=%(refname) %(objectname)");
export const omfRefs = (repo: string): string[] =>
  refsOf(repo)
    .split("\n")
    .filter((line) => line.startsWith("refs/heads/omf/"));
export const nonOmfRefs = (repo: string): string =>
  refsOf(repo)
    .split("\n")
    .filter((line) => !line.startsWith("refs/heads/omf/"))
    .join("\n");

/** True when the fake daemon was asked to build, pull, create, start or exec anything. */
export const startedAnything = (rig: ImplementerRig): boolean =>
  rig.fake.verbs().some((verb) => MUTATING_VERBS.has(verb));
/** The execs that carried the secret: the client is told only the variable's name, so the name in argv is the proof. */
export const secretExecs = (rig: ImplementerRig): string[][] =>
  rig.fake.calls("exec").flatMap((call) => (call.argv.includes("ANTHROPIC_API_KEY") ? [call.argv] : []));
/** The `sh -c` script of every exec, and the argv of the others joined, in order. */
export const execScripts = (rig: ImplementerRig): string[] =>
  rig.fake.calls("exec").map((call) => call.argv.join("\u0000"));

export const eventsOf = (rig: ImplementerRig, type: string): LedgerEvent[] =>
  rig.l.f.fx.ledger.readVerified().filter((event) => event.type === type);

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}
/** Files of the whole project directory (ledger, items, runs) that contain `needle`. The vault holds canaries by design, so do not search for a canary. */
export const diskHolds = (rig: ImplementerRig, needle: string): string[] =>
  filesUnder(rig.l.f.fx.location.dir).filter((file) => readFileSync(file).includes(needle));
export const filesNamed = (rig: ImplementerRig, name: string): string[] =>
  filesUnder(itemDirOf(rig)).filter((file) => file.endsWith(`/${name}`));
/** What a round's stage directory still holds of the three things that may carry a key: bundle, quarantine, exported tree. */
export function stageLeftovers(rig: ImplementerRig): string[] {
  const runs = join(itemDirOf(rig), "runs");
  if (!existsSync(runs)) return [];
  return readdirSync(runs, { recursive: true })
    .map(String)
    .filter((path) => /(^|\/)implementer-stage\/round-\d+\/(bundle|quarantine|tree-\d+)/.test(path));
}

const scriptOf = (call: FakeExecCall): string =>
  call.argv[0] === "sh" && call.argv[1] === "-c" ? (call.argv[2] ?? "") : "";
export const isPrepare = (call: FakeExecCall): boolean => scriptOf(call) === PREPARE_SCRIPT;
export const isFinalize = (call: FakeExecCall): boolean => scriptOf(call) === FINALIZE_SCRIPT;
export const isKill = (call: FakeExecCall): boolean =>
  call.argv.length === KILL_ALL_ARGV.length && KILL_ALL_ARGV.every((part, index) => call.argv[index] === part);
export const isCapture = (call: FakeExecCall): boolean => scriptOf(call) === CAPTURE_SCRIPT;
/** An `execFault` that answers `reply` to the calls `match` accepts and lets the container double answer the rest. */
export const faultOn =
  (match: (call: FakeExecCall) => boolean, reply: FakeResult) =>
  (call: FakeExecCall): FakeResult | null =>
    match(call) ? reply : null;
export const FAILED: FakeResult = { status: 1, stdout: "", stderr: PLANTED };

/** A session that ends with `code`. */
export const failingSession =
  (code: ImplementerFailureCode) =>
  (_credential: Credential): ImplementerSession => ({
    id: `failing-${code}`,
    vendor: "stub",
    model: null,
    async run() {
      return { ok: false, code, log: "", credential_hits: 0, durationMs: 1 };
    },
  });
/** A session that finishes at once, makes no commit and reports `cost` (null: the vendor cost is unknown). */
export const quietSession =
  (cost: number | null) =>
  (_credential: Credential): ImplementerSession => ({
    id: "quiet",
    vendor: "stub",
    model: null,
    async run() {
      return { ok: true, log: "", credential_hits: 0, notes: null, cost_micro_usd: cost, durationMs: 1 };
    },
  });
/** A session that holds until `release()`, then ends with a timeout; `entered` settles when the session has started. */
export function hangingSession(): { session: () => ImplementerSession; entered: Promise<void>; release(): void } {
  let enter: () => void = () => {};
  let free: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    free = resolve;
  });
  return {
    entered,
    release: () => free(),
    session: () => ({
      id: "hanging",
      vendor: "stub",
      model: null,
      async run() {
        enter();
        await gate;
        return { ok: false, code: "timeout", log: "", credential_hits: 0, durationMs: 1 };
      },
    }),
  };
}
