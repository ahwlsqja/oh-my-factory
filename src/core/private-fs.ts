import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
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
