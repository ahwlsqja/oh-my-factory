import { pinnedImage } from "../../src/container/image-ref.js";
import type { SecretHandle } from "../../src/container/runtime.js";
import {
  type ContainerRole,
  type ContainerSpec,
  type OwnedLabels,
  type RoleLimits,
  type SecretEnvName,
  containerName,
  agentLifetimeSeconds,
  roleLimits,
  roleTmpfs,
} from "../../src/container/spec.js";
import { type AuthorConfig, CONFIG_DEFAULTS, type ImplementerConfig } from "../../src/core/config.js";

// Invented ids and digests; nothing here names a real image, path or home.
export const FIXTURE_WORK_ID = "w-0123456789ab";
export const FIXTURE_RUN_ID = "r-20261015T120000Z-ab12";
export const SUT_BASE = `example.test/omf/sut-base@sha256:${"a".repeat(64)}`;
export const HARNESS_BASE = `example.test/omf/harness-base@sha256:${"b".repeat(64)}`;
export const IMPLEMENTER_BASE = `example.test/omf/implementer-base@sha256:${"c".repeat(64)}`;
export const AUTHOR_BASE = `example.test/omf/author-base@sha256:${"d".repeat(64)}`;

/** Explicit numbers, so the pinned argv of the implementer does not move when a default of `[implementer]` does. */
export const FIXTURE_IMPLEMENTER_LIMITS: ImplementerConfig = {
  ...CONFIG_DEFAULTS.implementer,
  memory_mb: 2048,
  cpus: 2,
  pids_limit: 512,
  tmp_tmpfs_mb: 256,
  work_tmpfs_mb: 1024,
  agent_tmpfs_mb: 256,
};

/** Explicit numbers, so the pinned argv of the author does not move when a default of `[author]` does. */
export const FIXTURE_AUTHOR_LIMITS: AuthorConfig = {
  ...CONFIG_DEFAULTS.author,
  memory_mb: 1024,
  cpus: 1,
  pids_limit: 256,
  tmp_tmpfs_mb: 64,
  in_tmpfs_mb: 16,
  out_tmpfs_mb: 16,
  agent_tmpfs_mb: 128,
};

export const labelsFor = (role: ContainerRole, round = 1): OwnedLabels => ({
  work_id: FIXTURE_WORK_ID,
  run_id: FIXTURE_RUN_ID,
  round,
  role,
});

/** The limits the stations pass for `role`: `[judge]` defaults for a judge role, the fixture numbers for an agent role. */
export const limitsFor = (role: ContainerRole): RoleLimits =>
  role === "implementer"
    ? { kind: "implementer", implementer: FIXTURE_IMPLEMENTER_LIMITS }
    : role === "author"
      ? { kind: "author", author: FIXTURE_AUTHOR_LIMITS }
      : { kind: "judge", judge: CONFIG_DEFAULTS.judge };

const imageFor = (role: ContainerRole): string =>
  role === "harness"
    ? HARNESS_BASE
    : role === "implementer"
      ? IMPLEMENTER_BASE
      : role === "author"
        ? AUTHOR_BASE
        : SUT_BASE;

export function specFor(role: ContainerRole, serial = 1, round = 1): ContainerSpec {
  const labels = labelsFor(role, round);
  const limits = limitsFor(role);
  const lifetime = agentLifetimeSeconds(role, limits);
  return {
    name: containerName(labels, serial),
    image: pinnedImage(imageFor(role)),
    labels,
    tmpfs: roleTmpfs(role, limits),
    limits: roleLimits(role, limits),
    ...(lifetime === null ? {} : { lifetime_s: lifetime }),
  };
}

/** A fake value shaped like a vendor key. No test uses a real one. */
export const TEST_SECRET = "sk-ant-test-0123456789abcdefghij";

/** The container layer's view of a secret, without `Credential`: a name and a value read once at exec time. */
export function secretHandle(value: string = TEST_SECRET, name: SecretEnvName = "ANTHROPIC_API_KEY"): SecretHandle {
  return { name, reveal: () => value };
}
