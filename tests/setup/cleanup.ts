import { afterAll } from "vitest";
import { removeTempDirsAsync } from "../helpers/tmp.js";

// Each test file removes the temp directories it made, so repeated runs leave nothing in the OS temp dir.
// The removal is async and concurrent: it is the only hook every file runs, and a synchronous delete was
// the hook that timed out under heavy machine load (see docs/maintainers/testing.md).
afterAll(() => removeTempDirsAsync());
