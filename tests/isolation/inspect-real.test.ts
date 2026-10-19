import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type StageGolden, evaluateStage } from "../../src/isolation/evaluate.js";
import { containerFactsFromInspect } from "../../src/isolation/inspect.js";
import type { ContainerChecks } from "../../src/isolation/types.js";
import { FIXTURE_DIR, findLeaks } from "../gated/helpers.js";

// Real `docker inspect` output (Docker 29 on colima profile omf-m3f), captured by the gated suite
// G-inspect-parser-real from containers that were created and never started, then scrubbed.
const NAMES = ["bind-ro", "hardened", "hardened-tmpfs", "minimal"] as const;
const load = (name: string): unknown => JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURE_DIR), "utf8"));
const facts = (name: string) => containerFactsFromInspect(load(name));

const CLEAN: ContainerChecks = { vendor_binaries: [], credential_paths: [], docker_socket_present: false };
const GOLDEN: StageGolden = {
  allowed_mounts: [
    { source: "", destination: "/tmp", read_only: false },
    { source: "", destination: "/scratch", read_only: false },
  ],
  forbidden_paths: ["/srv"],
  allowed_env_names: ["PATH"],
  network: "none",
  require_read_only_rootfs: true,
  allowed_vendor_binaries: [],
  allowed_credential_paths: [],
};
const judge = (name: string) => evaluateStage("sut", { facts: facts(name), checks: CLEAN }, GOLDEN, new Date(0));

describe("real docker inspect fixtures", () => {
  it("has the four captured shapes", () => {
    expect(readdirSync(FIXTURE_DIR).sort()).toEqual(NAMES.map((name) => `${name}.json`).sort());
  });

  it.each(NAMES)("%s parses without a thrown field and holds no home path or user name", (name) => {
    expect(() => facts(name)).not.toThrow();
    expect(findLeaks(readFileSync(new URL(`${name}.json`, FIXTURE_DIR), "utf8"))).toEqual([]);
  });

  it("minimal: an unhardened container is seen as one", () => {
    expect(facts("minimal")).toMatchObject({
      privileged: false,
      cap_drop: [],
      read_only_rootfs: false,
      user: "",
      mounts: [],
    });
    expect(judge("minimal").violations).toEqual([
      "caps_not_dropped",
      "network_not_none",
      "root_user",
      "rootfs_writable",
      "no_new_privileges_missing",
      "init_not_disabled",
    ]);
  });

  it("hardened: the argv's flags come back as facts", () => {
    expect(facts("hardened")).toMatchObject({
      network_mode: "none",
      cap_drop: ["ALL"],
      cap_add: [],
      privileged: false,
      read_only_rootfs: true,
      user: "65532:65532",
      mounts: [],
      devices: [],
      sysctls: [],
      runtime: "runc",
      init: false,
    });
    expect(facts("hardened").security_opt.some((option) => option.startsWith("no-new-privileges"))).toBe(true);
    expect(judge("hardened").violations).toEqual([]);
  });

  it("hardened-tmpfs: the tmpfs mounts are seen, and the pinned golden accepts them (L2)", () => {
    expect(facts("hardened-tmpfs").mounts).toEqual([
      { type: "tmpfs", source: "", destination: "/scratch", read_only: false },
      { type: "tmpfs", source: "", destination: "/tmp", read_only: false },
    ]);
    expect(judge("hardened-tmpfs").level).toBe("L2");
  });

  it("bind-ro: a bind is seen as a bind and judged against the golden", () => {
    expect(facts("bind-ro").mounts).toEqual([
      { type: "bind", source: "/srv/omf-capture", destination: "/mnt", read_only: true },
    ]);
    expect(judge("bind-ro").violations).toEqual(["unexpected_mount", "forbidden_mount_source"]);
  });
});
