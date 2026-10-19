interface Entry {
  run: () => void;
  first: boolean;
}

const entries = new Set<Entry>();
let installed = false;

function onSigint(): void {
  onSignal("SIGINT");
}

function onSigterm(): void {
  onSignal("SIGTERM");
}

function onSighup(): void {
  onSignal("SIGHUP");
}

function onSigquit(): void {
  onSignal("SIGQUIT");
}

/**
 * Runs every registered callback synchronously, `first` ones before the rest and each group in registration order (each in its own try/catch, so one failing callback cannot stop the others),
 * takes the handlers off so the signal has its default effect again, and re-raises it: the process still ends with the
 * signal status instead of exit 0. Entries stay registered; a process that survives (another handler caught the re-raise)
 * installs the handlers again on the next registration.
 */
function onSignal(signal: NodeJS.Signals): void {
  const all = [...entries];
  for (const entry of [...all.filter((candidate) => candidate.first), ...all.filter((candidate) => !candidate.first)]) {
    try {
      entry.run();
    } catch {
      // best effort: a cleanup that throws has nothing left to report to
    }
  }
  removeHandlers();
  process.kill(process.pid, signal);
}

function install(): void {
  if (installed) return;
  installed = true;
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("SIGHUP", onSighup);
  process.on("SIGQUIT", onSigquit);
}

function removeHandlers(): void {
  installed = false;
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  process.off("SIGHUP", onSighup);
  process.off("SIGQUIT", onSigquit);
}

/**
 * One process-wide handler set for SIGINT, SIGTERM, SIGHUP (the terminal closed) and SIGQUIT, installed on the first registration and removed on the last unregister.
 * `process-group.ts` (running commands), `proveTest` (tree copies) and the judge containers register here; none
 * installs its own handler. The callback must be synchronous and idempotent. Returns the unregister function.
 * `first` callbacks run before every other one on a signal, whatever the registration order: a process-group killer
 * uses it so a command is dead before a directory it may still write into is deleted.
 */
export function registerCleanup(fn: () => void, options: { first?: boolean } = {}): () => void {
  const entry: Entry = { run: fn, first: options.first === true };
  entries.add(entry);
  install();
  return () => {
    entries.delete(entry);
    if (entries.size === 0) removeHandlers();
  };
}
