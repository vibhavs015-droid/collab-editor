import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist', 'node_modules', 'coverage', '.data'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // tsconfig.json only includes src/, so the tool's own config files sit
        // outside any project. allowDefaultProject lets them be linted anyway
        // instead of being silently skipped or excluded.
        projectService: {
          allowDefaultProject: ['*.config.ts', '*.config.js'],
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
