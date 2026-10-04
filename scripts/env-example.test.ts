/**
 * `.env.example` must describe the environment the code actually reads.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS TEST EXISTS
 * ---------------------------------------------------------------------------
 * `.env.example` advertised six variables that nothing read: `DATABASE_URL`,
 * `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and `REDIS_URL`.
 * They were aspirational — ADR-0006 defers Supabase and ADR-0007 keeps the relay a
 * single process — and no code referenced any of them.
 *
 * That is worse than leaving them out. Someone who sets `DATABASE_URL` and sees the
 * server start believes persistence is networked, when it is PGlite on local disk. A
 * variable that does nothing is a lie with a comment above it.
 *
 * The same file also used `K6_VUS` and `K6_DURATION` when the harness reads
 * `LOAD_VUS` and `LOAD_DURATION`, because `K6_*` is k6's own namespace and setting it
 * silently overrides the scenario's duration.
 *
 * Documentation drifts the moment nobody checks it. This is the check.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Repository root.
 *
 * One level up from this file's directory. Two (`../..`) resolves to the parent of the
 * repository, which fails with a confusing ENOENT on the first `readdirSync` rather than
 * anything that points at the cause.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Every file under a directory, recursively. */
function walk(directory: string, extensions: readonly string[]): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(directory)) {
    const absolute = join(directory, entry);

    if (statSync(absolute).isDirectory()) {
      found.push(...walk(absolute, extensions));
      continue;
    }

    if (extensions.some((extension) => entry.endsWith(extension))) {
      found.push(absolute);
    }
  }

  return found;
}

/**
 * Variables the code reads from the process environment.
 *
 * Two forms, because the project has two runtimes:
 *   - `process.env['NAME']` in TypeScript, which is how the server reads configuration.
 *   - `__ENV.NAME` in k6 scripts, which is how a load scenario reads it.
 *
 * Scanned as text rather than by importing the modules, because importing the server
 * would construct real components. A regex that misses a read is a gap in this test,
 * which is why the "no drift" assertion below is written to fail loudly rather than
 * pass quietly when it finds nothing.
 */
