import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Phase 2 adds property-based fuzzing here (fast-check).
    // The fuzz test IS the project's strongest artifact — keep it fast enough to run on every push.
    include: ['src/**/*.test.ts'],
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
