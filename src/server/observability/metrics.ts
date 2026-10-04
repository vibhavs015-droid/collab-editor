/**
 * Metric registry and Prometheus text rendering.
 *
 * NOTE ON ENCODING: ASCII only. See the note at the top of src/core/crdt/rga.ts.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Benchmark numbers are only worth publishing if the thing being measured can be
 * observed while it happens. A load test that reports "1200 requests, all fine"
 * tells you nothing about whether the WebSocket relay was keeping up or quietly
 * falling behind; a counter of unplaced operations tells you immediately.
 *
 * No Prometheus client dependency. The text format is a few dozen lines, and
 * vendoring the whole ecosystem to serialise a Map is a poor trade.
 *
 * ---------------------------------------------------------------------------
 * THE THING THAT ACTUALLY BITES: LABEL CARDINALITY
 * ---------------------------------------------------------------------------
 * `requests_total{path="/api/documents/abc123"}` creates one time series per
 * document. A user creates forty documents and the registry has forty series for one
 * endpoint; a crawler creates forty thousand. Memory grows without bound, scrapes
 * get slower, and the monitoring system falls over while the application is fine.
 *
 * So there are two defences here:
 *
 *   1. Labels are ROUTE TEMPLATES, never raw paths. `/api/documents/:id` is one
 *      series no matter how many documents exist.
 *   2. Every metric has a hard cap on distinct label combinations. Past the cap,
 *      new combinations fold into `<overflow>` and a warning is counted. This is a
 *      backstop for the case someone adds a raw path by accident, which is exactly
 *      the mistake that is easy to make and hard to notice.
 */

export type MetricType = 'counter' | 'gauge' | 'histogram';

/** A set of label name/value pairs. Order does not matter; the key is sorted. */
export type Labels = Readonly<Record<string, string>>;

/** Label used when the cardinality cap has been hit. */
export const OVERFLOW_LABEL = '<overflow>';

/**
 * Default cap on distinct label combinations per metric.
 *
 * Chosen to be far above any legitimate value (a route template plus a status code
 * plus a reason is tens) and far below anything that hurts (thousands).
 */
export const DEFAULT_LABEL_LIMIT = 200;

/**
 * Default histogram buckets, in seconds. Chosen for a sub-second relay.
 *
 * `+Inf` is a real bucket rather than an implied one, and it is what makes an
 * observation too large for every other bound still counted. Without it, a
 * pathological 30-second replay would appear in `_count` and in no bucket at all,
 * which reads as "no slow requests happened".
 */
export const DEFAULT_BUCKETS: readonly number[] = [
  0.001,
  0.005,
  0.01,
  0.025,
  0.05,
  0.1,
  0.25,
  0.5,
  1,
  2.5,
  5,
  10,
  Number.POSITIVE_INFINITY,
];

interface Series {
  readonly name: string;
  readonly labels: Labels;
  /** Sorted, so the same labels always produce the same key. */
  readonly key: string;
  value: number;
}

interface HistogramSeries {
  readonly name: string;
  readonly labels: Labels;
  readonly key: string;
  readonly buckets: readonly number[];
  /** Cumulative counts, parallel to `buckets`. */
  readonly counts: number[];
  sum: number;
  count: number;
}

interface MetricFamily {
  readonly name: string;
  readonly help: string;
  readonly type: MetricType;
  readonly series: Map<string, Series>;
  readonly histograms: Map<string, HistogramSeries>;
  /** Distinct label keys seen, including those that overflowed. */
  seenKeys: Set<string>;
  overflowed: boolean;
}

function labelKey(labels: Labels): string {
  const names = Object.keys(labels).sort();

  if (names.length === 0) {
    return '';
  }

  return names.map((name) => `${name}="${escapeLabelValue(labels[name] ?? '')}"`).join(',');
}

/**
 * Escape a label value per the Prometheus text format.
 *
 * Backslash, double quote and newline are escaped. A label value containing a bare
 * newline produces output that is no longer parseable, so an unescaped one is a way
 * to corrupt a scrape rather than merely to display badly.
 */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"').replace(/\n/gu, '\\n');
}

/** Render a number the way Prometheus expects. Integers stay integers. */
function renderValue(value: number): string {
  if (!Number.isFinite(value)) {
    // NaN and Infinity are not valid samples. Emitting them makes the whole scrape
    // fail to parse, which turns one broken metric into a monitoring outage.
    return '0';
  }

  if (Number.isInteger(value)) {
    return String(value);
  }

  return value.toFixed(6);
}

export class Metrics {
  readonly #families = new Map<string, MetricFamily>();
  readonly #labelLimit: number;
  /** Times a label combination was refused because the cap was reached. */
  #cardinalityOverflows = 0;

