import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { Credential, containsCredential } from "../../src/implementer/credential.js";

// Scans for a model key. It lives outside tests/gated because it must read the key value, which the gated suites may not do.

/**
 * Whether `bytes` hold the key as it was given or as JSON writes it inside a string (a key with a quote or a backslash is
 * escaped in a ledger line or an inspect document, and a plain search would miss it).
 */
export function holdsCredentialText(bytes: Buffer | string, credential: Credential): boolean {
  if (containsCredential(bytes, credential)) return true;
  const escaped = JSON.stringify(credential.reveal()).slice(1, -1);
  return escaped !== credential.reveal() && containsCredential(bytes, new Credential(credential.name, escaped));
}

/** Whether any string in a parsed document, object keys included, holds the key. Walks the values, so JSON escaping cannot hide it. */
export function documentHoldsCredential(doc: unknown, credential: Credential): boolean {
  if (typeof doc === "string") return holdsCredentialText(doc, credential);
  if (Array.isArray(doc)) return doc.some((item) => documentHoldsCredential(item, credential));
  if (doc !== null && typeof doc === "object") {
    return Object.entries(doc).some(
      ([key, value]) => holdsCredentialText(key, credential) || documentHoldsCredential(value, credential),
    );
  }
  return false;
}

/** Files above this size are not read: a log or a core file is not where a key accident hides, and a read would cost the run. */
const SCAN_LIMIT = 64 * 1024 * 1024;

/**
 * Paths under `root` whose bytes hold the key. A symlink is followed, to a file or a directory, once per real path, so a link
 * cannot hide a file and a loop cannot hang the scan. Paths are relative to `root`, sorted. Unreadable entries are skipped.
 */
export function filesHoldingCredential(root: string, credential: Credential): string[] {
  const hits: string[] = [];
  const seen = new Set<string>();
  const visit = (full: string, rel: string): void => {
    let real: string;
    let stat: ReturnType<typeof statSync>;
    try {
      real = realpathSync(full);
      stat = statSync(full);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    if (stat.isDirectory()) {
      for (const name of readdirSync(full)) visit(join(full, name), rel === "" ? name : `${rel}/${name}`);
    } else if (stat.isFile() && stat.size <= SCAN_LIMIT && holdsCredentialText(readFileSync(full), credential)) {
      hits.push(rel);
    }
  };
  visit(root, "");
  return hits.sort();
}

/**
 * Entries of the temp directory written since `sinceMs` (a temporary CODEX_HOME or a scratch file of this run), scanned like
 * `filesHoldingCredential`; the paths are relative to `tmp`. Older entries are other programs' and are not read.
 */
export function tempFilesHoldingCredential(tmp: string, sinceMs: number, credential: Credential): string[] {
  const hits: string[] = [];
  for (const name of readdirSync(tmp)) {
    let modified: number;
    try {
      modified = lstatSync(join(tmp, name)).mtimeMs;
    } catch {
      continue;
    }
    if (modified < sinceMs) continue;
    for (const hit of filesHoldingCredential(join(tmp, name), credential))
      hits.push(hit === "" ? name : `${name}/${hit}`);
  }
  return hits.sort();
}
