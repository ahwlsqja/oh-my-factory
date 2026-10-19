import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMarkdownStore } from "../../src/adapters/state-markdown.js";
import { cancelGoalAndSweep } from "../../src/cli/goal.js";
import { runVeto } from "../../src/cli/work.js";
import { findWorkItem } from "../../src/adapters/state-markdown.js";
import { Ledger } from "../../src/core/ledger.js";
import { claimFile } from "../../src/work/claim.js";
import { acquireLock, releaseLock, sealLockFile } from "../../src/core/lock.js";
import { cancelGoal } from "../../src/goal/lifecycle.js";
import { claimItem, releaseItem } from "../../src/work/claim.js";
import { CLI, harnessEnv, omf } from "../helpers/cli.js";
import { appendEscalation } from "../helpers/loop-events.js";
import { type FakeDockerBin, fakeDockerBin, plantOwnedContainer, verbOf } from "../helpers/fake-docker.js";
import { type LineFixture, setupLine } from "../helpers/line-fixture.js";
import { AUTHOR_KEY, configureSeal, plantStandingSeal } from "../helpers/seal-cli.js";
import { gitIn, makeTempDir } from "../helpers/tmp.js";

const KILLED = "r-20261001T080000Z-dddd";
const LISTING = ["context inspect", "ps", "image ls"];

