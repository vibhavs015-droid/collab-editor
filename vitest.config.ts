import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Phase 2 adds property-based fuzzing here (fast-check).
    // The fuzz test IS the project's strongest artifact — keep it fast enough to run on every push.
    // `scripts/` is included because some of what needs testing is the repository's own
    // tooling rather than the application. `.env.example` documented six variables no
    // code read, and nothing noticed: a test that compares it against the code is the
    // only reason the next such drift gets caught.
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    // PGlite boots a WASM Postgres per suite: roughly 2.5s of real startup
    // cost. Running files in parallel does not help, because the total is
    // dominated by Postgres initialisation rather than assertion count.
    //
    // The fuzz test in Phase 2 is the case that argues for parallelism, so if
    // it lands this should be revisited rather than left at 1 indefinitely.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    /**
     * Transformed modules are cached inside the repository, not in the OS temp directory.
     *
     * Observed twice on this machine: something outside the project - Storage Sense, or a
     * scheduled cleanup - deletes `%TEMP%\<random>\ssr\` while a full suite is running, and
     * every file not yet imported fails with
     *
     *     ENOENT: no such file or directory, open '...\ssr\<hash>'
     *
     * which looks exactly like forty simultaneous code failures and is not one. The path is
     * random per run, so it cannot be pre-cleaned. Pointing the cache at `.tools/` makes the
     * suite independent of whatever is managing the temp directory, and `.tools` is already
     * gitignored and already skipped by the line-endings gate.
     */
    cache: { dir: '.tools/vitest-cache' },
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
