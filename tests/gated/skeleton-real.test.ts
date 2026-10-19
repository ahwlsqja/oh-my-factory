import { it } from "vitest";
import { containsCredential } from "../../src/implementer/credential.js";
import { omf } from "../helpers/cli.js";
import { authorCredential, filesHoldingCredential } from "./author-support.js";
import { describeGatedModel, gatedCredential, gatedDockerConfig, gatedPath } from "./helpers.js";
import { assertFalse, assertTrue } from "./implementer-support.js";
import { ownedLeftovers } from "./lifecycle-support.js";
import { latestEvidence, setupSearchItem, writeSearchConfig } from "./skeleton-kit.js";

// covers: S5.0.skeleton-real-line
// G-skeleton-real. The whole line through the shipped CLI with the real Codex author, the real
// Claude implementer and the real judge, on a staged item (see skeleton-kit.ts): decide lint, omf seal, omf run, omf report,
// with one rework round. It asserts what the line may claim under owner decision O-1: outcome success, recommendation
// human_needed (never merge_recommended: the noise check is not evaluated), run isolation level L2 and noise_check_not_evaluated
// as the only unverified area. Decision signatures come from the fixture. Same fixed-message rule as the other model suites:
// no expect call, nothing printed. Written, never run by an agent; not enforced until docs/evidence/gated-runs.json records it.

const ONLY_NOISE = '["noise_check_not_evaluated"]';

describeGatedModel("G-skeleton-real", (ctx) => {
  it(
    "seals, runs and reports a staged item with a real author and implementer: one rework round, success, human_needed, L2",
    async () => {
      const author = authorCredential();
      const implementer = gatedCredential();
      const f = setupSearchItem();
      writeSearchConfig(f, ctx);
      const keys = {
        OMF_AUTHOR_API_KEY: process.env.OMF_AUTHOR_API_KEY ?? "",
        OMF_IMPLEMENTER_API_KEY: process.env.OMF_IMPLEMENTER_API_KEY ?? "",
      };
      const base = { PATH: gatedPath(), DOCKER_CONFIG: gatedDockerConfig() };
      const cli = (args: string[], env: Record<string, string>) => omf(args, f.fx.repo, f.fx.home, { ...base, ...env });
      const events = () => f.fx.ledger.readVerified();

      const lint = cli(["decide", "lint", f.workId], {});
      assertTrue(lint.code === 0, "GATE-1 does not pass for the staged item");

      const seal = cli(["seal", f.workId], { OMF_AUTHOR_API_KEY: keys.OMF_AUTHOR_API_KEY });
      assertTrue(seal.code === 0, "omf seal did not seal the item");
      const authorL2 = events().some(
        (event) =>
          event.type === "isolation.measured" && event.payload.stage === "author" && event.payload.level === "L2",
      );
      assertTrue(authorL2, "no author L2 measurement is in the ledger");

      const run = cli(["run", f.workId], keys);
      assertTrue(run.code === 0, "omf run did not finish with success");
      const submitted = events().filter((event) => event.type === "work.submitted");
      assertTrue(submitted.length === 1, "the item was not submitted exactly once");
      assertTrue(submitted[0]?.payload.outcome === "success", "the run outcome is not success");
      assertTrue(submitted[0]?.payload.recommendation === "human_needed", "the recommendation is not human_needed");

      const released = events().filter((event) => event.type === "feedback.released");
      const evidence = latestEvidence(f.item.dir);
      assertTrue(evidence !== null, "the run left no evidence.json");
      const rounds = evidence?.self_metrics.rounds ?? 0;
      assertTrue(released.length >= 1 && rounds >= 2, "the line finished without a rework round");
      assertTrue(evidence?.isolation_level === "L2", "the run isolation level is not L2");
      const unverified = JSON.stringify((evidence?.unverified_areas ?? []).map((area) => area.code));
      assertTrue(unverified === ONLY_NOISE, "the unverified areas are not only the noise check");

      const report = cli(["report", f.workId], {});
      assertTrue(report.code === 0, "omf report showed no trusted evidence");
      assertTrue(report.stdout.includes("isolation level: L2"), "the report does not state isolation level L2");
      assertFalse(report.stdout.includes("merge_recommended"), "the report names merge_recommended");

      const output = [seal, run, report].map((result) => result.stdout + result.stderr).join("\n");
      assertFalse(containsCredential(output, author), "a command printed the author key");
      assertFalse(containsCredential(output, implementer), "a command printed the implementer key");
      for (const credential of [author, implementer]) {
        assertTrue(filesHoldingCredential(f.fx.location.dir, credential).length === 0, "OMF state holds a key");
        assertTrue(filesHoldingCredential(f.fx.repo, credential).length === 0, "the repository holds a key");
      }
      assertTrue(ownedLeftovers(ctx).length === 0, "an OMF container was left behind");
    },
    90 * 60_000,
  );
});
