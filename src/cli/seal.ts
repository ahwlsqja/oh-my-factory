import type { Command } from "commander";
import type { AuthorRefusalCode, SealPassResult } from "../author/station.js";
import { sealItem } from "../author/station.js";
import { createDockerRuntime } from "../container/docker-cli.js";
import { readConfig } from "../core/config.js";
import type { ProjectLocation } from "../core/paths.js";
import { requireProject } from "../core/project.js";
import type { ExitCode } from "./exit.js";
import { type Order, checkOrder, openRuntime, sweepItemBestEffort } from "./w-assembly.js";

const CLOSED_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** Everything `omf seal` prints from a code passes through here: a value that is not a short snake_case word prints as `unspecified`. */
export function closedCode(code: string): string {
  return CLOSED_CODE.test(code) ? code : "unspecified";
}

const REFUSAL_FIX: Readonly<Record<AuthorRefusalCode, string>> = {
  docker_context_unset: "set docker_context in the [judge] table of config.toml",
  author_image_unset: "set image in the [author] table of config.toml, pinned by digest",
  author_key_missing: "pass OMF_AUTHOR_API_KEY in the environment of this one command",
  same_vendor: "the author and the implementer cannot be the same vendor",
  author_vendor_unsupported: "the author must be codex in this version",
  docker_unreachable: "start Docker and check the context named in [judge]",
  endpoint_not_local: "the Docker context must point at this machine",
  author_call_cap:
    "this item used its author calls; raise max_calls in the [author] table of config.toml to allow more",
};

export interface SealReport {
  exit: ExitCode;
  stream: "out" | "err";
  text: string;
  json: Record<string, unknown>;
}

/** Said wherever the author container ran: its network is Docker's default bridge, with no egress allowlist. */
const EGRESS_LINE = "author network egress is not restricted; see docs/author.md";

/**
 * The exit code, text and JSON of one seal pass: 0 sealed or already sealed, 1 a problem in the result (the
 * author failed, GATE-2 sent the item back, or the author stage is unmeasured), 3 a person must act, 2 the command
 * could not run. Only ids, statuses and closed codes appear; the author's text never reaches this function.
 */
export function reportSeal(workId: string, result: SealPassResult): SealReport {
  const make = (exit: ExitCode, stream: "out" | "err", text: string, json: Record<string, unknown>): SealReport => ({
    exit,
    stream,
    text,
    json: { status: result.status, work_id: workId, ...json, exit },
  });
  switch (result.status) {
    case "already_sealed":
      return make(0, "out", `already sealed ${result.seal_id}; its author stage is measured, nothing was run`, {
        seal_id: result.seal_id,
        author_measured: true,
      });
    case "sealed":
      return make(
        0,
        "out",
        `sealed ${result.seal_id} (round ${result.round}); the author ran in a measured container and GATE-2 passed\n${EGRESS_LINE}`,
        {
          seal_id: result.seal_id,
          round: result.round,
          author_measured: true,
        },
      );
    case "stored":
      return make(
        1,
        "err",
        `stored ${result.seal_id} (round ${result.round}); GATE-2 passed but the author stage is unmeasured, so omf run will stop at GATE-3; run omf seal ${workId} again\n${EGRESS_LINE}`,
        { seal_id: result.seal_id, round: result.round, author_measured: false },
      );
    case "retry": {
      const code = closedCode(result.code);
      return make(1, "err", `seal failed: ${code}; run omf seal ${workId} again`, { code });
    }
    case "blocked": {
      const code = closedCode(result.code);
      const text =
        result.route === "J2"
          ? `blocked on a person (J2): ${code}; run omf decide lint ${workId}`
          : result.route === "J3"
            ? `blocked on a person (J3): ${code}`
            : `stopped by the environment (J7): ${code}`;
      return make(result.route === "J7" ? 2 : 3, "err", text, { route: result.route, code });
    }
    case "refused":
      return make(2, "err", `refused: ${result.code}: ${REFUSAL_FIX[result.code]}`, { code: result.code });
  }
}

export interface RunSealInput {
  location: ProjectLocation;
  workId: string;
  json: boolean;
  env: NodeJS.ProcessEnv;
  now?: () => Date;
}

function printRefusal(workId: string, order: Extract<Order, { ok: false }>, json: boolean): ExitCode {
  if (json) {
    console.log(
      JSON.stringify({ status: "refused", work_id: workId, missing: order.missing, exit: order.exit }, null, 2),
    );
  } else {
    console.error(order.message);
  }
  return order.exit;
}

/**
 * `omf seal`: the order check, then `sealItem`, then a closed report. Nothing here decides anything the station owns;
 * a ConfigError or a corrupt ledger throws and main.ts exits 2 with its hint.
 */
export async function runSeal(input: RunSealInput): Promise<ExitCode> {
  const { location, workId, json, env } = input;
  const now = input.now ?? ((): Date => new Date());
  const order = checkOrder(location, workId, "seal", now());
  if (!order.ok) {
    // A refusal here never reaches `sealItem`, but it must not leave an earlier pass's container running either.
    await sweepItemBestEffort(location, workId, env);
    return printRefusal(workId, order, json);
  }
  const config = readConfig(location.dir);
  // A runtime with no context refuses every call, so sealItem reports docker_context_unset in its own refusal order.
  const runtime = openRuntime(config, env) ?? createDockerRuntime({ context: null, env });
  const result = await sealItem({ location, workId, runtime, env, now });
  const report = reportSeal(workId, result);
  if (json) console.log(JSON.stringify(report.json, null, 2));
  else (report.stream === "out" ? console.log : console.error)(report.text);
  return report.exit;
}

export function registerSealCommand(program: Command): void {
  program
    .command("seal")
    .argument("<work_id>")
    .option("--json", "print the result as JSON (closed codes only)")
    .description(
      "run the sealing author in a measured container and check GATE-2; exit 0 sealed, 1 author failure or unmeasured, 2 refused, 3 blocked on a person",
    )
    .action(async (workId: string, options: { json?: boolean }) => {
      const location = requireProject(process.cwd());
      process.exitCode = await runSeal({ location, workId, json: options.json === true, env: process.env });
    });
}
