import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMarkdownStore } from "../../src/adapters/state-markdown.js";
import { runVeto } from "../../src/cli/work.js";
import { acquireLock, releaseLock, sealLockFile } from "../../src/core/lock.js";
import { cancelGoal } from "../../src/goal/lifecycle.js";
import { claimItem, releaseItem } from "../../src/work/claim.js";
import { omf } from "../helpers/cli.js";
import { type FakeDockerBin, fakeDockerBin, plantOwnedContainer, verbOf } from "../helpers/fake-docker.js";
import { type LineFixture, setupLine } from "../helpers/line-fixture.js";
import { AUTHOR_KEY, configureSeal } from "../helpers/seal-cli.js";
import { gitIn } from "../helpers/tmp.js";

const KILLED = "r-20261001T080000Z-dddd";
const LISTING = ["context inspect", "ps", "image ls"];

/** A run that was killed after its container exists: the run marker `runs/<id>` and an exited container with the omf.owner label. */
function plantKilled(l: LineFixture, bin: FakeDockerBin, role: "author" | "implementer"): string {
  mkdirSync(join(l.f.item.dir, "runs", KILLED), { recursive: true });
  let name = "";
  bin.update((state) => {
    name = plantOwnedContainer(state, role, KILLED, l.f.workId);
    const made = state.containers[name];
    if (made !== undefined) made.running = false;
  });
  return name;
}

const names = (bin: FakeDockerBin): string[] => Object.keys(bin.state().containers).sort();

/** The docker verbs one command made, in order, with nothing dropped. */
function command(bin: FakeDockerBin, run: () => { code: number; stdout: string; stderr: string }) {
  const before = bin.state().calls.length;
  const out = run();
  return {
    out,
    verbs: bin
      .state()
      .calls.slice(before)
      .map((call) => verbOf(call.argv)),
  };
}

const cli = (l: LineFixture, bin: FakeDockerBin, args: string[], env: NodeJS.ProcessEnv = {}) =>
  omf(args, l.f.fx.repo, l.f.fx.home, { PATH: bin.path, ...env });

const veto = (l: LineFixture): void => {
  runVeto(l.f.fx.location, l.f.workId, "human:dev", "wrong direction");
};

