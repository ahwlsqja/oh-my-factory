import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CANARY_SEARCH } from "../../src/scenario/types.js";

const ROOT = join(import.meta.dirname, "..", "..");

// A source tarball has no .git, so there is no file list to scan: skip with that reason.
const HAS_GIT = existsSync(join(ROOT, ".git"));
const SKIP_NOTE = HAS_GIT ? "" : " (skipped: no .git in a source tarball)";

describe("a clean OMF checkout", () => {
  it.skipIf(!HAS_GIT)(
    `holds no complete canary literal in any tracked or untracked-but-not-ignored text file${SKIP_NOTE}`,
    () => {
      const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
        cwd: ROOT,
        encoding: "utf8",
      });
      const offenders: string[] = [];
      for (const rel of listed.split("\0").filter(Boolean)) {
        let text: string;
        try {
          text = readFileSync(join(ROOT, rel)).toString("latin1");
        } catch {
          continue; // deleted in the working tree
        }
        if (CANARY_SEARCH.test(text)) offenders.push(rel);
      }
      // The guard matches any complete canary; fixtures must build theirs at run time.
      expect(offenders).toEqual([]);
    },
  );
});