/** A run that was killed after its container exists: the run marker `runs/<id>` and an exited container with the omf.owner label. */
function plantKilled(
  l: LineFixture,
  bin: FakeDockerBin,
  role: "author" | "implementer" | "sut" | "harness" | "workcopy",
): string {
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
  it("the next omf seal removes it: only the listing and the planted removal are allowed", () => {
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

  it("the next omf run, refused before its first station, removes it: only the listing and the planted removal are allowed", () => {
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

  it("omf veto itself removes it: only the listing and the planted removal are allowed", () => {
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

  it("after the goal was cancelled the next omf seal and omf run remove it: only the listing and the planted removal are allowed", () => {
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

  it("stays while a live process holds the claim and the author orphan goes in the same sweep: only the listing and the planted removals are allowed", () => {
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

const JUDGE_ROLES = ["sut", "harness", "workcopy"] as const;

describe("judge containers of a killed run on an item that is vetoed", () => {
  const plantJudge = (l: LineFixture, bin: FakeDockerBin): string[] =>
    JUDGE_ROLES.map((role) => plantKilled(l, bin, role));

  it("the next omf seal and the next omf run remove them: only the listing and the planted removals are allowed", () => {
    const l = setupLine();
    configureSeal(l);
    const bin = fakeDockerBin();
    plantJudge(l, bin);
    veto(l);
    const seal = command(bin, () => cli(l, bin, ["seal", l.f.workId], { OMF_AUTHOR_API_KEY: AUTHOR_KEY }));
    expect(seal.out.code).toBe(2);
    expect(seal.verbs).toEqual([...LISTING, "rm", "rm", "rm"]);
    expect(names(bin)).toEqual([]);
    plantJudge(l, bin);
    expect(names(bin)).toHaveLength(3);
    const run = command(bin, () => cli(l, bin, ["run", l.f.workId]));
    expect(run.out.code).toBe(2);
    expect(run.verbs).toEqual([...LISTING, "rm", "rm", "rm"]);
    expect(names(bin)).toEqual([]);
  });

  it("stay while a live process holds the claim, and go once it is released: only the listing is allowed while held", () => {
    const l = setupLine();
    configureSeal(l);
    const bin = fakeDockerBin();
    const planted = plantJudge(l, bin);
    veto(l);
    claimItem(l.f.item.dir);
    try {
      const held = command(bin, () => cli(l, bin, ["seal", l.f.workId], { OMF_AUTHOR_API_KEY: AUTHOR_KEY }));
      expect(held.out.code).toBe(2);
      expect(held.verbs).toEqual(LISTING);
      const run = command(bin, () => cli(l, bin, ["run", l.f.workId]));
      expect(run.verbs).toEqual(LISTING);
      expect(names(bin)).toEqual([...planted].sort());
    } finally {
      releaseItem(l.f.item.dir);
    }
    const free = command(bin, () => cli(l, bin, ["run", l.f.workId]));
    expect(free.verbs).toEqual([...LISTING, "rm", "rm", "rm"]);
    expect(names(bin)).toEqual([]);
  });
});

describe("omf run refused before S1 sweeps the item's orphans", () => {
  it("omf run refused at GATE-1 removes the author orphan with a free seal.lock and the implementer orphan: only the listing and the planted removals are allowed", () => {
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

  it("omf run refused at GATE-1 keeps the author orphan while seal.lock is held and removes the implementer orphan: only the listing and the planted removal are allowed", () => {
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

describe("omf run sweeps on every error outcome", () => {
  it("a sealed-material guard refusal removes the author and implementer orphans before it is printed", async () => {
    const l = setupLine();
    configureSeal(l);
    await plantStandingSeal(l, { measured: true });
    const bin = fakeDockerBin();
    plantKilled(l, bin, "author");
    bin.update((state) => {
      plantOwnedContainer(state, "implementer", KILLED, l.f.workId);
    });
    expect(names(bin)).toHaveLength(2);
    mkdirSync(join(l.f.fx.repo, "goals"), { recursive: true });
    writeFileSync(join(l.f.fx.repo, "goals", "m-latency.lock.json"), "{}\n");
    const { out, verbs } = command(bin, () => cli(l, bin, ["run", l.f.workId]));
    expect(out.code).not.toBe(0);
    expect(out.stderr).toMatch(/sealed material/);
    expect(verbs).toEqual([...LISTING, "rm", "rm"]);
    expect(names(bin)).toEqual([]);
  });

  it("negative guard: a finished goal refuses the run with goal_stopped and still removes both orphans", async () => {
    const l = setupLine();
    configureSeal(l);
    await plantStandingSeal(l, { measured: true });
    appendEscalation(l.f.fx.ledger, l.f.fx.goalId, "J6", "no_progress");
    const bin = fakeDockerBin();
    plantKilled(l, bin, "author");
    bin.update((state) => {
      plantOwnedContainer(state, "implementer", KILLED, l.f.workId);
    });
    const { out, verbs } = command(bin, () => cli(l, bin, ["run", l.f.workId]));
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("goal_stopped");
    expect(verbs).toEqual([...LISTING, "rm", "rm"]);
    expect(names(bin)).toEqual([]);
  });
});

describe("a claim.lock nobody can read", () => {
  const unreadableClaim = (l: LineFixture, mtimeMs: number): void => {
    const file = claimFile(l.f.item.dir);
    writeFileSync(file, "");
    utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  };

  it("older than the grace no longer shields an implementer orphan from the next omf seal after a veto", () => {
    const l = setupLine();
    configureSeal(l);
    const bin = fakeDockerBin();
    plantKilled(l, bin, "implementer");
    veto(l);
    unreadableClaim(l, Date.now() - 3_600_000);
    const { out, verbs } = command(bin, () => cli(l, bin, ["seal", l.f.workId], { OMF_AUTHOR_API_KEY: AUTHOR_KEY }));
    expect(out.code).toBe(2);
    expect(verbs).toEqual([...LISTING, "rm"]);
    expect(names(bin)).toEqual([]);
  });

  it("a claim file dated in the future still shields it: only the listing is allowed", () => {
    const l = setupLine();
    configureSeal(l);
    const bin = fakeDockerBin();
    const implementer = plantKilled(l, bin, "implementer");
    veto(l);
    unreadableClaim(l, Date.now() + 3_600_000);
    const { out, verbs } = command(bin, () => cli(l, bin, ["seal", l.f.workId], { OMF_AUTHOR_API_KEY: AUTHOR_KEY }));
    expect(out.code).toBe(2);
    expect(verbs).toEqual(LISTING);
    expect(names(bin)).toEqual([implementer]);
  });

  it("negative guard: dated 100 ms ago still shields it: only the listing is allowed", () => {
    const l = setupLine();
    configureSeal(l);
    const bin = fakeDockerBin();
    const implementer = plantKilled(l, bin, "implementer");
    veto(l);
    unreadableClaim(l, Date.now() - 100);
    const { out, verbs } = command(bin, () => cli(l, bin, ["seal", l.f.workId], { OMF_AUTHOR_API_KEY: AUTHOR_KEY }));
    expect(out.code).toBe(2);
    expect(verbs).toEqual(LISTING);
    expect(names(bin)).toEqual([implementer]);
  });
});

describe("omf run stopped at the line entry sweeps the item's orphans", () => {
  it("after the same park reason three times, GATE-4 stops the line before S1 and both orphans are removed: only the listing and the planted removals are allowed", async () => {
    const l = setupLine();
    configureSeal(l);
    await plantStandingSeal(l, { measured: true });
    const bin = fakeDockerBin();
    for (let pass = 0; pass < 3; pass += 1) {
      const parked = cli(l, bin, ["run", l.f.workId]);
      expect(parked.stdout).toContain("disclosure_unavailable");
    }
    plantKilled(l, bin, "author");
    bin.update((state) => {
      plantOwnedContainer(state, "implementer", KILLED, l.f.workId);
    });
    expect(names(bin)).toHaveLength(2);
    const { out, verbs } = command(bin, () => cli(l, bin, ["run", l.f.workId]));
    expect(out.stdout).toContain("reentry_loop");
    expect(verbs).toEqual([...LISTING, "rm", "rm"]);
    expect(names(bin)).toEqual([]);
  });
});

describe("omf goal cancel and omf veto print first and sweep afterwards", () => {
  it("cancelGoalAndSweep prints its result before the first docker call and then removes the orphans of the cancelled items", async () => {
    const l = setupLine();
    configureSeal(l);
    const bin = fakeDockerBin();
    plantKilled(l, bin, "author");
    bin.update((state) => {
      plantOwnedContainer(state, "implementer", KILLED, l.f.workId);
    });
    const before = bin.state().calls.length;
    const callsWhenPrinted: number[] = [];
    const printed: string[] = [];
    const result = await cancelGoalAndSweep({
      location: l.f.fx.location,
      ledger: new Ledger(l.f.fx.location.dir),
      store: createMarkdownStore(l.f.fx.location.dir),
      goalId: l.f.fx.goalId,
      actor: "human:dev",
      env: { PATH: bin.path, HOME: l.f.fx.home },
      print: (line) => {
        printed.push(line);
        callsWhenPrinted.push(bin.state().calls.length - before);
      },
    });
    expect(result.cancelled).toEqual([l.f.workId]);
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain(`cancelled ${l.f.fx.goalId}`);
    expect(callsWhenPrinted).toEqual([0]);
    expect(
      bin
        .state()
        .calls.slice(before)
        .map((call) => verbOf(call.argv)),
    ).toEqual([...LISTING, "rm", "rm"]);
    expect(names(bin)).toEqual([]);
  });

  it("omf veto records and prints the veto even when the docker daemon never answers the listing", async () => {
    const l = setupLine();
    configureSeal(l);
    gitIn(l.f.fx.repo, "config", "user.email", "dev@example.com");
    const bin = fakeDockerBin();
    const hangDir = makeTempDir("omf-hang-docker-");
    const pidFile = join(hangDir, "ps.pid");
    const wrapper = join(hangDir, "docker");
    writeFileSync(
      wrapper,
      [
        "#!/bin/sh",
        'for arg in "$@"; do',
        `  if [ "$arg" = ps ]; then echo $$ > '${pidFile}'; exec sleep 600; fi`,
        "done",
        `exec '${join(bin.dir, "docker")}' "$@"`,
        "",
      ].join("\n"),
    );
    chmodSync(wrapper, 0o755);
    const child = spawn(process.execPath, [CLI, "veto", l.f.workId], {
      cwd: l.f.fx.repo,
      env: harnessEnv(l.f.fx.home, { PATH: `${hangDir}:${bin.path}` }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const killOnce = (pid: number): void => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    };
    try {
      const printed = await new Promise<string>((resolve, reject) => {
        let seen = "";
        const timer = setTimeout(() => reject(new Error(`no veto line before the timeout: ${seen}`)), 20_000);
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          seen += chunk;
          if (seen.includes(`vetoed ${l.f.workId}`)) {
            clearTimeout(timer);
            resolve(seen);
          }
        });
        child.on("exit", () => reject(new Error(`omf veto ended before it printed: ${seen}`)));
      });
      expect(printed).toContain(`vetoed ${l.f.workId} (was ready)`);
      expect(findWorkItem(l.f.fx.location.dir, l.f.workId)?.front.state).toBe("vetoed");
      expect(child.exitCode).toBeNull();
    } finally {
      if (child.pid !== undefined) killOnce(child.pid);
      if (existsSync(pidFile)) killOnce(Number(readFileSync(pidFile, "utf8").trim()));
    }
  });
});
