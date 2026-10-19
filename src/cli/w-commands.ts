import type { Command } from "commander";
import { registerReportCommand } from "./report.js";
import { registerRunCommand } from "./run.js";
import { registerSealCommand } from "./seal.js";

/**
 * The W verbs behind one call, so `main.ts` changes by one import and one line and the parallel `omf ui` work does not
 * conflict with it. `omf seal`, `omf run` and `omf report` register here.
 */
export function registerWCommands(program: Command): void {
  registerSealCommand(program);
  registerRunCommand(program);
  registerReportCommand(program);
}
