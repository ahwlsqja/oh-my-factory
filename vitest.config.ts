import { defineConfig } from "vitest/config";

/**
 * Timeouts. Every test file spawns real child processes (the built CLI, git, agent stubs) and the shared
 * afterAll hook deletes the temp directories it created. On an idle laptop the slowest test takes ~5 s and
 * the slowest hook ~1.5 s, but under a heavily loaded machine (load average 45+) they stretch ten-fold.
 * vitest's default hookTimeout of 10 s then fails unrelated files (goal/reconcile, core/doctor) that pass
 * when run alone. 30 s for both leaves headroom without hiding a real hang.
 *
 * OMF_TEST_MAX_WORKERS caps the number of parallel test files. Unset keeps vitest's default (about one
 * worker per core); set it to 2 or 4 on a busy or small machine to trade wall-clock time for stability.
 */
const maxWorkers = Number.parseInt(process.env.OMF_TEST_MAX_WORKERS ?? "", 10);

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/setup/cleanup.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      // Used only by `npm run test:coverage`. v8 sees this process, not the CLI children that
      // tests spawn from dist/, so src/cli numbers undercount (see docs/maintainers/testing.md).
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary", "json-summary", "lcov", "html"],
      reportsDirectory: "coverage",
    },
    ...(Number.isInteger(maxWorkers) && maxWorkers > 0 ? { maxWorkers } : {}),
  },
});
