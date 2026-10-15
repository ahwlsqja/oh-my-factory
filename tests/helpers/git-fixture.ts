import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { gitEnv } from "../../src/core/paths.js";
import type { GitTarget } from "../../src/git/hardened.js";
import { type ContextFiles, contextPaths } from "../../src/implementer/context-files.js";
import { realTempDir } from "./ops-fixture.js";
import { commitAll, gitIn, makeGitRepo } from "./tmp.js";

export interface GitFixture {
  /** Real path of the work repository. */
  repo: string;
  /** `<repo>/.git` by real path, usable as the quarantine of `runHostGit` and every `ops` function. */
  quarantine: GitTarget;
  base: string;
  head: string;
}

function writeFiles(repo: string, files: Record<string, string | null>): void {
  for (const [path, content] of Object.entries(files)) {
    const file = join(repo, path);
    if (content === null) {
      rmSync(file);
      continue;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

/**
 * A real repository with two commits on top of `makeGitRepo`'s own: `base` holds `baseFiles`, `head` applies
 * `headChanges` (a path maps to its new content, or to null to delete it). Both sets must change something, because
 * an empty commit fails. The one fixture every gate, audit and prove-test test builds on.
 */
export function gitFixture(baseFiles: Record<string, string>, headChanges: Record<string, string | null>): GitFixture {
  if (Object.keys(baseFiles).length === 0 || Object.keys(headChanges).length === 0) {
    throw new Error("gitFixture needs at least one base file and one head change");
  }
  const repo = realpathSync(makeGitRepo());
  writeFiles(repo, baseFiles);
  commitAll(repo, "base");
  const base = gitIn(repo, "rev-parse", "HEAD").trim();
  writeFiles(repo, headChanges);
  commitAll(repo, "head");
  const head = gitIn(repo, "rev-parse", "HEAD").trim();
  return { repo, quarantine: { gitDir: realpathSync(join(repo, ".git")) }, base, head };
}

/** Files the container-side repository is seeded with; the user's repository gets the same ones, so the two root trees are equal. */
export const CANDIDATE_BASE_FILES: Readonly<Record<string, string>> = {
  "src/app.ts": "export const app = 1;\n",
  "README.md": "# demo\n",
};

/** One commit the implementer made after the context commit: a path maps to its new content, or to null to delete it. */
export interface WorkCommit {
  files: Record<string, string | null>;
  message?: string;
}

export interface CandidateWorldInput {
  workId: string;
  /** Commits made after the context commit, oldest first. */
  work?: readonly WorkCommit[];
  baseFiles?: Readonly<Record<string, string>>;
  /** What the container committed as `spec` and `intent` when it is not what the host rendered. */
  containerContext?: Partial<ContextFiles>;
  /** Extra files added in the context commit. */
  extraContextFiles?: Readonly<Record<string, string>>;
  /** Commit `spec.md` with the executable bit. */
  executableSpec?: boolean;
}

export interface CandidateWorld {
  workId: string;
  /** The user's repository: the base files in one commit, nothing else. */
  userRepo: string;
  baseSha: string;
  baseTreeSha: string;
  /** What the host rendered and expects the context commit to hold. */
  context: ContextFiles;
  /** The container-side repository the bundle is made from. */
  containerRepo: string;
  rootSha: string;
  contextSha: string;
  headSha: string;
}

function seedRepo(files: Readonly<Record<string, string>>): string {
  const repo = realTempDir("omf-seed-");
  gitIn(repo, "init", "-q", "-b", "main");
  writeFiles(repo, files);
  commitAll(repo, "base");
  return repo;
}

const revOf = (repo: string, rev: string): string => gitIn(repo, "rev-parse", rev).trim();

/**
 * The two repositories of one candidate: the user's, and the one a container would have built (root commit with the user's
 * base tree, a context commit with the two rendered files, then the work commits). Both are real git repositories.
 */
export function makeCandidateWorld(input: CandidateWorldInput): CandidateWorld {
  const baseFiles = input.baseFiles ?? CANDIDATE_BASE_FILES;
  const userRepo = seedRepo(baseFiles);
  const containerRepo = seedRepo(baseFiles);
  const rootSha = revOf(containerRepo, "HEAD");
  const context: ContextFiles = { spec: "# spec\n", intent: "# intent\n" };
  const committed = { ...context, ...input.containerContext };
  const paths = contextPaths(input.workId);
  writeFiles(containerRepo, {
    [paths.spec]: committed.spec,
    [paths.intent]: committed.intent,
    ...input.extraContextFiles,
  });
  if (input.executableSpec === true) chmodSync(join(containerRepo, paths.spec), 0o755);
  commitAll(containerRepo, "context");
  const contextSha = revOf(containerRepo, "HEAD");
  for (const [index, commit] of (input.work ?? []).entries()) {
    writeFiles(containerRepo, commit.files);
    commitAll(containerRepo, commit.message ?? `work ${index + 1}`);
  }
  return {
    workId: input.workId,
    userRepo,
    baseSha: revOf(userRepo, "HEAD"),
    baseTreeSha: revOf(userRepo, "HEAD^{tree}"),
    context,
    containerRepo,
    rootSha,
    contextSha,
    headSha: revOf(containerRepo, "HEAD"),
  };
}

/** `git bundle create` of `refs` (default: `HEAD`) in `repo`, read back as bytes: what the container's script prints. */
export function bundleOf(repo: string, ...refs: string[]): Buffer {
  const file = join(realTempDir("omf-bundle-"), "candidate.bundle");
  gitIn(repo, "bundle", "create", file, ...(refs.length === 0 ? ["HEAD"] : refs));
  return readFileSync(file);
}

/** `git` in `repo` with a fixed identity, for commands that write commits (merge, commit, tag). */
export function gitAs(repo: string, ...args: string[]): string {
  return gitIn(
    repo,
    "-c",
    "user.name=omf-test",
    "-c",
    "user.email=omf-test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    ...args,
  );
}

/** `count` more commits on `main`, written through `git fast-import` (a loop of real commits would take seconds). */
export function appendFastCommits(repo: string, count: number): void {
  const parent = revOf(repo, "HEAD");
  let stream = "";
  for (let i = 1; i <= count; i += 1) {
    const content = `${i}\n`;
    stream +=
      `commit refs/heads/main\nmark :${i}\n` +
      `committer omf-test <omf-test@example.invalid> ${1_700_000_000 + i} +0000\n` +
      `data 5\nwork\nfrom ${i === 1 ? parent : `:${i - 1}`}\n` +
      `M 100644 inline fast.txt\ndata ${Buffer.byteLength(content)}\n${content}\n`;
  }
  execFileSync("git", ["fast-import", "--quiet"], {
    cwd: repo,
    input: stream,
    env: gitEnv(),
    stdio: ["pipe", "ignore", "pipe"],
  });
}

/** Every non-directory under `root` mapped to a digest of its bytes (a symlink to its target text), posix paths. `skip` drops paths. */
export function snapshotDir(root: string, skip: (rel: string) => boolean = () => false): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    const file = join(entry.parentPath, entry.name);
    const rel = relative(root, file).split(sep).join("/");
    if (skip(rel)) continue;
    snapshot.set(
      rel,
      lstatSync(file).isSymbolicLink()
        ? `link:${readlinkSync(file)}`
        : createHash("sha1").update(readFileSync(file)).digest("hex"),
    );
  }
  return snapshot;
}

/** `snapshotDir` of a git directory; the object store is left out unless `objects` is true. */
export function snapshotGitDir(gitDir: string, options: { objects?: boolean } = {}): Map<string, string> {
  return snapshotDir(gitDir, (rel) => options.objects !== true && (rel === "objects" || rel.startsWith("objects/")));
}

export function diffSnapshots(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): { added: string[]; changed: string[]; removed: string[] } {
  return {
    added: [...after.keys()].filter((key) => !before.has(key)).sort(),
    changed: [...after.keys()].filter((key) => before.has(key) && before.get(key) !== after.get(key)).sort(),
    removed: [...before.keys()].filter((key) => !after.has(key)).sort(),
  };
}
