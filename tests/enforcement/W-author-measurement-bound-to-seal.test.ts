// covers: S5.3.author-measurement-bound
import { describe, expect, it } from "vitest";
import { recordAuthorMeasurement } from "../../src/author/station.js";
import type { Ledger } from "../../src/core/ledger.js";
import { loadRunIsolation } from "../../src/isolation/record.js";
import { AUTHOR_PASS, sealStamped } from "../helpers/author-session.js";
import { measurement } from "../helpers/gate3-parts.js";
import { type LineFixture, ROUND2, setupLine, writeYaml } from "../helpers/line-fixture.js";

const record = (
  l: LineFixture,
  seal: { seal_id: string; set_sha256: string },
  ledger: Pick<Ledger, "readVerified" | "appendWith"> = l.f.fx.ledger,
): boolean =>
  recordAuthorMeasurement({
    ledger,
    itemDir: l.f.item.dir,
    scope: { ...l.f.scope, run_id: AUTHOR_PASS },
    measurement: measurement("author", "L2", 1),
    seal,
  });

const authorLevel = (l: LineFixture) =>
  loadRunIsolation(l.f.item.dir, { ...l.f.scope, run_id: AUTHOR_PASS }, l.f.fx.ledger.readVerified()).stages.author
    ?.level;

describe("W-author-measurement-bound-to-seal", () => {
  it("binds the measurement to the seal's ledger seq and set hash", async () => {
    const l = setupLine();
    const sealed = await sealStamped(l, writeYaml(l, "a.yaml", ROUND2));
    expect(record(l, sealed)).toBe(true);
    const seal = l.f.fx.ledger.readVerified().find((event) => event.type === "seal.completed");
    const measured = l.f.fx.ledger.readVerified().find((event) => event.type === "isolation.measured");
    expect(measured?.payload.author_scope).toEqual({ seal_seq: seal?.seq, set_sha256: sealed.set_sha256 });
    expect(authorLevel(l)).toBe("L2");
  });

  it("writes nothing for a seal that is no longer the latest, and nothing for a seal the ledger never completed", async () => {
    const l = setupLine();
    const first = await sealStamped(l, writeYaml(l, "a.yaml", ROUND2));
    await sealStamped(l, writeYaml(l, "b.yaml", ROUND2));
    const before = l.f.fx.ledger.readVerified().length;
    expect(record(l, first)).toBe(false);
    expect(record(l, { seal_id: `seal-${"f".repeat(16)}`, set_sha256: "f".repeat(64) })).toBe(false);
    expect(l.f.fx.ledger.readVerified()).toHaveLength(before);
    expect(authorLevel(l)).toBeUndefined();
  });

  it("does not attest a seal stored between the read and the append (the in-lock re-check)", async () => {
    const l = setupLine();
    const sealed = await sealStamped(l, writeYaml(l, "a.yaml", ROUND2));
    const racing = {
      readVerified: () => l.f.fx.ledger.readVerified(),
      appendWith: (build: Parameters<Ledger["appendWith"]>[0]) => {
        // A second seal lands after the measurement's seal was read and before the ledger lock is taken.
        const completed = l.f.fx.ledger.readVerified().find((event) => event.type === "seal.completed");
        l.f.fx.ledger.append({
          actor: "omf",
          type: "seal.completed",
          payload: { ...completed?.payload, round: 2, seal_id: `seal-${"b".repeat(16)}` },
        });
        return l.f.fx.ledger.appendWith(build);
      },
    };
    expect(record(l, sealed, racing)).toBe(false);
    expect(l.f.fx.ledger.readVerified().filter((event) => event.type === "isolation.measured")).toHaveLength(0);
  });

  it("moves the binding on a reseal: the older measurement does not attest the new seal", async () => {
    const l = setupLine();
    const first = await sealStamped(l, writeYaml(l, "a.yaml", ROUND2));
    expect(record(l, first)).toBe(true);
    expect(authorLevel(l)).toBe("L2");
    const second = await sealStamped(l, writeYaml(l, "b.yaml", ROUND2));
    expect(authorLevel(l)).toBeUndefined();
    expect(record(l, second)).toBe(true);
    const seals = l.f.fx.ledger.readVerified().filter((event) => event.type === "seal.completed");
    const measured = l.f.fx.ledger.readVerified().filter((event) => event.type === "isolation.measured");
    expect(measured.at(-1)?.payload.author_scope).toEqual({
      seal_seq: seals.at(-1)?.seq,
      set_sha256: second.set_sha256,
    });
    expect(authorLevel(l)).toBe("L2");
  });

  it("needs both halves of the seal: the real seal id with another set hash is unknown and writes nothing", async () => {
    const l = setupLine();
    const sealed = await sealStamped(l, writeYaml(l, "a.yaml", ROUND2));
    const before = l.f.fx.ledger.readVerified().length;
    expect(record(l, { seal_id: sealed.seal_id, set_sha256: "f".repeat(64) })).toBe(false);
    expect(l.f.fx.ledger.readVerified()).toHaveLength(before);
    expect(authorLevel(l)).toBeUndefined();
    expect(record(l, sealed)).toBe(true);
  });

  it("moves the binding on a reseal that keeps the same set hash: the seq alone retires the older measurement", async () => {
    const l = setupLine();
    const first = await sealStamped(l, writeYaml(l, "a.yaml", ROUND2));
    expect(record(l, first)).toBe(true);
    expect(authorLevel(l)).toBe("L2");
    const completed = l.f.fx.ledger.readVerified().find((event) => event.type === "seal.completed");
    const resealed = l.f.fx.ledger.append({
      actor: "omf",
      type: "seal.completed",
      payload: { ...completed?.payload, round: 2, seal_id: `seal-${"c".repeat(16)}` },
    });
    expect(resealed.payload.set_sha256).toBe(first.set_sha256);
    expect(authorLevel(l)).toBeUndefined();
  });
});
