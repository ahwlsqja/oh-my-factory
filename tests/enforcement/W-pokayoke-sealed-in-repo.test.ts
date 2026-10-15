import { randomBytes } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../../src/core/doctor.js";
import { resolveProject } from "../../src/core/paths.js";
import { initProject } from "../../src/core/project.js";
import { runGate2 } from "../../src/scenario/gate2.js";
import { PokaYokeError, assertNoSealedInRepo, scanWorktreeCanaries } from "../../src/vault/pokayoke.js";
import { type SealedItem, fakeFixtureRunner, plant, sealedCtx, seedSealedItem } from "../helpers/scenario-fixture.js";
import { commitAll, makeGitRepo, makeTempDir } from "../helpers/tmp.js";

/** M3c rule 4 (spec §8): sealed material inside the repository or an OMF worktree stops the run. */

const SEALED_PROBLEM = "sealed material inside the repository or an OMF worktree";
const canary = (): string => `omf-canary-${randomBytes(16).toString("hex")}`;

function put(root: string, rel: string, content = "x\n"): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

interface Fixture {
  repo: string;
  env: NodeJS.ProcessEnv;
  location: ReturnType<typeof resolveProject>;
  worktree: string;
}

function fixture(): Fixture {
  const repo = makeGitRepo();
  const home = makeTempDir("omf-home-");
  const env: NodeJS.ProcessEnv = { HOME: home, OMF_HOME: join(home, ".omf"), PATH: makeTempDir("omf-emptybin-") };
  initProject(repo, env);
  const location = resolveProject(repo, env);
  const worktree = join(location.dir, "worktrees", "w-1");
  put(worktree, "a.txt");
  return { repo, env, location, worktree };
}

const doctorSealed = (f: Fixture): string[] =>
  runDoctor(f.repo, f.env).problems.filter((problem) => problem.startsWith(SEALED_PROBLEM));

const REPO_PLANTS: Array<[string, (f: Fixture) => void]> = [
  ["a scenario file under vault/scenarios", (f) => put(f.repo, "vault/scenarios/w-1/seal-1/s-1.yaml", "kind: behavior\n")],
  [
    "a canary string in a committed file",
    (f) => {
      put(f.repo, "docs/notes.md", `see ${canary()}\n`);
      commitAll(f.repo, "plant a canary");
    },
  ],
  ["a metric lock", (f) => put(f.repo, "goals/m-latency.lock.json", "{}\n")],
  ["an empty vault/scenarios directory", (f) => mkdirSync(join(f.repo, "vault", "scenarios"), { recursive: true })],
  ["a symlink to the OMF home", (f) => symlinkSync(f.env.OMF_HOME as string, join(f.repo, "omf-home"))],
];

const WORKTREE_PLANTS: Array<[string, (f: Fixture) => void]> = [
  ["a vault path", (f) => put(f.worktree, "vault/metrics/m-x.json", "{}\n")],
  ["a lock file", (f) => put(f.worktree, "claim.lock", "{}\n")],
  ["a symlink that escapes the worktree into the state root", (f) => symlinkSync(f.location.dir, join(f.worktree, "state"))],
];

describe("W-pokayoke-sealed-in-repo", () => {
  it("passes a clean repository and worktree, and doctor reports no sealed material", () => {
    const f = fixture();
    expect(() => assertNoSealedInRepo(f.location, f.env)).not.toThrow();
    expect(doctorSealed(f)).toEqual([]);
  });

  it.each(REPO_PLANTS)("refuses %s in the repository and doctor reports it", (_name, plant) => {
    const f = fixture();
    plant(f);
    expect(() => assertNoSealedInRepo(f.location, f.env)).toThrow(PokaYokeError);
    expect(doctorSealed(f)).toHaveLength(1);
  });

  it.each(WORKTREE_PLANTS)("refuses %s in an OMF worktree and doctor reports it", (_name, plant) => {
    const f = fixture();
    plant(f);
    expect(() => assertNoSealedInRepo(f.location, f.env)).toThrow(PokaYokeError);
    expect(doctorSealed(f)).toHaveLength(1);
  });

  it("allows a symlink inside a worktree that stays inside it (README -> docs/README.md)", () => {
    const f = fixture();
    put(f.worktree, "docs/README.md", "hello\n");
    symlinkSync(join("docs", "README.md"), join(f.worktree, "README.md"));
    expect(() => assertNoSealedInRepo(f.location, f.env)).not.toThrow();
    expect(doctorSealed(f)).toEqual([]);
  });

  it("returns canary-shaped strings in a worktree as data (known and made up) and never throws for them", () => {
    const f = fixture();
    const known = canary();
    const madeUp = canary();
    put(f.worktree, "notes.txt", `${known} ${madeUp}\n`);
    expect(() => assertNoSealedInRepo(f.location, f.env)).not.toThrow();
    expect(doctorSealed(f)).toEqual([]);
    expect(scanWorktreeCanaries(f.location, new Set([known]), f.env)).toEqual([
      { worktree: "w-1", path: "notes.txt", known: true },
      { worktree: "w-1", path: "notes.txt", known: false },
    ]);
  });

  it("gives scan_incomplete for a symlink loop (ELOOP) instead of crashing", () => {
    const f = fixture();
    symlinkSync("loop-b", join(f.worktree, "loop-a"));
    symlinkSync("loop-a", join(f.worktree, "loop-b"));
    let caught: unknown;
    try {
      assertNoSealedInRepo(f.location, f.env);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PokaYokeError);
    expect((caught as PokaYokeError).findings.every((finding) => finding.kind === "scan_incomplete")).toBe(true);
    expect(doctorSealed(f)).toHaveLength(1);
  });
});

describe("W-pokayoke-sealed-in-repo: GATE-2 refuses before it does anything", () => {
  it.each([
    ["a scenario file inside the repository", (s: SealedItem) => plant(join(s.f.fx.repo, "vault", "scenarios", "w.yaml"), "x\n")],
    ["a canary string in a repository file", (s: SealedItem) => plant(join(s.f.fx.repo, "notes.txt"), `see ${s.scenarios[0]?.canary}\n`)],
  ])("%s", async (_name, arrange) => {
    const s = seedSealedItem();
    arrange(s);
    const fake = fakeFixtureRunner();
    const before = s.f.fx.ledger.readVerified().length;
    await expect(runGate2(sealedCtx(s, { runner: fake.runner }))).rejects.toBeInstanceOf(PokaYokeError);
    expect(fake.opened, "no scenario was run").toHaveLength(0);
    expect(s.f.fx.ledger.readVerified(), "nothing was appended").toHaveLength(before);
  });
});

describe("W-pokayoke-sealed-in-repo: the seal stage", () => {
  it("refuses before the author runs, before any ledger event and before any vault file", async () => {
    const { probeSealRefusal } = await import("../helpers/seal-fixture.js");
    const { PokaYokeError } = await import("../../src/vault/pokayoke.js");
    const { SymlinkRefusedError } = await import("../../src/core/safe-fs.js");
    const cases = [
      ["canary_in_repo", PokaYokeError],
      ["symlink_in_state", SymlinkRefusedError],
    ] as const;
    for (const [kind, errorClass] of cases) {
      const probe = await probeSealRefusal(kind);
      expect(probe.error, kind).toBeInstanceOf(errorClass);
      expect(probe.calls, `${kind}: no author call`).toBe(0);
      expect(probe.eventsAfter, `${kind}: no ledger event`).toBe(probe.eventsBefore);
      expect(probe.vaultEntries, `${kind}: no vault file`).toEqual([]);
    }
  });
});
