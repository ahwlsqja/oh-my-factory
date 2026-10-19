import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMarkdownStore } from "../../src/adapters/state-markdown.js";
import { writePrivateFile } from "../../src/core/private-fs.js";
import type { InterfaceContract } from "../../src/decision/types.js";
import { fingerprintOf } from "../../src/work/fingerprint.js";
import { type DecisionFixture, closeInterface } from "../helpers/decision-fixture.js";
import { setupEnforcementGoal } from "../helpers/enforcement-goal.js";
import { listFiles, put } from "../helpers/ops-fixture.js";
import { commitAll } from "../helpers/tmp.js";
import { createRecorded, makeNewItem } from "../helpers/work.js";
import { type GatedContext, GatedRefusal } from "./helpers.js";

// The item of G-skeleton-real. It is staged on purpose: its constraints tell the implementer to leave the missing-value case
// for the feedback round, so the rework path (S6 release, round 2 at S3) is exercised without depending on a model error. The
// interface decision states the whole behaviour, so the author's scenarios cover the missing value too. Holds no key.
// The item has no quantitative decision and its constraints keep the implementer off test paths, so the only unverified
// area a successful run can carry is the noise check (a test file the implementer adds anyway is a high-risk path).

const SEARCH = readFileSync(new URL("../../examples/hello-goal/app/search.mjs", import.meta.url), "utf8");

export const SEARCH_CANDIDATE = {
  title: "Add a search command line program",
  problem: "Callers can look a value up in a sorted list only by importing app/search.mjs; there is no program to run.",
  proposed_outcome:
    "A program app/search-cli.mjs takes a value and a sorted list as arguments and prints where the value sits in the list.",
  affected_users_systems: "Scripts that look values up in sorted lists.",
  constraints:
    "Use the function in app/search.mjs and change only app/search-cli.mjs; add or edit no test file. Deliver in two steps: in the first attempt handle only a value that is in the list, and add the case of a missing value only after you receive feedback.",
  open_questions: [] as string[],
  rationale: "A program is the interface other tools of the callers already offer.",
  affected_paths: ["app"],
};

export const SEARCH_CONTRACT: InterfaceContract = {
  kind: "cli",
  build: ["node", "--version"],
  run: ["node", "app/search-cli.mjs"],
  io_contract:
    "Arguments: a value, then the sorted list as one comma separated argument. Prints the zero-based index of the value, or -1 when the value is not in the list, then a newline.",
  gates: { fast: ["node", "--check", "app/search-cli.mjs"], full: null, deep: null, required: ["fast"] },
  test_command: ["node", "--check", "app/search-cli.mjs"],
};

/**
 * A ready item with a passing GATE-1 (the interface decision closed by a fixture signature, the way the decision tests do),
 * a disclosure budget for the feedback round, and a repository that holds the search function. Nothing here calls a model.
 */
export function setupSearchItem(): DecisionFixture {
  const fx = setupEnforcementGoal({ disclosure: 20 });
  put(fx.repo, "app/search.mjs", SEARCH);
  commitAll(fx.repo, "add the search function");
  const base = makeNewItem({ goalId: fx.goalId, paths: ["app"] });
  const candidate = { ...base.candidate, ...SEARCH_CANDIDATE };
  const input = { ...base, candidate, fingerprint: fingerprintOf(fx.goalId, candidate) };
  const item = createRecorded(fx.ledger, createMarkdownStore(fx.location.dir), input);
  const f: DecisionFixture = {
    fx,
    item,
    workId: item.front.work_id,
    scope: { goal_id: fx.goalId, work_id: item.front.work_id },
  };
  closeInterface(f, SEARCH_CONTRACT);
  return f;
}

function imageFromEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new GatedRefusal(`${name} must be set for G-skeleton-real`);
  return value;
}

/**
 * The project's config.toml for the real run: the gated context, the judge's SUT and harness bases (the harness image ships
 * Node, which the SUT also needs to run `node app/search-cli.mjs`), the implementer image and the author image.
 */
export function writeSearchConfig(f: DecisionFixture, ctx: GatedContext): void {
  const harness = imageFromEnv("OMF_GATED_HARNESS_IMAGE");
  const text = [
    f.fx.baseConfig,
    "",
    "[judge]",
    `docker_context = "${ctx.context}"`,
    `sut_base_image = "${harness}"`,
    `harness_base_image = "${harness}"`,
    "",
    "[implementer]",
    `image = "${imageFromEnv("OMF_GATED_IMPLEMENTER_IMAGE")}"`,
    "",
    "[author]",
    `image = "${imageFromEnv("OMF_GATED_AUTHOR_IMAGE")}"`,
    "",
  ].join("\n");
  writePrivateFile(join(f.fx.location.dir, "config.toml"), text);
}

export interface EvidenceView {
  outcome: string;
  recommendation: string;
  isolation_level: string;
  unverified_areas: { code: string }[];
  self_metrics: { rounds: number };
}

/** The newest evidence.json under the item (a run's directory sorts by its time), or null. */
export function latestEvidence(itemDir: string): EvidenceView | null {
  const last = listFiles(itemDir)
    .filter((path) => path.endsWith("evidence.json"))
    .at(-1);
  return last === undefined ? null : (JSON.parse(readFileSync(join(itemDir, last), "utf8")) as EvidenceView);
}
