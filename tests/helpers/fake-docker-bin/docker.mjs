// The program behind the generated `docker` wrapper of fakeDockerBin(): argv is [state file, ...docker arguments].
// One process per call; the state lives in the file, so a second process (or a killed one) sees what the first left.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { handle, newState } from "../fake-docker-core.mjs";

const [statePath, ...argv] = process.argv.slice(2);
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : newState();

// Only `docker exec -i` reads stdin; every other caller closes it, but reading it elsewhere could block on a terminal.
let stdin = null;
if (argv.includes("exec") && argv.includes("-i")) {
  try {
    stdin = readFileSync(0);
  } catch {
    stdin = Buffer.alloc(0);
  }
}

const result = handle(state, argv, stdin, {}, process.env);
// What the client saw: a test asserts it was started with PATH and DOCKER_CONFIG and nothing else.
// macOS adds __CF_USER_TEXT_ENCODING to some processes on its own; it is not a variable the caller passed.
const call = state.calls.at(-1);
call.env_keys = Object.keys(process.env)
  .filter((key) => key !== "__CF_USER_TEXT_ENCODING")
  .sort();
call.docker_config = process.env.DOCKER_CONFIG ?? null;
writeFileSync(`${statePath}.tmp`, JSON.stringify(state));
renameSync(`${statePath}.tmp`, statePath);

process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.status;
