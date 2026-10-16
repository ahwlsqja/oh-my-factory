import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildImplementerPrompt } from "../../src/implementer/prompt.js";
import { assertLineSafe } from "../../src/vault/line-guard.js";
import { CANARY, canaryHits } from "../helpers/canary.js";
import { FakeDocker } from "../helpers/fake-docker.js";
import {
  RUN_ID,
  contextHandedOver,
  found,
  handedOver,
  lineStarter,
  startedContainers,
} from "../helpers/implementer-e2.js";
import { commitAll, gitIn } from "../helpers/tmp.js";
import { joinTree, readTree } from "../helpers/tree.js";

// Spec §4.6 (F6), E2 on the W side, the implementer's workspace and prompts. What OMF hands to the container, to
// the session and to its own staging directory carries none of the sealed set. The model is a stub, so this proves
// what OMF gives the implementer and records, not what a real model does with it (that is the gated red-team run).

const start = lineStarter();
const RELEASED = "- interface: 33% of 6 scenarios";

describe("E2-W-c canary-no-leak, workspace and prompts", () => {
  it("hands over the tracked files, the rendered context and a fixed prompt, and nothing the sealed set holds", async () => {
    const line = await start();
    // Positive control: the sealed set on the host holds every needle, so a clean search below means something.
    expect(found(line.vaultText, line.scenarioStrings)).toHaveLength(line.scenarioStrings.length);

    expect(await line.stations.S3.run(line.ctx(1))).toMatchObject({ kind: "ok" });
    line.released.push(RELEASED);
    expect(await line.stations.S3.run(line.ctx(2))).toMatchObject({ kind: "ok" });

    // Every docker argv and stdin the daemon was sent: the base tarball, the context tarball, the container creation.
    const handed = handedOver(line.fake);
    expect(handed, "positive control: the base tarball was sent").toContain("# fixture");
    expect(handed, "positive control: the context tarball was sent").toContain(`.omf/${line.workId}/spec.md`);
    expect(handed, "positive control: the spec projection was sent").toContain("### d-latency");
    expect(found(handed, line.scenarioStrings)).toEqual([]);
    // The user's own tracked files may hold the goal's readings; the files OMF renders must not.
    expect(canaryHits(contextHandedOver(line.fake, line.workId))).toEqual([]);

    // What the session was given, as the real adapter would receive it.
    expect(line.requests).toHaveLength(2);
    for (const request of line.requests) {
      expect(JSON.parse(request.settings), "positive control: the settings were generated").toHaveProperty(
        "permissions",
      );
      for (const text of [request.prompt, request.settings]) {
        expect(found(text, line.scenarioStrings)).toEqual([]);
        expect(canaryHits(text)).toEqual([]);
      }
    }
    const prompts = line.requests.map((request) => request.prompt);
    expect(prompts).toEqual([
      buildImplementerPrompt({ workId: line.workId, round: 1, feedback: [] }),
      buildImplementerPrompt({ workId: line.workId, round: 2, feedback: [RELEASED] }),
    ]);
    expect(prompts[0]).not.toContain(RELEASED);
    expect(prompts[1]).toContain(RELEASED);

    // What OMF staged on the host for the two rounds.
    const staged = readTree(join(line.item.dir, "runs", RUN_ID));
    const promptFiles = [...staged.keys()].filter((path) => path.endsWith("prompt.txt"));
    expect(promptFiles, "positive control: both rounds left their prompt file").toHaveLength(2);
    expect(found(joinTree(staged), line.scenarioStrings)).toEqual([]);
  });

  it("finds a needle anywhere in the recording: in an argv, in a stdin, and only in the context tarball", () => {
    const fake = new FakeDocker();
    const inArgv = "needle-in-argv-0123456789";
    const inStdin = "needle-in-stdin-0123456789";
    const inContext = "needle-in-context-0123456789";
    fake.state.calls.push({ argv: ["exec", "x", `echo ${inArgv}`], context: null, stdin_b64: null });
    fake.state.calls.push({ argv: ["exec", "y"], context: null, stdin_b64: Buffer.from(inStdin).toString("base64") });
    fake.state.calls.push({
      argv: ["exec", "z"],
      context: null,
      stdin_b64: Buffer.from(`.omf/w-0123456789ab/spec.md ${inContext}`).toString("base64"),
    });
    expect(found(handedOver(fake), [inArgv, inStdin, inContext])).toHaveLength(3);
    expect(contextHandedOver(fake, "w-0123456789ab")).toContain(inContext);
    expect(contextHandedOver(fake, "w-0123456789ab")).not.toContain(inStdin);
  });

  it("stops an intent that names the locked target before any container exists", async () => {
    const line = await start();
    const candidate = { ...line.item.intent.candidate, problem: `Lookups must stay under ${CANARY.target} ms.` };
    const item = { ...line.item, intent: { ...line.item.intent, candidate } };

    const out = await line.stations.S3.run(line.ctx(1, item));

    expect(out).toEqual({ kind: "blocked", reason_code: "gate_blocked" });
    expect(startedContainers(line.fake)).toEqual([]);
    expect(handedOver(line.fake)).not.toContain(CANARY.target);
    expect(line.requests).toHaveLength(0);
  });

  it("stops a canary that the base commit tracks at the pre-exec scan, before the first container exists", async () => {
    const line = await start();
    writeFileSync(join(line.repo, "notes.txt"), `${line.entry.canary}\n`);
    commitAll(line.repo, "add notes");
    rmSync(join(line.repo, "notes.txt"));
    // Positive controls: HEAD tracks the file, and the line-entry guard (a working-tree walk) no longer sees it,
    // so the stop below can only come from the scan of the exported base.
    expect(gitIn(line.repo, "ls-tree", "-r", "--name-only", "HEAD")).toContain("notes.txt");
    expect(() => assertLineSafe(line.l.f.fx.location)).not.toThrow();

    const out = await line.stations.S3.run(line.ctx(1));

    expect(out).toEqual({ kind: "blocked", reason_code: "gate_blocked" });
    expect(startedContainers(line.fake)).toEqual([]);
    expect(found(handedOver(line.fake), [line.entry.canary])).toEqual([]);
    expect(line.requests).toHaveLength(0);
  });
});
