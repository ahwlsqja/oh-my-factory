import { describe, expect, it } from "vitest";
import { humanActor } from "../../src/core/actor.js";
import { gitIn, makeGitRepo, makeTempDir } from "../helpers/tmp.js";

describe("humanActor", () => {
  it("is human:<git user.email>", () => {
    const repo = makeGitRepo();
    gitIn(repo, "config", "user.email", "dev@example.com");
    expect(humanActor(repo, { HOME: makeTempDir(), PATH: process.env.PATH })).toBe("human:dev@example.com");
  });

  it("refuses when no email is configured", () => {
    const repo = makeGitRepo();
    expect(() => humanActor(repo, { HOME: makeTempDir(), PATH: process.env.PATH })).toThrow(/user.email/);
  });
});
