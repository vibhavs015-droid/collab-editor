import { defineConfig, devices } from '@playwright/test';

/**
 * Browser end-to-end tests (T1).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE CONFIG AND A SEPARATE SCRIPT
 * ---------------------------------------------------------------------------
 * The default `npm test` stays fast, because the unit and integration suite must not wait on a
 * browser. These run the real application in a real browser against a real built server, which
 * is the only way to catch the class of bug this project kept hitting: defects at the seam
 * between two layers that are each individually well tested.
 *
 * `npm run test:e2e` builds first, as a separate step. The build is slow and deterministic and
 * does not vary per run, so keeping it out of the runner keeps startup timeouts meaningful
 * rather than hiding a TypeScript compile inside one.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */
export default defineConfig({
  testDir: 'e2e',

  // The server is started by globalSetup rather than the `webServer` option, because scenario
  // (b) needs it to genuinely stop. See e2e/global-setup.ts for why an emulated outage is not
  // an outage in Chromium.
  globalSetup: './e2e/global-setup.ts',

  // Every spec shares one server and one PGlite data directory, so they must not run
  // concurrently: two workers would contend for the same database files.
  workers: 1,
  fullyParallel: false,

  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,

  // Generous, because the first spec in a run pays for PGlite opening its data directory, which
  // is slow on Windows. The rest reuse the same process.
  timeout: 90_000,
  expect: { timeout: 20_000 },

  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],

        /**
         * Run the FULL Chromium build in headless mode, not `chromium_headless_shell`.
         *
         * Playwright ships two binaries: the full browser, and a smaller `headless shell` built
         * from the same source. Since 1.49 the default for `headless: true` is the shell, and
         * CI installs only the full build:
         *
         *     npx playwright install --with-deps --no-shell chromium
         *
         * `--no-shell` excludes precisely the binary the default config wants. Every one of the
         * six tests then failed with `Executable doesn't exist at .../chromium_headless_shell-1243`.
         *
         * That was never caught before the first CI run, because a developer machine that has
         * run a plain `npx playwright install` has both binaries and passes either way. The
         * local green and the CI red were both correct about their own machine.
         *
         * Two ways to make them agree:
         *
         *   - drop `--no-shell` from CI, and download a ~50 MB binary nobody runs.
         *   - ask for the full build here, which is what CI has.
         *
         * The second is chosen, and it is also the better test: the full build is real headless
         * Chrome rather than a stripped harness, so what runs in CI is closer to what a user's
         * browser does. `channel: 'chromium'` is the supported way to select it.
         *
         * VERIFIED by deleting the local `chromium_headless_shell` directory - leaving the machine
         * in exactly the state CI is in - and running the suite. Before this line it failed to
         * launch; after it, all six pass. Reproduced rather than assumed.
         */
        channel: 'chromium',
      },
    },
  ],
});