  constructor(options: { labelLimit?: number } = {}) {
    this.#labelLimit = options.labelLimit ?? DEFAULT_LABEL_LIMIT;
  }

  /**
   * Add to a counter.
   *
   * @returns the new value, so a caller can log or branch on it.
   */
  increment(name: string, labels: Labels = {}, amount = 1): number {
    const series = this.#seriesFor(name, 'counter', labels);
    series.value += amount;
    return series.value;
  }

  /** Set a gauge. */
  set(name: string, labels: Labels = {}, value: number): void {
    const series = this.#seriesFor(name, 'gauge', labels);
    series.value = value;
  }

  /** Add to a gauge, for values that move both ways without a separate setter. */
  add(name: string, labels: Labels = {}, amount = 1): void {
    const series = this.#seriesFor(name, 'gauge', labels);
    series.value += amount;
  }

  /** Remove a gauge series entirely, used when a document's room empties. */
  clear(name: string, labels: Labels = {}): void {
    const family = this.#families.get(name);

    if (!family) {
      return;
    }

    family.series.delete(labelKey(labels));
  }

  /** Record a duration in seconds. */
  observe(name: string, labels: Labels = {}, seconds: number): void {
    const family = this.#ensureFamily(name, 'histogram', '');
    const key = this.#admitKey(family, labelKey(labels));

    if (key === null) {
      // Refused for cardinality. A histogram that drops observations is worse than
      // useless - it looks like latency went down - so the drop is counted loudly.
      return;
    }

    let histogram = family.histograms.get(key);

    if (histogram === undefined) {
      histogram = {
        name,
        labels,
        key,
        buckets: DEFAULT_BUCKETS,
        counts: new Array<number>(DEFAULT_BUCKETS.length).fill(0),
        sum: 0,
        count: 0,
      };
      family.histograms.set(key, histogram);
    }

    histogram.sum += seconds;
    histogram.count += 1;

    for (let index = 0; index < histogram.buckets.length; index += 1) {
      const bound = histogram.buckets[index] ?? Number.POSITIVE_INFINITY;

      if (seconds <= bound) {
        histogram.counts[index] = (histogram.counts[index] ?? 0) + 1;
      }
    }
  }

  /** Declare a metric's help text. Optional; an undeclared metric renders bare. */
  describe(name: string, help: string): void {
    const family = this.#families.get(name);

    if (family) {
      // Help text is not part of the series identity, so this is safe to call more
      // than once. It is intentionally not an error: two components instrumenting
      // the same counter should be able to describe it without coordinating.
      (family as { help: string }).help = help;
      return;
    }

    this.ensure(name, 'counter', help);
  }

  /** Declare a metric's type without creating a series for it. */
  ensure(name: string, type: MetricType, help = ''): void {
    this.#ensureFamily(name, type, help);
  }

  /** Read one series, for tests and assertions. Returns null when absent. */
  value(name: string, labels: Labels = {}): number | null {
    return this.#families.get(name)?.series.get(labelKey(labels))?.value ?? null;
  }

  /** Sum across every series of a metric. For counters that only ever grow. */
  total(name: string): number {
    const family = this.#families.get(name);

    if (!family) {
      return 0;
    }

    let sum = 0;
    for (const series of family.series.values()) {
      sum += series.value;
    }
    return sum;
  }

  /** Distinct label combinations currently held for a metric. */
  seriesCount(name: string): number {
    return this.#families.get(name)?.series.size ?? 0;
  }

  /** How many observations were refused for exceeding the cardinality cap. */
  get cardinalityOverflows(): number {
    return this.#cardinalityOverflows;
  }

