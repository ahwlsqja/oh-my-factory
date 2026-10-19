#!/bin/sh
# Smoke test of the three verbs of the line (omf seal, omf run, omf report) in a throwaway project. It runs the built CLI
# in a temp repository, a temp HOME and a Docker config that holds only the omf-m3f context, against an item that does not
# exist, and checks that each verb refuses in order (exit 2), names the item, and that no key value appears in any output.
# It spends nothing and starts no container: a real item needs J1 and J2 signatures that refuse non-terminals, so the full
# walk with a real model is the gated suite G-skeleton-real (docs/author.md, "Gated runs").
#
#   npm run build && OMF_AUTHOR_API_KEY="$(security find-generic-password -a "$USER" -s omf-gated-openai -w)" \
#     OMF_IMPLEMENTER_API_KEY="$(security find-generic-password -a "$USER" -s omf-gated-anthropic -w)" sh scripts/smoke-w.sh
#
# The keychain form keeps the key text out of the shell history. The keys are read from this environment only, never written to a file and never printed. The colima-omf-m3f Docker
# context must exist (npm run test:gated creates it by starting the profile).
# Exit codes: 0 every check held, 1 a check failed, 2 the script could not run.
set -eu

for name in OMF_AUTHOR_API_KEY OMF_IMPLEMENTER_API_KEY; do
  if [ -z "$(printenv "$name" || true)" ]; then
    echo "$name is not set; the keys are read from this environment only. Nothing was run." >&2
    exit 2
  fi
done

root=$(cd "$(dirname "$0")/.." && pwd)
if [ ! -f "$root/dist/cli/main.js" ]; then
  echo "dist/ is missing; run npm run build first. Nothing was run." >&2
  exit 2
fi
for tool in git docker node; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool is not installed. Nothing was run." >&2
    exit 2
  fi
done

host=$(docker context inspect colima-omf-m3f --format '{{.Endpoints.docker.Host}}' 2>/dev/null) || host=""
case "$host" in
  unix://*/omf-m3f/docker.sock) ;;
  *)
    echo "the colima-omf-m3f Docker context does not point at the omf-m3f socket. Nothing was run." >&2
    exit 2
    ;;
esac

scratch=$(mktemp -d "${TMPDIR:-/tmp}/omf-smoke-w-XXXXXX")
trap 'rm -rf "$scratch"' EXIT INT TERM HUP

OMF_ROOT="$root" OMF_SCRATCH="$scratch" OMF_SOCKET="$host" node --input-type=module <<'JS'
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.OMF_ROOT ?? "";
const scratch = process.env.OMF_SCRATCH ?? "";
const { dockerConfigFor } = await import(pathToFileURL(join(root, "scripts", "gated-docker.mjs")).href);

const keyNames = ["OMF_AUTHOR_API_KEY", "OMF_IMPLEMENTER_API_KEY"];
const keys = keyNames.map((name) => process.env[name] ?? "");
const home = join(scratch, "home");
const repo = join(scratch, "repo");
mkdirSync(home, { recursive: true });
mkdirSync(repo, { recursive: true });
// A closed environment: the temp HOME, the limited Docker config and the two keys. Nothing else of the caller's passes.
const env = {
  PATH: process.env.PATH ?? "",
  HOME: home,
  LC_ALL: "C",
  DOCKER_CONFIG: dockerConfigFor(join(scratch, "docker"), process.env.OMF_SOCKET ?? ""),
  ...Object.fromEntries(keyNames.map((name, index) => [name, keys[index]])),
};
const run = (command, args) => spawnSync(command, args, { cwd: repo, env, encoding: "utf8" });
const omf = (...args) => run(process.execPath, [join(root, "dist", "cli", "main.js"), ...args]);

const git = ["-c", "user.name=omf-smoke", "-c", "user.email=omf-smoke@example.invalid", "-c", "commit.gpgsign=false"];
run("git", ["init", "-q", "-b", "main"]);
run("git", [...git, "commit", "-q", "--allow-empty", "-m", "init"]);

const failures = [];
const outputs = [];
const check = (label, ok) => {
  console.log(`${ok ? "ok" : "FAIL"}: ${label}`);
  if (!ok) failures.push(label);
};

const init = omf("init");
outputs.push(init.stdout, init.stderr);
check("omf init exits 0", init.status === 0);

const ITEM = "w-000000000000";
for (const verb of ["seal", "run", "report"]) {
  const result = omf(verb, ITEM);
  outputs.push(result.stdout, result.stderr);
  check(`omf ${verb} refuses an unknown item (exit 2)`, result.status === 2);
  check(`omf ${verb} names the item`, `${result.stdout}${result.stderr}`.includes(ITEM));
}
const help = omf("--help");
outputs.push(help.stdout, help.stderr);
check("omf --help lists seal, run and report", ["seal", "run", "report"].every((verb) => new RegExp(`^\\s+${verb}\\b`, "m").test(help.stdout)));

check("no key value appears in any output", !keys.some((key) => outputs.some((text) => text.includes(key))));
check("the repository is untouched", run("git", ["status", "--porcelain"]).stdout === "");

if (failures.length > 0) process.exit(1);
console.log("smoke-w OK");
JS
