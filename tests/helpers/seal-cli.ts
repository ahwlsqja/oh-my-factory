import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContainerAuthorSession } from "../../src/author/codex-session.js";
import type { AuthorSessionFacts } from "../../src/author/events.js";
import { sealItem } from "../../src/author/station.js";
import { Ledger } from "../../src/core/ledger.js";
import { HARNESS_BASE, SUT_BASE } from "./container-fixture.js";
import { FakeDocker } from "./fake-docker.js";
import { fakeRuntime } from "./fake-runtime.js";
import { measurement } from "./gate3-parts.js";
import { type LineFixture, ROUND2, authoredYaml } from "./line-fixture.js";

/** A context name the fake daemon knows; the key is invented and never leaves the test process. */
export const CONTEXT = "colima-omf-m3f";
export const AUTHOR_KEY = "omf-test-author-key-0001";
export const AUTHOR_IMAGE = `example.test/omf/author@sha256:${"d".repeat(64)}`;

/**
 * Rewrites config.toml so `omf seal` can run: a `[judge]` table (with a Docker context unless `context` is false), an
 * `[author]` image, and the author vendor of `[roles]` (`claude` makes the pairing the same vendor as the implementer).
 */
export function configureSeal(
  l: LineFixture,
  options: { context?: boolean; authorVendor?: "claude" | "codex" } = {},
): void {
  const { context = true, authorVendor = "codex" } = options;
  const base = l.f.fx.baseConfig.replace('author = { vendor = "codex" }', `author = { vendor = "${authorVendor}" }`);
  const judge = `\n[judge]\nk = 3\nsut_base_image = "${SUT_BASE}"\nharness_base_image = "${HARNESS_BASE}"\n${
    context ? `docker_context = "${CONTEXT}"\n` : ""
  }`;
  writeFileSync(join(l.f.fx.location.dir, "config.toml"), `${base}${judge}\n[author]\nimage = "${AUTHOR_IMAGE}"\n`);
}

/** The ledger file as bytes: a refusal must leave it exactly as it was. */
export function ledgerBytes(l: LineFixture): string {
  return readFileSync(new Ledger(l.f.fx.location.dir).file, "utf8");
}

/** A container author that answers with the ROUND2 scenarios. `takeMeasurement` hands over an L2 author measurement once, or none. */
function scriptedAuthor(measured: boolean, passId: string): ContainerAuthorSession {
  let pending = measured ? measurement("author", "L2") : null;
  const facts: AuthorSessionFacts = {
    pass_id: passId,
    round: 1,
    vendor: "codex",
    model: "codex-default",
    outcome: "completed",
    duration_ms: 5,
    image_id: `sha256:${"d".repeat(64)}`,
    input_sha256: "e".repeat(64),
    violation_codes: [],
    answer_sha256: "f".repeat(64),
    answer_bytes: 100,
    credential_hits: 0,
    output_bytes: 0,
    limit_timeout_ms: 600_000,
    limit_output_bytes: 1_048_576,
    limit_calls: 10,
    calls_before: 0,
    injected_secret_names: ["CODEX_API_KEY"],
  };
  return {
    id: "author:codex:test",
    vendor: "codex",
    model: "codex-default",
    isolation: "container",
    run: async () => ({ ok: true, output: authoredYaml(ROUND2), durationMs: 5 }),
    takeMeasurement: () => {
      const taken = pending;
      pending = null;
      return taken;
    },
    takeFacts: () => facts,
  };
}

/**
 * Seals the item through `sealItem` with the scripted author and returns the seal id. `measured: true` leaves a standing
 * seal whose author stage is measured L2; `measured: false` leaves one whose author stage is unmeasured (status `stored`).
 * The item must be ready with GATE-1 passing and `configureSeal` already called.
 */
export async function plantStandingSeal(l: LineFixture, options: { measured: boolean }): Promise<string> {
  const result = await sealItem({
    location: l.f.fx.location,
    workId: l.f.workId,
    runtime: fakeRuntime(new FakeDocker(), CONTEXT),
    env: { ...l.f.fx.env, OMF_AUTHOR_API_KEY: AUTHOR_KEY },
    now: () => new Date(),
    session: (_credential, passId) => scriptedAuthor(options.measured, passId),
  });
  if (result.status !== "sealed" && result.status !== "stored") {
    throw new Error(`expected a planted seal, got ${result.status}`);
  }
  if ((result.status === "sealed") !== options.measured) {
    throw new Error(`asked for measured=${options.measured}, got ${result.status}`);
  }
  return result.seal_id;
}
