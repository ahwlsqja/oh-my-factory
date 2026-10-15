import { describe, expect, it } from "vitest";
import { goldenFor } from "../../src/container/golden.js";
import { createMeasured } from "../../src/container/measure.js";
import type { ImageInfo } from "../../src/container/runtime.js";
import {
  CREDENTIAL_SHAPED_ENV_NAMES,
  IMPLEMENTER_ENV_NAMES,
  type ImageId,
  SECRET_ENV_NAMES,
} from "../../src/container/spec.js";
import { measureFixture } from "../helpers/measure-fixture.js";

// W-implementer-env-allowlist: the environment names a container may hold are an exact table. The secret and every
// credential-shaped name are never in it, whoever adds them (the image or the create call), so a baked-in key is an L1 stage.
const CREDENTIAL_NAMES = [...new Set([...SECRET_ENV_NAMES, ...CREDENTIAL_SHAPED_ENV_NAMES])];
const IMAGE: ImageInfo = {
  id: `sha256:${"b".repeat(64)}` as ImageId,
  env_names: ["PATH", "NODE_VERSION", ...CREDENTIAL_NAMES],
  user: "",
  volumes: [],
};
const VALUE = "not-a-real-value";

describe("the implementer golden's env allowlist", () => {
  it("is exactly the image's names without any credential name, plus the daemon's, plus the fixed implementer names", () => {
    const golden = goldenFor({ role: "implementer", image: IMAGE, forbidden: [] });
    const expected = ["PATH", "NODE_VERSION", "HOSTNAME", "HOME", "LC_ALL", ...IMPLEMENTER_ENV_NAMES];
    expect(golden.allowed_env_names).toEqual([...new Set(expected)].sort());
    for (const name of CREDENTIAL_NAMES) expect(golden.allowed_env_names).not.toContain(name);
  });

  it("leaves the judge roles' trust in their base image unchanged", () => {
    expect(goldenFor({ role: "sut", image: IMAGE, forbidden: [] }).allowed_env_names).toContain("GITHUB_TOKEN");
  });

  it("measures a clean implementer container L2 with exactly the expected names", async () => {
    const f = await measureFixture();
    const { measurement } = await createMeasured(f.deps, f.spec("implementer"), f.golden("implementer"));
    expect(measurement).toMatchObject({ stage: "implementer", level: "L2", violations: [] });
    expect(measurement.facts?.env_names).toEqual(["LC_ALL", "PATH", ...IMPLEMENTER_ENV_NAMES].sort());
  });

  it("does not recognise a credential under a name outside the closed set (an owner-built image is trusted)", async () => {
    const f = await measureFixture({}, { imageEnv: ["PATH=/usr/bin", "MY_CUSTOM_SETTING=1"] });
    const { measurement } = await createMeasured(f.deps, f.spec("implementer"), f.golden("implementer"));
    expect(measurement.level).toBe("L2");
  });

  it.each(CREDENTIAL_NAMES)(
    "an image that declares %s is unexpected_env_name and L1 before the container starts",
    async (name) => {
      const f = await measureFixture({}, { imageEnv: ["PATH=/usr/bin", `${name}=${VALUE}`] });
      await expect(createMeasured(f.deps, f.spec("implementer"), f.golden("implementer"))).rejects.toMatchObject({
        violations: ["unexpected_env_name"],
      });
      expect(f.lifecycle()).toEqual(["create", "inspect", "rm"]);
      expect(f.run().stages.implementer).toMatchObject({ level: "L1", violations: ["unexpected_env_name"] });
    },
  );

  it.each(CREDENTIAL_NAMES)("%s added at create time is unexpected_env_name and L1", async (name) => {
    const f = await measureFixture({
      inspect: (doc) => void (doc.Config.Env = [...(doc.Config.Env ?? []), `${name}=${VALUE}`]),
    });
    await expect(createMeasured(f.deps, f.spec("implementer"), f.golden("implementer"))).rejects.toMatchObject({
      violations: ["unexpected_env_name"],
    });
    expect(f.lifecycle()).toEqual(["create", "inspect", "rm"]);
    expect(f.run().stages.implementer).toMatchObject({ level: "L1", violations: ["unexpected_env_name"] });
  });
});
