import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Writes a host-state file: missing parents at 0700, the file at 0600 whatever the umask, also when the
 * file already existed with a looser mode. `flag: "wx"` refuses to overwrite.
 */
export function writePrivateFile(path: string, data: string, flag: "w" | "wx" = "w"): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, data, { mode: 0o600, flag });
  chmodSync(path, 0o600);
}

/**
 * Replaces a host-state file so a concurrent reader sees the old content or the new content, never a mix:
 * the data goes to a temp file in the same directory (0600, fsynced) and is renamed over `path`. The
 * state-markdown store uses it for item.md, which `omf work list` and a running tick read while a veto
 * or approval rewrites it (spec §11.1).
 */
export function writePrivateFileAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, data);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    rmSync(temp, { force: true });
    throw err;
  }
  closeSync(fd);
  try {
    renameSync(temp, path);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}
