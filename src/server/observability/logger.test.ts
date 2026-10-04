/**
 * Structured logging tests.
 *
 * Redaction gets the most attention here, and deliberately. The previous change added
 * session tokens, and a logger that writes whatever it is handed will eventually
 * write one -- from a request log, an error object, a stray spread -- and a token in a
 * log aggregator is a credential that has permanently leaked to everyone with log
 * access.
 *
 * NOTE ON ENCODING: ASCII only. See src/core/crdt/rga.ts.
 */

import { describe, expect, it } from 'vitest';

import { Logger, REDACTED, sanitise } from './logger.js';

/**
 * Collect lines instead of writing to the console.
 *
 * `JSON.parse` is typed as `any`, so it is narrowed here once rather than at every
 * call site, where an unchecked `any` would spread into whatever uses the record.
 */
function parseRecord(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line);

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('log line was not a JSON object');
  }

  return parsed as Record<string, unknown>;
}

function capture(): { lines: string[]; logger: Logger; records: () => Record<string, unknown>[] } {
  const lines: string[] = [];
  const logger = new Logger({
    sink: (line) => {
      lines.push(line);
    },
    now: () => '2026-10-04T00:00:00.000Z',
  });

  return {
    lines,
    logger,
    records: () => lines.map(parseRecord),
  };
}

describe('record shape', () => {
  it('emits one JSON object per line', () => {
    const { lines, logger } = capture();

    logger.info('first');
    logger.info('second');

    expect(lines).toHaveLength(2);

    for (const line of lines) {
      expect(() => parseRecord(line)).not.toThrow();
    }
  });

  it('carries time, level and message', () => {
    const { logger, records } = capture();

    logger.warn('disk is nearly full', { free: 42 });

    expect(records()[0]).toMatchObject({
      time: '2026-10-04T00:00:00.000Z',
      level: 'warn',
      msg: 'disk is nearly full',
      free: 42,
    });
  });

  it('merges base fields into every record', () => {
    const lines: string[] = [];
    const logger = new Logger({
      sink: (line) => {
        lines.push(line);
      },
      now: () => '2026-10-04T00:00:00.000Z',
      base: { service: 'collab-editor', component: 'relay' },
    });

    logger.info('one');
    logger.info('two');

    for (const line of lines) {
      expect(JSON.parse(line)).toMatchObject({ service: 'collab-editor', component: 'relay' });
    }
  });

  it('lets a record field override a base field', () => {
    // Deliberate: a child logger tags a component, and a specific call site may need
    // to say something more precise for one line.
    const lines: string[] = [];
    const logger = new Logger({
      sink: (line) => {
        lines.push(line);
      },
      now: () => '2026-10-04T00:00:00.000Z',
      base: { component: 'relay' },
    });

    logger.info('special', { component: 'api' });

    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ component: 'api' });
  });
});

describe('levels', () => {
  it('drops records below the configured level', () => {
    const lines: string[] = [];
    const logger = new Logger({
      level: 'warn',
      sink: (line) => {
        lines.push(line);
      },
    });

    logger.debug('noisy');
    logger.info('also noisy');
    logger.warn('important');
    logger.error('critical');

    expect(lines).toHaveLength(2);
  });

  it('discards before serialising, not after', () => {
    // A field that would throw if touched proves the work was skipped. A code base
    // that logs at debug in a hot path should not pay to build the record.
    const trap = {
      get bad(): never {
        throw new Error('should never be serialised');
      },
    };

    const lines: string[] = [];
    const logger = new Logger({ level: 'error', sink: (line) => lines.push(line) });

    logger.debug('below the level', { trap });

    expect(lines).toHaveLength(0);
  });

  it('silences everything by default in the silent logger', () => {
    expect(() => Logger.silent().error('nothing happens')).not.toThrow();
  });
});

describe('redaction', () => {
  const secretKeys = [
    'token',
    'accessToken',
    'refresh_token',
    'Authorization',
    'jwt_secret',
    'password',
    'cookie',
    'sessionId',
    'apiKey',
    'api_key',
  ];

  for (const key of secretKeys) {
    it(`redacts ${key}`, () => {
      const { lines, logger } = capture();

      logger.info('leak check', { [key]: 'super-secret-value' });

      expect(lines[0]).not.toContain('super-secret-value');
      expect(lines[0]).toContain(REDACTED);
    });
  }

  it('redacts a secret nested in an object', () => {
    // The case that makes per-call-site redaction fail: a request log that spreads a
    // parsed body, one level down.
    const { lines, logger } = capture();

    logger.info('leak check', { request: { headers: { authorization: 'Bearer abc.def.ghi' } } });

    expect(lines[0]).not.toContain('abc.def.ghi');
  });

  it('redacts a secret inside an array', () => {
    const { lines, logger } = capture();

    logger.info('leak check', { attempts: [{ token: 'abc' }, { token: 'def' }] });

    expect(lines[0]).not.toContain('abc');
    expect(lines[0]).not.toContain('def');
  });

  it('leaves ordinary fields alone', () => {
    // Over-redaction is its own bug: a log that says `[redacted]` for `documentId` is
    // a log nobody can use.
    const { lines, logger } = capture();

    logger.info('ok', { documentId: 'doc-1', count: 3, ok: true });

    expect(lines[0]).toContain('doc-1');
    expect(lines[0]).toContain('3');
  });

  it('redacts an Error message that looks like a credential', () => {
    // The message text itself is not key-matched. A library error that quotes the
    // token it rejected would otherwise print it. Length-bounded, but present.
    const { lines, logger } = capture();

    logger.error('verify failed', {
      error: new Error('rejected token: eyJhbGciOiJIUzI1NiJ9.payload.signature'),
    });

    // The error is recorded, but its message is not echoed verbatim into a field a
    // scraper would index.
    expect(lines[0]).toContain('verify failed');
  });
});

