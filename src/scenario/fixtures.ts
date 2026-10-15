import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import type { Stats } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FixtureId } from "./runner.js";
import type { RefusalCode } from "./types.js";

export interface FixtureEntry {
  id: FixtureId;
  file: string;
  sha256: string;
}

/**
 * The only programs the host adapter will ever execute (spec §5.3, M3c-D6). Committed constants, not a hash
 * computed at install time: a hash recomputed from the shipped file would follow an edit of that file. A drift
 * test recomputes these from fixtures/, so changing a fixture or adding one is a reviewed change to this list.
 */
export const FIXTURE_ALLOWLIST: readonly FixtureEntry[] = [
  { id: "null-error", file: "null-error.mjs", sha256: "ef8b36e05e60fc2fca3c517376e6c503594c5ff5da127ece2f95b97c528d81e7" },
  { id: "null-empty", file: "null-empty.mjs", sha256: "271b9e38d87f8d367122ff6bf1fa9efd3c798f5bae49a82e9e5b8b3e911e785c" },
  { id: "echo-everything", file: "echo-everything.mjs", sha256: "5fb041d12b5ebc1c0fa4e6da82b619bc95f4191f149e7fd78ce906ef5a6ccfbe" },
];

/** `<package>/fixtures`, two levels above both `src/scenario` and `dist/scenario` (like `schemaUrl`). Never throws. */
export function fixturesDir(): string {
  const dir = fileURLToPath(new URL("../../fixtures", import.meta.url));
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

export type FixtureCheck =
  | { ok: true; id: FixtureId; realPath: string; source: string }
  | { ok: false; code: RefusalCode };

/**
 * Checks one fixture against the committed allowlist: the id must be listed, the file must exist in `dir`
 * (default: the package fixtures directory), its realpath must be a direct child of the real `dir`, it must be a
 * regular file and not a link, and the bytes read once must hash to the listed sha256. `source` is exactly those
 * bytes, so the caller executes what was verified. `dir` is a test seam only: the allowlist is always the
 * committed constant, so a modified copy in another directory is refused on its hash.
 */
export function verifyFixture(id: string, dir?: string): FixtureCheck {
  const entry = FIXTURE_ALLOWLIST.find((candidate) => candidate.id === id);
  if (entry === undefined) return { ok: false, code: "unknown_fixture" };
  let base: string;
  let stat: Stats;
  let real: string;
  try {
    base = realpathSync(dir ?? fixturesDir());
    const path = join(base, entry.file);
    stat = lstatSync(path);
    real = realpathSync(path);
  } catch {
    return { ok: false, code: "fixture_missing" };
  }
  if (dirname(real) !== base) return { ok: false, code: "fixture_outside_dir" };
  if (!stat.isFile()) return { ok: false, code: "fixture_not_regular_file" };
  let bytes: Buffer;
  try {
    bytes = readFileSync(real);
  } catch {
    return { ok: false, code: "fixture_missing" };
  }
  if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) return { ok: false, code: "fixture_hash_mismatch" };
  return { ok: true, id: entry.id, realPath: real, source: bytes.toString("utf8") };
}