function readVariablesFromCode(): Set<string> {
  const variables = new Set<string>();
  const files = [
    ...walk(join(ROOT, 'src'), ['.ts']),
    ...walk(join(ROOT, 'scripts'), ['.js', '.mjs']),
  ];

  for (const file of files) {
    // Test files are excluded: a test that constructs an environment object literal is
    // not the application reading a variable.
    if (/\.(test|spec)\.ts$/u.test(file)) {
      continue;
    }

    const source = readFileSync(file, 'utf8');

    for (const match of source.matchAll(/process\.env\[['"]([A-Z0-9_]+)['"]\]/gu)) {
      variables.add(match[1] ?? '');
    }

    for (const match of source.matchAll(/__ENV\.([A-Z0-9_]+)/gu)) {
      variables.add(match[1] ?? '');
    }

    // `env.JWT_SECRET` in resolveAuthenticator, which takes an injected `NodeJS.ProcessEnv`
    // rather than reading the global directly so it can be tested.
    for (const match of source.matchAll(/\benv\.([A-Z][A-Z0-9_]{2,})\b/gu)) {
      variables.add(match[1] ?? '');
    }
  }

  return new Set([...variables].filter((name) => name.length > 0));
}

/**
 * Variables `.env.example` defines, split by whether they are active or optional.
 *
 * A commented-out `NAME=` counts as documented. `JWT_TTL_MS` and `AUTH_MODE` are real
 * options that are off by default, and the file documents them by showing the line
 * commented out, which is the clearest way to present an optional setting.
 */
function readVariablesFromExample(): { active: Set<string>; optional: Set<string> } {
  const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
  const active = new Set<string>();
  const optional = new Set<string>();

  for (const line of example.split('\n')) {
    const trimmed = line.trim();

    if (trimmed === '' || trimmed.startsWith('#!')) {
      continue;
    }

    const commented = trimmed.startsWith('#');
    // Strip the comment marker so `# JWT_TTL_MS=604800000` still identifies the name.
    const body = commented ? trimmed.replace(/^#+\s*/u, '') : trimmed;
    const match = /^([A-Z][A-Z0-9_]*)=/u.exec(body);

    if (!match?.[1]) {
      continue;
    }

    (commented ? optional : active).add(match[1]);
  }

  return { active, optional };
}

/**
 * Variables the harness owns rather than the operator.
 *
 * `LOAD_*` are per-scenario knobs that `run.mjs` passes explicitly. Listing all nine in
 * `.env.example` would be noise, and they are documented where they belong, in
 * `scripts/load/README.md`.
 *
 * Excluded here, and separately asserted below, because the mistake that actually
 * happened was using k6's `K6_*` namespace instead — which is not an exclusion question
 * but a correctness one.
 */
const isLoadHarnessVariable = (name: string): boolean => name.startsWith('LOAD_');

const readByCode = readVariablesFromCode();
const declared = readVariablesFromExample();
const declaredInExample = new Set([...declared.active, ...declared.optional]);

describe('.env.example', () => {
  it('found the variables to check', () => {
    // A guard on the guard. If the scanner above silently stopped matching, both sets
    // would be empty, every assertion below would pass, and the test would be worthless.
    expect(readByCode.size).toBeGreaterThan(5);
    expect(declaredInExample.size).toBeGreaterThan(5);
  });

  it('documents every server variable the code reads', () => {
    // Load-scenario knobs are excluded: the harness sets them, and they belong in
    // scripts/load/README.md rather than in the file an operator copies.
    const undocumented = [...readByCode]
      .filter((name) => !isLoadHarnessVariable(name))
      .filter((name) => !declaredInExample.has(name))
      .sort();

    expect(undocumented, `add these to .env.example: ${undocumented.join(', ')}`).toEqual([]);
  });

  it('declares no active variable the code ignores', () => {
    // The failure this test was written for. A variable here is a promise the code does
    // not keep.
    const ignored = [...declared.active].filter((name) => !readByCode.has(name)).sort();

    expect(ignored, `remove these from .env.example: ${ignored.join(', ')}`).toEqual([]);
  });

  it('leaves JWT_SECRET empty, because this file is committed', () => {
    // The one variable where a value here would be a real credential. Checked as a shape
    // so a pasted key is caught rather than trusted to review.
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
    const value = /^JWT_SECRET=(.*)$/mu.exec(example)?.[1]?.trim() ?? '';

    expect(value).toBe('');
  });

  it('carries no other value long enough to be a credential', () => {
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
    const suspicious = example
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[A-Z][A-Z0-9_]*=/u.test(line))
      .filter((line) => !line.startsWith('JWT_SECRET='))
      .filter((line) => {
        const value = line.slice(line.indexOf('=') + 1);
        // A placeholder is fine. Something long and random-shaped is not.
        return value.length >= 24 && /^[A-Za-z0-9+/_-]+$/u.test(value);
      });

    expect(suspicious).toEqual([]);
  });

  it('carries no value that could be a secret', () => {
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
    const suspicious = example
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[A-Z][A-Z0-9_]*=/u.test(line))
      .filter((line) => !line.startsWith('JWT_SECRET='))
      .filter((line) => {
        const value = line.slice(line.indexOf('=') + 1);
        // A placeholder is fine. Something long and random-shaped is not.
        return value.length >= 24 && /^[A-Za-z0-9+/_-]+$/u.test(value);
      });

    expect(suspicious).toEqual([]);
  });

  it('documents the three container traps', () => {
    // Each of these is a mistake that produces a container which starts, looks healthy,
    // and serves nothing. The explanations in the file are the point; the variables
    // alone would not be enough.
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8');

    expect(example).toMatch(/HOST=127\.0\.0\.1/u);
    expect(example).toMatch(/0\.0\.0\.0/u);
    expect(example).toMatch(/PGLITE_DATA_DIR/u);
    expect(example).toMatch(/volume/iu);
    expect(example).toMatch(/CLIENT_DIST/u);
  });

  it("does not use k6's own K6_ namespace", () => {
    // `K6_DURATION` overrode the scenario's duration and produced a run of the wrong
    // length that still exited 0. Present in `.env.example` until this test existed.
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
    const offending = example
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => !line.startsWith('#'))
      .filter((line) => /^K6_/u.test(line));

    expect(offending).toEqual([]);
  });

  it('carries no value that could be a secret', () => {
    // The file is committed. A pasted key here is unrecoverable once pushed, even to a
    // private repository, so this asserts the shape rather than trusting review.
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
    const suspicious = example
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[A-Z][A-Z0-9_]*=/u.test(line))
      // JWT_SECRET is legitimately present and must be empty in the template.
      .filter((line) => !line.startsWith('JWT_SECRET='))
      .filter((line) => {
        const value = line.slice(line.indexOf('=') + 1);
        // A placeholder is fine. Something long and random-shaped is not.
        return value.length >= 24 && /^[A-Za-z0-9+/_-]+$/u.test(value);
      });

    expect(suspicious).toEqual([]);
  });
});
