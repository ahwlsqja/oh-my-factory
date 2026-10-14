interface Entry {
  run: () => void;
}

const entries = new Set<Entry>();
let installed = false;

function onSigint(): void {
  onSignal("SIGINT");
}

function onSigterm(): void {
  onSignal("SIGTERM");
}

/**
 * Runs every registered callback synchronously (each in its own try/catch, so one failing callback cannot stop the others),
 * takes the handlers off so the signal has its default effect again, and re-raises it: the process still ends with the
 * signal status instead of exit 0. Entries stay registered; a process that survives (another handler caught the re-raise)
 * installs the handlers again on the next registration.
 */
function onSignal(signal: NodeJS.Signals): void {
  for (const entry of [...entries]) {
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
}

function removeHandlers(): void {
  installed = false;
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
}

/**
 * One process-wide SIGINT/SIGTERM handler pair, installed on the first registration and removed on the last unregister
 * (M3e-D25). `process-group.ts` (running commands), `proveTest` (tree copies) and M3f (judge containers) register here; none
 * installs its own handler. The callback must be synchronous and idempotent. Returns the unregister function.
 */
export function registerCleanup(fn: () => void): () => void {
  const entry: Entry = { run: fn };
  entries.add(entry);
  install();
  return () => {
    entries.delete(entry);
    if (entries.size === 0) removeHandlers();
  };
}
