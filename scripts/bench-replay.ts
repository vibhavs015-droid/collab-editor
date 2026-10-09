/**
 * Measure the four costs T5 names, and print them as a table.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 *
 * Run: npx tsx scripts/bench-replay.ts
 *
 * ---------------------------------------------------------------------------
 * WHY THESE FOUR, AND WHY TOGETHER
 * ---------------------------------------------------------------------------
 * Building operations, replaying them, opening a document from a log, and adopting a snapshot
 * all scale with the size of the log. They are measured together because they share the same hot
 * path - resolving an element id to a position - and a fix that helps one but not the others is
 * not a fix to the problem.
 *
 * `Replica.init` is the headline number because it is what a user waits for when they open a
 * document. The snapshot path is measured because T5 records it as UNMEASURED, and it is the
 * other way a client gets a big document.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SHAPES ARE WHAT THEY ARE
 * ---------------------------------------------------------------------------
 * The document is built by typing: one insert chained to the previous one. That is the shape of
 * real typing, and it is the WORST case for element resolution, because every insert anchors to
 * the element before it and that element sits at the end of the array.
 *
 * A document built by concurrent inserts at scattered positions would resolve faster, because
 * the anchor would usually be found earlier in the scan. Measuring only the easy shape would hide
 * the cost that real typing actually pays.
 *
 * `RgaDocument` is driven directly for the build and replay rows, and `Replica` for the init row,
 * because that is how production uses them: the CRDT for hot paths, the replica for opening.
 */

import type { ElementId } from '../src/core/clock.js';
import { RgaDocument, type Operation } from '../src/core/crdt/rga.js';
import { Replica, type LoggedOperation, type OperationLog } from '../src/core/crdt/replica.js';

/** The sizes T5 asks for. */
const SIZES = [2_000, 5_000, 10_000, 20_000] as const;

const SITE = 'bench-site';

/**
 * A chain of `count` single-character inserts, each anchored to the one before it.
 *
 * This is what a paste or a fast typist produces, and it is deliberately the worst case for
 * element resolution.
 */
function buildOps(count: number): Operation[] {
  const ops: Operation[] = [];
  let previous: ElementId | null = null;

  for (let i = 0; i < count; i += 1) {
    const id = { site: SITE, clock: i + 1 };

    ops.push({ type: 'insert', id, origin: previous, value: 'x' });
    previous = id;
  }

  return ops;
}

/**
 * An in-memory log, so the benchmark measures the CRDT and not a database.
 *
 * `Promise.resolve` rather than `async`, for the reason src/core/crdt/replica.test.ts gives: this
 * adapter has no I/O, and a fake await would make a synchronous benchmark look like it were
 * measuring asynchronous behaviour.
 */
function memoryLog(entries: LoggedOperation[]): OperationLog {
  return {
    load: () => Promise.resolve(entries),
    append: () => Promise.resolve(),
    truncateBefore: () => Promise.resolve(),
    clear: () => Promise.resolve(),
  };
}

/**
 * Run `body` and return milliseconds.
 *
 * `global.gc` where available, because a benchmark that measures garbage collection is measuring
 * the wrong thing. Not forced when unavailable - the numbers are then marked as collected, and
 * that is stated rather than hidden.
 */
function time(body: () => void): number {
  const collect = (globalThis as { gc?: () => void }).gc;

  collect?.();
  const started = performance.now();
  body();
  return performance.now() - started;
}

/**
 * Run `body` and return milliseconds, for work that returns a promise.
 *
 * Separated from {@link time} rather than made generic, because a benchmark that awaits through a
 * union of sync and async would hide which of the two it measured.
 */
async function timeAsync(body: () => Promise<void>): Promise<number> {
  const collect = (globalThis as { gc?: () => void }).gc;

  collect?.();
  const started = performance.now();
  await body();
  return performance.now() - started;
}

interface Row {
  readonly size: number;
  readonly build: number;
  readonly replay: number;
  readonly init: number;
  readonly adopt: number;
}

