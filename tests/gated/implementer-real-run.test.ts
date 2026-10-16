import { readFileSync } from "node:fs";
import { it } from "vitest";
import { blobId } from "../../src/git/ops.js";
import { userRepoTarget } from "../../src/git/user-repo.js";
import { claudeSettings, createClaudeSession } from "../../src/implementer/claude-session.js";
import { containsCredential } from "../../src/implementer/credential.js";
import { scanCandidateHistory } from "../../src/implementer/history-scan.js";
import { buildImplementerPrompt } from "../../src/implementer/prompt.js";
import { realTempDir } from "../helpers/ops-fixture.js";
import { describeGatedModel, gatedCredential } from "./helpers.js";
import {
  NO_CANARIES,
  WORK_ID,
  assertFalse,
  assertTrue,
  importedOf,
  makeUserRepo,
  runImplementerRound,
  writeModelReport,
} from "./implementer-support.js";
import { ownedLeftovers } from "./lifecycle-support.js";

// G-implementer-real-run: Claude Code in the real container on examples/hello-goal. Needs the owner's key (OMF_GATED=docker+model)
// and spends a small amount against the provider-side limit. This file calls no `expect` and prints nothing: a failure message
// is a fixed string, so nothing key-bearing can reach the owner's terminal. Written, never run by an agent; not enforced until
// docs/evidence/gated-runs.json records it.

const SEARCH = readFileSync(new URL("../../examples/hello-goal/app/search.mjs", import.meta.url), "utf8");
const CONTEXT = {
  spec: "# Spec\n\nsearch(list, value) returns the index of value in the sorted list, or -1. Every answer stays the same.\n",
  intent:
    "# Intent\n\nMake search in app/search.mjs fast for large sorted lists: replace the linear scan with a binary search.\n",
};

describeGatedModel("G-implementer-real-run", (ctx) => {
  it(
    "follows the plan-first rule, publishes a candidate, reports its cost and leaves the key nowhere that is scanned",
    async () => {
      const credential = gatedCredential();
      const repo = makeUserRepo({ "app/search.mjs": SEARCH }, null);
      const round = await runImplementerRound({
        ctx,
        repo: repo.dir,
        dir: realTempDir("omf-gated-rr-"),
        files: CONTEXT,
        session: (runtime) => createClaudeSession({ runtime, credential, model: null }),
        request: {
          prompt: buildImplementerPrompt({ workId: WORK_ID, round: 1, feedback: [] }),
          settings: claudeSettings({ denyEditGlobs: [] }),
          timeoutMs: 20 * 60_000,
          maxOutputBytes: 64 * 1024 * 1024,
          model: null,
          maxBudgetUsd: 1,
        },
        credential,
        canaries: NO_CANARIES,
      });
      assertTrue(round.level === "L2", "the implementer container did not measure L2");
      assertTrue(round.outcome.ok, "the session did not complete");
      assertFalse(
        containsCredential(round.outcome.log, credential),
        "the credential appears in the redacted session log",
      );
      const imported = importedOf(round);
      assertTrue(round.plan?.status === "ok", "the first commit is not the plan alone");
      assertTrue(round.scan?.status === "clean", "the history scan was not clean");
      assertTrue(round.published, "no candidate branch was published");
      assertFalse(
        containsCredential(round.capture.bytes, credential),
        "the credential appears in the workspace capture",
      );

      const target = userRepoTarget(repo.dir);
      const published = await scanCandidateHistory({
        quarantine: target,
        head: imported.head,
        credential,
        canaries: NO_CANARIES,
        maxTotalBytes: 64 * 1024 * 1024,
      });
      assertTrue(published.status === "clean", "the published branch holds the credential or could not be scanned");
      const changed =
        (await blobId(target, imported.head, "app/search.mjs")) !==
        (await blobId(target, imported.context, "app/search.mjs"));
      assertTrue(changed, "the candidate did not change app/search.mjs");
      const cost = round.outcome.ok ? round.outcome.cost_micro_usd : null;
      assertTrue(cost !== null, "the session reported no cost");
      writeModelReport({ name: "default", spend_micro_usd: cost, log_bytes: Buffer.byteLength(round.outcome.log) });
      assertTrue(ownedLeftovers(ctx).length === 0, "an OMF container was left behind");
    },
    25 * 60_000,
  );
});
