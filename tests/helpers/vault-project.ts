import { type ProjectLocation, resolveProject } from "../../src/core/paths.js";
import { initProject } from "../../src/core/project.js";
import { type Vault, openVault } from "../../src/vault/vault.js";
import { makeGitRepo, makeTempDir } from "./tmp.js";

export interface VaultProject {
  env: NodeJS.ProcessEnv;
  home: string;
  repo: string;
  location: ProjectLocation;
  vault: Vault;
}

/** An initialized project in a temp OMF home (never the real one) with its vault opened. */
export function setupVault(): VaultProject {
  const repo = makeGitRepo();
  const home = makeTempDir("omf-home-");
  const env = { ...process.env, OMF_HOME: home };
  initProject(repo, env);
  const location = resolveProject(repo, env);
  return { env, home, repo, location, vault: openVault(location, env) };
}
