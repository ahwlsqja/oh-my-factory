import { execFileSync } from "node:child_process";
import { gitEnv } from "./paths.js";

/**
 * The actor for a decision a person makes at the terminal: `human:<git user.email>` (spec §8). v0.1
 * signatures are not cryptographic; the interactive confirmation is what makes them deliberate.
 */
export function humanActor(repo: string, env: NodeJS.ProcessEnv = process.env): string {
  let email = "";
  try {
    email = execFileSync("git", ["config", "user.email"], {
      cwd: repo,
      encoding: "utf8",
      env: gitEnv(env),
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    email = "";
  }
  if (email === "" || /\s/.test(email))
    throw new Error("set git config user.email; OMF records people as human:<email>");
  return `human:${email}`;
}
