import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../../src/core/doctor.js";
import { Ledger } from "../../src/core/ledger.js";
import { resolveProject } from "../../src/core/paths.js";
import { initProject, requireProject } from "../../src/core/project.js";
import { SymlinkRefusedError, assertStateTreeClean } from "../../src/core/safe-fs.js";
import { omf } from "../helpers/cli.js";
import { makeGitRepo, makeTempDir } from "../helpers/tmp.js";

// Spec §8, design M3c-D15: no symlink below the OMF home is followed. Part A: the state tree that exists
// today (the M1 carried item). The vault and set-directory cases are part B, added with the vault.

interface Fixture {
  repo: string;
  home: string;
  env: NodeJS.ProcessEnv;
  dir: string;
  /** The project dir relative to the OMF home: what an error message may contain. */
  rel: string;
  outside: string;
}

function initialized(): Fixture {
  const repo = makeGitRepo();
  const home = makeTempDir("omf-home-");
  const env = { OMF_HOME: join(home, ".omf") };
  const { projectDir } = initProject(repo, env);
  return { repo, home, env, dir: projectDir, rel: `projects/${basename(projectDir)}`, outside: makeTempDir("omf-outside-") };
}

/** The message of whatever `fn` throws, or "no error". */
function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return "no error";
}

const refusedMessage = (relPath: string): string => `symlink found under OMF state: ${relPath}`;

const PLANTS: Array<{ name: string; plant: (f: Fixture) => void; refused: (f: Fixture) => string }> = [
  {
    name: "a lock file",
    plant: (f) => symlinkSync(join(f.outside, "target"), join(f.dir, "claim.lock")),
    refused: (f) => `${f.rel}/claim.lock`,
  },
  {
    name: "a file under goals/",
    plant: (f) => {
      mkdirSync(join(f.dir, "goals", "g-1"), { recursive: true });
      symlinkSync(join(f.outside, "target"), join(f.dir, "goals", "g-1", "intent.md"));
    },
    refused: (f) => `${f.rel}/goals/g-1/intent.md`,
  },
  {
    name: "the vault directory",
    plant: (f) => {
      rmSync(join(f.dir, "vault"), { recursive: true });
      symlinkSync(f.outside, join(f.dir, "vault"));
    },
    refused: (f) => `${f.rel}/vault`,
  },
  {
    name: "the project directory",
    plant: (f) => {
      const moved = join(f.outside, "moved");
      renameSync(f.dir, moved);
      symlinkSync(moved, f.dir);
    },
    refused: (f) => f.rel,
  },
];

describe("W-vault-symlink-refused (part A: the existing state tree)", () => {
  for (const p of PLANTS) {
    it(`requireProject and assertStateTreeClean stop on a symlink at ${p.name}`, () => {
      const f = initialized();
      p.plant(f);
      expect(messageOf(() => requireProject(f.repo, f.env))).toBe(refusedMessage(p.refused(f)));
      expect(() => assertStateTreeClean(resolveProject(f.repo, f.env), f.env)).toThrow(SymlinkRefusedError);
    });
  }

  it("does not walk worktrees/, where links such as node_modules are normal, but refuses a link named worktrees", () => {
    const f = initialized();
    mkdirSync(join(f.dir, "worktrees", "w-1"), { recursive: true });
    symlinkSync(f.outside, join(f.dir, "worktrees", "w-1", "node_modules"));
    expect(requireProject(f.repo, f.env).initialized).toBe(true);

    rmSync(join(f.dir, "worktrees"), { recursive: true });
    symlinkSync(f.outside, join(f.dir, "worktrees"));
    expect(messageOf(() => requireProject(f.repo, f.env))).toBe(refusedMessage(`${f.rel}/worktrees`));
  });

  it("keeps the not-initialized message when the home or the project does not exist yet", () => {
    const repo = makeGitRepo();
    const home = join(makeTempDir("omf-home-"), ".omf");
    expect(messageOf(() => requireProject(repo, { OMF_HOME: home }))).toBe("project not initialized; run omf init");
    mkdirSync(home);
    expect(messageOf(() => requireProject(repo, { OMF_HOME: home }))).toBe("project not initialized; run omf init");
  });

  it("works through a symlinked OMF home and reports paths below the real root only", () => {
    const real = makeTempDir("omf-real-");
    const link = join(makeTempDir("omf-link-"), "home");
    symlinkSync(real, link);
    const repo = makeGitRepo();
    const env = { OMF_HOME: link };
    const { projectDir } = initProject(repo, env);
    expect(initProject(repo, env).created).toBe(false);
    expect(requireProject(repo, env).initialized).toBe(true);

    symlinkSync(join(real, "target"), join(projectDir, "claim.lock"));
    expect(messageOf(() => requireProject(repo, env))).toBe(refusedMessage(`projects/${basename(projectDir)}/claim.lock`));
  });

  it("omf init on an existing project refuses a planted link and writes nothing through it", () => {
    const f = initialized();
    PLANTS[2]?.plant(f);
    expect(messageOf(() => initProject(f.repo, f.env))).toBe(refusedMessage(`${f.rel}/vault`));
    // Before the guard, init created vault/metrics inside the link target.
    expect(readdirSync(f.outside)).toEqual([]);
    expect(new Ledger(f.dir).readVerified()).toHaveLength(1);
  });

  it("omf doctor reports the link and does not write preflight.json through it", () => {
    const f = initialized();
    const keep = join(f.outside, "keep.json");
    writeFileSync(keep, "KEEP");
    symlinkSync(keep, join(f.dir, "preflight.json"));
    const report = runDoctor(f.repo, { HOME: f.home, OMF_HOME: f.env.OMF_HOME, PATH: process.env.PATH });
    expect(report.problems).toContain(refusedMessage(`${f.rel}/preflight.json`));
    expect(report.ok).toBe(false);
    expect(readFileSync(keep, "utf8")).toBe("KEEP");
  });

  it("omf ledger verify exits 2 and names the path on a planted link; a clean tree still exits 0", () => {
    const f = initialized();
    expect(omf(["ledger", "verify"], f.repo, f.home).code).toBe(0);
    PLANTS[2]?.plant(f);
    const run = omf(["ledger", "verify"], f.repo, f.home);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(refusedMessage(`${f.rel}/vault`));
    expect(run.stderr).not.toContain(f.home);
  });
});
