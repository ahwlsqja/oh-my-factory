import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GitTarget } from "../../src/git/hardened.js";
import { type ChainEntry, commitChain, treePaths } from "../../src/git/ops.js";
import { commitAll, gitIn, makeTempDir } from "./tmp.js";

/** File content of one step: text, bytes, a symlink, or null to delete the path. */
export type Content = string | Buffer | { link: string } | null;
export type Step = Record<string, Content>;

export const WORK_ID = "w-0123456789ab";

/** What the context commit adds: the two files OMF renders for the implementer. */
export const contextStep = (workId: string = WORK_ID): Step => ({
  [`.omf/${workId}/spec.md`]: "# spec\n",
  [`.omf/${workId}/intent.md`]: "# intent\n",
});

export interface Chain {
  /** `<repo>/.git` by real path, usable as the quarantine of every ops function. */
  quarantine: GitTarget;
  base: string;
  context: string;
  head: string;
  /** The commits after the context commit, oldest first (what `importBundle` returns as `work`). */
  work: ChainEntry[];
  /** Every path of the base tree (what `readConflictRequest` takes as `basePaths`). */
  basePaths: Set<string>;
}

/** A base commit, the context commit (default `contextStep()`), then one commit per entry of `work`, in a real repository. */
export async function buildChain(input: { base: Step; context?: Step; work: Step[] }): Promise<Chain> {
  const repo = realpathSync(makeTempDir("omf-chain-"));
  gitIn(repo, "init", "-q", "-b", "main");
  const commit = (step: Step, message: string): string => {
    for (const [path, content] of Object.entries(step)) {
      const file = join(repo, path);
      if (content === null) {
        rmSync(file, { force: true });
        continue;
      }
      mkdirSync(dirname(file), { recursive: true });
      if (typeof content === "object" && "link" in content) symlinkSync(content.link, file);
      else writeFileSync(file, content);
    }
    commitAll(repo, message);
    return gitIn(repo, "rev-parse", "HEAD").trim();
  };
  const base = commit(input.base, "base");
  const context = commit(input.context ?? contextStep(), "context");
  let head = context;
  for (const [index, step] of input.work.entries()) head = commit(step, `work ${index + 1}`);
  const quarantine: GitTarget = { gitDir: realpathSync(join(repo, ".git")) };
  const chain = await commitChain(quarantine, head);
  const work = chain.slice(chain.findIndex((entry) => entry.sha === context) + 1);
  return { quarantine, base, context, head, work, basePaths: new Set(await treePaths(quarantine, base)) };
}
