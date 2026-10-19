import { describe, expect, it } from "vitest";
import { containerState } from "../../src/container/running.js";
import type { ContainerHandle } from "../../src/container/runtime.js";

const handle: ContainerHandle = { name: "omf-sut-x-1", id: "omf-sut-x-1", role: "sut" };
const answering = (answer: unknown) => ({ inspect: async () => answer });

describe("containerState", () => {
  it("reads the array of one document that docker inspect prints", async () => {
    expect(await containerState(answering([{ State: { Running: true } }]), handle)).toBe("running");
    expect(await containerState(answering([{ State: { Running: false } }]), handle)).toBe("gone");
  });

  it("reads a bare document", async () => {
    expect(await containerState(answering({ State: { Running: true } }), handle)).toBe("running");
  });

  it("reads a failed inspect as unknown, never as gone", async () => {
    const failing = {
      inspect: async () => {
        throw new Error("daemon unreachable");
      },
    };
    expect(await containerState(failing, handle)).toBe("unknown");
  });

  it("reads an answer without a boolean Running as unknown", async () => {
    expect(await containerState(answering([]), handle)).toBe("unknown");
    expect(await containerState(answering(null), handle)).toBe("unknown");
    expect(await containerState(answering({ State: {} }), handle)).toBe("unknown");
    expect(await containerState(answering([{ State: { Running: "true" } }]), handle)).toBe("unknown");
  });
});
