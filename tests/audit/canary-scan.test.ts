import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AuditSurface,
  AuditError,
  AUDIT_REQUIRED_SURFACES,
  MIN_CANARY_LENGTH,
  SURFACE_KINDS,
  type SurfaceKind,
  scanCanaries,
  textSurface,
  treeSurface,
} from "../../src/audit/canary-scan.js";
import { makeTempDir } from "../helpers/tmp.js";

const CANARY = "CNRY-7f3a91c2e8b4d605"; // 21 characters, above MIN_CANARY_LENGTH
const OTHER = "OTHR-0b6c2d9e41a8f735";

/** All six required kinds, each with innocent text, except those in `over`. */
const surfaces = (over: Partial<Record<SurfaceKind, string>> = {}): AuditSurface[] =>
  SURFACE_KINDS.map((kind) => textSurface(kind, over[kind] ?? "nothing to see here"));
const without = (kind: SurfaceKind): AuditSurface[] => surfaces().filter((s) => s.kind !== kind);
/** A surface that yields the parts as separate chunks. */
const chunked = (kind: SurfaceKind, parts: string[]): AuditSurface => ({
  kind,
  async *read() {
    for (const part of parts) yield Buffer.from(part);
  },
});

describe("scanCanaries", () => {
  it("finds a canary on one surface and reports that surface alone, as a count", async () => {
    const scan = await scanCanaries([CANARY], surfaces({ commit_messages: `fix: ${CANARY} leaked` }));
    expect(scan).toEqual({
      status: "scanned",
      surfaces_scanned: [...SURFACE_KINDS],
      hits: [{ surface: "commit_messages", count: 1 }],
      total: 1,
      symlinks_skipped: 0,
      truncated: false,
    });
  });

  it("finds a canary in the diff surface and in a binary buffer", async () => {
    const binary = Buffer.concat([Buffer.from([0, 255, 1, 2, 0, 128]), Buffer.from(CANARY), Buffer.from([0, 7, 9])]);
    const scan = await scanCanaries([CANARY], [...without("diff"), textSurface("diff", `+const k = "${CANARY}";\n`)]);
    expect(scan.hits).toEqual([{ surface: "diff", count: 1 }]);
    const bin = await scanCanaries([CANARY], [...without("prompt"), textSurface("prompt", binary)]);
    expect(bin.hits).toEqual([{ surface: "prompt", count: 1 }]);
  });

  it("finds a canary that is split across two chunks, at every split position", async () => {
    for (let at = 1; at < CANARY.length; at += 1) {
      const scan = await scanCanaries(
        [CANARY],
        [
          ...without("implementer_log"),
          chunked("implementer_log", [`xx${CANARY.slice(0, at)}`, `${CANARY.slice(at)}yy`]),
        ],
      );
      expect(scan.total, `split at ${at}`).toBe(1);
    }
  });

  it("finds a canary that is split across three chunks", async () => {
    const scan = await scanCanaries(
      [CANARY],
      [...without("feedback"), chunked("feedback", [CANARY.slice(0, 5), CANARY.slice(5, 12), CANARY.slice(12)])],
    );
    expect(scan.total).toBe(1);
  });

  it("counts distinct canaries per surface, not occurrences", async () => {
    const twice = await scanCanaries([CANARY, OTHER], surfaces({ diff: `${CANARY} ${OTHER} ${CANARY}` }));
    expect(twice.hits).toEqual([{ surface: "diff", count: 2 }]);
    expect(twice.total).toBe(2);
    const repeated = await scanCanaries([CANARY], surfaces({ diff: `${CANARY}${CANARY}${CANARY}` }));
    expect(repeated.total).toBe(1);
  });

  it("merges two surfaces of one kind", async () => {
    const scan = await scanCanaries(
      [CANARY, OTHER],
      [...surfaces(), textSurface("diff", CANARY), textSurface("diff", OTHER)],
    );
    expect(scan.hits).toEqual([{ surface: "diff", count: 2 }]);
  });

  it("never puts the canary or any part of its id in the result", async () => {
    const text = JSON.stringify(await scanCanaries([CANARY], surfaces({ prompt: CANARY })));
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain("7f3a91c2");
  });

  it("refuses a canary shorter than 16 characters, with a message that is only the code", async () => {
    expect(MIN_CANARY_LENGTH).toBe(16);
    const failure = await scanCanaries(["a".repeat(15)], surfaces()).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AuditError);
    expect((failure as AuditError).code).toBe("canary_too_short");
    expect((failure as AuditError).message).toBe("canary_too_short");
    await expect(scanCanaries(["a".repeat(16)], surfaces())).resolves.toMatchObject({ status: "scanned" });
  });

  it("is not_run, with nothing scanned, when there are no canaries", async () => {
    expect(await scanCanaries([], surfaces({ diff: CANARY }))).toEqual({
      status: "not_run",
      surfaces_scanned: [],
      hits: [],
      total: 0,
      symlinks_skipped: 0,
      truncated: false,
    });
  });

  it("is not_run when a required surface was not supplied, and still reports the hits it found", async () => {
    for (const kind of SURFACE_KINDS) {
      const scan = await scanCanaries([CANARY], without(kind));
      expect(scan.status, kind).toBe("not_run");
      expect(scan.surfaces_scanned, kind).not.toContain(kind);
    }
    const partial = await scanCanaries(
      [CANARY],
      [...without("worktree").filter((s) => s.kind !== "diff"), textSurface("diff", CANARY)],
    );
    expect(partial).toMatchObject({ status: "not_run", total: 1 });
  });

  it("a caller can narrow the required surfaces only by naming them", async () => {
    expect([...AUDIT_REQUIRED_SURFACES]).toEqual([...SURFACE_KINDS]);
    const scan = await scanCanaries([CANARY], [textSurface("diff", "x")], ["diff"]);
    expect(scan.status).toBe("scanned");
  });

  it("a surface that throws while reading makes the scan not_run and truncated, and keeps what it found first", async () => {
    const flaky: AuditSurface = {
      kind: "implementer_log",
      async *read() {
        yield Buffer.from(`log ${CANARY}`);
        throw new Error("disk went away");
      },
    };
    const scan = await scanCanaries([CANARY], [...without("implementer_log"), flaky]);
    expect(scan).toMatchObject({
      status: "not_run",
      truncated: true,
      total: 1,
      hits: [{ surface: "implementer_log", count: 1 }],
    });
    expect(scan.surfaces_scanned).not.toContain("implementer_log");
  });

  it("a surface that reports itself incomplete makes the scan not_run", async () => {
    const partial: AuditSurface = { ...textSurface("prompt", "x"), incomplete: () => true };
    const scan = await scanCanaries([CANARY], [...without("prompt"), partial]);
    expect(scan).toMatchObject({ status: "not_run", truncated: true });
  });

  it("a canary that only a SUT or harness output string holds is not found on the allowed surfaces", async () => {
    const sutOutput = `server answered ${CANARY}`;
    expect(sutOutput).toContain(CANARY);
    const scan = await scanCanaries([CANARY], surfaces());
    expect(scan).toMatchObject({ status: "scanned", total: 0, hits: [] });
  });
});

