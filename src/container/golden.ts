import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { JudgeConfig } from "../core/config.js";
import { type ProjectLocation, omfHome } from "../core/paths.js";
import type { StageGolden } from "../isolation/evaluate.js";
import type { PinnedImage } from "./image-ref.js";
import type { ImageInfo } from "./runtime.js";
import {
  type ContainerRole,
  type ContainerSpec,
  type ImageId,
  type OwnedLabels,
  type TmpfsSpec,
  containerName,
  roleTmpfs,
} from "./spec.js";

export { roleTmpfs } from "./spec.js";

/** The tmpfs mounts of each role and nothing else: no role has a bind mount, so no golden holds a host path (M3f-D22). */
const ROLE_DESTINATIONS = {
  sut: ["/tmp", "/scratch"],
  harness: ["/tmp", "/state"],
  workcopy: ["/tmp", "/work"],
} as const satisfies Record<ContainerRole, readonly TmpfsSpec["destination"][]>;

/** Names the daemon adds itself (names only, values are never read); `PATH` because the daemon defaults it when the image sets none. */
const DAEMON_ENV_NAMES = ["HOSTNAME", "HOME", "LC_ALL", "PATH"] as const;

/** The one place a role, labels and the judge config become a `ContainerSpec`. */
export function containerSpecFor(input: {
  role: ContainerRole;
  image: PinnedImage | ImageId;
  labels: Omit<OwnedLabels, "role">;
  serial: number;
  judge: JudgeConfig;
}): ContainerSpec {
  const labels: OwnedLabels = { ...input.labels, role: input.role };
  return {
    name: containerName(labels, input.serial),
    image: input.image,
    labels,
    tmpfs: roleTmpfs(input.role, input.judge),
    limits: { memory_mb: input.judge.memory_mb, cpus: input.judge.cpus, pids: input.judge.pids_limit },
  };
}

/** Realpath of the nearest existing ancestor plus the rest, so a path that does not exist yet still compares correctly. */
function realOrResolved(path: string): string {
  let current = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(current), ...rest);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * What no container may be given a path to (spec §11 rule 1): the vault, this project's state, the OMF home, the repository,
 * the user's home and the agent config homes. Real paths, once each. `evaluateStage` also forbids a bind source that is an
 * ANCESTOR of one of them, so a bind of `~` is caught.
 */
export function forbiddenPaths(location: ProjectLocation, env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME !== undefined && env.HOME !== "" ? env.HOME : homedir();
  const candidates = [
    join(location.dir, "vault"),
    location.dir,
    omfHome(env),
    location.repo,
    home,
    join(home, ".claude"),
    join(home, ".codex"),
    join(home, ".config"),
  ];
  return [...new Set(candidates.map(realOrResolved))].sort();
}

/**
 * The golden a role is judged against: no network, a read-only root, only the role's tmpfs mounts, the digest-pinned base
 * image's own environment names (trusted data, M3f-D9), no vendor CLI and no credential file.
 */
export function goldenFor(input: { role: ContainerRole; image: ImageInfo; forbidden: readonly string[] }): StageGolden {
  return {
    allowed_mounts: ROLE_DESTINATIONS[input.role].map((destination) => ({ source: "", destination, read_only: false })),
    forbidden_paths: [...input.forbidden],
    allowed_env_names: [...new Set([...input.image.env_names, ...DAEMON_ENV_NAMES])].sort(),
    network: "none",
    require_read_only_rootfs: true,
    allowed_vendor_binaries: [],
    allowed_credential_paths: [],
  };
}
