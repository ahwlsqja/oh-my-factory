import type { Command } from "commander";
import { registerSealCommand } from "./seal.js";

/**
 * The W verbs behind one call, so `main.ts` changes by one import and one line and the parallel `omf ui` work does not
 * conflict with it (M3h-D18). `omf run` and `omf report` register here when they exist.
 */
export function registerWCommands(program: Command): void {
  registerSealCommand(program);
}