/** A worktree surface plus innocent text for the five other kinds, so the worktree is the only variable. */
async function scanTree(root: string, limits?: Parameters<typeof treeSurface>[1]) {
  const tree = treeSurface(root, limits);
  const scan = await scanCanaries([CANARY], [tree, ...surfaces().filter((s) => s.kind !== "worktree")]);
  return { scan, tree };
}

describe("treeSurface", () => {
  it("finds a canary in an ordinary file and in a binary file", async () => {
    const root = makeTempDir("omf-tree-");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), `const k = "${CANARY}";\n`);
    writeFileSync(join(root, "blob.bin"), Buffer.concat([Buffer.from([0, 1, 2, 255]), Buffer.from(CANARY)]));
    const { scan } = await scanTree(root);
    expect(scan).toMatchObject({ status: "scanned", hits: [{ surface: "worktree", count: 1 }], total: 1 });
  });

  it("scans .git at the root and nested .git directories as ordinary files", async () => {
    for (const rel of [".git/config", "foo/.git/COMMIT_EDITMSG", ".git/hooks/pre-commit"]) {
      const root = makeTempDir("omf-tree-git-");
      const file = join(root, rel);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, `leak ${CANARY}\n`);
      const { scan } = await scanTree(root);
      expect(scan.total, rel).toBe(1);
    }
  });

  it("scans the text of a symlink target, and does not follow a symlink to a directory", async () => {
    const root = makeTempDir("omf-tree-links-");
    symlinkSync(`/tmp/${CANARY}`, join(root, "text-link"));
    const { scan, tree } = await scanTree(root);
    expect(scan).toMatchObject({ status: "scanned", total: 1, symlinks_skipped: 1 });
    expect(tree.symlinksSkipped?.()).toBe(1);

    const holder = makeTempDir("omf-tree-vault-");
    writeFileSync(join(holder, "secret.txt"), `${CANARY}\n`);
    const clean = makeTempDir("omf-tree-dirlink-");
    symlinkSync(holder, join(clean, "vault"));
    const followed = await scanTree(clean);
    expect(followed.scan).toMatchObject({ status: "scanned", total: 0, symlinks_skipped: 1 });
  });

  it("does not match across a file boundary", async () => {
    const root = makeTempDir("omf-tree-boundary-");
    writeFileSync(join(root, "a"), CANARY.slice(0, 9));
    writeFileSync(join(root, "b"), CANARY.slice(9));
    expect((await scanTree(root)).scan.total).toBe(0);
  });

  it("a file padded past the per-file cap, with the canary beyond it, is not_run and truncated", async () => {
    const root = makeTempDir("omf-tree-pad-");
    writeFileSync(join(root, "big.txt"), `${"x".repeat(200)}${CANARY}`);
    const { scan, tree } = await scanTree(root, { maxFileBytes: 100 });
    expect(scan).toMatchObject({ status: "not_run", truncated: true, total: 0 });
    expect(tree.incomplete?.()).toBe(true);
  });

  it("a tree past the total cap is not_run and truncated", async () => {
    const root = makeTempDir("omf-tree-total-");
    writeFileSync(join(root, "a.txt"), "x".repeat(40));
    writeFileSync(join(root, "b.txt"), `${"x".repeat(20)}${CANARY}`);
    const { scan } = await scanTree(root, { maxTotalBytes: 60 });
    expect(scan).toMatchObject({ status: "not_run", truncated: true });
  });

  it("a walk limit is not_run and truncated", async () => {
    const root = makeTempDir("omf-tree-walk-");
    for (const name of ["a", "b", "c"]) writeFileSync(join(root, name), "x");
    const { scan } = await scanTree(root, { walk: { maxEntries: 1 } });
    expect(scan).toMatchObject({ status: "not_run", truncated: true });
  });

  it.skipIf(process.getuid?.() === 0)("a file that cannot be read is not_run and truncated", async () => {
    const root = makeTempDir("omf-tree-eacces-");
    const file = join(root, "locked.txt");
    writeFileSync(file, `${CANARY}\n`);
    chmodSync(file, 0o000);
    try {
      const { scan } = await scanTree(root);
      expect(scan).toMatchObject({ status: "not_run", truncated: true });
    } finally {
      chmodSync(file, 0o600);
    }
  });

  it("a root that does not exist is not_run, not clean", async () => {
    const { scan } = await scanTree(join(makeTempDir("omf-tree-none-"), "missing"));
    expect(scan).toMatchObject({ status: "not_run", truncated: true });
  });
});
