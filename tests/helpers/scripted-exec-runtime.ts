import type { ProcessResult } from "../../src/adapters/process-group.js";
import type { ContainerHandle, ContainerRuntime, ExecSpec } from "../../src/container/runtime.js";

export const HANDLE: ContainerHandle = { name: "omf-implementer-test", id: "0".repeat(64), role: "implementer" };

export const exited = (status: number | null, stdout = "", stderr = ""): ProcessResult => ({
  kind: "exited",
  status,
  signal: null,
  stdout,
  stderr,
});

export interface ScriptedExec {
  runtime: ContainerRuntime;
  /** Every `exec` spec the code under test passed, in order. */
  calls: ExecSpec[];
}

/**
 * A runtime with `exec` only. Each call takes the next answer (an Error is thrown instead of returned); any other port
 * call throws, so a session that reached past `exec` would fail loudly instead of passing by accident.
 */
export function scriptedExec(answers: ReadonlyArray<ProcessResult | Error>): ScriptedExec {
  const calls: ExecSpec[] = [];
  const queue = [...answers];
  const exec = async (_handle: ContainerHandle, spec: ExecSpec): Promise<ProcessResult> => {
    calls.push(spec);
    const next = queue.shift();
    if (next === undefined) throw new Error("scriptedExec: no answer left");
    if (next instanceof Error) throw next;
    return next;
  };
  const runtime = new Proxy(
    { exec },
    {
      get(target, prop) {
        if (prop === "exec") return target.exec;
        throw new Error(`scriptedExec: runtime.${String(prop)} is not scripted`);
      },
    },
  );
  return { runtime: runtime as unknown as ContainerRuntime, calls };
}
