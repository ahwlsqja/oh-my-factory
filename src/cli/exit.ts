/**
 * The process exit codes every `omf` command uses. The meaning is the documented one (README and `omf --help`):
 * 0 ok, 1 a problem was found, 2 the command could not run, 3 blocked on a person.
 */
export const EXIT = {
  ok: 0,
  problem: 1,
  cannotRun: 2,
  waiting: 3,
} as const;

export type ExitKind = keyof typeof EXIT;
export type ExitCode = (typeof EXIT)[ExitKind];

/** Exit code for a result kind: `problem` is for what the command found, `cannotRun` is for what stopped it. */
export function exitFor(kind: ExitKind): ExitCode {
  return EXIT[kind];
}
