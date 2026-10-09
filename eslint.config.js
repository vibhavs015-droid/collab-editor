import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist', 'node_modules', 'coverage', '.data', '.tools'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // tsconfig.json only includes src/, so the tool's own config files and the
        // tests that check repo tooling sit outside any project. allowDefaultProject
        // lets them be linted anyway instead of being silently skipped or excluded.
        //
        // `scripts/**/*.test.ts` is here for the same reason as `*.config.ts`: vitest
        // runs it (see vitest.config.ts), so it is real test code that belongs under
        // the same gate as everything else.
        //
        // The limitation is real and worth stating: without a tsconfig project, the
        // type-aware rules in these files see imports as `any`. Rules that do not need
        // cross-file types - unused variables, undefined references, `no-explicit-any`
        // on locally annotated values - still apply. The alternative was widening
        // `include` in tsconfig.json, which would drag these files into `dist/` and
        // break the build output layout, so the weaker checking is the better trade.
        //
        // `scripts/*.test.ts` and not `scripts/**/*.test.ts`: typescript-eslint rejects
        // `**` here, for a real reason - every file on the default project costs
        // type information the service cannot cache across projects. The tests that
        // exist here sit directly in `scripts/`, so one level of `*` is enough, and if
        // one moves into a subdirectory it should be named explicitly rather than
        // answered by widening the glob.
        //
        // `scripts/bench-replay.ts` is named explicitly for the same reason. It produces the
        // numbers in docs/benchmarks.md, so it is code whose output is trusted; leaving it
        // unlinted would make it the one script that can quietly rot.
        projectService: {
          allowDefaultProject: [
            '*.config.ts',
            '*.config.js',
            'scripts/*.test.ts',
            'scripts/bench-replay.ts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      // CRDT code is genuinely tricky. Explicit any/nonnull hides the bugs you are hunting.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      eqeqeq: ['error', 'smart'],
    },
  },

  {
    // The Playwright specs.
    //
    // They need their own entry because they are covered by tsconfig.e2e.json rather than
    // tsconfig.json. Without a matching project the project service cannot resolve them and
    // reports "not found by the project service", which surfaces as a parse error rather than
    // a lint finding.
    //
    // Typed linting is kept rather than falling back to allowDefaultProject, because these
    // specs hold the assertions guarding the two regressions the reviewer found. A spec that
    // typechecks loosely is a spec that can silently assert the wrong shape.
    files: ['e2e/**/*.ts', 'playwright.config.ts'],
    languageOptions: {
      parserOptions: {
        // `projectService: false` turns the global project service OFF for these files, which
        // is what lets the explicit `project` below take effect. The service walks up from a
        // file looking for the nearest tsconfig, finds tsconfig.json, and cannot place files
        // outside `include`.
        //
        // Note that `allowDefaultProject` and `defaultProject` are NOT scoped by `files` in
        // flat config - they merge across every matching object. Setting them here emptied the
        // global list and made eslint.config.js itself unlintable.
        projectService: false,
        project: './tsconfig.e2e.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  {
    // e2e/server.mjs, the harness Playwright starts for the tests. Plain Node ESM like
    // scripts/**/*.mjs, and like them it must opt out of type-aware linting.
    files: ['e2e/**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { process: 'readonly', console: 'readonly', setTimeout: 'readonly' },
    },
  },

  {
    // The orchestrator, scripts/load/run.mjs.
    //
    // Plain Node ESM. Separate from the k6 config below because the two need
    // different globals and pretending otherwise produces 30 phantom errors.
    files: ['scripts/**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        URL: 'readonly',
      },
    },
  },
  {
    // k6 load scripts.
    //
    // These run on k6's own Go-based JavaScript runtime, not Node and not the browser.
    // They import 'k6/*' modules that no npm package provides, and they use k6's
    // injected globals (__ENV, __VU, __ITER). None of that exists for TypeScript or for
    // the type-aware lint rules, so including them would mean a wall of phantom errors.
    //
    // They are still linted as plain JavaScript, so the rules that matter - unused
    // variables, undefined references - still apply. What is skipped is type-aware
    // checking, which could not be meaningful here even if it ran.
    files: ['scripts/load/**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        __ENV: 'readonly',
        __VU: 'readonly',
        __ITER: 'readonly',
        __TEST: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        clearTimeout: 'readonly',
        Math: 'readonly',
        JSON: 'readonly',
        Date: 'readonly',
        Number: 'readonly',
        String: 'readonly',
        Buffer: 'readonly',
      },
    },
  },

  // ── Platform boundaries ──────────────────────────────────────────────────
  //
  // tsconfig includes both DOM and Node types so one compiler can check the
  // whole package (ADR-0002). The cost is that neither platform's globals are
  // actually unavailable. These two rule sets restore the separation — a
  // violation becomes a lint error rather than a bug that only appears in the
  // browser or only on the server.

  {
    // Server code must never touch the DOM. It runs in Node, where `window`
    // does not exist, so the mistake would surface as a runtime crash.
    files: ['src/server/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'Server code runs in Node — there is no window.' },
        { name: 'document', message: 'Server code runs in Node — there is no document.' },
        { name: 'localStorage', message: 'Server code has no browser storage.' },
        { name: 'navigator', message: 'Server code has no navigator.' },
      ],
    },
  },
  {
    // Client code must not import Node built-ins. It is bundled for the
    // browser, where `node:fs` does not exist.
    files: ['src/client/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*'],
              message: 'Client code runs in the browser — Node built-ins are unavailable.',
            },
          ],
        },
      ],
    },
  },
  {
    // The CRDT must stay pure: no I/O of any kind. This is what allows the fuzz
    // test to run thousands of cases in milliseconds, so a violation here
    // silently destroys the project's main verification strategy.
    files: ['src/core/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*'],
              message: 'src/core must stay pure - no Node built-ins.',
            },
            {
              // Only bare specifiers are banned. Relative imports (./, ../) stay
              // allowed, because src/core is a directory of modules that must
              // import each other. Banning '*' outright also matched the
              // relative paths, which made the rule unusable rather than strict.
              group: ['^[^./]'],
              message: 'src/core must stay pure - no external dependencies at all.',
            },
          ],
        },
      ],
    },
  },
);