async function measure(size: number): Promise<Row> {
  const ops = buildOps(size);

  // 1. Build. Every insert allocates an id and anchors to the previous element.
  const build = time(() => {
    buildOps(size);
  });

  // 2. Replay into a fresh document.
  //
  //    ONE call with the whole array, because that is what production does - `Replica.init`
  //    passes every logged operation to a single `applyInAnyOrder`. An earlier version of this
  //    benchmark looped and called it per operation, which measures N invocations of a
  //    whole-batch method and made 20,000 operations run out of memory.
  const replay = time(() => {
    const doc = new RgaDocument('other-site');
    doc.applyInAnyOrder(ops);
  });

  // 3. Open a document from a persisted log. This is the number a user waits for.
  const entries: LoggedOperation[] = ops.map((op, index) => ({
    seq: index + 1,
    op,
    at: 0,
  }));

  const init = await timeAsync(async () => {
    const replica = new Replica({
      site: 'reader-site',
      log: memoryLog(entries),
      onOperations: () => {},
    });

    await replica.init();
  });

  // 4. Adopt a snapshot of `size` elements. T5 records this as UNMEASURED.
  //
  //    Built through Replica.snapshot() rather than by hand, because that is where a real
  //    snapshot comes from - it re-anchors elements and drops tombstones, and a hand-built list
  //    of the original operations would measure the log path again instead.
  const source = new Replica({
    site: SITE,
    log: memoryLog(entries),
    onOperations: () => {},
  });

  await source.init();

  const baseline = source.snapshot().elements.map((element) => ({
    type: 'insert' as const,
    id: element.id,
    origin: element.origin,
    value: element.value,
  }));

  const adopt = time(() => {
    const doc = new RgaDocument('other-site');
    doc.applyInAnyOrder(baseline);
  });

  return { size, build, replay, init, adopt };
}

function row(cells: readonly (number | string)[]): string {
  return cells.map((cell) => String(cell).padStart(12)).join('');
}

async function main(): Promise<void> {
  const collected = typeof (globalThis as { gc?: () => void }).gc === 'function';

  process.stdout.write(
    `element resolution benchmark, worst case for a typing chain\n` +
      `node ${process.version} on ${process.platform}/${process.arch}\n` +
      `garbage collection between samples: ${collected ? 'forced' : 'NOT AVAILABLE, numbers include GC'}\n` +
      `all times in milliseconds\n\n`,
  );

  process.stdout.write(row(['operations', 'build', 'replay', 'init', 'adopt']) + '\n');
  process.stdout.write(
    row(['-'.repeat(12), '-'.repeat(12), '-'.repeat(12), '-'.repeat(12), '-'.repeat(12)]) + '\n',
  );

  const rows: Row[] = [];

  for (const size of SIZES) {
    process.stdout.write(`measuring ${String(size)}...\n`);

    const measured = await measure(size);
    rows.push(measured);

    process.stdout.write(
      row([
        measured.size,
        measured.build.toFixed(1),
        measured.replay.toFixed(1),
        measured.init.toFixed(1),
        measured.adopt.toFixed(1),
      ]) + '\n',
    );
  }

  // Scaling is the finding, not any single number: a constant factor in one row can be a fixed
  // cost, and only the ratio between rows shows whether something is quadratic.
  process.stdout.write(`\nscaling from 2k to 20k (10x the work):\n`);

  const first = rows[0];
  const last = rows[rows.length - 1];

  if (first && last) {
    for (const [name, a, b] of [
      ['build', first.build, last.build],
      ['replay', first.replay, last.replay],
      ['Replica.init', first.init, last.init],
      ['adopt', first.adopt, last.adopt],
    ] as const) {
      const factor = a > 0 ? b / a : Number.POSITIVE_INFINITY;
      process.stdout.write(
        `  ${name.padEnd(14)} ${a.toFixed(1).padStart(8)}ms -> ${b
          .toFixed(1)
          .padStart(8)}ms   ${factor.toFixed(1).padStart(6)}x   ${
          factor > 50 ? 'quadratic or worse' : 'roughly linear'
        }\n`,
      );
    }
  }

  process.stdout.write('\nTargets from T5:\n');
  process.stdout.write('  Replica.init on 20,000 ops under 1.5 s\n');
  process.stdout.write('  Replica.init on 10,000 ops under 0.5 s\n');

  const init20 = rows[rows.length - 1]?.init ?? Number.NaN;
  const init10 = rows.find((r) => r.size === 10_000)?.init ?? Number.NaN;

  process.stdout.write(
    `\n  20,000 ops: ${init20.toFixed(0)}ms  ${init20 < 1500 ? 'MET' : 'NOT MET'}\n` +
      `  10,000 ops: ${init10.toFixed(0)}ms  ${init10 < 500 ? 'MET' : 'NOT MET'}\n`,
  );
}

await main();
