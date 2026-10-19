import { describe, expect, it } from "vitest";
import { codexArgv, refuseInteractive } from "../../src/author/codex-argv.js";

// The author's argv is byte-pinned: only the model value may differ. Anything else is refused at run time, including
// flags that loosen the sandbox or the approval policy.
describe("refuseInteractive is an exact match with the pinned argv except the model value", () => {
  const base = codexArgv({ model: null });
  const withModel = codexArgv({ model: "gpt-5-codex" });

  it("accepts the pinned argv with and without a model", () => {
    expect(refuseInteractive(base)).toBeNull();
    expect(refuseInteractive(withModel)).toBeNull();
  });

  it.each([
    ["--full-auto", [...base.slice(0, -1), "--full-auto", "-"]],
    ["--sandbox workspace-write", [...base.slice(0, -1), "--sandbox", "workspace-write", "-"]],
    ["-s workspace-write added", [...base.slice(0, -1), "-s", "workspace-write", "-"]],
    ["the sandbox value changed", base.map((part) => (part === "read-only" ? "workspace-write" : part))],
    ["a -c sandbox_mode override", [...base.slice(0, -1), "-c", 'sandbox_mode="danger-full-access"', "-"]],
    ["a -c approval_policy override", [...base.slice(0, -1), "-c", 'approval_policy="never"', "-"]],
    ["an extra trailing argument", [...base, "extra"]],
    ["a missing stdin marker", base.slice(0, -1)],
    ["a second model flag", [...withModel.slice(0, -1), "-m", "other", "-"]],
    ["a model value that is not a model name", [...base.slice(0, -1), "-m", "--full-auto", "-"]],
    ["the output file changed", base.map((part) => (part === "/out/answer.json" ? "/tmp/x" : part))],
  ])("refuses %s", (_label, argv) => {
    expect(refuseInteractive(argv)).toBe("interactive");
  });
});