  /**
   * Render the Prometheus text exposition format.
   *
   * Series are emitted in a stable order so two scrapes of identical state produce
   * byte-identical output. A diffable scrape is worth more than it sounds when the
   * alternative is a monitoring system that reports a change every time it restarts.
   */
  render(): string {
    const lines: string[] = [];

    for (const name of [...this.#families.keys()].sort()) {
      const family = this.#families.get(name);

      if (family === undefined) {
        continue;
      }

      // A metric with no series carries no information, and emitting a HELP/TYPE
      // pair with nothing under it makes a scrape look like a collection failure.
      if (family.series.size === 0 && family.histograms.size === 0) {
        continue;
      }

      if (family.help !== '') {
        lines.push(`# HELP ${name} ${escapeHelp(family.help)}`);
      }

      lines.push(`# TYPE ${name} ${family.type}`);

      for (const key of [...family.series.keys()].sort()) {
        const series = family.series.get(key);

        if (series === undefined) {
          continue;
        }

        lines.push(`${name}${renderLabels(key)} ${renderValue(series.value)}`);
      }

      for (const key of [...family.histograms.keys()].sort()) {
        const histogram = family.histograms.get(key);

        if (histogram === undefined) {
          continue;
        }

        lines.push(...renderHistogram(histogram));
      }
    }

    // Nothing to say is an empty string rather than a bare newline. A scraper is
    // indifferent, but a file or a shell pipeline is not.
    if (lines.length === 0) {
      return '';
    }

    return `${lines.join('\n')}\n`;
  }

  /**
   * Names of metrics that hit their cardinality cap.
   *
   * Reported at startup and in the log rather than silently tolerated: a metric that
   * started collapsing into `<overflow>` has stopped being measurable, and nobody
   * should discover that from a dashboard.
   */
  overflowedMetrics(): string[] {
    const names: string[] = [];

    for (const family of this.#families.values()) {
      if (family.overflowed) {
        names.push(family.name);
      }
    }

    return names.sort();
  }

  #ensureFamily(name: string, type: MetricType, help: string): MetricFamily {
    const existing = this.#families.get(name);

    if (existing) {
      if (existing.type !== type) {
        // Silently changing a counter into a gauge makes every rate() over it wrong,
        // and the symptom appears in a dashboard rather than here.
        throw new Error(
          `Metric "${name}" was declared as ${existing.type} and cannot be re-declared as ${type}.`,
        );
      }

      return existing;
    }

    const family: MetricFamily = {
      name,
      help,
      type,
      series: new Map(),
      histograms: new Map(),
      seenKeys: new Set(),
      overflowed: false,
    };

    this.#families.set(name, family);
    return family;
  }

  /**
   * Decide whether a label combination may be stored.
   *
   * @returns the key to use, or null when the combination was refused.
   */
  #admitKey(family: MetricFamily, key: string): string | null {
    if (family.seenKeys.has(key)) {
      return key;
    }

    if (family.seenKeys.size >= this.#labelLimit) {
      family.seenKeys.add(key);
      family.overflowed = true;
      this.#cardinalityOverflows += 1;

      return null;
    }

    family.seenKeys.add(key);
    return key;
  }

  #seriesFor(name: string, type: 'counter' | 'gauge', labels: Labels): Series {
    const family = this.#ensureFamily(name, type, '');
    const key = this.#admitKey(family, labelKey(labels));

    if (key === null) {
      // Refused. Return a throwaway so the caller does not have to handle null. It is
      // never stored, so the increment is simply lost, and the overflow counter is
      // what makes that visible.
      return { name, labels, key: '', value: 0 };
    }

    const existing = family.series.get(key);

    if (existing) {
      return existing;
    }

    const series: Series = { name, labels, key, value: 0 };
    family.series.set(key, series);
    return series;
  }
}

/** Escape a HELP line. Only a backslash needs it; newlines would split the scrape. */
function escapeHelp(help: string): string {
  return help.replace(/\\/gu, '\\\\').replace(/\n/gu, ' ');
}

function renderLabels(_key: string): string {
  // The key IS the rendered label set, complete with escaping, so there is no second
  // representation to keep in sync with the first.
  return _key === '' ? '' : `{${_key}}`;
}

function renderHistogram(histogram: HistogramSeries): string[] {
  const lines: string[] = [];
  const base = histogram.labels;
  const suffix = labelKey(base);

  for (let index = 0; index < histogram.buckets.length; index += 1) {
    const bound = histogram.buckets[index] ?? 0;
    const isLast = index === histogram.buckets.length - 1;
    // The bound is CONFIGURATION, not a measurement, so it gets the compact
    // representation: `le="0.005"`, not `le="0.005000"`. Both parse, but a label full
    // of trailing zeroes is a label nobody can read in a dashboard legend.
    const leLabels = isLast ? suffix : mergeLe(suffix, bound);

    lines.push(
      `${histogram.name}_bucket${leLabels === '' ? '{le="+Inf"}' : `{${leLabels}}`} ${
        histogram.counts[index] ?? 0
      }`,
    );
  }

  lines.push(`${histogram.name}_sum${renderLabels(suffix)} ${renderValue(histogram.sum)}`);
  lines.push(`${histogram.name}_count${renderLabels(suffix)} ${histogram.count}`);

  return lines;
}

/** Add `le` to an existing rendered label set. */
function mergeLe(suffix: string, bound: number): string {
  const rendered = String(bound);

  if (suffix === '') {
    return `le="${rendered}"`;
  }

  // `le` last, which is the conventional order and keeps the sort stable.
  return `${suffix},le="${rendered}"`;
}
