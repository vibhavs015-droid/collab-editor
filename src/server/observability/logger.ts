/**
 * Structured logging.
 *
 * JSON lines on stdout, one object per line. Not a pretty format: a log that a person
 * reads comfortably and a log that `jq` can filter are not the same artifact, and
 * the second one is what actually gets used during an incident.
 *
 * NOTE ON ENCODING: ASCII only. See the note at the top of src/core/crdt/rga.ts.
 *
 * ---------------------------------------------------------------------------
 * REDACTION IS THE POINT, NOT A NICETY
 * ---------------------------------------------------------------------------
 * The previous commit added session tokens. A logger that writes whatever it is
 * handed will eventually write a token -- from a request log, an error object, a
 * stray spread -- and a token in a log aggregator is a credential that has already
 * leaked to everyone with log access, permanently.
 *
 * So every key that looks like a credential is replaced before serialisation, at the
 * one place where log records are turned into bytes. Doing it per call site would
 * work exactly until a new call site is written.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Keys whose values never reach the output. */
const SECRET_KEY = /(token|secret|password|authorization|cookie|session|apikey|api_key)/iu;

/** Value written in place of a redacted field. */
export const REDACTED = '[redacted]';

/**
 * Longest single value kept intact.
 *
 * A document body is megabytes. Logging one whole would be a denial of service
 * against the log pipeline, so oversized values are truncated with a marker that says
 * how much was dropped.
 */
export const MAX_VALUE_LENGTH = 2_000;

export type LogFields = Readonly<Record<string, unknown>>;

/** Where log lines go. A function, so tests do not write to the console. */
export type LogSink = (line: string) => void;

export interface LoggerOptions {
  /**
   * Minimum level to emit. Anything below is dropped before serialisation, so a
   * debug-heavy codebase does not pay for formatting it will discard.
   */
  readonly level?: LogLevel;
  readonly sink?: LogSink;
  /**
   * Extra fields merged into every record. Used for a component name, or a request
   * id that follows one request through several log lines.
   */
  readonly base?: LogFields;
  /** Clock injection, so a test can assert on an exact line. */
  readonly now?: () => string;
}

export class Logger {
  readonly #level: LogLevel;
  readonly #sink: LogSink;
  readonly #base: LogFields;
  readonly #now: () => string;

  constructor(options: LoggerOptions = {}) {
    this.#level = options.level ?? 'info';
    this.#sink = options.sink ?? ((line) => process.stdout.write(`${line}\n`));
    this.#base = options.base ?? {};
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /** A logger that writes nothing. For tests, and for components with no metrics. */
  static silent(): Logger {
    return new Logger({ sink: () => undefined });
  }

  debug(message: string, fields?: LogFields): void {
    this.#write('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.#write('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.#write('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.#write('error', message, fields);
  }

  /** A logger sharing this one's sink and level, tagged with a component name. */
  child(component: string): Logger {
    return new Logger({
      level: this.#level,
      sink: this.#sink,
      base: { ...this.#base, component },
      now: this.#now,
    });
  }

  #write(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.#level]) {
      return;
    }

    const record: Record<string, unknown> = {
      time: this.#now(),
      level,
      msg: message,
      ...sanitise(this.#base),
      ...(fields === undefined ? {} : sanitise(fields)),
    };

    try {
      this.#sink(JSON.stringify(record));
    } catch {
      // A log line that cannot be serialised must not take down the request that
      // produced it. Logging is the least important thing happening at this point.
      this.#sink(
        JSON.stringify({
          time: this.#now(),
          level: 'error',
          msg: 'log record could not be serialised',
        }),
      );
    }
  }
}

/**
 * Redact and bound a field set.
 *
 * Exported so the /metrics and error paths can guarantee the same treatment as the
 * log path, rather than trusting that every caller remembered.
 */
export function sanitise(fields: LogFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_KEY.test(key)) {
      out[key] = REDACTED;
      continue;
    }

    out[key] = sanitiseValue(value, 0);
  }

  return out;
}

/** How deep to walk before giving up on an object graph. */
const MAX_DEPTH = 4;

function sanitiseValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' ? truncate(value) : value;
  }

  if (value instanceof Error) {
    // An Error's own enumerable properties are usually empty; the useful parts are
    // name, message and stack. Serialising the object directly produces `{}`.
    return {
      name: value.name,
      message: truncate(value.message),
      stack: value.stack === undefined ? undefined : truncate(value.stack, MAX_VALUE_LENGTH * 4),
      ...sanitise(value as unknown as LogFields),
    };
  }

  if (depth >= MAX_DEPTH) {
    // Deeper than this is almost certainly a cycle or an accidental class instance.
    return '[truncated: too deep]';
  }

  if (Array.isArray(value)) {
    const capped = value.slice(0, 50).map((item) => sanitiseValue(item, depth + 1));

    if (value.length > 50) {
      capped.push(`[+${value.length - 50} more]`);
    }

    return capped;
  }

  const out: Record<string, unknown> = {};

  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : sanitiseValue(inner, depth + 1);
  }

  return out;
}

function truncate(value: string, limit = MAX_VALUE_LENGTH): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit)}...[+${value.length - limit} chars]`;
}
