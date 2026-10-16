import { afterEach, describe, expect, it, vi } from "vitest";
import { setupImplementer } from "../helpers/implementer-fixture.js";
import { hangingSession } from "../helpers/implementer-matrix.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// The station runs candidate-influenced code with a key, so a SIGINT or SIGTERM in the middle of the session must remove
// the container by name before the process ends with the signal status. The registry's real handler runs here; only the
// final re-raise of the signal is stubbed, because it would end the test process.
describe("W-implementer-cleanup-on-kill", () => {
  it("a SIGTERM during the session removes the implementer container and re-raises the signal", async () => {
    const hang = hangingSession();
    const rig = setupImplementer({ session: hang.session });
    const raise = vi.spyOn(process, "kill").mockImplementation(() => true);
    const run = rig.stations.S3.run(rig.ctx());
    try {
      await hang.entered;
      expect(Object.keys(rig.fake.state.containers)).toHaveLength(1);
      const handler = process.listeners("SIGTERM").find((listener) => listener.name === "onSigterm");
      expect(handler).toBeDefined();
      (handler as () => void)();
      expect(raise).toHaveBeenCalledWith(process.pid, "SIGTERM");
      expect(Object.keys(rig.fake.state.containers)).toEqual([]);
    } finally {
      hang.release();
    }
    expect(await run).toEqual({ kind: "blocked", reason_code: "infra_failure" });
    await rig.stations.dispose();
    expect(Object.keys(rig.fake.state.containers)).toEqual([]);
  });
});
