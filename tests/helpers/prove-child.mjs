// argv: <parent> <gitDir> <base> <head> <markerFile>
// Runs proveTest from dist/ with a test command that writes its pid to <markerFile> and then sleeps. It imports the built
// code, like every other child-process test. Copies are made under <parent> with the naming of tests/helpers/temp-work-copy.ts
// (a plain node child cannot import TypeScript helpers, so this is the same factory in JavaScript).
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const dist = (path) => import(new URL(`../../dist/${path}`, import.meta.url).href);
const { proveTest } = await dist("gate/prove-test.js");
const { runProcessGroup } = await dist("adapters/process-group.js");
const { createScratchGitDir } = await dist("git/hardened.js");
const { applyPatchToDir, exportTree, isDirClean } = await dist("git/ops.js");

const [parent, gitDir, base, head, marker] = process.argv.slice(2);

function makeCopy(quarantine, sha, root, holder, scratch) {
  const remove = () => {
    rmSync(root, { recursive: true, force: true });
    rmSync(holder, { recursive: true, force: true });
  };
  return {
    id: root,
    run: (argv, options) =>
      runProcessGroup(argv, { cwd: root, env: { PATH: process.env.PATH }, timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes }),
    isClean: () => isDirClean({ gitDir: quarantine.gitDir, indexFile: join(holder, "index") }, sha, root),
    applyPatch: (patch, options) => applyPatchToDir(scratch, root, patch, options),
    dispose: async () => remove(),
    abortSync: remove,
  };
}

const copies = {
  async create({ quarantine, sha }) {
    const id = `wc-${process.pid}-${randomBytes(4).toString("hex")}`;
    const root = join(parent, id);
    const holder = join(parent, `${id}-s`);
    mkdirSync(root, { mode: 0o700 });
    mkdirSync(holder, { mode: 0o700 });
    await exportTree(quarantine, sha, root);
    return makeCopy(quarantine, sha, root, holder, await createScratchGitDir(holder));
  },
};

const announce = 'require("node:fs").writeFileSync(process.argv[1], process.pid + "\\n"); setInterval(() => {}, 1000)';
const result = await proveTest({
  quarantine: { gitDir },
  base,
  head,
  testCommand: [process.execPath, "-e", announce, marker],
  explicitTestPaths: [],
  copies,
  timeoutMs: 120000,
});
console.log(JSON.stringify(result));
