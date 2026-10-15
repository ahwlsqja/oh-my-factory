import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createCommandAuthor } from "../../src/seal/session.js";
import { runS2Station } from "../../src/seal/station.js";
import { ledgerEvents } from "../helpers/enforcement-goal.js";
import { ROUND2, appendWorkStarted, plantCanary, prompts, sealDeps, sealStored, setupLine, writeYaml } from "../helpers/line-fixture.js";

describe("runS2Station", () => {
  it("stores a set and hands over to GATE-2", async () => {
    const l = setupLine();
    const out = await runS2Station(sealDeps(l, writeYaml(l, "r2.yaml", ROUND2)));
    expect(out.step).toMatchObject({ next: "gate2", seal: "stored" });
    expect(ledgerEvents(l.f.fx, "seal.completed")).toHaveLength(1);
    expect(prompts(l)).toHaveLength(1);
  });

  it("stops at J2 when GATE-1 no longer passes, and never calls the author", async () => {
    const l = setupLine({ decisions: false });
    const out = await runS2Station(sealDeps(l, writeYaml(l, "r2.yaml", ROUND2)));
    expect(out.step).toEqual({ next: "stop", route: "J2", code: "gate1_not_passing" });
    expect(existsSync(l.promptLog)).toBe(false);
    expect(ledgerEvents(l.f.fx, "seal.requested")).toHaveLength(0);
  });

  it("stops at J3 when the item started before any seal exists", async () => {
    const l = setupLine();
    appendWorkStarted(l);
    const out = await runS2Station(sealDeps(l, writeYaml(l, "r2.yaml", ROUND2)));
    expect(out.step).toEqual({ next: "stop", route: "J3", code: "implementation_started" });
    expect(existsSync(l.promptLog)).toBe(false);
  });

  it("reuses the latest seal after a killed run and does not call the author again", async () => {
    const l = setupLine();
    const yaml = writeYaml(l, "r2.yaml", ROUND2);
    const sealId = await sealStored(l, yaml);
    appendWorkStarted(l);
    const out = await runS2Station(sealDeps(l, yaml));
    expect(out.step).toEqual({ next: "gate2", seal: "reused", seal_id: sealId });
    expect(prompts(l)).toHaveLength(1);
    expect(ledgerEvents(l.f.fx, "seal.completed")).toHaveLength(1);
  });

  it("retries S2 when the author fails for its own reasons, and records seal.failed", async () => {
    const l = setupLine();
    const session = createCommandAuthor({ command: [process.execPath, "-e", "process.exit(3)"], timeoutMs: 20_000 });
    const out = await runS2Station({ ...sealDeps(l, writeYaml(l, "r2.yaml", ROUND2)), session });
    expect(out.step).toEqual({ next: "retry_s2", code: "nonzero_exit" });
    expect(ledgerEvents(l.f.fx, "seal.failed")).toHaveLength(1);
  });

  it("stops at J7 before any work when sealed material is in the repository", async () => {
    const l = setupLine();
    plantCanary(l.f.fx.repo);
    const out = await runS2Station(sealDeps(l, writeYaml(l, "r2.yaml", ROUND2)));
    expect(out.step).toEqual({ next: "stop", route: "J7", code: "sealed_material_in_repo" });
    expect(out.stage).toBeNull();
    expect(existsSync(l.promptLog)).toBe(false);
    expect(ledgerEvents(l.f.fx, "seal.requested")).toHaveLength(0);
  });
});
