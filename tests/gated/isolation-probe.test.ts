import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { expect, it } from "vitest";
import { createDockerRuntime } from "../../src/container/docker-cli.js";
import { containerSpecFor, forbiddenPaths, goldenFor } from "../../src/container/golden.js";
import { type PinnedImage, pinnedImage } from "../../src/container/image-ref.js";
import { createMeasured } from "../../src/container/measure.js";
import type { ContainerHandle } from "../../src/container/runtime.js";
import type { ContainerRole } from "../../src/container/spec.js";
import { CONFIG_DEFAULTS } from "../../src/core/config.js";
import { Ledger } from "../../src/core/ledger.js";
import { loadRunIsolation } from "../../src/isolation/record.js";
import { makeTempDir } from "../helpers/tmp.js";
import { setupVault } from "../helpers/vault-project.js";
import { GATED_CONTEXT, describeGated, gatedDockerConfig } from "./helpers.js";

const WORK = "w-0123456789ab";
/** The caller's PATH without the offline docker shim that tests/global-setup.ts puts first; a gated test needs the real client. */
const REAL_PATH = (process.env.PATH ?? "")
  .split(delimiter)
  .filter((dir) => resolve(dir) !== resolve("tests", "helpers", "bin-shims"))
  .join(delimiter);
const MARKER = `omf-vault-marker-${randomBytes(8).toString("hex")}`;

/**
 * A digest-pinned base image with `sh`, `sleep` and `wget` (busybox). `OMF_GATED_BASE_IMAGE` names one; without it the test
 * pulls the `alpine:3.22` tag ONCE, only to learn its digest in this gated lane, and everything after uses the digest.
 */
function baseImage(config: string): PinnedImage {
  const fromEnv = process.env.OMF_GATED_BASE_IMAGE;
  if (fromEnv !== undefined && fromEnv !== "") return pinnedImage(fromEnv);
  const docker = (args: string[]) =>
    spawnSync("docker", ["--context", GATED_CONTEXT, ...args], {
      env: { PATH: REAL_PATH, DOCKER_CONFIG: config },
      encoding: "utf8",
      timeout: 300_000,
    });
  const pulled = docker(["pull", "--quiet", "alpine:3.22"]);
  if (pulled.status !== 0) throw new Error(`could not pull the base image: ${pulled.stderr.trim()}`);
  return pinnedImage(docker(["image", "inspect", "--format", "{{index .RepoDigests 0}}", "alpine:3.22"]).stdout.trim());
}

describeGated("G-real-isolation-probe", () => {
  it("measures real sut and harness containers L2; the vault is unreachable and the network is closed", async () => {
    const config = gatedDockerConfig();
    const runtime = createDockerRuntime({
      context: GATED_CONTEXT,
      dockerConfig: config,
      env: { PATH: REAL_PATH, HOME: makeTempDir("omf-gated-home-") },
    });
    const base = baseImage(config);
    const image = await runtime.ensureImage(base);

    // A temp OMF home and project with a marker planted in its vault. Never the real home.
    const { env, location } = setupVault();
    const planted = join(location.dir, "vault", "planted-secret.txt");
    writeFileSync(planted, MARKER, { mode: 0o600 });
    const runId = `r-20261015T000000Z-${randomBytes(2).toString("hex")}`;
    const ledger = new Ledger(location.dir);
    const itemDir = join(location.dir, "items", WORK);
    const scope = { goal_id: "g-fast", work_id: WORK, run_id: runId };
    const deps = { runtime, sink: ledger, scope, itemDir, now: () => new Date() };
    const forbidden = forbiddenPaths(location, { ...env, HOME: makeTempDir("omf-gated-forbidden-home-") });
    const measure = (role: ContainerRole) =>
      createMeasured(
        deps,
        containerSpecFor({
          role,
          image: base,
          labels: { work_id: WORK, run_id: runId, round: 1 },
          serial: 1,
          judge: CONFIG_DEFAULTS.judge,
        }),
        goldenFor({ role, image, forbidden }),
      );
    const exec = (handle: ContainerHandle, argv: string[]) =>
      runtime.exec(handle, { argv, timeoutMs: 20_000, maxOutputBytes: 64 * 1024 });

    const handles: ContainerHandle[] = [];
    let failure: unknown;
    try {
      const sut = await measure("sut");
      handles.push(sut.handle);
      const harness = await measure("harness");
      handles.push(harness.handle);
      expect(sut.measurement).toMatchObject({ stage: "sut", level: "L2", violations: [] });
      expect(harness.measurement).toMatchObject({ stage: "harness", level: "L2", violations: [] });

      // The ledger agrees; the run stays unmeasured because author and implementer are not measured here.
      const isolation = loadRunIsolation(itemDir, scope, ledger.readVerified());
      expect(isolation.stages.sut).toMatchObject({ level: "L2", measurements: 1 });
      expect(isolation.stages.harness).toMatchObject({ level: "L2", measurements: 1 });
      expect(isolation.level).toBe("unmeasured");

      // The planted vault file is absent inside the container and its marker is nowhere the container can look.
      expect(await exec(sut.handle, ["sh", "-c", 'test ! -e "$1"', "sh", planted])).toMatchObject({
        kind: "exited",
        status: 0,
      });
      const grep = ["sh", "-c", 'grep -rl "$1" /tmp /scratch /home /root /mnt /srv 2>/dev/null; true', "sh", MARKER];
      expect(await exec(sut.handle, grep)).toMatchObject({ kind: "exited", stdout: "" });

      // An outbound connection fails. The tool must exist, so a missing wget cannot pass for a closed network.
      expect(await exec(sut.handle, ["sh", "-c", "command -v wget"])).toMatchObject({ kind: "exited", status: 0 });
      const outbound = await exec(sut.handle, ["wget", "-T", "3", "-q", "-O", "/dev/null", "http://1.1.1.1/"]);
      expect(outbound.kind).toBe("exited");
      expect(outbound.kind === "exited" && outbound.status).not.toBe(0);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      const cleanup: unknown[] = [];
      for (const handle of handles) {
        try {
          await runtime.remove(handle);
        } catch (error) {
          cleanup.push(error);
        }
      }
      const left = spawnSync(
        "docker",
        ["--context", GATED_CONTEXT, "ps", "-a", "-q", "--filter", `label=omf.run=${runId}`],
        {
          env: { PATH: REAL_PATH, DOCKER_CONFIG: config },
          encoding: "utf8",
        },
      );
      // An earlier assertion failure stays the reported error; cleanup problems surface only on an otherwise passing run.
      if (failure === undefined) {
        if (cleanup.length > 0) throw cleanup[0];
        expect(left.status).toBe(0);
        expect(left.stdout.trim()).toBe("");
      }
    }
  }, 240_000);
});
