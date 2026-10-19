import { chmodSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../helpers/tmp.js";
import { ownedLeftovers } from "./lifecycle-support.js";

// Positive controls for the leftover scan the gated suites end on: it must list a labelled container, network, volume and image,
// exempt only the cached harness image, and refuse to pass when the daemon cannot be asked. Run offline against a `docker` stub.

const savedPath = process.env.PATH;
afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
});

function stubDocker(answers: Record<string, string[]>): void {
  const dir = makeTempDir("omf-leftover-docker-");
  const lines = Object.entries(answers).map(
    ([verb, out]) => `  ${verb}) printf '%s\\n' ${out.map((line) => `'${line}'`).join(" ")} ;;`,
  );
  writeFileSync(join(dir, "docker"), `#!/bin/sh\nshift 2\ncase "$1" in\n${lines.join("\n")}\n  *) exit 1 ;;\nesac\n`);
  chmodSync(join(dir, "docker"), 0o755);
  process.env.PATH = `${dir}${delimiter}${savedPath ?? ""}`;
}

const ctx = { context: "colima-omf-m3f", dockerConfig: "" };

describe("ownedLeftovers", () => {
  it("lists a labelled container, network, volume and image, and exempts only the cached harness image", () => {
    stubDocker({
      ps: ["container omf-implementer-r-1-1-1"],
      network: ["network omf-net-x"],
      volume: ["volume omf-vol-y"],
      images: [
        "image omf-harness:abc",
        "image omf-sut:run-1",
        "image omf-harness-evil:abc",
        "image omf-implementer:abc",
      ],
    });
    expect(ownedLeftovers(ctx)).toEqual([
      "container omf-implementer-r-1-1-1",
      "network omf-net-x",
      "volume omf-vol-y",
      "image omf-sut:run-1",
      "image omf-harness-evil:abc",
      "image omf-implementer:abc",
    ]);
  });

  it("is empty only when the daemon lists nothing, and throws when the daemon cannot be asked", () => {
    stubDocker({ ps: [], network: [], volume: [], images: ["image omf-harness:abc"] });
    expect(ownedLeftovers(ctx)).toEqual([]);
    stubDocker({ ps: [] });
    expect(() => ownedLeftovers(ctx)).toThrow();
  });
});
