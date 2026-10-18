import { ChildProcess, spawn } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openUiBrowser } from "../../src/cli/ui.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

beforeEach(() => vi.resetAllMocks());

describe("UI browser launcher host-process boundary", () => {
  it.each([
    ["darwin", "open"],
    ["linux", "xdg-open"],
  ] as const)("%s starts only %s with one unchanged URL argument and no shell", async (platform, command) => {
    const child = new ChildProcess();
    vi.mocked(spawn).mockReturnValue(child);
    const hostileUrl = "http://127.0.0.1:12345/token/?q=;$(touch /tmp/omf-not-executed)`uname`&x='quoted'";
    const opening = openUiBrowser(hostileUrl, platform);
    expect(spawn).toHaveBeenCalledExactlyOnceWith(command, [hostileUrl], { stdio: "ignore", shell: false });
    child.emit("exit", 0, null);
    await opening;
  });

  it("starts no process on an unsupported platform", async () => {
    await expect(openUiBrowser("http://127.0.0.1:12345/token/", "win32")).rejects.toThrow("No browser opener");
    expect(spawn).not.toHaveBeenCalled();
  });
});
