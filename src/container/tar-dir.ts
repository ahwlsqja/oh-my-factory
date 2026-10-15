import { readlinkSync } from "node:fs";
import { join } from "node:path";
import { TreeReadError, readTreeFile, walkTree } from "../git/tree-walk.js";

export type TarErrorCode = "path_escapes_root" | "path_too_long" | "link_too_long" | "unsupported_entry" | "too_large";

/** The message is the code; no path ever appears in it. */
export class TarError extends Error {
  constructor(readonly code: TarErrorCode) {
    super(code);
    this.name = "TarError";
  }
}

export interface TarEntry {
  /** Posix, relative to the tree root. */
  path: string;
  kind: "file" | "dir" | "symlink";
  /** File bytes; ignored for the other kinds. */
  data: Buffer;
  /** Symlink target as stored; ignored for the other kinds. */
  linkTarget: string;
  executable: boolean;
}

const BLOCK = 512;
/** The sandbox user inside every container (`SANDBOX_USER` 65532:65532), so extracted files belong to the user that runs the gates. */
const SANDBOX_ID = 65532;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TAR_BYTES = 256 * 1024 * 1024;

function assertRelative(path: string): void {
  const segments = path.split("/");
  if (
    path === "" ||
    path.startsWith("/") ||
    path.includes("\0") ||
    segments.some((s) => s === "" || s === "." || s === "..")
  ) {
    throw new TarError("path_escapes_root");
  }
}

/** ustar keeps 100 bytes of name and 155 of prefix; the split is at a slash. A longer path is refused, not truncated. */
function splitName(full: string): { name: string; prefix: string } {
  if (Buffer.byteLength(full) <= 100) return { name: full, prefix: "" };
  for (let i = 0; i < full.length - 1; i += 1) {
    if (full[i] !== "/") continue;
    const prefix = full.slice(0, i);
    const name = full.slice(i + 1);
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) return { name, prefix };
  }
  throw new TarError("path_too_long");
}

function octal(value: number, width: number): Buffer {
  const digits = value.toString(8).padStart(width - 1, "0");
  if (digits.length > width - 1) throw new TarError("too_large");
  return Buffer.from(`${digits}\0`, "latin1");
}

function header(entry: TarEntry): Buffer {
  const { name, prefix } = splitName(entry.kind === "dir" ? `${entry.path}/` : entry.path);
  if (entry.kind === "symlink" && Buffer.byteLength(entry.linkTarget) > 100) throw new TarError("link_too_long");
  // Modes are masked to three values on purpose: nothing from the candidate's tree decides a permission bit beyond "executable".
  const mode = entry.kind === "symlink" ? 0o777 : entry.kind === "dir" || entry.executable ? 0o755 : 0o644;
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, "utf8");
  octal(mode, 8).copy(block, 100);
  octal(SANDBOX_ID, 8).copy(block, 108);
  octal(SANDBOX_ID, 8).copy(block, 116);
  octal(entry.kind === "file" ? entry.data.length : 0, 12).copy(block, 124);
  octal(0, 12).copy(block, 136); // mtime 0: the same tree always gives the same bytes
  block.fill(0x20, 148, 156); // the checksum is computed with its own field read as spaces
  block.write(entry.kind === "file" ? "0" : entry.kind === "dir" ? "5" : "2", 156, 1, "latin1");
  if (entry.kind === "symlink") block.write(entry.linkTarget, 157, 100, "utf8");
  block.write("ustar\0", 257, 6, "latin1");
  block.write("00", 263, 2, "latin1");
  block.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  return block;
}

/** Pure: entries in, archive out. The two zero blocks at the end are the ustar terminator. */
export function tarOfEntries(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  let total = 0;
  for (const entry of entries) {
    assertRelative(entry.path);
    parts.push(header(entry));
    total += BLOCK;
    if (entry.kind === "file" && entry.data.length > 0) {
      const body = Buffer.alloc(Math.ceil(entry.data.length / BLOCK) * BLOCK);
      entry.data.copy(body);
      parts.push(body);
      total += body.length;
    }
    if (total > MAX_TAR_BYTES) throw new TarError("too_large");
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

/**
 * The tree under `root` (an OMF-made staging directory holding objects exported from the quarantine) as a ustar archive. `walkTree`
 * uses `lstat` and never descends into a symlink; a symlink becomes a symlink entry and its target is never read. A file is read
 * with `readTreeFile` (no symlink in the path, regular files only). A FIFO, socket or device is refused: a git tree holds none.
 */
export function tarOfDir(root: string): Buffer {
  const entries: TarEntry[] = [];
  for (const walked of walkTree(root)) {
    if (walked.kind === "other") throw new TarError("unsupported_entry");
    let data: Buffer = Buffer.alloc(0);
    if (walked.kind === "file") {
      try {
        data = readTreeFile(root, walked.path, MAX_FILE_BYTES);
      } catch (error) {
        if (error instanceof TreeReadError && error.code === "too_large") throw new TarError("too_large");
        throw error;
      }
    }
    entries.push({
      path: walked.path,
      kind: walked.kind,
      data,
      linkTarget: walked.kind === "symlink" ? readlinkSync(join(root, walked.path)) : "",
      executable: walked.executable,
    });
  }
  return tarOfEntries(entries);
}
