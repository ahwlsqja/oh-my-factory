import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { CanaryIndexEntry } from "../../src/audit/attribute.js";
import { CONTAINER_PROBE_ARGV } from "../../src/container/measure.js";
import type { ImplementerSession, SessionRequest } from "../../src/implementer/session.js";
import { type ImplementerStations, implementerStations } from "../../src/implementer/station.js";
import { createStubSession } from "../../src/implementer/stub-session.js";
import type { FeedbackSlot } from "../../src/judge/round-state.js";
import { foldSeals } from "../../src/scenario/events.js";
import { listVaultCanaryIndex, setDir } from "../../src/vault/vault.js";
import { emptyEvidenceInputs } from "../../src/work/classify.js";
import type { StationContext } from "../../src/work/sequencer.js";
import type { WorkItem } from "../../src/work/types.js";
import { HARNESS_BASE, SUT_BASE } from "./container-fixture.js";
import { NOW } from "./decision-fixture.js";
import { FakeDocker, MUTATING_VERBS } from "./fake-docker.js";
import { type FakeExecCall, type FakeResult, addImage } from "./fake-docker-core.mjs";
import { fakeRuntime } from "./fake-runtime.js";
import { LocalTreeContainer } from "./implementer-container.js";
import { type LineFixture, ROUND2, SCENARIO_TEXT, sealStored, setupLine, writeYaml } from "./line-fixture.js";
import { readTree } from "./tree.js";

export const RUN_ID = "r-20261016T000100Z-ab01";
export const IMPLEMENTER_IMAGE = `example.test/omf/implementer@sha256:${"c".repeat(64)}`;
/** The one credential of the line: a sentinel, never a real key. */
export const SENTINEL_KEY = "sk-omf-e2-sentinel-0123456789abcdef";
const CONTEXT = "colima-omf-m3f";

/** What the stub implementer does in `/work`. Without a plan it only commits `plan.md`, then one file. */
export interface StubPlan {
  /** A file the second commit adds. The text must not hold a single quote. */
  code?: { path: string; text: string };
  /** A third commit removes `code.path` again. */
  removeAgain?: boolean;
  /** Printed on stdout, which is the session log. */
  say?: string;
  /** Written under `$OMF_TMP` and never committed. */
  scratch?: string;
}

function quote(text: string): string {
  if (text.includes("'")) throw new Error("stub text cannot hold a single quote");
  return `'${text}'`;
}

/**
 * The shell script the stub session runs in the container: plan first (the per-item path), then one code file, then
 * whatever the plan asks for. `set -u` makes an unset `$OMF_TMP` fail loudly instead of writing under the real `/tmp`.
 */
export function stubScript(workId: string, plan: StubPlan = {}): string {
  const dir = `.omf/${workId}`;
  const code = plan.code ?? { path: "feature.txt", text: "implemented" };
  if (plan.removeAgain === true && plan.code === undefined) throw new Error("removeAgain needs a code file");
  const lines = [
    "set -eu",
    `mkdir -p ${dir}`,
    `printf '%s\\n' 'Plan: add one file.' > ${dir}/plan.md`,
    `git add ${dir}/plan.md`,
    "git commit -q -m plan",
    `printf '%s\\n' ${quote(code.text)} > ${code.path}`,
    `git add ${code.path}`,
    "git commit -q -m implement",
  ];
  if (plan.removeAgain === true) lines.push(`git rm -q ${code.path}`, "git commit -q -m remove");
  if (plan.say !== undefined) lines.push(`printf '%s\\n' ${quote(plan.say)}`);
  if (plan.scratch !== undefined) lines.push(`printf '%s\\n' ${quote(plan.scratch)} > "$OMF_TMP/scratch.txt"`);
  return lines.join("\n");
}

export interface ImplementerLineOptions {
  /** Built after the seal, from the first canary of the sealed set. */
  plan?: (canary: string) => StubPlan;
}

export interface ImplementerLine {
  l: LineFixture;
  workId: string;
  /** The user's repository: the base commit is its HEAD. */
  repo: string;
  item: WorkItem;
  fake: FakeDocker;
  stations: ImplementerStations;
  index: CanaryIndexEntry[];
  /** The first canary of the sealed set, with its scenario. */
  entry: CanaryIndexEntry;
  /** Everything only the sealed set holds: every canary, every scenario id and the distinctive step text. */
  scenarioStrings: string[];
  /** The file names and the text of the sealed set's files in the vault. */
  vaultText: string;
  /** Every request the session received, in order (prompt and settings as the real adapter would get them). */
  requests: SessionRequest[];
  /** The feedback texts S6 would have released; push to it before a round. */
  released: string[];
  spends: Array<number | null>;
  ctx(round?: number, item?: WorkItem): StationContext;
}

function recording(inner: ImplementerSession, requests: SessionRequest[]): ImplementerSession {
  return {
    id: inner.id,
    vendor: inner.vendor,
    model: inner.model,
    run: (container, request) => {
      requests.push(request);
      return inner.run(container, request);
    },
  };
}

const sameArgv = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((part, at) => part === b[at]);

