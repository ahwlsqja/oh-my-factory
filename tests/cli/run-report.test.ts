import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { declareBudget } from "../../src/core/budget.js";
import { runS2ThenGate2 } from "../../src/seal/station.js";
import { NOT_ENFORCED_LINE } from "../../src/work/evidence.js";
import { omf } from "../helpers/cli.js";
import { HARNESS_BASE, SUT_BASE } from "../helpers/container-fixture.js";
import { HUMAN } from "../helpers/decision-fixture.js";
import { passDeps, ROUND2, setupLine, writeYaml } from "../helpers/line-fixture.js";

// `omf run` end to end through the built CLI, up to the point where the container layer would start. The project has a Docker
// context, the judge images and a disclosure budget, a standing seal from the stub author (so the author stage is unmeasured),
// and no [implementer] image: the real S3 stops the line with infra_failure before it touches the daemon or a key.
async function armed() {
  const l = setupLine();
  const { fx, scope } = l.f;
  writeFileSync(
    join(fx.location.dir, "config.toml"),
    `${fx.baseConfig}\n[judge]\nk = 3\nsut_base_image = "${SUT_BASE}"\nharness_base_image = "${HARNESS_BASE}"\ndocker_context = "colima-omf-m3f"\n`,
  );
  declareBudget(fx.ledger, scope.goal_id, "disclosure", 5, HUMAN);
  const sealed = await runS2ThenGate2(passDeps(l, writeYaml(l, "round2.yaml", ROUND2)));
  expect(sealed.status).toBe("pass");
  return l;
}

describe("omf run and omf report through the built CLI", () => {
  it("warns about the unmeasured author, stops at the implementer with exit 3 and a J6 handoff, and claims no run-level L2", async () => {
    const l = await armed();
    const { workId } = l.f;
    const { repo, home } = l.f.fx;
    const run = omf(["run", workId], repo, home);
    expect(run.code, run.stderr).toBe(3);
    expect(run.stderr).toContain("warning: the author stage is unmeasured");
    expect(run.stdout).toContain("outcome: blocked");
    expect(run.stdout).toContain("reason: infra_failure");
    expect(run.stdout).toMatch(/handoff: .+ \(J6\)/);
    expect(run.stdout).toContain("isolation level: unmeasured");
    expect(run.stdout).not.toMatch(/isolation level: L[123]/);
    expect(run.stdout).toContain(NOT_ENFORCED_LINE);
    expect(run.stdout).toContain("judge: deterministic checks only (model judge not available)");

    // The run left trusted evidence of a parked item, and the report shows it with the label stated once.
    const report = omf(["report", workId], repo, home);
    expect(report.code, report.stderr).toBe(0);
    expect(report.stdout).toContain("- isolation level: unmeasured");
    expect(report.stdout.split(NOT_ENFORCED_LINE)).toHaveLength(2);
  });

  it("--json prints one closed object with the exit code", async () => {
    const l = await armed();
    const run = omf(["run", l.f.workId, "--json"], l.f.fx.repo, l.f.fx.home);
    expect(run.code, run.stderr).toBe(3);
    const summary = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(summary).toMatchObject({
      kind: "finished",
      outcome: "blocked",
      reason_code: "infra_failure",
      isolation_level: "unmeasured",
      handoff_route: "J6",
      exit: 3,
    });
  });
});
