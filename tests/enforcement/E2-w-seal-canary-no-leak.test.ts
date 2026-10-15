import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { needsHumanFile } from "../../src/decision/needs-human.js";
import { specFile } from "../../src/decision/spec-md.js";
import { foldSeals } from "../../src/scenario/events.js";
import { runS2Station, runS2ThenGate2 } from "../../src/seal/station.js";
import { setDir, readScenarioSet } from "../../src/vault/vault.js";
import { CANARY, canaryHits } from "../helpers/canary.js";
import { omf } from "../helpers/cli.js";
import { measureOnce } from "../helpers/decision-fixture.js";
import { ledgerEvents } from "../helpers/enforcement-goal.js";
import {
  SCENARIO_TEXT,
  ROUND1,
  ROUND2,
  passDeps,
  prompts,
  sealDeps,
  setupLine,
  writeYaml,
} from "../helpers/line-fixture.js";
import { readTree } from "../helpers/tree.js";

// Spec §4.6 (F6), E2 on the W side, first third: what OMF puts in the seal prompt, the ledger and its own
// projections. The author is a stub process; this proves what OMF gives it and records, not what it does with
// it (independent sealing is M3h). Implementer and verifier surfaces are M3e.

function expectNone(surfaces: Record<string, string>, needles: readonly string[]): void {
  for (const [name, text] of Object.entries(surfaces)) {
    for (const needle of needles) expect(text.includes(needle), `${name} holds ${needle.slice(0, 12)}...`).toBe(false);
  }
}

describe("E2-w-seal-canary-no-leak", () => {
  it("keeps scenario text and the goal's canaries out of prompts, payloads, projections and output", async () => {
    const l = setupLine();
    measureOnce(l.f);
    const first = await runS2ThenGate2(passDeps(l, writeYaml(l, "r1.yaml", ROUND1)));
    if (first.status !== "back_to_S2") throw new Error(`expected back_to_S2, got ${first.status}`);
    const second = await runS2ThenGate2(passDeps(l, writeYaml(l, "r2.yaml", ROUND2), first.feedback ?? undefined));
    expect(second.status).toBe("pass");

    const events = ledgerEvents(l.f.fx);
    const seal = foldSeals(events, l.f.scope).latest;
    if (seal === null) throw new Error("no seal was recorded");
    const ref = { work_id: l.f.workId, seal_id: seal.seal_id };
    const set = readScenarioSet(l.vault, ref);
    if (!set.ok) throw new Error(`the vault set is unreadable: ${set.reason}`);
    const scenarioStrings = [...SCENARIO_TEXT, ...set.scenarios.map((s) => s.canary)];

    const vaultText = [...readTree(setDir(l.vault, ref)).values()].join("\n");
    for (const needle of scenarioStrings)
      expect(vaultText, "positive control: the vault holds the scenario").toContain(needle);
    expect(
      canaryHits(readFileSync(l.f.fx.ledger.file, "utf8")),
      "positive control: the ledger holds the reading",
    ).toContain("reading");

    const cli = ["decide lint --render", "decide show", "ledger verify"]
      .map((line) => {
        const args = line.split(" ");
        const run = omf(
          args[0] === "decide" ? [...args.slice(0, 2), l.f.workId, ...args.slice(2)] : args,
          l.f.fx.repo,
          l.f.fx.home,
        );
        // A refusal prints little, so a non-zero exit would pass the no-leak checks below for nothing.
        expect(run.code, `${line} exits 0`).toBe(0);
        return `${run.stdout}\n${run.stderr}`;
      })
      .join("\n");
    const needsHuman = existsSync(needsHumanFile(l.f.item.dir))
      ? readFileSync(needsHumanFile(l.f.item.dir), "utf8")
      : "";
    const payloads = events
      .filter((e) => /^(seal|scenario|gate2)\./.test(e.type))
      .map((e) => JSON.stringify(e.payload))
      .join("\n");
    const surfaces = {
      "round 1 prompt": prompts(l)[0] ?? "",
      "round 2 prompt": prompts(l)[1] ?? "",
      "seal, scenario and gate2 payloads": payloads,
      "spec.md": readFileSync(specFile(l.f.item.dir), "utf8"),
      "needs-human.json": needsHuman,
      "command output": cli,
    };
    expect(prompts(l)).toHaveLength(2);
    expectNone({ ...surfaces, ledger: readFileSync(l.f.fx.ledger.file, "utf8") }, scenarioStrings);
    for (const [name, text] of Object.entries(surfaces)) expect(canaryHits(text), name).toEqual([]);
    expect(surfaces["round 2 prompt"], "feedback is the unlinked decision id").toContain("d-cache");
    expect(set.scenarios.some((s) => s.kind === "contradiction_canary")).toBe(true);
  });

  it("refuses an intent that holds the locked target before the author is ever called", async () => {
    const l = setupLine();
    const candidate = { ...l.f.item.intent.candidate, problem: `Lookups must stay under ${CANARY.target} ms.` };
    const item = { ...l.f.item, intent: { ...l.f.item.intent, candidate } };
    const out = await runS2Station({ ...sealDeps(l, writeYaml(l, "r2.yaml", ROUND2)), item });
    expect(out.step).toEqual({ next: "stop", route: "J3", code: "intent_leak" });
    expect(prompts(l)).toHaveLength(0);
    expect(existsSync(join(l.yamlDir, "prompts.log"))).toBe(false);
    expect(ledgerEvents(l.f.fx, "seal.requested")).toHaveLength(0);
  });
});