/**
 * An item with a sealed set and a user repository, the real S3 over the fake daemon, `LocalTreeContainer` and a stub
 * session. The line is not run: the caller runs `stations.S3` (and, for an audit, `auditCandidate`).
 */
export async function setupImplementerLine(options: ImplementerLineOptions = {}): Promise<ImplementerLine> {
  const l = setupLine();
  const sealId = await sealStored(l, writeYaml(l, "round2.yaml", ROUND2));
  const { fx, workId, scope } = l.f;
  writeFileSync(
    join(fx.location.dir, "config.toml"),
    `${fx.baseConfig}\n[judge]\nk = 3\nsut_base_image = "${SUT_BASE}"\nharness_base_image = "${HARNESS_BASE}"\ndocker_context = "${CONTEXT}"\n\n[implementer]\nimage = "${IMPLEMENTER_IMAGE}"\n`,
  );

  const { records } = foldSeals(fx.ledger.readVerified(), scope);
  const { index } = listVaultCanaryIndex(l.vault, workId, records);
  const entry = index[0];
  if (entry === undefined) throw new Error("the sealed set has no canary");
  const scenarioStrings = [...SCENARIO_TEXT, ...index.flatMap((e) => [e.canary, e.scenario_id])];
  // File names are the scenario ids, so the paths count as vault text too.
  const vaultFiles = readTree(setDir(l.vault, { work_id: workId, seal_id: sealId }));
  const vaultText = [...vaultFiles.keys(), ...vaultFiles.values()].join("\n");

  // One directory tree per container, as on a real daemon: a later round gets a fresh container and an empty `/work`.
  const trees = new Map<string, LocalTreeContainer>();
  const treeOf = (name: string): LocalTreeContainer => {
    const known = trees.get(name);
    if (known !== undefined) return known;
    const created = new LocalTreeContainer();
    trees.set(name, created);
    return created;
  };
  const exec = (call: FakeExecCall): FakeResult =>
    sameArgv(call.argv, CONTAINER_PROBE_ARGV)
      ? { status: 0, stdout: "socket:0\nend\n", stderr: "" }
      : treeOf(call.name).exec(call);
  const fake = new FakeDocker({ exec });
  addImage(fake.state, IMPLEMENTER_IMAGE);

  const runtime = fakeRuntime(fake, CONTEXT);
  const requests: SessionRequest[] = [];
  const released: string[] = [];
  const spends: Array<number | null> = [];
  const feedback: FeedbackSlot = { put: () => {}, take: () => null, released: () => [...released] };
  const script = stubScript(workId, options.plan?.(entry.canary));
  const stations = implementerStations({
    location: fx.location,
    runtime,
    feedback,
    session: () => recording(createStubSession({ runtime, script: { argv: ["sh", "-c", script] } }), requests),
    env: { OMF_IMPLEMENTER_API_KEY: SENTINEL_KEY },
    now: () => NOW,
  });

  return {
    l,
    workId,
    repo: fx.repo,
    item: l.f.item,
    fake,
    stations,
    index,
    entry,
    scenarioStrings,
    vaultText,
    requests,
    released,
    spends,
    ctx: (round = 1, item = l.f.item) => ({
      runId: RUN_ID,
      workId,
      goalId: fx.goalId,
      round,
      resumed: false,
      entryState: "ready",
      item,
      now: () => NOW,
      inputs: emptyEvidenceInputs(),
      recordSpend: (amount) => {
        spends.push(amount);
      },
    }),
  };
}

/** Registers the per-test disposal of the stations (leftover containers of the fake daemon) and returns the starter. */
export function lineStarter(): (options?: ImplementerLineOptions) => Promise<ImplementerLine> {
  const lines: ImplementerLine[] = [];
  afterEach(async () => {
    await Promise.all(lines.splice(0).map((line) => line.stations.dispose()));
  });
  return async (options = {}) => {
    const line = await setupImplementerLine(options);
    lines.push(line);
    return line;
  };
}

/** Every docker argv and every stdin the daemon was sent, as one latin1 string (tar bytes keep their ASCII text). */
export function handedOver(fake: FakeDocker): string {
  return fake.state.calls
    .map((call) => {
      const stdin = call.stdin_b64 === null ? "" : Buffer.from(call.stdin_b64, "base64").toString("latin1");
      return `${call.argv.join("\0")}\0${stdin}`;
    })
    .join("\0");
}

/** The stdins that carry the OMF-rendered context files, which the base tarball never does. */
export function contextHandedOver(fake: FakeDocker, workId: string): string {
  return fake.state.calls
    .map((call) => (call.stdin_b64 === null ? "" : Buffer.from(call.stdin_b64, "base64").toString("latin1")))
    .filter((stdin) => stdin.includes(`.omf/${workId}/spec.md`))
    .join("\0");
}

/** The calls that build, pull, create, start or exec: empty means no container work began. */
export function startedContainers(fake: FakeDocker): string[] {
  return fake.verbs().filter((verb) => MUTATING_VERBS.has(verb));
}

/** The needles present in `text`, cut to 14 characters so a failure names the leak without printing all of it. */
export function found(text: string, needles: readonly string[]): string[] {
  return needles.filter((needle) => text.includes(needle)).map((needle) => needle.slice(0, 14));
}
