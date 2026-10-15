import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../helpers/tmp.js";
import {
  GATED_CONTEXT,
  GatedRefusal,
  assertGatedConfig,
  findLeaks,
  gatedDocker,
  gatedEnabled,
  scrubInspect,
} from "./helpers.js";

function configWith(...names: string[]): string {
  const dir = makeTempDir("omf-gated-cfg-");
  for (const name of names) {
    const meta = join(dir, "contexts", "meta", createHash("sha256").update(name).digest("hex"));
    mkdirSync(meta, { recursive: true });
    writeFileSync(join(meta, "meta.json"), JSON.stringify({ Name: name }));
  }
  return dir;
}

describe("gated helpers", () => {
  it("the switch is exactly OMF_GATED=docker", () => {
    expect(gatedEnabled({})).toBe(false);
    expect(gatedEnabled({ OMF_GATED: "1" })).toBe(false);
    expect(gatedEnabled({ OMF_GATED: "docker" })).toBe(true);
  });

  it("accepts a config holding only the omf-m3f context", () => {
    const config = configWith(GATED_CONTEXT);
    expect(assertGatedConfig({ OMF_GATED_CONTEXT: GATED_CONTEXT, DOCKER_CONFIG: config })).toEqual({
      context: GATED_CONTEXT,
      config,
    });
  });

  it.each([
    ["another context name", { OMF_GATED_CONTEXT: "default", DOCKER_CONFIG: "/x" }],
    ["no context name", { DOCKER_CONFIG: "/x" }],
    ["no DOCKER_CONFIG", { OMF_GATED_CONTEXT: GATED_CONTEXT }],
    ["an empty config", { OMF_GATED_CONTEXT: GATED_CONTEXT, DOCKER_CONFIG: configWith() }],
    [
      "a second context",
      { OMF_GATED_CONTEXT: GATED_CONTEXT, DOCKER_CONFIG: configWith(GATED_CONTEXT, "colima-a1-bench") },
    ],
    ["the wrong only context", { OMF_GATED_CONTEXT: GATED_CONTEXT, DOCKER_CONFIG: configWith("colima") }],
  ])("refuses %s", (_label, env) => {
    expect(() => assertGatedConfig(env)).toThrow(GatedRefusal);
  });

  it.each([
    ["--context", "default"],
    ["--context=default"],
    ["--host", "tcp://x"],
    ["-H", "tcp://x"],
    ["--host=tcp://x"],
  ])("gatedDocker refuses to let a caller choose the daemon (%s)", (...args) => {
    expect(() => gatedDocker(["ps", ...args])).toThrow(/context|daemon/);
  });

  it("scrubInspect blanks env values, shortens ids and replaces the home path and user name", () => {
    const id = "a".repeat(64);
    const doc = {
      Id: id,
      Config: {
        Hostname: "a".repeat(12),
        Env: ["PATH=/usr/bin", "TOKEN=hunter2", "BARE"],
        Labels: { x: "/Users/jane/work" },
      },
      HostConfig: { Binds: ["/Users/jane/repo:/r:ro"] },
      ResolvConfPath: `/var/lib/docker/containers/${id}/resolv.conf`,
    };
    const out = scrubInspect(doc, { id, homes: ["/Users/jane"], names: ["jane"] });
    expect(out).toEqual({
      Id: "a".repeat(12),
      Config: { Hostname: "a".repeat(12), Env: ["PATH=", "TOKEN=", "BARE="], Labels: { x: "/home/user/work" } },
      HostConfig: { Binds: ["/home/user/repo:/r:ro"] },
      ResolvConfPath: `/var/lib/docker/containers/${"a".repeat(12)}/resolv.conf`,
    });
    expect(JSON.stringify(out)).not.toContain("hunter2");
    expect(scrubInspect({ a: "cab" }, { id, homes: [], names: ["ab"] })).toEqual({ a: "cab" });
  });

  it("findLeaks reports a home path or a user name and ignores a short or root name", () => {
    const targets = { homes: ["/Users/jane"], names: ["jane", "ab", "root"] };
    expect(findLeaks("x /Users/jane/y", targets)).toEqual(["/Users/jane", "jane"]);
    expect(findLeaks("cab root", targets)).toEqual([]);
  });
});
