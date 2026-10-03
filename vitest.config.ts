import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Phase 2 adds property-based fuzzing here (fast-check).
    // The fuzz test IS the project's strongest artifact — keep it fast enough to run on every push.
    include: ['src/**/*.test.ts'],
    // PGlite boots a WASM Postgres per suite: roughly 2.5s of real startup
    // cost. Running files in parallel does not help, because the total is
    // dominated by Postgres initialisation rather than assertion count.
    //
    // The fuzz test in Phase 2 is the case that argues for parallelism, so if
    // it lands this should be revisited rather than left at 1 indefinitely.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // Phase 2+ raises these deliberately. 100% is not the goal; the CRDT internals are.
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 50,
        statements: 60,
      },
    },
  },
});
