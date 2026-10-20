import { describe, expect, it } from "vitest";
import { createArgv } from "../../src/container/argv.js";
import { containerSpecFor } from "../../src/container/golden.js";
import {
  AGENT_LIFETIME_MARGIN_S,
  type ContainerRole,
  ContainerSpecError,
  agentLifetimeSeconds,
  assertSpec,
  roleLifetimeSeconds,
} from "../../src/container/spec.js";
import { CONFIG_DEFAULTS } from "../../src/core/config.js";
import {
  AUTHOR_BASE,
  FIXTURE_AUTHOR_LIMITS,
  IMPLEMENTER_BASE,
  FIXTURE_IMPLEMENTER_LIMITS,
  FIXTURE_RUN_ID,
  FIXTURE_WORK_ID,
  limitsFor,
  specFor,
} from "../helpers/container-fixture.js";
import { FakeDocker } from "../helpers/fake-docker.js";
import { addImage } from "../helpers/fake-docker-core.mjs";

// A host killed by SIGKILL runs no handler and no timer, so the cap of an agent container must live inside the container:
// its entrypoint sleeps for the configured lifetime plus a margin instead of for ever. The image is user-built, so only
// `sleep` is assumed (no `timeout`).
const labels = { work_id: FIXTURE_WORK_ID, run_id: FIXTURE_RUN_ID, round: 1 };
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof ContainerSpecError ? error.code : `other: ${String(error)}`;
  }
  return "no error";
};
const tail = (argv: readonly string[]): string[] => argv.slice(argv.indexOf("--entrypoint"));

describe("agent container lifetime", () => {
  it("is the configured wall time of the one model call, the caps of the other execs and a margin", () => {
    expect(AGENT_LIFETIME_MARGIN_S).toBeGreaterThan(0);
    expect(agentLifetimeSeconds("author", { kind: "author", author: CONFIG_DEFAULTS.author })).toBe(765);
    expect(agentLifetimeSeconds("implementer", { kind: "implementer", implementer: CONFIG_DEFAULTS.implementer })).toBe(
      2865,
    );
  });

  it("rounds a configured time up to whole seconds and moves with the configured bound", () => {
    const author = (timeout_ms: number) =>
      agentLifetimeSeconds("author", { kind: "author", author: { ...FIXTURE_AUTHOR_LIMITS, timeout_ms } });
    expect(author(1500)).toBe(2 + 105 + 60);
    expect((author(1_200_000) ?? 0) - (author(600_000) ?? 0)).toBe(600);
    const implementer = (timeout_ms: number) =>
      agentLifetimeSeconds("implementer", {
        kind: "implementer",
        implementer: { ...FIXTURE_IMPLEMENTER_LIMITS, timeout_ms },
      });
    expect((implementer(3_600_000) ?? 0) - (implementer(1_800_000) ?? 0)).toBe(1800);
    expect(implementer(1)).toBeGreaterThan(1005);
  });

  it("is null for a judge role and refuses limits of another kind", () => {
    for (const role of ["sut", "harness", "workcopy"] as const) {
      expect(agentLifetimeSeconds(role, limitsFor(role))).toBeNull();
    }
    expect(codeOf(() => agentLifetimeSeconds("author", limitsFor("implementer")))).toBe("invalid_limits");
    expect(codeOf(() => agentLifetimeSeconds("implementer", limitsFor("author")))).toBe("invalid_limits");
  });

  it.each([
    ["author", "765"],
    ["implementer", "2865"],
  ] as const)("pins the %s entrypoint argv: sleep for its lifetime, no timeout program", (role, seconds) => {
    const argv = createArgv(specFor(role), "ctx");
    expect(tail(argv)).toEqual(["--entrypoint", "sleep", specFor(role).image, seconds]);
    expect(argv).not.toContain("timeout");
    expect(argv).not.toContain("2147483647");
  });

  it("is built into the spec the stations use, from the role's own table", () => {
    for (const role of ["author", "implementer"] as const) {
      const spec = containerSpecFor({ role, image: specFor(role).image, labels, serial: 1, limits: limitsFor(role) });
      expect(spec.lifetime_s).toBe(agentLifetimeSeconds(role, limitsFor(role)));
    }
    const judge = containerSpecFor({
      role: "sut",
      image: specFor("sut").image,
      labels,
      serial: 1,
      limits: limitsFor("sut"),
    });
    expect(judge.lifetime_s).toBe(roleLifetimeSeconds("sut", limitsFor("sut")));
  });

  it("refuses an agent spec with no lifetime and a lifetime that is not a positive integer", () => {
    for (const role of ["author", "implementer"] as const) {
      const { lifetime_s: _dropped, ...bare } = specFor(role);
      expect(codeOf(() => assertSpec(bare as never))).toBe("invalid_limits");
      for (const lifetime_s of [0, -1, 1.5, Number.NaN, 2147483648]) {
        expect(codeOf(() => assertSpec({ ...specFor(role), lifetime_s }))).toBe("invalid_limits");
      }
    }
    expect(codeOf(() => assertSpec({ ...specFor("sut"), lifetime_s: 60 }))).toBe("no error");
  });

  it("reaches the daemon: the docker double records the sleep argument of each role", async () => {
    const fake = new FakeDocker();
    addImage(fake.state, AUTHOR_BASE, { env: [] });
    addImage(fake.state, IMPLEMENTER_BASE, { env: [] });
    const seen: Record<string, unknown> = {};
    for (const role of ["author", "implementer", "sut"] as ContainerRole[]) {
      const spec = specFor(role);
      const result = await fake.run(createArgv(spec, "fake"), { timeoutMs: 1000, maxOutputBytes: 1_000_000 });
      expect(result).toMatchObject({ kind: "exited", status: 0 });
      const made = fake.state.containers[spec.name] as unknown as { entrypoint: string; cmd: string[] };
      seen[role] = [made.entrypoint, ...made.cmd];
    }
    expect(seen).toEqual({
      author: ["sleep", "765"],
      implementer: ["sleep", "2865"],
      sut: ["sleep", "1703"],
    });
  });
});
