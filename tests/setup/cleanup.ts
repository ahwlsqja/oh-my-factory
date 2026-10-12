import { afterAll } from "vitest";
import { removeTempDirs } from "../helpers/tmp.js";

// Each test file removes the temp directories it made, so repeated runs leave nothing in the OS temp dir.
afterAll(() => removeTempDirs());
