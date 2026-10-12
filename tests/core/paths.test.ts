import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NotAGitRepoError, omfHome, projectDir, projectId, repoToplevel } from "../../src/core/paths.js";
import { makeGitRepo, makeTempDir } from "../helpers/tmp.js";

describe("omfHome", () => {
  it("uses OMF_HOME when it is set", () => {
    expect(omfHome({ OMF_HOME: "/x/omf", HOME: "/h" })).toBe("/x/omf");
  });

  it("falls back to $HOME/.omf", () => {
    expect(omfHome({ HOME: "/h" })).toBe("/h/.omf");
  });
});

describe("repoToplevel", () => {
  it("returns the real path of the repository root from a subdirectory", () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, "sub"));
    expect(repoToplevel(join(repo, "sub"))).toBe(realpathSync(repo));
  });

  it("throws NotAGitRepoError outside a repository", () => {
    expect(() => repoToplevel(makeTempDir())).toThrow(NotAGitRepoError);
  });
});

describe("projectId and projectDir", () => {
  it("is 16 lowercase hex characters and stable", () => {
    const repo = makeGitRepo();
    const top = repoToplevel(repo);
    expect(projectId(top)).toMatch(/^[0-9a-f]{16}$/);
    expect(projectId(top)).toBe(projectId(top));
  });

  it("differs between repositories", () => {
    expect(projectId(repoToplevel(makeGitRepo()))).not.toBe(projectId(repoToplevel(makeGitRepo())));
  });

  it("places the project under OMF_HOME/projects/<id>", () => {
    const repo = makeGitRepo();
    const id = projectId(repoToplevel(repo));
    expect(projectDir(repo, { OMF_HOME: "/x/omf" })).toBe(`/x/omf/projects/${id}`);
  });
});
