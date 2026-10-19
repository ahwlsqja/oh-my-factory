import { defineConfig } from "vitest/config";

/**
 * The configuration of a vitest run started from inside a test: the same include rule as the repository's, but no global
 * setup, because that one deletes and rebuilds dist/ and would break every test file running beside it.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup/cleanup.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
