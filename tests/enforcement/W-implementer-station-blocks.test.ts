import { describe, expect, it } from "vitest";
import { CANARY } from "../helpers/canary.js";
import type { ImplementerRig, ImplementerRigOptions } from "../helpers/implementer-fixture.js";
import { FAKE_KEY, setupImplementer } from "../helpers/implementer-fixture.js";
import {
  FAILED,
  PLANTED,
  commitStaged,
  diskHolds,
  faultOn,
  isFinalize,
  isKill,
  isPrepare,
  refsOf,
  secretExecs,
  startedAnything,
  workIdOf,
} from "../helpers/implementer-matrix.js";
import { gitIn } from "../helpers/tmp.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NOT_RUN } from "../../src/work/line-types.js";
import type { StationContext } from "../../src/work/sequencer.js";
import type { ReasonCode } from "../../src/work/w-events.js";

function commitFiles(rig: ImplementerRig, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(rig.repo, path)), { recursive: true });
    writeFileSync(join(rig.repo, path), text);
  }
  gitIn(rig.repo, "add", "-A");
  commitStaged(rig.repo, "arrange");
}

interface Case {
  name: string;
  options?: ImplementerRigOptions;
  arrange?: (rig: ImplementerRig) => void;
  ctx?: (rig: ImplementerRig) => Partial<StationContext>;
  code: ReasonCode;
  /** True when the station must stop before it asks the daemon to build, create or run anything; null when either order is fine. */
  beforeDaemon: boolean | null;
  /** True when the container proved golden and the session ran, so the secret exec is expected. */
  secret?: true;
}

const fullyBadBundle = "A".repeat(1_600_000);

const CASES: Case[] = [
  { name: "no credential", options: { env: {} }, code: "infra_failure", beforeDaemon: true },
  {
    name: "an invalid credential",
    options: { env: { OMF_IMPLEMENTER_API_KEY: "bad\nkey" } },
    code: "infra_failure",
    beforeDaemon: true,
  },
  {
    name: "a key set only as the reconciler's ANTHROPIC_API_KEY (no fallback)",
    options: { env: { ANTHROPIC_API_KEY: FAKE_KEY } },
    code: "infra_failure",
    beforeDaemon: true,
  },
  {
    name: "a config that names a codex implementer",
    arrange: (rig) => {
      const file = join(rig.l.f.fx.location.dir, "config.toml");
      const text = readFileSync(file, "utf8");
      const swapped = text.replace(
        'implementer = { vendor = "claude", model = ',
        'implementer = { vendor = "codex", model = ',
      );
      if (swapped === text) throw new Error("the rig config names no claude implementer");
      writeFileSync(file, swapped);
    },
    code: "gate_blocked",
    beforeDaemon: true,
  },
  { name: "no implementer image", options: { image: null }, code: "infra_failure", beforeDaemon: true },
  { name: "no docker context", options: { context: null }, code: "infra_failure", beforeDaemon: true },
  {
    name: "daemon down",
    options: { info: { ok: false, failure: PLANTED } },
    code: "infra_failure",
    beforeDaemon: true,
  },
  { name: "non-local endpoint", options: { local: false }, code: "infra_failure", beforeDaemon: true },
  {
    name: "an intent that holds the locked target",
    ctx: (rig) => {
      const candidate = { ...rig.l.f.item.intent.candidate, problem: `Lookups must stay under ${CANARY.target} ms.` };
      return { item: { ...rig.l.f.item, intent: { ...rig.l.f.item.intent, candidate } } };
    },
    code: "gate_blocked",
    beforeDaemon: true,
  },
  {
    name: "a canary in a tracked file of the base commit",
    arrange: (rig) => commitFiles(rig, { "src/leak.txt": `note ${rig.canary}\n` }),
    code: "gate_blocked",
    beforeDaemon: true,
  },
  {
    name: "a submodule in the base commit",
    arrange: (rig) => {
      gitIn(rig.repo, "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},vendor/sub`);
      commitStaged(rig.repo, "arrange");
    },
    code: "gate_blocked",
    beforeDaemon: true,
  },
  {
    name: "LFS attributes in the base commit",
    arrange: (rig) => commitFiles(rig, { ".gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n" }),
    code: "gate_blocked",
    beforeDaemon: true,
  },
  {
    name: "a base that already tracks the item's own directory",
    arrange: (rig) => commitFiles(rig, { [`.omf/${workIdOf(rig)}/plan.md`]: "an earlier plan\n" }),
    code: "gate_blocked",
    beforeDaemon: true,
  },
  {
    name: "the branch is checked out in the user's repository",
    arrange: (rig) => {
      gitIn(rig.repo, "switch", "-q", "-c", `omf/${workIdOf(rig)}`);
    },
    code: "gate_blocked",
    beforeDaemon: null, // refused when the base is read or, at the latest, by publishBranch before it writes a ref
    secret: true,
  },
  {
    name: "a container that is not golden",
    options: {
      tamper: (doc) => {
        (doc.HostConfig as Record<string, unknown>).Privileged = true;
      },
    },
    code: "gate_blocked",
    beforeDaemon: false,
  },
  {
    name: "the workspace cannot be prepared",
    options: { execFault: faultOn(isPrepare, FAILED) },
    code: "infra_failure",
    beforeDaemon: false,
  },
  {
    name: "the kill-all step fails",
    options: { execFault: faultOn(isKill, FAILED) },
    code: "infra_failure",
    beforeDaemon: false,
    secret: true,
  },
  {
    name: "the finalize step fails",
    options: { execFault: faultOn(isFinalize, FAILED) },
    code: "infra_failure",
    beforeDaemon: false,
    secret: true,
  },
  {
    name: "the bundle comes back malformed",
    options: { execFault: faultOn(isFinalize, { status: 0, stdout: `${PLANTED}\n`, stderr: "" }) },
    code: "gate_blocked",
    beforeDaemon: false,
    secret: true,
  },
  {
    name: "the bundle is over the size cap",
    options: {
      implementerToml: "max_workspace_bytes = 1048576\n",
      execFault: faultOn(isFinalize, { status: 0, stdout: `${fullyBadBundle}\nOMF-BUNDLE-END\n`, stderr: "" }),
    },
    code: "gate_blocked",
    beforeDaemon: false,
    secret: true,
  },
];

// Every way S3 cannot hand a candidate on ends the station with one closed code. Nothing the daemon, git or an error said
// reaches the result, the ledger or the disk; nothing is published; the key never leaves the host unless the container
// proved golden; and no container outlives the station.
describe("W-implementer-station-blocks", () => {
  it.each(CASES)("$name stops S3 with $code", async ({ options, arrange, ctx: over, code, beforeDaemon, secret }) => {
    const rig = setupImplementer(options);
    arrange?.(rig);
    const refsBefore = refsOf(rig.repo);
    const ctx = rig.ctx(over?.(rig));
    const result = await rig.stations.S3.run(ctx);
    expect(result).toEqual({ kind: "blocked", reason_code: code });
    expect(JSON.stringify(result)).not.toContain(PLANTED);
    expect(refsOf(rig.repo)).toBe(refsBefore);
    if (beforeDaemon !== null) expect(startedAnything(rig)).toBe(!beforeDaemon);
    if (secret !== true) expect(secretExecs(rig)).toEqual([]);
    expect(diskHolds(rig, PLANTED)).toEqual([]);
    expect(diskHolds(rig, FAKE_KEY)).toEqual([]);
    expect(ctx.inputs.plan_summary).toBe(NOT_RUN);
    await rig.stations.dispose();
    expect(Object.keys(rig.fake.state.containers)).toEqual([]);
  });
});
