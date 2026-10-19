import { join } from "node:path";
import type { Command } from "commander";
import { readConfig } from "../core/config.js";
import { requireProject } from "../core/project.js";
import { EVIDENCE_JSON, NOT_ENFORCED_LINE } from "../work/evidence.js";
import { handoffFile } from "../work/handoff.js";
import { type LineResult, runLine } from "../work/sequencer.js";
import { WError } from "../work/w-verbs.js";
import { EXIT, type ExitCode } from "./exit.js";
import { assembleLine, checkOrder, exitForLine, judgeLine, openRuntime, sweepItemBestEffort } from "./w-assembly.js";

/**
 * The lines `omf run` prints for a result. Ids, enum members, closed codes and paths of the host state only: nothing an
 * agent wrote reaches the terminal here, and the run-level isolation label is the one in the evidence, so a line whose
 * containers were not all measured never prints an L2 claim.
 */
export function describeLine(result: LineResult, itemDir: string): string[] {
  if (result.kind === "aborted") {
    const why = result.code ?? result.wcode;
    return [`run: ${result.run_id}`, `aborted at ${result.at}: ${result.reason}${why === null ? "" : ` (${why})`}`];
  }
  const { evidence } = result;
  const lines = [`run: ${result.run_id}`, `outcome: ${result.outcome}`, `recommendation: ${evidence.recommendation}`];
  if (result.reason_code !== null) lines.push(`reason: ${result.reason_code}`);
  lines.push(
    `reasons: ${evidence.recommendation_reasons.join(", ")}`,
    `isolation level: ${evidence.isolation_level}`,
    `evidence: ${join(itemDir, EVIDENCE_JSON)}`,
  );
  if (result.handoff !== null) {
    lines.push(`handoff: ${handoffFile(itemDir, result.run_id, "outcome")} (${result.handoff.decision_required.j})`);
  }
  if (evidence.isolation_level === "unmeasured") lines.push(NOT_ENFORCED_LINE);
  return lines;
}

function summaryOf(result: LineResult, itemDir: string, exit: ExitCode): Record<string, unknown> {
  if (result.kind === "aborted") {
    return {
      kind: "aborted",
      run_id: result.run_id,
      reason: result.reason,
      code: result.code ?? result.wcode,
      at: result.at,
      exit,
    };
  }
  return {
    kind: "finished",
    run_id: result.run_id,
    outcome: result.outcome,
    recommendation: result.evidence.recommendation,
    reason_code: result.reason_code,
    reasons: result.evidence.recommendation_reasons,
    isolation_level: result.evidence.isolation_level,
    evidence: join(itemDir, EVIDENCE_JSON),
    handoff: result.handoff === null ? null : handoffFile(itemDir, result.run_id, "outcome"),
    handoff_route: result.handoff?.decision_required.j ?? null,
    exit,
  };
}

/**
 * `omf run <work_id>`: the order check, then one `runLine` over `assembleLine`. Returns the exit code. The order check
 * and its warning come before the runtime is opened, so a refusal and a warning cost nothing; an item that already ran is
 * reported and left alone.
 */
export async function runVerb(workId: string, json: boolean): Promise<ExitCode> {
  const location = requireProject(process.cwd());
  const order = checkOrder(location, workId, "run", new Date());
  if (!order.ok) {
    // A refusal never reaches S1, so the sweep of the line's start would never run: an exited container of a killed run goes here.
    await sweepItemBestEffort(location, workId, process.env);
    // Exit 0 is the one refusal that is not a failure: the item already ran and awaits review.
    if (order.exit === 0) console.log(order.message);
    else console.error(order.message);
    return order.exit;
  }
  for (const warning of order.warnings) console.error(`warning: ${warning}`);
  const runtime = openRuntime(readConfig(location.dir), process.env);
  if (runtime === null) {
    console.error(
      "omf run needs judge.docker_context in config.toml: the line runs its containers in a local Docker context",
    );
    return EXIT.cannotRun;
  }
  const line = assembleLine({ location, runtime, env: process.env });
  let result: LineResult;
  try {
    result = await runLine({ location, workId, stations: line.stations, onLineEnd: line.onLineEnd });
  } catch (err) {
    // Whatever the line threw before a run existed (a refusal of beginRun, a guard refusal of assertLineSafe): no station ran,
    // so no station sweep did, and a container of a killed run is removed here, before the error reaches the person. The claim
    // is not held by this process any more; a live run elsewhere keeps its own containers (sweepItemOrphans).
    await sweepItemBestEffort(location, workId, process.env, runtime);
    // beginRun's refusals (claim_held, wrong_state, needs_human, governance, malformed) carry a code and a message built from ids.
    if (err instanceof WError) {
      console.error(`run refused: ${err.message}`);
      return err.code === "needs_human" ? EXIT.waiting : EXIT.cannotRun;
    }
    throw err;
  } finally {
    await line.onLineEnd();
  }
  // A line that ended aborted before S1 ran (the entry recheck, a lost claim) never reached a station's own sweep either.
  if (result.kind === "aborted" && result.at === "S1") await sweepItemBestEffort(location, workId, process.env, runtime);
  const code = exitForLine(result);
  if (json) {
    console.log(JSON.stringify(summaryOf(result, order.item.dir, code), null, 2));
  } else {
    for (const text of describeLine(result, order.item.dir)) console.log(text);
    console.log(judgeLine(location));
  }
  return code;
}

export function registerRunCommand(program: Command): void {
  program
    .command("run")
    .argument("<work_id>", "the work item to run the verification line on")
    .option("--json", "print the result as JSON")
    .description("run the verification line on one sealed work item and write its evidence (seal it first: omf seal)")
    .addHelpText(
      "after",
      "\nExit codes: 0 success, 1 flawed, 2 refused or could not run (no passing seal, the environment, an aborted line), 3 blocked on a person (open decisions, a handoff to read). An item that already ran prints 'already ran' and exits 0.",
    )
    .action(async (workId: string, options: { json?: boolean }) => {
      process.exitCode = await runVerb(workId, options.json === true);
    });
}
