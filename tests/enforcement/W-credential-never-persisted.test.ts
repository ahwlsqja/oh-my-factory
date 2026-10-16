import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeDocker } from "../helpers/fake-docker.js";
import { gitFixture } from "../helpers/git-fixture.js";
import {
  type Behavior,
  type ImplementerLineRun,
  SENTINEL_KEY,
  keyHits,
  omfRefs,
  runImplementerLine,
} from "../helpers/implementer-line.js";
import { eventsOfType } from "../helpers/line-m3f.js";
import { gitIn, makeTempDir } from "../helpers/tmp.js";

// M3-D3, M3g-D5: the key is exposed to candidate code by design, and OMF itself writes it nowhere. A sentinel key goes
// through the whole line on three paths; then every place OMF could have kept it is searched.
const stageDirOf = (run: ImplementerLineRun, runId: string): string =>
  join(run.jl.l.f.item.dir, "runs", runId, "implementer-stage", "round-1");

function sessionOf(run: ImplementerLineRun): { runId: string; payload: Record<string, unknown> } {
  const [event] = eventsOfType(run, "implementer.session_completed");
  if (event === undefined) throw new Error("the line recorded no implementer session");
  return { runId: String(event.payload.run_id), payload: event.payload };
}

describe("W-credential-never-persisted", () => {
  it("the sweep finds a key in a file, in a commit that a later commit removed, and in a docker call, and finds nothing in a clean setup", () => {
    const history = gitFixture({ "notes.txt": `${SENTINEL_KEY}\n` }, { "notes.txt": null, "ok.txt": "fine\n" });
    const stateDir = makeTempDir("omf-sweep-");
    const docker = new FakeDocker();
    const input = { key: SENTINEL_KEY, stateDir, userRepo: history.repo, docker };
    const onlyHistory = keyHits(input);
    expect(onlyHistory.length, "the removed commit is still an object of the repository").toBeGreaterThan(0);
    expect(onlyHistory.every((hit) => hit.startsWith("objects "))).toBe(true);
    expect(gitIn(history.repo, "ls-files"), "the head tree no longer holds it").not.toContain("notes.txt");
    writeFileSync(join(stateDir, "leak.txt"), SENTINEL_KEY);
    docker.state.calls.push({
      argv: ["exec", "--env", `ANTHROPIC_API_KEY=${SENTINEL_KEY}`],
      context: null,
      stdin_b64: null,
    });
    expect(keyHits(input)).toEqual(expect.arrayContaining(["file leak.txt", "docker argv"]));
    const clean = gitFixture({ "a.txt": "x\n" }, { "b.txt": "y\n" });
    expect(
      keyHits({
        key: SENTINEL_KEY,
        stateDir: makeTempDir("omf-sweep-"),
        userRepo: clean.repo,
        docker: new FakeDocker(),
      }),
    ).toEqual([]);
  });

  interface Case {
    behavior: Behavior;
    check(run: ImplementerLineRun): void;
  }
  const CASES: readonly Case[] = [
    {
      behavior: "good",
      check(run) {
        const { runId, payload } = sessionOf(run);
        expect(payload).toMatchObject({ outcome: "completed", injected_secret_names: ["ANTHROPIC_API_KEY"] });
        expect(
          Number(payload.log_credential_hits),
          "the raw log held the key once and was only redacted",
        ).toBeGreaterThan(0);
        // Positive controls: the container process saw the key, in exactly one exec, and the log shows it redacted.
        expect(run.secretExecs).toHaveLength(1);
        const log = readFileSync(
          join(run.jl.l.f.item.dir, "runs", runId, "implementer", "round-1", "implementer.log"),
          "utf8",
        );
        expect(log).toContain(`SAW_KEY_LENGTH=${run.key.length}`);
        expect(log).toContain("token=[redacted]");
        expect(omfRefs(run.userRepo)).toEqual([`refs/heads/omf/${run.workId}`]);
      },
    },
    {
      behavior: "leak_then_remove",
      check(run) {
        const { runId } = sessionOf(run);
        expect(run.secretExecs).toHaveLength(1);
        expect(eventsOfType(run, "implementer.candidate_checked").at(-1)?.payload).toMatchObject({
          scan: "credential",
          published: false,
        });
        expect(run.result.outcome).toBe("blocked");
        expect(run.result.reason_code).toBe("gate_blocked");
        expect(omfRefs(run.userRepo), "nothing was published").toEqual([]);
        expect(existsSync(stageDirOf(run, runId)), "the round's stage directory was deleted at once").toBe(false);
      },
    },
    {
      behavior: "fail_after_print",
      check(run) {
        expect(sessionOf(run).payload).toMatchObject({
          outcome: "nonzero_exit",
          injected_secret_names: ["ANTHROPIC_API_KEY"],
        });
        expect(run.secretExecs).toHaveLength(1);
        expect(run.result.outcome).toBe("blocked");
        expect(run.result.reason_code).toBe("infra_failure");
        expect(eventsOfType(run, "implementer.candidate_checked")).toEqual([]);
        expect(omfRefs(run.userRepo)).toEqual([]);
      },
    },
  ];

  it.each(CASES)(
    "$behavior: the key is in no file, object, ref, docker argv, evidence, handoff or result",
    async ({ behavior, check }) => {
      const run = await runImplementerLine({ behavior });
      check(run);
      const hits = keyHits({
        key: run.key,
        stateDir: run.jl.l.f.fx.location.dir,
        userRepo: run.userRepo,
        docker: run.jl.fake,
        texts: { result: JSON.stringify(run.result), events: JSON.stringify(run.events) },
      });
      expect(hits).toEqual([]);
    },
    60_000,
  );
});
