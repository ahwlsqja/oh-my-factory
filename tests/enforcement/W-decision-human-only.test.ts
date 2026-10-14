import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runDecideDefer, runDecideNa, runDecideResolve } from "../../src/cli/decide.js";
import { findDecision } from "../../src/decision/state.js";
import { readTree } from "../helpers/tree.js";
import {
  CONTRACT,
  NOW,
  addInterface,
  addOpen,
  closeInterface,
  decideCli,
  errorCode,
  forge,
  reasonsFor,
  reportAt,
  setupDecisionItem,
  writeJson,
} from "../helpers/decision-fixture.js";

// Spec §5.2, §6.2, §8: a decision is closed by a person. Enforced twice: the writers refuse any actor that is
// not `human:*`, and the fold does not honour a closing event written by `omf` or `agent:*`. The CLI also needs
// a terminal and a retyped `<work_id>/<decision_id>`.
// NOT detected, and not asserted here: a `human:*` event appended directly by someone who can write to ~/.omf
// with a recomputed hash chain. The chain does not protect against write access and v0.1 signatures are not
// cryptographic (spec §8).
describe("W-decision-human-only", () => {
  it("the writers refuse omf and agent actors and append nothing", () => {
    const f = setupDecisionItem();
    closeInterface(f);
    addOpen(f, "d-cache");
    const loc = f.fx.location;
    for (const actor of ["omf", "agent:claude"]) {
      const before = readFileSync(f.fx.ledger.file, "utf8");
      const attempts: Array<[string, () => unknown]> = [
        ["resolve", () => runDecideResolve(loc, f.workId, "d-cache", { choice: "Anything", rationale: "Because.", rejected: [] }, actor)],
        ["defer", () => runDecideDefer(loc, f.workId, "d-cache", { owner: "x", reason: "Later.", revisit_trigger: "Never.", default: "Ship.", expires_at: "2099-01-01T00:00:00.000Z" }, actor, NOW)],
        ["n/a", () => runDecideNa(loc, f.workId, "d-cache", { rationale: "Not needed." }, actor)],
        ["resolve interface", () => runDecideResolve(loc, f.workId, "d-interface", { choice: "Anything", rationale: "Because.", rejected: [], interface: CONTRACT }, actor)],
      ];
      for (const [name, attempt] of attempts) expect(errorCode(attempt), `${actor} ${name}`).toBe("not_human");
      expect(readFileSync(f.fx.ledger.file, "utf8"), `${actor} left the ledger as it was`).toBe(before);
    }
  });

  it("a closing event that omf or an agent appended directly does not close anything", () => {
    const f = setupDecisionItem();
    closeInterface(f);
    for (const id of ["d-r", "d-d", "d-n"]) addOpen(f, id);
    const at = "2026-10-14T00:00:00.000Z";
    forge(f, "agent:claude", "decision.resolved", "d-r", {
      resolution: { choice: "Forged", rationale: "Closed by an agent.", rejected: [], by: "agent:claude", at },
    });
    forge(f, "omf", "decision.deferred", "d-d", {
      deferral: { owner: "omf", reason: "later", revisit_trigger: "never", default: "ship", signed_by: "omf", expires_at: "2099-01-01T00:00:00.000Z" },
    });
    forge(f, "agent:claude", "decision.marked_na", "d-n", { rationale: "Closed by an agent.", by: "agent:claude", at });

    const { state, gate } = reportAt(f, NOW);
    expect(gate.status).toBe("blocked_on_user");
    expect(state.anomalies.length).toBeGreaterThan(0);
    for (const id of ["d-r", "d-d", "d-n"]) {
      expect(findDecision(state, id)?.status, id).toBe("open");
      expect(reasonsFor(gate, id).map((r) => r.code), id).toContain("required_open");
    }
  });

  it("a forged resolution of the interface decision does not make it resolved", () => {
    const f = setupDecisionItem();
    addInterface(f);
    forge(f, "omf", "decision.resolved", "d-interface", {
      resolution: { choice: "Forged", rationale: "Closed by omf.", rejected: [], by: "omf", at: "2026-10-14T00:00:00.000Z" },
      interface: CONTRACT,
    });
    const { state, gate } = reportAt(f, NOW);
    expect(findDecision(state, "d-interface")?.status).toBe("open");
    expect(gate.status).toBe("blocked_on_user");
  });

  it("resolve and defer need a terminal: piped stdin exits 2 and writes nothing", () => {
    const f = setupDecisionItem();
    closeInterface(f);
    addOpen(f, "d-cache");
    const resolution = writeJson(f, "resolution.json", { choice: "Keep it", rationale: "Callers rely on it.", rejected: [] });
    const na = writeJson(f, "na.json", { rationale: "Not needed." });
    const deferral = writeJson(f, "deferral.json", { owner: "dev", reason: "Later.", revisit_trigger: "After review.", default: "Keep it.", expires_at: "2099-01-01T00:00:00.000Z" });
    const commands = [
      ["resolve", f.workId, "d-cache", "--file", resolution],
      ["resolve", f.workId, "d-cache", "--na", "--file", na],
      ["defer", f.workId, "d-cache", "--file", deferral],
    ];
    const project = f.fx.location.dir;
    const before = [...readTree(project)];
    for (const args of commands) {
      const run = decideCli(f, args);
      expect(run.code, args.join(" ")).toBe(2);
      expect(run.stderr, args.join(" ")).toContain("needs an interactive terminal");
      expect([...readTree(project)], `${args.join(" ")} changed host state`).toEqual(before);
    }
    expect(findDecision(reportAt(f, NOW).state, "d-cache")?.status).toBe("open");
  });
});
