import { describe, expect, it } from "vitest";
import { isRunning } from "../../src/container/running.js";
import type { ContainerHandle } from "../../src/container/runtime.js";

const handle: ContainerHandle = { name: "omf-sut-x-1", id: "omf-sut-x-1", role: "sut" };
const answering = (answer: unknown) => ({ inspect: async () => answer });

describe("isRunning", () => {
  it("reads the array of one document that docker inspect prints", async () => {
    expect(await isRunning(answering([{ State: { Running: true } }]), handle)).toBe(true);
    expect(await isRunning(answering([{ State: { Running: false } }]), handle)).toBe(false);
  });

  it("reads a bare document", async () => {
    expect(await isRunning(answering({ State: { Running: true } }), handle)).toBe(true);
  });

  it("treats a failed inspect, an empty answer and a missing field as not running", async () => {
    const failing = {
      inspect: async () => {
        throw new Error("gone");
      },
    };
    expect(await isRunning(failing, handle)).toBe(false);
    expect(await isRunning(answering([]), handle)).toBe(false);
    expect(await isRunning(answering(null), handle)).toBe(false);
    expect(await isRunning(answering({ State: {} }), handle)).toBe(false);
    expect(await isRunning(answering([{ State: { Running: "true" } }]), handle)).toBe(false);
  });
});