describe("an implementer container of a killed run on an item that is vetoed", () => {
  it("is removed by the next omf seal; the sweep lists once and removes exactly it", () => {
    const l = setupLine();
    configureSeal(l);
    const bin = fakeDockerBin();
    const implementer = plantKilled(l, bin, "implementer");
    veto(l);
    const { out, verbs } = command(bin, () => cli(l, bin, ["seal", l.f.workId], { OMF_AUTHOR_API_KEY: AUTHOR_KEY }));
    expect(out.code).toBe(2);
    expect(verbs).toEqual([...LISTING, "rm"]);
    expect(names(bin)).not.toContain(implementer);
    expect(names(bin)).toEqual([]);
  });

  it("is removed by the next omf run, which is refused before its first station", () => {
    const l = setupLine();
    configureSeal(l);
    const bin = fakeDockerBin();
    plantKilled(l, bin, "implementer");
    veto(l);
    const { out, verbs } = command(bin, () => cli(l, bin, ["run", l.f.workId]));
    expect(out.code).toBe(2);
    expect(verbs).toEqual([...LISTING, "rm"]);
    expect(names(bin)).toEqual([]);
  });

  it("is removed by omf veto itself", () => {
    const l = setupLine();
    configureSeal(l);
    const bin = fakeDockerBin();
    gitIn(l.f.fx.repo, "config", "user.email", "dev@example.com");
    plantKilled(l, bin, "implementer");
    const { out, verbs } = command(bin, () => cli(l, bin, ["veto", l.f.workId], {}));
    expect(out.code).toBe(0);
    expect(verbs).toEqual([...LISTING, "rm"]);
    expect(names(bin)).toEqual([]);
  });

  it("is removed after the goal was cancelled, by the next omf seal and the next omf run", () => {
    const l = setupLine();
    configureSeal(l);
    const bin = fakeDockerBin();
    const store = createMarkdownStore(l.f.fx.location.dir);
    cancelGoal(l.f.fx.ledger, store, l.f.fx.goalId, "human:dev", new Date());
    const implementer = plantKilled(l, bin, "implementer");
    const seal = command(bin, () => cli(l, bin, ["seal", l.f.workId], { OMF_AUTHOR_API_KEY: AUTHOR_KEY }));
    expect(seal.out.code).toBe(2);
    expect(seal.verbs).toEqual([...LISTING, "rm"]);
    expect(names(bin)).toEqual([]);
    bin.update((state) => {
      plantOwnedContainer(state, "implementer", KILLED, l.f.workId);
    });
    expect(names(bin)).toEqual([implementer]);
    const run = command(bin, () => cli(l, bin, ["run", l.f.workId]));
    expect(run.out.code).toBe(2);
    expect(run.verbs).toEqual([...LISTING, "rm"]);
    expect(names(bin)).toEqual([]);
  });

  it("is kept while a live process holds the claim, and an author orphan with a free seal.lock goes in the same sweep", () => {
    const l = setupLine();
    configureSeal(l);
    const bin = fakeDockerBin();
    const implementer = plantKilled(l, bin, "implementer");
    const author = plantKilled(l, bin, "author");
    veto(l);
    claimItem(l.f.item.dir);
    try {
      const held = command(bin, () => cli(l, bin, ["seal", l.f.workId], { OMF_AUTHOR_API_KEY: AUTHOR_KEY }));
      expect(held.out.code).toBe(2);
      expect(held.verbs).toEqual([...LISTING, "rm"]);
      expect(names(bin)).toEqual([implementer]);
      expect(names(bin)).not.toContain(author);
      const run = command(bin, () => cli(l, bin, ["run", l.f.workId]));
      expect(run.out.code).toBe(2);
      expect(run.verbs).toEqual(LISTING);
      expect(names(bin)).toEqual([implementer]);
    } finally {
      releaseItem(l.f.item.dir);
    }
    const free = command(bin, () => cli(l, bin, ["run", l.f.workId]));
    expect(free.verbs).toEqual([...LISTING, "rm"]);
    expect(names(bin)).toEqual([]);
  });
});

describe("omf run refused before S1 sweeps the item's orphans", () => {
  it("removes an author orphan when GATE-1 is failing and seal.lock is free; the implementer orphan goes with it", () => {
    const l = setupLine({ decisions: false });
    configureSeal(l);
    const bin = fakeDockerBin();
    plantKilled(l, bin, "author");
    bin.update((state) => {
      plantOwnedContainer(state, "implementer", KILLED, l.f.workId);
    });
    expect(names(bin)).toHaveLength(2);
    const { out, verbs } = command(bin, () => cli(l, bin, ["run", l.f.workId]));
    expect(out.code).toBe(3);
    expect(out.stderr).toContain("GATE-1 is not passing");
    expect(verbs).toEqual([...LISTING, "rm", "rm"]);
    expect(names(bin)).toEqual([]);
  });

  it("keeps the author orphan while seal.lock is held and removes the implementer orphan", () => {
    const l = setupLine({ decisions: false });
    configureSeal(l);
    const bin = fakeDockerBin();
    const author = plantKilled(l, bin, "author");
    bin.update((state) => {
      plantOwnedContainer(state, "implementer", KILLED, l.f.workId);
    });
    acquireLock(sealLockFile(l.f.item.dir));
    try {
      const { out, verbs } = command(bin, () => cli(l, bin, ["run", l.f.workId]));
      expect(out.code).toBe(3);
      expect(verbs).toEqual([...LISTING, "rm"]);
      expect(names(bin)).toEqual([author]);
    } finally {
      releaseLock(sealLockFile(l.f.item.dir));
    }
  });
});
