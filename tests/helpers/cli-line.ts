import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTAINER_PROBE_ARGV } from "../../src/container/measure.js";
import { IMPLEMENTER_FIXED_ENV } from "../../src/container/spec.js";
import { declareBudget } from "../../src/core/budget.js";
import type { LedgerEvent } from "../../src/core/ledger.js";
import { WRITE_SETTINGS_ARGV } from "../../src/implementer/claude-session.js";
import { KILL_ALL_ARGV } from "../../src/implementer/workspace.js";
import { HARNESS_EXEC_ARGV } from "../../src/judge/harness-protocol.js";
import { runS2ThenGate2 } from "../../src/seal/station.js";
import { omf } from "./cli.js";
import { HARNESS_BASE, SUT_BASE } from "./container-fixture.js";
import { CONTRACT, HUMAN } from "./decision-fixture.js";
import { ledgerEvents } from "./enforcement-goal.js";
import { type FakeDockerBin, fakeDockerBin } from "./fake-docker.js";
import { addImage } from "./fake-docker-core.mjs";
import { TOOL_PATH } from "./implementer-container.js";
import { SENTINEL_KEY } from "./implementer-line.js";
import { type LineFixture, passDeps, ROUND2, setupLine, writeYaml } from "./line-fixture.js";
import { BUGGY } from "./prove-fixture.js";
import { commitAll, gitIn } from "./tmp.js";

const HOOKS = fileURLToPath(new URL("./cli-line-hooks.mjs", import.meta.url));
const KIT = new URL("../../examples/hello-goal/w-kit/", import.meta.url);
const CONTEXT = "colima-omf-m3f";
/** The mark of the fix in the work copy's tree: what `FIXED` in prove-fixture.ts holds and `BUGGY` does not. */
const FIX_MARK = "=> a + b";

export interface CliLineOptions {
  /** `good` fixes `add`; `null` commits a plan and changes no code. */
  implementer?: "good" | "null";
  /** Plant a stub-authored seal that passed GATE-2 (default). `false` leaves a ready item with no seal. */
  sealed?: boolean;
}
export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}
export interface CliLine {
  /** The decision, vault and ledger fixture the CLI works on, in this process. */
  l: LineFixture;
  bin: FakeDockerBin;
  workId: string;
  /** The user's repository: the project's own, holding the buggy `src/calc.mjs` the stub implementer fixes. */
  userRepo: string;
  mainBefore: string;
  /** The implementer key every `cli()` call carries as `OMF_IMPLEMENTER_API_KEY`. */
  key: string;
  /** `omf <args>` in the user's repository with the fake docker first on PATH; `env` adds variables (the author key). */
  cli(args: string[], env?: NodeJS.ProcessEnv): CliResult;
  /** Verified ledger events, read fresh (what a restarted process sees), optionally of one type. */
  events(type?: string): LedgerEvent[];
  /** The containers still in the fake daemon. */
  containers(): string[];
}

/**
 * A project whose item is ready (GATE-1 passes) and, by default, carries a seal planted in this process by a stub author
 * stamped `host_command` that passed GATE-2: no container measured the author stage. The shipped CLI then runs against a
 * `docker` program on PATH whose exec hooks emulate the implementer, SUT, harness and work-copy roles and leave the author
 * container unanswered (tests/helpers/cli-line-hooks.mjs). No switch in the product is involved.
 */
export async function setupCliLine(options: CliLineOptions = {}): Promise<CliLine> {
  const { implementer = "good", sealed = true } = options;
  const l = setupLine();
  const { fx, workId } = l.f;

  mkdirSync(join(fx.repo, "src"), { recursive: true });
  writeFileSync(join(fx.repo, "src", "calc.mjs"), BUGGY);
  commitAll(fx.repo, "add calc");
  const mainBefore = gitIn(fx.repo, "rev-parse", "refs/heads/main").trim();

  // The daemon already holds the two judge bases; it also gets the implementer's and the author's local images.
  const bin = fakeDockerBin({ hooks: HOOKS });
  let implementerImage = "";
  let authorImage = "";
  bin.update((state) => {
    const env = ["PATH=/usr/local/bin:/usr/bin"];
    implementerImage = addImage(state, "omf-test/implementer:fixture", { env });
    authorImage = addImage(state, "omf-test/author:fixture", { env });
  });
  appendFileSync(
    join(fx.location.dir, "config.toml"),
    [
      "",
      "[judge]",
      "k = 3",
      `sut_base_image = "${SUT_BASE}"`,
      `harness_base_image = "${HARNESS_BASE}"`,
      `docker_context = "${CONTEXT}"`,
      "",
      "[implementer]",
      `image = "${implementerImage}"`,
      "",
      "[author]",
      `image = "${authorImage}"`,
      "",
    ].join("\n"),
  );
  declareBudget(fx.ledger, fx.goalId, "disclosure", 5, HUMAN);

  const script = fileURLToPath(new URL(`implementer-${implementer}.sh`, KIT));
  writeFileSync(
    join(bin.dir, "cli-line-hooks.json"),
    JSON.stringify({
      probe_argv: CONTAINER_PROBE_ARGV,
      harness_argv: HARNESS_EXEC_ARGV,
      kill_all_argv: KILL_ALL_ARGV,
      write_settings_argv: WRITE_SETTINGS_ARGV,
      fixed_env: IMPLEMENTER_FIXED_ENV,
      tool_path: TOOL_PATH,
      contract_run: CONTRACT.run,
      fix_mark: FIX_MARK,
      sut_output: implementer === "good" ? "ok-distinct-output\n" : "",
      implementer_script: script,
    }),
  );

  if (sealed) {
    const pass = await runS2ThenGate2(passDeps(l, writeYaml(l, "round2.yaml", ROUND2)));
    if (pass.status !== "pass") throw new Error(`the fixture could not plant a passing seal: ${pass.status}`);
  }

  return {
    l,
    bin,
    workId,
    userRepo: fx.repo,
    mainBefore,
    key: SENTINEL_KEY,
    cli: (args, env = {}) =>
      omf(args, fx.repo, fx.home, { PATH: bin.path, OMF_IMPLEMENTER_API_KEY: SENTINEL_KEY, ...env }),
    events: (type) => ledgerEvents(fx, type),
    containers: () => Object.keys(bin.state().containers),
  };
}
