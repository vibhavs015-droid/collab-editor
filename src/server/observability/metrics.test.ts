/**
 * Metric registry tests.
 *
 * The rendering is the part that matters: output that Prometheus cannot parse looks
 * like a working monitoring system right up until someone needs it. So these tests
 * assert on exact output, not just on numbers.
 *
 * NOTE ON ENCODING: ASCII only. See src/core/crdt/rga.ts.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_BUCKETS, Metrics, OVERFLOW_LABEL } from './metrics.js';

describe('counters', () => {
  it('accumulates', () => {
    const metrics = new Metrics();

    metrics.increment('a');
    metrics.increment('a');
    metrics.increment('a', {}, 3);

    expect(metrics.value('a')).toBe(5);
    expect(metrics.total('a')).toBe(5);
  });

  it('reads back as absent rather than zero before it is touched', () => {
    // A counter that reports 0 before it has ever fired makes "no data" and "no
    // events" indistinguishable on a dashboard.
    expect(new Metrics().value('never_touched')).toBeNull();
  });

  it('keeps separate series per label combination', () => {
    const metrics = new Metrics();

    metrics.increment('ops_total', { kind: 'insert' });
    metrics.increment('ops_total', { kind: 'delete' });
    metrics.increment('ops_total', { kind: 'insert' });

    expect(metrics.value('ops_total', { kind: 'insert' })).toBe(2);
    expect(metrics.value('ops_total', { kind: 'delete' })).toBe(1);
    expect(metrics.seriesCount('ops_total')).toBe(2);
  });

  it('treats label order as irrelevant', () => {
    const metrics = new Metrics();

    metrics.increment('ops_total', { a: '1', b: '2' });
    metrics.increment('ops_total', { b: '2', a: '1' });

    // Two identical label sets are one series. Rendering them separately would make
    // the same measurement look like two different things.
    expect(metrics.seriesCount('ops_total')).toBe(1);
    expect(metrics.value('ops_total', { a: '1', b: '2' })).toBe(2);
  });
});

describe('gauges', () => {
  it('sets and moves', () => {
    const metrics = new Metrics();
    metrics.ensure('connections', 'gauge');

    metrics.set('connections', {}, 5);
    expect(metrics.value('connections')).toBe(5);

    metrics.add('connections', {}, -2);
    expect(metrics.value('connections')).toBe(3);
  });

  it('can go negative, which a cumulative counter cannot', () => {
    const metrics = new Metrics();
    metrics.ensure('delta', 'gauge');

    metrics.add('delta', {}, 1);
    metrics.add('delta', {}, -3);

    expect(metrics.value('delta')).toBe(-2);
  });

  it('clears a series when it no longer applies', () => {
    // Rooms disappear. A gauge for a room that no longer exists would report a
    // connection that is not there, forever.
    const metrics = new Metrics();
    metrics.ensure('rooms', 'gauge');

    metrics.set('rooms', { doc: 'a' }, 2);
    metrics.clear('rooms', { doc: 'a' });

    expect(metrics.value('rooms', { doc: 'a' })).toBeNull();
  });
});

describe('label cardinality', () => {
  it('refuses new combinations past the cap and counts the refusals', () => {
    // The accident this defends against: someone labels a metric with a raw document
    // id, and forty thousand documents become forty thousand time series.
    const metrics = new Metrics({ labelLimit: 3 });

    for (let index = 0; index < 10; index += 1) {
      metrics.increment('requests_total', { doc: `doc-${index}` });
    }

    expect(metrics.seriesCount('requests_total')).toBe(3);
    expect(metrics.cardinalityOverflows).toBe(7);
  });

  it('keeps counting combinations it already admitted', () => {
    // The refusal must not break a metric that is working. Losing increments on an
    // admitted series would be worse than the problem being solved.
    const metrics = new Metrics({ labelLimit: 1 });

    metrics.increment('requests_total', { doc: 'a' });
    metrics.increment('requests_total', { doc: 'a' });
    metrics.increment('requests_total', { doc: 'b' });

    expect(metrics.value('requests_total', { doc: 'a' })).toBe(2);
  });

  it('exports the overflow label so callers can fold deliberately', () => {
    expect(OVERFLOW_LABEL).toBe('<overflow>');
  });
});

describe('type conflicts', () => {
  it('refuses to re-declare a counter as a gauge', () => {
    const metrics = new Metrics();
    metrics.increment('things');

    // Silently changing type makes every rate() over the metric wrong, and the
    // symptom shows up in a dashboard rather than at the mistake.
    expect(() => metrics.ensure('things', 'gauge')).toThrow(/cannot be re-declared/u);
  });

  it('allows re-declaring the same type', () => {
    const metrics = new Metrics();
    metrics.increment('things');
    metrics.describe('things', 'Things that happened.');

    expect(() => metrics.ensure('things', 'counter')).not.toThrow();
  });
});

describe('help text', () => {
  it('emits HELP and TYPE', () => {
    const metrics = new Metrics();
    metrics.ensure('things_total', 'counter', 'How many things happened.');
    metrics.increment('things_total');

    const output = metrics.render();

    expect(output).toContain('# HELP things_total How many things happened.');
    expect(output).toContain('# TYPE things_total counter');
  });

  it('replaces a newline, which would otherwise split the scrape', () => {
    const metrics = new Metrics();
    metrics.ensure('things_total', 'counter', 'Line one.\nLine two.');
    metrics.increment('things_total');

    const output = metrics.render();

    // Exactly one HELP line for this metric, not two.
    expect(output.split('\n').filter((line) => line.startsWith('# HELP'))).toHaveLength(1);
  });
});

describe('label escaping', () => {
  it('escapes quotes and backslashes', () => {
    const metrics = new Metrics();
    metrics.increment('m', { path: '/a"b\\c' });

    expect(metrics.render()).toContain('m{path="/a\\"b\\\\c"} 1');
  });

  it('escapes a newline so it cannot break the format', () => {
    const metrics = new Metrics();
    metrics.increment('m', { note: 'a\nb' });

    const output = metrics.render();
    const sampleLines = output.split('\n').filter((line) => line.startsWith('m{'));

    // One sample line, not two.
    expect(sampleLines).toHaveLength(1);
    expect(output).toContain('note="a\\nb"');
  });

  it('renders a metric with no labels bare', () => {
    const metrics = new Metrics();
    metrics.increment('bare_total', {}, 4);

    expect(metrics.render()).toContain('bare_total 4');
  });
});

describe('value rendering', () => {
  it('keeps integers integral', () => {
    const metrics = new Metrics();
    metrics.increment('m', {}, 3);

    expect(metrics.render()).toContain('m 3');
  });

  it('renders fractions with fixed precision', () => {
    const metrics = new Metrics();
    metrics.ensure('m', 'gauge');
    metrics.set('m', {}, 1 / 3);

    expect(metrics.render()).toContain('m 0.333333');
  });

  it('renders a non-finite value as zero rather than breaking the scrape', () => {
    // NaN or Infinity in a sample makes the whole exposition unparseable, which turns
    // one bad gauge into a monitoring outage.
    const metrics = new Metrics();
    metrics.ensure('m', 'gauge');

    metrics.set('m', {}, Number.NaN);
    metrics.set('n', {}, Number.POSITIVE_INFINITY);

    const output = metrics.render();

    expect(output).toContain('m 0');
    expect(output).toContain('n 0');
    expect(output).not.toContain('NaN');
    expect(output).not.toContain('Infinity');
  });
});

describe('histograms', () => {
  it('cumulatively counts buckets', () => {
    const metrics = new Metrics();
    metrics.ensure('latency_seconds', 'histogram');

    metrics.observe('latency_seconds', {}, 0.004);
    metrics.observe('latency_seconds', {}, 0.2);

    const output = metrics.render();

    // Prometheus buckets are cumulative: le="0.005" counts everything at or under it.
    expect(output).toContain('latency_seconds_bucket{le="0.005"} 1');
    expect(output).toContain('latency_seconds_bucket{le="0.25"} 2');
    expect(output).toContain('latency_seconds_bucket{le="+Inf"} 2');
    expect(output).toContain('latency_seconds_count 2');
  });

  it('sums observations', () => {
    const metrics = new Metrics();
    metrics.ensure('latency_seconds', 'histogram');

    metrics.observe('latency_seconds', {}, 0.5);
    metrics.observe('latency_seconds', {}, 1.5);

    // Exactly 2, rendered as an integer because the sum happens to be whole. Both
    // `2` and `2.000000` are valid samples; the registry keeps integers integral
    // everywhere rather than special-casing one field.
    expect(metrics.render()).toContain('latency_seconds_sum 2');
  });

  it('keeps label sets on every emitted line', () => {
    const metrics = new Metrics();
    metrics.ensure('latency_seconds', 'histogram');
    metrics.observe('latency_seconds', { route: '/api/health' }, 0.01);

    const output = metrics.render();

    // A bucket without its labels is a different series, and the sum and count losing
    // them makes them unattributable.
    expect(output).toContain('latency_seconds_bucket{route="/api/health",le="0.025"} 1');
    expect(output).toContain('latency_seconds_count{route="/api/health"} 1');
    expect(output).toContain('latency_seconds_sum{route="/api/health"} 0.010000');
  });

  it('covers the full range up to +Inf', () => {
    const metrics = new Metrics();
    metrics.ensure('latency_seconds', 'histogram');
    metrics.observe('latency_seconds', {}, 999);

    const output = metrics.render();
    const buckets = output.split('\n').filter((line) => line.includes('_bucket'));

    expect(buckets).toHaveLength(DEFAULT_BUCKETS.length);
    // Anything that fits no bucket still lands in +Inf, so no observation is lost.
    expect(output).toContain('latency_seconds_bucket{le="+Inf"} 1');
    expect(output).toContain('latency_seconds_count 1');
  });

  it('records values with no labels without adding braces', () => {
    const metrics = new Metrics();
    metrics.ensure('latency_seconds', 'histogram');
    metrics.observe('latency_seconds', {}, 0.001);

    expect(metrics.render()).toContain('latency_seconds_bucket{le="0.001"} 1');
    expect(metrics.render()).toContain('latency_seconds_count 1');
  });
});

describe('rendering', () => {
  it('is stable across calls with identical state', () => {
    // A scrape that reorders itself between identical calls makes every diff noisy,
    // which is how people stop reading them.
    const metrics = new Metrics();
    metrics.ensure('b_total', 'counter');
    metrics.ensure('a_total', 'counter');
    metrics.ensure('latency_seconds', 'histogram');

    metrics.increment('b_total', { x: '2' });
    metrics.increment('a_total', { x: '1' });
    metrics.observe('latency_seconds', { r: 'x' }, 0.01);

    const first = metrics.render();
    const second = metrics.render();

    expect(first).toBe(second);
  });

  it('orders metric families by name', () => {
    const metrics = new Metrics();
    metrics.increment('zebra');
    metrics.increment('apple');

    const names = metrics
      .render()
      .split('\n')
      .filter((line) => line.startsWith('# TYPE'))
      .map((line) => line.split(' ')[2]);

    expect(names).toEqual(['apple', 'zebra']);
  });

  it('omits a family that was declared but never used', () => {
    const metrics = new Metrics();
    metrics.ensure('never_used_total', 'counter', 'Declared but untouched.');

    // A HELP/TYPE pair with no samples under it reads as a collection failure.
    expect(metrics.render()).toBe('');
  });

  it('ends with a newline', () => {
    const metrics = new Metrics();
    metrics.increment('m');

    expect(metrics.render().endsWith('\n')).toBe(true);
  });

  it('renders an empty registry as nothing', () => {
    expect(new Metrics().render()).toBe('');
  });

  it('reports which metric hit its cardinality cap', () => {
    // Worth naming rather than counting alone: a metric that started collapsing into
    // `<overflow>` has stopped being measurable, and the only clue is which one.
    const metrics = new Metrics({ labelLimit: 1 });
    metrics.increment('requests_total', { doc: 'a' });
    metrics.increment('requests_total', { doc: 'b' });
    metrics.increment('ops_total', { doc: 'a' });

    expect(metrics.overflowedMetrics()).toEqual(['requests_total']);
  });

  it('accepts an amount that would make a gauge go backwards', () => {
    // Counters that decrease break rate(). The registry does not stop it; the test
    // documents that the responsibility is the caller's, which is why every metric
    // has an explicit type.
    const metrics = new Metrics();
    metrics.ensure('c', 'counter');

    metrics.increment('c', {}, -1);

    expect(metrics.render()).toContain('c -1');
  });
});
