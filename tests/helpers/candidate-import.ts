import { join } from "node:path";
import { type ImportResult, type ImportedCandidate, importBundle } from "../../src/implementer/import.js";
import { type CandidateWorld, bundleOf } from "./git-fixture.js";
import { realTempDir } from "./ops-fixture.js";

/** `importBundle` of the world's own bundle (or `options.bundle`) into a fresh stage directory. */
export async function attemptImport(
  world: CandidateWorld,
  options: { bundle?: Buffer; baseTreeSha?: string } = {},
): Promise<{ result: ImportResult; stageDir: string }> {
  const stageDir = join(realTempDir("omf-stage-"), "round-1");
  const result = await importBundle({
    stageDir,
    repo: world.userRepo,
    bundle: options.bundle ?? bundleOf(world.containerRepo),
    workId: world.workId,
    expect: { base_tree_sha: options.baseTreeSha ?? world.baseTreeSha, context: world.context },
  });
  return { result, stageDir };
}

/** The closed code of a failed import, or "ok". */
export const importCode = (result: ImportResult): string => (result.ok ? "ok" : result.code);

export async function importCandidate(world: CandidateWorld): Promise<ImportedCandidate> {
  const { result } = await attemptImport(world);
  if (!result.ok) throw new Error(`candidate import failed: ${result.code}`);
  return result.value;
}
