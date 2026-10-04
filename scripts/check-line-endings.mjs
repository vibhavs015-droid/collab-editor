/**
 * Fail on mixed or wrong line endings.
 *
 * `.gitattributes` already declares `* text=auto eol=lf`, which normalises the index and
 * therefore hides the problem at commit time. That is exactly why the problem is worth a
 * separate check: git would store a correct blob, the commit would look clean, and the
 * damage would appear later as a whole-file diff the moment the same file was edited by a
 * tool that writes CRLF.
 *
 * This caught a real case. Edits applied through PowerShell's `WriteAllLines` on Windows
 * emit CRLF, which turned two source files into a mix of CRLF and bare LF. The committed
 * content was still correct, so nothing complained; the working copy was silently
 * inconsistent until a later edit failed to match text that was visibly present.
 *
 * Three separate problems are reported, because they have different fixes:
 *   - CRLF where LF is required: an editor or script wrote Windows line endings.
 *   - A lone CR: a very old Mac convention, or a botched edit.
 *   - A missing final newline: an incomplete write, usually a truncated file.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Directories never searched.
 *
 * Not `node_modules` and `.git` alone. Every entry here is machine-generated or
 * deliberately binary, and a byte-level scan of them is slow and uninformative.
 *
 * `docs/benchmarks` is excluded because k6 writes those files, not this project, and a
 * tool we do not control should not be able to fail our lint. They are still LF in the
 * repository, because git normalises them on commit like everything else.
 */
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.data',
  '.tools',
  'docs/benchmarks',
  'docs/load-artifacts',
]);

/**
 * Extensions where CRLF is genuinely required.
 *
 * Windows refuses to execute a batch file with LF-only endings in several situations, and
 * `.gitattributes` already declares these as `eol=crlf`. They are listed here so this
 * check and git agree rather than contradicting each other.
 */
const CRLF_REQUIRED = /\.(bat|cmd|ps1)$/iu;

/** Extensions skipped entirely, because they are binary. */
const BINARY = /\.(png|jpe?g|gif|ico|pdf|zip|gz|woff2?|ttf|wasm)$/iu;

const problems = [];

/**
 * U+FFFD REPLACEMENT CHARACTER, written as an escape on purpose.
 *
 * The first version of this check used the literal glyph, which made the file contain
 * the very sequence it searches for: it reported itself as mangled, which is both a false
 * positive and a good illustration of why the detector must not depend on readable text.
 */
const REPLACEMENT_CHARACTER = '\uFFFD';

/**
 * Classify one file's bytes.
 *
 * Works on bytes rather than a decoded string on purpose: decoding first would hide the
 * problem for any file that is not valid UTF-8, which is exactly the case where a byte
 * count is the only honest answer.
 */
function inspect(absolutePath) {
  const relativePath = relative(ROOT, absolutePath).split(sep).join('/');
  const bytes = readFileSync(absolutePath);

  if (BINARY.test(relativePath)) {
    return;
  }

  let crlf = 0;
  let bareLf = 0;
  let loneCr = 0;

  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0d) {
      if (bytes[index + 1] === 0x0a) {
        crlf += 1;
        // Skip the LF so the pair is counted once, not also as a bare LF.
        index += 1;
      } else {
        loneCr += 1;
      }
    } else if (bytes[index] === 0x0a) {
      bareLf += 1;
    }
  }

  const expectsCrlf = CRLF_REQUIRED.test(relativePath);

  if (expectsCrlf) {
    // A lone LF in a batch file is the failure that matters, not a CRLF.
    if (bareLf > 0) {
      problems.push({ path: relativePath, reason: `${bareLf} LF must be CRLF here` });
    }
    return;
  }

  if (crlf > 0 && bareLf > 0) {
    problems.push({ path: relativePath, reason: `mixed: ${crlf} CRLF and ${bareLf} LF` });
  } else if (crlf > 0) {
    problems.push({ path: relativePath, reason: `${crlf} CRLF where .gitattributes says LF` });
  }

  if (loneCr > 0) {
    problems.push({ path: relativePath, reason: `${loneCr} lone CR` });
  }

  // An empty file has no final newline to check, and saying otherwise would be noise.
  if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) {
    problems.push({ path: relativePath, reason: 'no final newline' });
  }

  // A UTF-8 BOM is legal but invisible, and it breaks the first line of every tool that
  // reads the file as text. Worth reporting rather than silently tolerating.
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    problems.push({ path: relativePath, reason: 'UTF-8 BOM' });
  }

  try {
    // Strict on purpose. `readFileSync(path, 'utf8')` replaces invalid sequences with
    // U+FFFD, which is the corruption this project has hit before in PowerShell
    // round-trips, so its absence is the signal that nothing was mangled.
    const text = readFileSync(absolutePath, 'utf8');

    if (text.includes(REPLACEMENT_CHARACTER)) {
      problems.push({ path: relativePath, reason: 'contains U+FFFD (mangled UTF-8)' });
    }
  } catch {
    problems.push({ path: relativePath, reason: 'is not valid UTF-8' });
  }
}

function walk(directory) {
  for (const entry of readdirSync(directory)) {
    const absolute = join(directory, entry);
    const relativePath = relative(ROOT, absolute).split(sep).join('/');

    if (SKIP_DIRECTORIES.has(relativePath)) {
      continue;
    }

    if (statSync(absolute).isDirectory()) {
      walk(absolute);
      continue;
    }

    inspect(absolute);
  }
}

walk(ROOT);

if (problems.length > 0) {
  process.stderr.write('[line-endings] problems found:\n');

  for (const problem of problems) {
    process.stderr.write(`  ${problem.path}: ${problem.reason}\n`);
  }

  process.stderr.write(
    `\n[line-endings] ${problems.length} problem(s).\n` +
      '[line-endings]   Fix by converting the file to LF, not by committing it: git would\n' +
      '[line-endings]   normalise the index and hide this, which is how it got here.\n',
  );
  process.exit(1);
}

process.stdout.write('[line-endings] clean\n');
