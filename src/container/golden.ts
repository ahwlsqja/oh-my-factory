import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { type ProjectLocation, omfHome } from "../core/paths.js";
import type { StageGolden } from "../isolation/evaluate.js";
import type { PinnedImage } from "./image-ref.js";
import type { ImageInfo } from "./runtime.js";
import {
  AUTHOR_ENV_NAMES,
  CREDENTIAL_SHAPED_ENV_NAMES,
  type ContainerRole,
  type ContainerSpec,
  IMPLEMENTER_ENV_NAMES,
  type ImageId,
  type OwnedLabels,
  ROLE_NETWORK,
  type RoleLimits,
  SECRET_ENV_NAMES,
  type TmpfsSpec,
  containerName,
  roleLimits,
  roleTmpfs,
} from "./spec.js";

export { roleTmpfs } from "./spec.js";

/** The tmpfs mounts of each role and nothing else: no role has a bind mount, so no golden holds a host path. */
const ROLE_DESTINATIONS = {
  sut: ["/tmp", "/scratch"],
  harness: ["/tmp", "/state"],
  workcopy: ["/tmp", "/work"],
  implementer: ["/tmp", "/work", "/agent"],
  author: ["/tmp", "/in", "/out", "/agent"],
} as const satisfies Record<ContainerRole, readonly TmpfsSpec["destination"][]>;

/** Names the daemon adds itself (names only, values are never read); `PATH` because the daemon defaults it when the image sets none. */
const DAEMON_ENV_NAMES = ["HOSTNAME", "HOME", "LC_ALL", "PATH"] as const;

/** The one place a role, labels and the role's limits become a `ContainerSpec`. A limits kind that is not the role's is refused. */
export function containerSpecFor(input: {
  role: ContainerRole;
  image: PinnedImage | ImageId;
  labels: Omit<OwnedLabels, "role">;
  serial: number;
  limits: RoleLimits;
}): ContainerSpec {
  const labels: OwnedLabels = { ...input.labels, role: input.role };
  return {
    name: containerName(labels, input.serial),
    image: input.image,
    labels,
    tmpfs: roleTmpfs(input.role, input.limits),
    limits: roleLimits(input.role, input.limits),
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

/** What the two agent roles add to the generic golden: the fixed names OMF sets at create and the one vendor CLI the role runs. */
const AGENT_ROLES = {
  implementer: { env_names: IMPLEMENTER_ENV_NAMES, binaries: ["claude"] },
  author: { env_names: AUTHOR_ENV_NAMES, binaries: ["codex"] },
} as const;

/**
 * The golden a role is judged against: a read-only root, only the role's tmpfs mounts, the digest-pinned base image's own
 * environment names (trusted data), no credential file, and no vendor CLI except the one the role runs.
 *
 * Judge roles run on no network and no vendor CLI. The two agent roles are the only ones on a network (`bridge`) and each has
 * one vendor CLI: `claude` for the implementer, `codex` for the author; the other one's binary, and a `~/.claude` or `~/.codex`,
 * are violations. An agent role's env names are the image's own names MINUS the secrets and every credential-shaped name, plus
 * the daemon's, plus the role's fixed names: an image that bakes in a key therefore measures `unexpected_env_name`, and a secret
 * name is never allowed at create time (it appears only at exec). `CODEX_HOME` is credential-shaped yet in the author's fixed
 * names; it is allowed because OMF sets it at create and that value replaces the image's own.
 */
export function goldenFor(input: { role: ContainerRole; image: ImageInfo; forbidden: readonly string[] }): StageGolden {
  const { role } = input;
  const agent = role === "implementer" || role === "author" ? AGENT_ROLES[role] : null;
  const refused = new Set<string>([...SECRET_ENV_NAMES, ...CREDENTIAL_SHAPED_ENV_NAMES]);
  const imageNames =
    agent === null ? input.image.env_names : input.image.env_names.filter((name) => !refused.has(name));
  return {
    allowed_mounts: ROLE_DESTINATIONS[role].map((destination) => ({ source: "", destination, read_only: false })),
    forbidden_paths: [...input.forbidden],
    allowed_env_names: [
      ...new Set([...imageNames, ...DAEMON_ENV_NAMES, ...(agent === null ? [] : agent.env_names)]),
    ].sort(),
    network: ROLE_NETWORK[role],
    require_read_only_rootfs: true,
    allowed_vendor_binaries: agent === null ? [] : [...agent.binaries],
    allowed_credential_paths: [],
  };
}
