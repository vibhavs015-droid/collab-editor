/**
 * Assert that paths which MUST never be committed actually are ignored.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `.gitignore` had `data/` where it meant `.data/`. Git reads that as "a directory named
 * `data`", so the PGlite database directory was never ignored - and `git add -A` committed
 * 997 files, 38 MB of live database, in cda7007. Nothing warned: the commit succeeded, the
 * build passed, and every test passed. It was only noticed by reading `git status` after a
 * commit and finding a dozen modified files under `.data/pgdata/`.
 *
 * A wrong `.gitignore` rule is silent. Git does not error on adding a file it was supposed to
 * exclude; it just adds it. So the only defence is to ask, mechanically, whether the rules do
 * what they claim.
 *
 * `git check-ignore` is exactly that question. This runs it against the paths that would do
 * real damage if committed, and fails when any of them is NOT ignored.
 *
 * It also asserts the inverse for one path, because an ignore rule that swallows something it
 * should not is its own bug: `src/` must stay tracked, or the next commit deletes the project.
 *
 * Runs in CI and in `npm run verify`. ASCII only.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const ROOT = resolve(import.meta.dirname, '..');

/**
 * Paths that must never be committed, and why each one matters.
 *
 * `null` as the path means "this directory does not need to exist for the check to be
 * meaningful" - `git check-ignore` works on hypothetical paths, which is what makes this
 * testable before anything has been created.
 */
const MUST_BE_IGNORED = [
  ['.data/pgdata', 'PGlite database. 38 MB of live data, and it is per-machine state.'],
  ['.data', 'PGlite database directory.'],
  ['node_modules', "192 packages, built for this machine's platform and Node ABI."],
  ['dist', 'Build output, rebuilt from source.'],
  ['coverage', 'Coverage output.'],
  ['.env', 'Real secrets. Unrecoverable once pushed, even to a private repo.'],
  ['.tools', 'k6 binary, ~100 MB, downloaded.'],
];

/**
 * Paths that look generated but are DELIBERATELY tracked.
 *
 * `docs/benchmarks/*.json` was on the ignore list in the first version of this file, and the
 * gate immediately reported it as a problem - which was the gate being wrong, not the repo.
 * Those 32 files are the evidence behind every benchmark claim in the README: three runs each
 * with median and min-max, which is the whole reason the numbers are quotable. Deleting them
 * to satisfy a check would remove the proof.
 *
 * Listed here rather than simply omitted so the next person to read `.dockerignore` (which
 * does exclude them, correctly - they are not needed to build an image) does not conclude the
 * same thing applies to git.
 */
const MUST_BE_TRACKED_EXTRA = [
  ['docs/benchmarks/connect-summary.json', 'the recorded benchmark evidence'],
];

/** Paths that must stay tracked, or the build cannot work. */
const MUST_BE_TRACKED = [
  ['src', 'the entire source tree'],
  ['index.html', 'the Vite entry point'],
  ['package.json', 'dependencies and scripts'],
  ...MUST_BE_TRACKED_EXTRA,
];

let failures = 0;

function fail(message) {
  failures += 1;
  process.stdout.write(`  FAIL  ${message}\n`);
}

/** @returns true when git says the path is ignored. */
function isIgnored(relativePath) {
  try {
    // Exit code 0 means "one or more paths are ignored", 1 means "none are".
    execFileSync('git', ['check-ignore', '--quiet', '--', relativePath], {
      cwd: ROOT,
      stdio: 'ignore',
    });

    return true;
  } catch (error) {
    // Status 1 is the documented "not ignored". Anything else is a real failure to run git.
    const status = error.status ?? error.code;

    if (status === 1) {
      return false;
    }

    throw new Error(
      `git check-ignore failed for ${relativePath} with status ${String(status)}. ` +
        'Is this a git repository?',
      { cause: error },
    );
  }
}

process.stdout.write('gitignore coverage\n');

for (const [relativePath, why] of MUST_BE_IGNORED) {
  if (isIgnored(relativePath)) {
    process.stdout.write(`  ok    ${relativePath} is ignored\n`);
  } else {
    fail(`${relativePath} is NOT ignored, so ` + `\`git add -A\` would commit it. ${why}`);
  }
}

for (const [relativePath, why] of MUST_BE_TRACKED) {
  if (!existsSync(resolve(ROOT, relativePath))) {
    fail(`${relativePath} does not exist, so this check cannot be trusted`);
  } else if (isIgnored(relativePath)) {
    fail(`${relativePath} is ignored but must be tracked - it is ${why}`);
  } else {
    process.stdout.write(`  ok    ${relativePath} is tracked\n`);
  }
}

// The end state that actually matters: nothing already tracked may be ignored. `git add -A`
// can do this in one command, and the fix is always the same - untrack it, do not delete it.
let trackedIgnored = 0;

try {
  const tracked = execFileSync('git', ['ls-files'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\n')
    .filter((line) => line !== '');

  for (const path of tracked) {
    if (isIgnored(path)) {
      fail(`${path} is tracked but matches an ignore rule. Run: git rm --cached ${path}`);
      trackedIgnored += 1;

      if (trackedIgnored > 10) {
        fail('more than 10 tracked files are ignored; stopping the list');
        break;
      }
    }
  }
} catch (error) {
  fail(`could not list tracked files: ${String(error)}`);
}

if (failures > 0) {
  process.stdout.write(`\n${failures} ignore problem(s)\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('\nignore rules cover what they should\n');
}
