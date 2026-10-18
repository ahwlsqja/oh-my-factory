// covers: S5.3.standing-seal-rule
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { standingSeal } from "../../src/author/standing.js";
import { gate2EvaluatedEvent } from "../../src/scenario/events.js";
import { evaluateGate2Step } from "../../src/scenario/gate2-adapter.js";
import { setDir } from "../../src/vault/vault.js";
import { bindMeasurement, sealStamped } from "../helpers/author-session.js";
import { addOpen, resolveOpen } from "../helpers/decision-fixture.js";
import { gate2Ctx, type LineFixture, ROUND2, setupLine, writeYaml } from "../helpers/line-fixture.js";

const standing = (l: LineFixture) => standingSeal(l.f.fx.ledger.readVerified(), l.f.scope, l.f.item.dir, l.vault);

/** A container-stamped seal of ROUND2 that GATE-2 passes. */
async function sealedAndPassed(l: LineFixture): Promise<{ seal_id: string; set_sha256: string }> {
  const sealed = await sealStamped(l, writeYaml(l, "round2.yaml", ROUND2));
  expect((await evaluateGate2Step(gate2Ctx(l))).verdict).toBe("pass");
  return sealed;
}

describe("standingSeal", () => {
  it("is none before a seal exists and none until GATE-2 has passed it", async () => {
    const l = setupLine();
    expect(standing(l)).toBeNull();
    await sealStamped(l, writeYaml(l, "round2.yaml", ROUND2));
    expect(standing(l)).toBeNull();
  });

  it("holds after GATE-2 passes, and reports the author as measured only once an L2 measurement is bound to it", async () => {
    const l = setupLine();
    const sealed = await sealedAndPassed(l);
    expect(standing(l)).toMatchObject({ seal: { seal_id: sealed.seal_id }, author_measured: false });
    bindMeasurement(l, "L2");
    expect(standing(l)).toMatchObject({ seal: { seal_id: sealed.seal_id }, author_measured: true });
  });

  it("does not count an L1 author measurement as measured", async () => {
    const l = setupLine();
    await sealedAndPassed(l);
    bindMeasurement(l, "L1");
    expect(standing(l)).toMatchObject({ author_measured: false });
  });

  it("is none once a decision changes the digest the seal was written against", async () => {
    const l = setupLine();
    await sealedAndPassed(l);
    addOpen(l.f, "d-extra", "other");
    resolveOpen(l.f, "d-extra");
    expect(standing(l)).toBeNull();
  });

  it("is none when the latest GATE-2 evaluation of the item failed", async () => {
    const l = setupLine();
    const sealed = await sealedAndPassed(l);
    const events = l.f.fx.ledger.readVerified();
    const seal = events.find((event) => event.type === "seal.completed");
    l.f.fx.ledger.append(
      gate2EvaluatedEvent(l.f.scope, {
        round: 1,
        seal_id: sealed.seal_id,
        status: "fail",
        route: "back_to_S2",
        reason_codes: ["unlinked_decisions"],
        unlinked_decision_ids: ["d-cache"],
        not_run_decision_ids: [],
        counts: { active: 4, behavior_train: 2, behavior_test: 1, canaries: 1, contaminated: 0, retired: 0 },
        set_sha256: sealed.set_sha256,
        decisions_digest: String(seal?.payload.decisions_digest),
        feedback_counts: { weak: 0, contradictions: 0, invalid: 0 },
      }),
    );
    expect(standing(l)).toBeNull();
  });

  it("is none when the sealed set was edited or deleted in the vault", async () => {
    const l = setupLine();
    const sealed = await sealedAndPassed(l);
    const dir = setDir(l.vault, { work_id: l.f.workId, seal_id: sealed.seal_id });
    const [file] = readdirSync(dir);
    // A YAML comment would not change the parsed set digest; flip a real field instead.
    const path = join(dir, String(file));
    const text = readFileSync(path, "utf8");
    const edited = text.replace(
      /^split: (train|test)$/m,
      (_m, split: string) => `split: ${split === "train" ? "test" : "train"}`,
    );
    expect(edited).not.toBe(text);
    writeFileSync(path, edited);
    expect(standing(l)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
    expect(standing(l)).toBeNull();
  });

  it("is none when the seal fold has an anomaly", async () => {
    const l = setupLine();
    await sealedAndPassed(l);
    l.f.fx.ledger.append({
      actor: "omf",
      type: "seal.failed",
      payload: { goal_id: l.f.scope.goal_id, work_id: l.f.workId, round: "not a number" },
    });
    expect(standing(l)).toBeNull();
  });
});
