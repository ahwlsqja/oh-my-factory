import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe } from "vitest";

/**
 * Helpers for the Docker-gated suites (tests/gated/*.test.ts). A gated suite runs only when
 * `OMF_GATED=docker`, which `scripts/gated-docker.mjs` sets after it has started the dedicated colima
 * profile and written a DOCKER_CONFIG that holds only the `colima-omf-m3f` context. These helpers refuse
 * any other context, so a gated test cannot touch the default daemon or another profile by mistake.
 */
export const GATED_CONTEXT = "colima-omf-m3f";

/** The offline docker shim that tests/global-setup.ts puts first on PATH for every vitest worker, gated runs included. */
const SHIM_DIR = fileURLToPath(new URL("../helpers/bin-shims", import.meta.url));

/**
 * The caller's PATH without the offline docker shim, so a gated test reaches the real docker client. The gated
 * DOCKER_CONFIG still limits that client to the one context.
 */
export function gatedPath(env: NodeJS.ProcessEnv = process.env): string {
  return (env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => resolve(dir) !== SHIM_DIR)
    .join(delimiter);
}

export class GatedRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatedRefusal";
  }
}

export function gatedEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMF_GATED === "docker";
}

/** The context and the docker config directory a gated test passes to `createDockerRuntime`. */
export interface GatedContext {
  context: string;
  dockerConfig: string;
}

/** The gated DOCKER_CONFIG directory, or a refusal. */
export function gatedDockerConfig(env: NodeJS.ProcessEnv = process.env): string {
  return assertGatedConfig(env).config;
}

/**
 * A suite that is skipped by name without the switch. A skipped gated suite is not evidence of anything. The body may take
 * the gated context; without the switch the body still runs once to collect its (skipped) tests, so it gets a placeholder
 * and nothing is asserted about the environment.
 */
export function describeGated(name: string, body: (ctx: GatedContext) => void): void {
  describe.skipIf(!gatedEnabled())(name, () => {
    body(
      gatedEnabled()
        ? { context: GATED_CONTEXT, dockerConfig: gatedDockerConfig() }
        : { context: GATED_CONTEXT, dockerConfig: "" },
    );
  });
}

/** Names of the contexts in a docker config directory (`contexts/meta/<id>/meta.json`). */
function contextNames(config: string): string[] {
  const root = join(config, "contexts", "meta");
  let ids: string[];
  try {
    ids = readdirSync(root);
  } catch {
    return [];
  }
  return ids
    .map((id) => (JSON.parse(readFileSync(join(root, id, "meta.json"), "utf8")) as { Name: string }).Name)
    .sort();
}

/** The context and config directory a gated test may use, or a refusal. The config must hold exactly the gated context. */
export function assertGatedConfig(env: NodeJS.ProcessEnv = process.env): { context: string; config: string } {
  if (env.OMF_GATED_CONTEXT !== GATED_CONTEXT)
    throw new GatedRefusal(`gated tests use only the ${GATED_CONTEXT} context`);
  const config = env.DOCKER_CONFIG;
  if (config === undefined || config === "")
    throw new GatedRefusal("DOCKER_CONFIG must name the gated config directory");
  const names = contextNames(config);
  if (names.length !== 1 || names[0] !== GATED_CONTEXT) {
    throw new GatedRefusal(`the gated DOCKER_CONFIG must hold only the ${GATED_CONTEXT} context`);
  }
  return { context: GATED_CONTEXT, config };
}

const DAEMON_CHOICE = /^(?:--context|--host|-H)(?:=|$)/;

/**
 * Runs the real `docker` CLI against the gated context. The caller cannot choose the daemon: an argument that
 * does is refused before anything runs. The child sees only PATH and the gated DOCKER_CONFIG.
 */
export function gatedDocker(
  args: readonly string[],
  input?: string | Buffer,
): { status: number | null; stdout: string; stderr: string } {
  if (args.some((arg) => DAEMON_CHOICE.test(arg)))
    throw new GatedRefusal("a gated call may not choose the context or the daemon");
  const { context, config } = assertGatedConfig();
  const result = spawnSync("docker", ["--context", context, ...args], {
    env: { PATH: gatedPath(), DOCKER_CONFIG: config },
    input,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr || (result.error?.message ?? "") };
}

export const FIXTURE_DIR = new URL("../fixtures/docker-inspect/", import.meta.url);

export interface ScrubOptions {
  /** The full container id; every occurrence becomes its first 12 characters. */
  id: string;
  homes: readonly string[];
  names: readonly string[];
}

const SCRUBBED_HOME = "/home/user";

/**
 * A copy of a `docker inspect` document that is safe to commit: environment values are blanked (names stay),
 * the container id is shortened wherever it appears, the home path becomes `/home/user` and the user name
 * becomes `user`. A name shorter than three characters is left alone, because replacing it would damage
 * unrelated text.
 */
export function scrubInspect(doc: unknown, options: ScrubOptions): unknown {
  const shortId = options.id.slice(0, 12);
  const text = (value: string): string => {
    let out = value.split(options.id).join(shortId);
    for (const home of options.homes) if (home.length > 1) out = out.split(home).join(SCRUBBED_HOME);
    for (const name of options.names) if (name.length >= 3) out = out.split(name).join("user");
    return out;
  };
  const walk = (value: unknown, key: string | null): unknown => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) {
      if (key === "Env")
        return value.map((entry) => (typeof entry === "string" ? `${text(entry.split("=")[0] ?? "")}=` : entry));
      return value.map((item) => walk(item, null));
    }
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [text(k), walk(v, k)]));
    }
    return value;
  };
  return walk(doc, null);
}

/** The home paths and user name of the machine the capture runs on. */
export function scrubTargets(env: NodeJS.ProcessEnv = process.env): { homes: string[]; names: string[] } {
  const homes = [
    ...new Set([env.HOME, homedir()].filter((home): home is string => typeof home === "string" && home.length > 1)),
  ];
  return { homes, names: [userInfo().username] };
}

/** The targets that appear in `text`. A short name and `root` are not reported: they would match unrelated text. */
export function findLeaks(text: string, targets: { homes: string[]; names: string[] } = scrubTargets()): string[] {
  const names = targets.names.filter((name) => name.length >= 3 && name !== "root");
  return [...targets.homes, ...names].filter((target) => text.includes(target));
}

export function writeFixture(name: string, doc: unknown): void {
  writeFileSync(new URL(`${name}.json`, FIXTURE_DIR), `${JSON.stringify(doc, null, 2)}\n`);
}
