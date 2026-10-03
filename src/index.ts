/**
 * Phase 0 entry point.
 *
 * Deliberately a self-check rather than a stub: running it proves the whole
 * toolchain (TypeScript compile, ESM resolution, strict mode) is wired
 * correctly before any real complexity exists. Cheap insurance.
 *
 * `npm start` after a build, or `npm run build && node dist/index.js`.
 */

import { LogicalClock, compareElementId, formatElementId } from './core/clock.js';
import { mulberry32, shuffle } from './core/rng.js';

function selfCheck(): void {
  // 1. Logical clocks issue unique, increasing ids.
  const clock = new LogicalClock('selfcheck');
  const issued = Array.from({ length: 5 }, () => clock.tick());
  const unique = new Set(issued.map(formatElementId));

  if (unique.size !== issued.length) {
    throw new Error('self-check failed: LogicalClock reissued an id');
  }

  // 2. Ordering is independent of the order we happened to collect ids in.
  const reference = [...issued].sort(compareElementId).map(formatElementId);
  const shuffled = shuffle(issued, mulberry32(42)).sort(compareElementId).map(formatElementId);

  if (reference.join(',') !== shuffled.join(',')) {
    throw new Error('self-check failed: ordering depended on input order');
  }

  // 3. Seeded randomness is reproducible.
  const a = Array.from({ length: 8 }, mulberry32(1234));
  const b = Array.from({ length: 8 }, mulberry32(1234));

  if (a.join(',') !== b.join(',')) {
    throw new Error('self-check failed: mulberry32 is not deterministic');
  }

  const lines = [
    'collab-editor — Phase 0 toolchain self-check',
    '',
    '  LogicalClock ......... ok  (unique, monotonic element ids)',
    '  compareElementId ..... ok  (order independent of input order)',
    '  mulberry32 ........... ok  (deterministic for a given seed)',
    '',
    '  Element ids issued:',
    ...issued.map((value, index) => `    ${index + 1}. ${formatElementId(value)}`),
    '',
    'Phase 0 complete. Next: Phase 1 (single-user editor).',
  ];

  process.stdout.write(`${lines.join('\n')}\n`);
}

selfCheck();
