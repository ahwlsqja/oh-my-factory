import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { Ledger } from "../core/ledger.js";
import { requireProject } from "../core/project.js";
import { EVIDENCE_MD, claimsMoreIsolation, readEvidence, renderEvidenceMd } from "../work/evidence.js";
import { EXIT, type ExitCode } from "./exit.js";
import { checkOrder, judgeLine } from "./w-assembly.js";

/**
 * `omf report <work_id>`. Read-only: the verified ledger vouches for the evidence (the report branch of `checkOrder`), and the text is
 * `renderEvidenceMd` of the validated evidence.json. The bytes of evidence.md are never printed; when they differ from that
 * rendering the file is untrusted and a note says so. Implementer text appears only in the rendering's fenced section.
 * The not-enforced line is part of the rendering whenever the run-level isolation is unmeasured, so it is not added again.
 */
export function reportVerb(workId: string, json: boolean): ExitCode {
  const location = requireProject(process.cwd());
  const order = checkOrder(location, workId, "report", new Date());
  if (!order.ok) {
    console.error(order.message);
    return order.exit;
  }
  const read = readEvidence(order.item.dir);
  if (!read.ok) {
    console.error(`no trusted evidence (S7 has not run): run omf run ${workId}`);
    return EXIT.cannotRun;
  }
  // The ledger vouches for the isolation level too: a file that claims more than the measurements support is untrusted.
  if (claimsMoreIsolation(read.doc, new Ledger(location.dir).readVerified())) {
    console.error(`no trusted evidence (the isolation level does not match the ledger): run omf run ${workId}`);
    return EXIT.cannotRun;
  }
  const rendered = renderEvidenceMd(read.doc);
  let copy: string | null = null;
  try {
    copy = readFileSync(join(order.item.dir, EVIDENCE_MD), "utf8");
  } catch {
    copy = null;
  }
  if (copy !== rendered) console.error("note: evidence.md differs from evidence.json and was not used");
  if (json) {
    console.log(JSON.stringify(read.doc, null, 2));
  } else {
    process.stdout.write(rendered);
    console.log(`\n${judgeLine(location)}`);
  }
  return EXIT.ok;
}

export function registerReportCommand(program: Command): void {
  program
    .command("report")
    .argument("<work_id>", "the work item whose last run to report")
    .option("--json", "print the validated evidence document as JSON")
    .description("print the evidence of the item's last run, re-rendered from evidence.json; writes nothing")
    .action((workId: string, options: { json?: boolean }) => {
      process.exitCode = reportVerb(workId, options.json === true);
    });
}
