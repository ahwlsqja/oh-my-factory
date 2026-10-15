import { readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { type WalkLimits, readTreeFile, walkTree } from "../git/tree-walk.js";

/** No member for SUT or harness output, on purpose: scanning it is a type error, and a canary there is not a hit (E2, F6). */
export const SURFACE_KINDS = ["worktree", "diff", "commit_messages", "implementer_log", "prompt", "feedback"] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];
export const MIN_CANARY_LENGTH = 16;
/** All six; a caller may only narrow by editing this list. */
export const AUDIT_REQUIRED_SURFACES: readonly SurfaceKind[] = SURFACE_KINDS;

export interface AuditSurface {
  kind: SurfaceKind;
  read(): AsyncIterable<Uint8Array>;
  /** True when the surface was truncated, a file was skipped, a walk limit was hit or a read failed. Valid once `read()` has finished. */
  incomplete?(): boolean;
  symlinksSkipped?(): number;
}

export function textSurface(kind: SurfaceKind, text: string | Buffer): AuditSurface {
  const bytes = typeof text === "string" ? Buffer.from(text, "utf8") : text;
  return {
    kind,
    async *read() {
      yield bytes;
    },
  };
}

export interface TreeSurfaceLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  walk: Partial<WalkLimits>;
}
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/**
 * The worktree surface. `walkTree` and `readTreeFile` only: regular files are read, a symlink is not followed but its readlink TEXT
 * is scanned, and `.git` is NOT skipped, at the root or nested (`foo/.git/`): its files are byte-scanned as ordinary files
 * (compressed objects are a recorded limit; plaintext files, config, hooks and packed text are scanned). A NUL byte separates files so
 * a canary cannot match across two. Any cap hit, skipped oversize file, walk limit or read error sets `incomplete()`; nothing is silently dropped.
 */
export function treeSurface(root: string, limits: Partial<TreeSurfaceLimits> = {}): AuditSurface & { symlinksSkipped(): number; incomplete(): boolean } {
  const maxFile = limits.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotal = limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  let incomplete = false;
  let symlinks = 0;
  return {
    kind: "worktree",
    symlinksSkipped: () => symlinks,
    incomplete: () => incomplete,
    async *read() {
      let real: string;
      let entries: ReturnType<typeof walkTree>;
      try {
        real = realpathSync(root);
        entries = walkTree(root, limits.walk);
      } catch {
        incomplete = true;
        return;
      }
      const separator = Buffer.from([0]);
      let total = 0;
      for (const entry of entries) {
        if (entry.kind === "symlink") {
          symlinks += 1;
          try {
            yield Buffer.from(readlinkSync(join(real, entry.path)));
            yield separator;
          } catch {
            incomplete = true;
          }
          continue;
        }
        if (entry.kind !== "file") continue;
        if (entry.size > maxFile) {
          incomplete = true;
          continue;
        }
        if (total + entry.size > maxTotal) {
          incomplete = true;
          return;
        }
        let bytes: Buffer;
        try {
          bytes = readTreeFile(root, entry.path, maxFile);
        } catch {
          incomplete = true;
          continue;
        }
        total += bytes.length;
        yield bytes;
        yield separator;
      }
    },
  };
}

export interface CanaryScan {
  /** `not_run`: no canaries, a required surface kind was not supplied, or ANY supplied surface was incomplete. */
  status: "scanned" | "not_run";
  surfaces_scanned: SurfaceKind[];
  /** `count` = distinct canaries found on that surface; the canary text and id never appear. */
  hits: Array<{ surface: SurfaceKind; count: number }>;
  total: number;
  symlinks_skipped: number;
  /** True forces status `not_run`: a padded file cannot hide a canary beyond a cap (GATE-3 fails it, E7). */
  truncated: boolean;
}

/** The message is the code: the canary is never in an error. */
export class AuditError extends Error {
  readonly code = "canary_too_short";
  constructor() {
    super("canary_too_short");
    this.name = "AuditError";
  }
}

/**
 * Chunked byte scan with a (longest canary - 1) overlap, so a hit across a chunk boundary is found. Base64 or otherwise re-encoded
 * canaries are not detected. Hits are reported even when the scan is `not_run`: a canary that was seen is evidence whatever else
 * was missed.
 */
export async function scanCanaries(canaries: readonly string[], surfaces: readonly AuditSurface[], required: readonly SurfaceKind[] = AUDIT_REQUIRED_SURFACES): Promise<CanaryScan> {
  if (canaries.some((canary) => canary.length < MIN_CANARY_LENGTH)) throw new AuditError();
  if (canaries.length === 0) return { status: "not_run", surfaces_scanned: [], hits: [], total: 0, symlinks_skipped: 0, truncated: false };

  const needles = canaries.map((canary) => Buffer.from(canary, "utf8"));
  const overlap = Math.max(...needles.map((needle) => needle.length)) - 1;
  const found = new Map<SurfaceKind, Set<number>>();
  const complete = new Set<SurfaceKind>();
  let incomplete = false;
  let symlinks = 0;

  for (const surface of surfaces) {
    let whole = true;
    try {
      let carry: Buffer = Buffer.alloc(0);
      for await (const chunk of surface.read()) {
        const window = Buffer.concat([carry, chunk]);
        needles.forEach((needle, index) => {
          if (!window.includes(needle)) return;
          const set = found.get(surface.kind) ?? new Set<number>();
          set.add(index);
          found.set(surface.kind, set);
        });
        carry = Buffer.from(window.subarray(Math.max(0, window.length - overlap)));
      }
    } catch {
      whole = false;
    }
    if (surface.incomplete?.() === true) whole = false;
    symlinks += surface.symlinksSkipped?.() ?? 0;
    if (whole) complete.add(surface.kind);
    else incomplete = true;
  }

  const hits = SURFACE_KINDS.filter((kind) => (found.get(kind)?.size ?? 0) > 0).map((kind) => ({ surface: kind, count: found.get(kind)?.size ?? 0 }));
  const allRequired = required.every((kind) => complete.has(kind));
  return {
    status: allRequired && !incomplete ? "scanned" : "not_run",
    surfaces_scanned: SURFACE_KINDS.filter((kind) => complete.has(kind)),
    hits,
    total: hits.reduce((sum, hit) => sum + hit.count, 0),
    symlinks_skipped: symlinks,
    truncated: incomplete,
  };
}