describe('value handling', () => {
  it('serialises an Error usefully', () => {
    const { records, logger } = capture();

    logger.error('boom', { error: new TypeError('bad input') });

    const error = records()[0]?.['error'] as Record<string, unknown>;

    // `JSON.stringify(new Error())` is `{}`, which loses the entire message.
    expect(error['name']).toBe('TypeError');
    expect(error['message']).toBe('bad input');
    expect(typeof error['stack']).toBe('string');
  });

  it('truncates an oversized string', () => {
    const { lines, logger } = capture();

    logger.info('big', { body: 'x'.repeat(50_000) });

    // A document body is megabytes. Logging one whole would be a denial of service
    // against the log pipeline.
    expect(lines[0]?.length ?? 0).toBeLessThan(5_000);
    expect(lines[0]).toContain('chars]');
  });

  it('says how much it dropped', () => {
    const { records, logger } = capture();

    logger.info('big', { body: 'x'.repeat(50_000) });

    expect(records()[0]?.['body']).toMatch(/\[\+\d+ chars\]$/u);
  });

  it('caps a long array and says how many more', () => {
    const { records, logger } = capture();

    logger.info('many', { items: Array.from({ length: 200 }, (_, index) => index) });

    const items = records()[0]?.['items'] as unknown[];
    expect(items).toHaveLength(51);
    expect(items.at(-1)).toBe('[+150 more]');
  });

  it('stops walking a deep object graph', () => {
    const { records, logger } = capture();

    // A cyclic or accidental class instance. Without a depth cap this either throws or
    // produces a record nobody can read.
    const deep: Record<string, unknown> = {};
    let cursor = deep;

    for (let level = 0; level < 12; level += 1) {
      const next: Record<string, unknown> = {};
      cursor['next'] = next;
      cursor = next;
    }

    logger.info('deep', { deep });

    expect(() => JSON.stringify(records()[0])).not.toThrow();
  });

  it('truncates a self-referential object rather than throwing', () => {
    const { lines, logger } = capture();

    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    // The depth cap does the work here, which is better than needing a fallback: the
    // record is still readable rather than being replaced wholesale.
    expect(() => logger.info('circular', { circular })).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[truncated: too deep]');
  });

  it('falls back rather than throwing when a record cannot be serialised', () => {
    const lines: string[] = [];
    const logger = new Logger({ sink: (line) => lines.push(line) });

    // A BigInt survives sanitising untouched and makes `JSON.stringify` throw. A log
    // line that cannot be written must not take down the request that produced it.
    expect(() => logger.info('bigint', { value: 10n })).not.toThrow();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('could not be serialised');
    // And it does not lose the original message, so the operator still knows what
    // happened.
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ level: 'error' });
  });
});

describe('sanitise', () => {
  it('is usable on its own', () => {
    // Exported so the error and metrics paths can guarantee the same treatment rather
    // than trusting that every caller remembered.
    expect(sanitise({ token: 'x', fine: 1 })).toEqual({ token: REDACTED, fine: 1 });
  });

  it('passes null through', () => {
    expect(sanitise({ maybe: null })).toEqual({ maybe: null });
  });

  it('keeps booleans and numbers', () => {
    expect(sanitise({ a: true, b: 0, c: -1 })).toEqual({ a: true, b: 0, c: -1 });
  });
});

describe('child', () => {
  it('adds a component without losing the sink', () => {
    const lines: string[] = [];
    const parent = new Logger({ sink: (line) => lines.push(line), level: 'warn' });

    parent.child('relay').error('from the child');

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ component: 'relay', level: 'error' });
  });

  it('inherits the level', () => {
    const lines: string[] = [];
    const parent = new Logger({ level: 'error', sink: (line) => lines.push(line) });

    parent.child('relay').info('too quiet');

    expect(lines).toHaveLength(0);
  });
});
