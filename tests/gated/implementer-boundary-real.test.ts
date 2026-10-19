// covers: F6.vault-host-only
// covers: S5.4.implementer-container
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { blobId } from "../../src/git/ops.js";
import { userRepoTarget } from "../../src/git/user-repo.js";
import { type Credential, readCredential } from "../../src/implementer/credential.js";
import { createStubSession } from "../../src/implementer/stub-session.js";
import { trackRuntime } from "../../src/judge/state.js";
import { realTempDir } from "../helpers/ops-fixture.js";
import { describeGated } from "./helpers.js";
import {
  CONTEXT,
  NO_CANARIES,
  WORK_ID,
  exitedOf,
  gatedImplementerImage,
  importedOf,
  makeUserRepo,
  measuredContainer,
  runImplementerRound,
  snapshotRepo,
} from "./implementer-support.js";
import { gatedRuntime, ownedLeftovers } from "./lifecycle-support.js";

// G-implementer-boundary-real (also the gated half of W-user-git-untouched). Docker only: a stub session in a real implementer
// container built from the owner's image. No model and no real key: the credential below is a made-up sentinel that exists
// to show where a secret is visible. Written, never run by an agent; not enforced until docs/evidence/gated-runs.json records it.

const SENTINEL_VALUE = "sk-ant-gated-fake-0123456789abcdef";
const read = readCredential("claude", { OMF_IMPLEMENTER_API_KEY: SENTINEL_VALUE });
if (read === null) throw new Error("the sentinel credential must be readable");
const SENTINEL: Credential = read;

const FILES = { "src/greet.txt": "hello\n", "crlf.txt": "a\r\nb\r\n", "id.txt": "$Id: 0123456789 $\n" };
const ATTRIBUTES = "*.txt text=auto\nid.txt ident\n";
/** Plain `git add` and `git commit` as the sandbox user, the way the real agent would run them. */
const STUB = [
  "set -e",
  `printf 'plan: change the greeting\\n' > .omf/${WORK_ID}/plan.md`,
  `git add .omf/${WORK_ID}/plan.md`,
  "git commit -q -m plan",
  "printf 'hello from the stub\\n' > src/greet.txt",
  "git add src/greet.txt",
  "git commit -q -m 'change the greeting'",
  "printf 'stub done\\n'",
].join("\n");
const REQUEST = {
  prompt: "",
  settings: "{}",
  timeoutMs: 120_000,
  maxOutputBytes: 1024 * 1024,
  model: null,
  maxBudgetUsd: null,
};

describeGated("G-implementer-boundary-real", (ctx) => {
  it("round-trips a real bundle into one OMF branch, leaves the user's repository alone and keeps untracked and ignored files out", async () => {
    const repo = makeUserRepo(FILES, ATTRIBUTES);
    const before = snapshotRepo(repo.dir);
    const round = await runImplementerRound({
      ctx,
      repo: repo.dir,
      dir: realTempDir("omf-gated-ib-"),
      files: CONTEXT,
      session: (runtime) => createStubSession({ runtime, script: { argv: ["sh", "-c", STUB] } }),
      request: REQUEST,
      credential: SENTINEL,
      canaries: NO_CANARIES,
    });
    expect(round.level).toBe("L2");
    expect(round.outcome.ok).toBe(true);
    const imported = importedOf(round); // the container's root tree equals the host-built base tree, CRLF and $Id$ blobs included
    expect(round.scan).toEqual({ status: "clean" });
    expect(round.plan).toMatchObject({ status: "ok" });
    expect(round.published).toBe(true);

    const { refs: refsBefore, ...restBefore } = before;
    const { refs: refsAfter, ...restAfter } = snapshotRepo(repo.dir);
    expect(refsAfter.filter((ref) => !refsBefore.includes(ref))).toEqual([
      `refs/heads/omf/${WORK_ID} ${imported.head}`,
    ]);
    expect(refsBefore.filter((ref) => !refsAfter.includes(ref))).toEqual([]);
    expect(restAfter).toEqual(restBefore);
    expect(existsSync(join(repo.dir, ".git", "logs", "refs", "heads", "omf"))).toBe(false);

    const target = userRepoTarget(repo.dir);
    expect(await blobId(target, imported.head, "crlf.txt")).toBe(await blobId(target, repo.head, "crlf.txt"));
    expect(await blobId(target, imported.head, "id.txt")).toBe(await blobId(target, repo.head, "id.txt"));
    expect(await blobId(target, imported.head, "src/greet.txt")).not.toBe(
      await blobId(target, repo.head, "src/greet.txt"),
    );

    expect(round.capture.complete).toBe(true);
    expect(round.capture.bytes.includes(repo.untrackedMarker)).toBe(false);
    expect(round.capture.bytes.includes(repo.ignoredMarker)).toBe(false);
    expect(ownedLeftovers(ctx)).toEqual([]);
  }, 300_000);

  it("shows the secret to one exec only, never to docker inspect, and keeps codex, docker.sock and a writable root out", async () => {
    const repo = makeUserRepo(FILES, null);
    const runtime = trackRuntime(gatedRuntime(ctx));
    try {
      const image = await gatedImplementerImage(runtime);
      const input = { dir: realTempDir("omf-gated-ib-"), repo: repo.dir };
      const { handle, measurement } = await measuredContainer(runtime, input, image);
      const sh = async (script: string, secret?: Credential) => {
        const spec = { argv: ["sh", "-c", script], timeoutMs: 20_000, maxOutputBytes: 4096 };
        return exitedOf(await runtime.exec(handle, secret === undefined ? spec : { ...spec, secret }));
      };
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell, not JS, expands this variable inside the container
      const LENGTH = 'printf %s "${ANTHROPIC_API_KEY:-}" | wc -c';
      expect(Number((await sh(LENGTH, SENTINEL)).stdout.trim())).toBe(SENTINEL_VALUE.length); // visible in the one exec that names it
      expect((await sh(LENGTH)).stdout.trim()).toBe("0"); // and in no other
      const inspect = JSON.stringify(await runtime.inspect(handle));
      expect(inspect).not.toContain(SENTINEL_VALUE);
      expect(inspect).not.toContain("ANTHROPIC_API_KEY");
      for (const script of [
        "command -v codex",
        "test -S /var/run/docker.sock",
        "test -e /agent/.codex",
        "touch /etc/omf-probe",
      ]) {
        expect((await sh(script)).status).not.toBe(0);
      }
      expect(measurement.level).toBe("L2");
    } finally {
      runtime.close();
    }
    expect(ownedLeftovers(ctx)).toEqual([]);
  }, 300_000);
});
