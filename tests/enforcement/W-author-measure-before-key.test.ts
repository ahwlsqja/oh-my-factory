import { describe, expect, it } from "vitest";
import { createContainerAuthor } from "../../src/author/codex-session.js";
import { AUTHOR_KEY, type AuthorScript, authorDeps, authorDouble, authorRequest } from "../helpers/author-container.js";

// covers: S5.3.author-measured-before-key
// W-author-measure-before-key: the author's key is handed to a container only after that container measured golden. In
// every refusal below no call at all carried the key, and the container is gone.
interface Refusal {
  label: string;
  script: AuthorScript;
  code: "not_golden" | "container_failed";
  violation: string | null;
}
const REFUSALS: Refusal[] = [
  {
    label: "an image that bakes in the key name",
    script: { imageEnv: ["PATH=/usr/bin", "CODEX_API_KEY=not-a-real-value"] },
    code: "not_golden",
    violation: "unexpected_env_name",
  },
  {
    label: "a tampered inspect (privileged)",
    script: {
      tamper: (doc) => {
        (doc.HostConfig as Record<string, unknown>).Privileged = true;
      },
    },
    code: "not_golden",
    violation: "privileged",
  },
  {
    label: "a vendor binary the probe finds",
    script: { probe: "vendor:claude\nsocket:0\nend\n" },
    code: "not_golden",
    violation: null,
  },
  { label: "a probe that cannot be read", script: { probe: "socket:0\n" }, code: "container_failed", violation: null },
];

describe("W-author-measure-before-key", () => {
  it.each(REFUSALS)("$label: the run is refused and no call carried the key", async ({ script, code, violation }) => {
    const double = authorDouble(script);
    const session = createContainerAuthor(authorDeps(double));
    expect(await session.run(authorRequest())).toMatchObject({ ok: false, code });
    expect(double.execs.every((call) => !("CODEX_API_KEY" in call.env))).toBe(true);
    // At most the probe ran (argv[0] is "sh"): no tar, no codex, no cat.
    expect(double.execs.map((call) => call.argv[0]).filter((command) => command !== "sh")).toEqual([]);
    expect(JSON.stringify(double.fake.state.calls)).not.toContain(AUTHOR_KEY);
    expect(Object.keys(double.fake.state.containers)).toEqual([]);
    expect(session.takeMeasurement()).toBeNull();
    const facts = session.takeFacts();
    expect(facts?.outcome).toBe(code);
    if (code === "not_golden") expect(facts?.violation_codes.length).toBeGreaterThan(0);
    if (violation !== null) expect(facts?.violation_codes).toContain(violation);
  });

  it("a golden container is probed first; then exactly one exec carries the name, the value only in the client's environment", async () => {
    const double = authorDouble();
    await createContainerAuthor(authorDeps(double)).run(authorRequest());
    expect(double.execs.map((call) => call.argv[0])).toEqual(["sh", "tar", "tar", "codex", "cat"]);
    const named = double.fake.calls("exec").filter((call) => call.argv.includes("CODEX_API_KEY"));
    expect(named).toHaveLength(1);
    expect(named[0]?.argv).toContain("codex");
    expect(double.execs.filter((call) => call.env.CODEX_API_KEY === AUTHOR_KEY)).toHaveLength(1);
    expect(JSON.stringify(double.fake.state.calls)).not.toContain(AUTHOR_KEY);
  });
});
