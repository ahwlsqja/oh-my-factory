import { expect, it } from "vitest";
import { trackRuntime } from "../../src/judge/state.js";
import type { Credential } from "../../src/implementer/credential.js";
import { realTempDir } from "../helpers/ops-fixture.js";
import { SENTINEL_VALUE, gatedAuthorImage, measuredAuthor, sentinelCredential } from "./author-support.js";
import { describeGated, gatedDocker } from "./helpers.js";
import { exitedOf } from "./implementer-support.js";
import { gatedRuntime, ownedLeftovers } from "./lifecycle-support.js";

// covers: S5.3.author-boundary-real
// covers: S5.3.author-measured-before-key
// G-author-boundary-real. Docker only: a real author container built from the owner's
// author image, with a made-up sentinel instead of a key and no model call. It shows what the daemon and the container say about
// the boundary: L2 from the real probe, tmpfs mounts only, a bridge network, one scoped secret, no vendor credential file, a
// writable answer path. Written, never run by an agent; not enforced until docs/evidence/gated-runs.json records it.

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

describeGated("G-author-boundary-real", (ctx) => {
  it("measures L2 and leaves the author tmpfs mounts, one scoped secret, no Claude binary or .codex and a writable answer path", async () => {
    const runtime = trackRuntime(gatedRuntime(ctx));
    const sentinel = sentinelCredential();
    try {
      const image = await gatedAuthorImage(runtime);
      const dir = realTempDir("omf-gated-ab-");
      const repo = realTempDir("omf-gated-ab-repo-");
      const { handle, measurement } = await measuredAuthor(runtime, { dir, forbidden: [dir, repo] }, image);
      const sh = async (script: string, secret?: Credential) => {
        const spec = { argv: ["sh", "-c", script], timeoutMs: 20_000, maxOutputBytes: 4096 };
        return exitedOf(await runtime.exec(handle, secret === undefined ? spec : { ...spec, secret }));
      };
      expect(measurement).toMatchObject({ stage: "author", level: "L2", violations: [] });

      // The secret is visible in the one exec that names it, in no other exec, and not in the daemon's document.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell, not JS, expands this variable inside the container
      const LENGTH = 'printf %s "${CODEX_API_KEY:-}" | wc -c';
      expect(Number((await sh(LENGTH, sentinel)).stdout.trim())).toBe(SENTINEL_VALUE.length);
      expect((await sh(LENGTH)).stdout.trim()).toBe("0");
      const inspected = gatedDocker(["inspect", handle.name]);
      expect(inspected.status).toBe(0);
      expect(inspected.stdout).not.toContain(SENTINEL_VALUE);
      expect(inspected.stdout).not.toContain("CODEX_API_KEY");

      // The mounts and limits as the daemon reports them: no bind, four tmpfs paths, bridge network, read-only root.
      const parsed: unknown = JSON.parse(inspected.stdout);
      const doc = asRecord(Array.isArray(parsed) ? parsed[0] : undefined);
      const host = asRecord(doc.HostConfig);
      expect(host.Binds ?? []).toEqual([]);
      expect(asArray(doc.Mounts).every((mount) => asRecord(mount).Type === "tmpfs")).toBe(true);
      expect(Object.keys(asRecord(host.Tmpfs)).sort()).toEqual(["/agent", "/in", "/out", "/tmp"]);
      expect(host.NetworkMode).toBe("bridge");
      expect(host.ReadonlyRootfs).toBe(true);
      expect(host.CapDrop).toEqual(["ALL"]);
      expect(
        asArray(host.SecurityOpt).some(
          (option) => typeof option === "string" && option.startsWith("no-new-privileges"),
        ),
      ).toBe(true);

      // Inside: the Codex CLI is there, no Claude binary, no credential directory, no Docker socket, a writable answer path.
      expect((await sh("command -v codex")).status).toBe(0);
      for (const script of [
        "command -v claude",
        "test -e /agent/.codex",
        "test -e /agent/.claude",
        "test -S /var/run/docker.sock",
        "test -e /work",
        "touch /etc/omf-probe",
      ]) {
        expect((await sh(script)).status).not.toBe(0);
      }
      expect((await sh("printf '{}' > /out/answer.json && test -s /out/answer.json")).status).toBe(0);
      expect((await sh("printf x > /in/probe.txt && test -s /in/probe.txt")).status).toBe(0);
      expect((await sh("id -u")).stdout.trim()).toBe("65532");
      await runtime.remove(handle);
    } finally {
      runtime.close();
    }
    expect(ownedLeftovers(ctx)).toEqual([]);
  }, 300_000);
});
