/**
 * Unit tests for the write-failure decision.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS NEEDS ITS OWN FILE
 * ---------------------------------------------------------------------------
 * The two counters T3 asks for are incremented in here rather than at the call sites, and the
 * two behaviours are different: one is a quota decision the user must see, the other is a crash
 * they cannot act on. Testing that split needs a fake relay and a fake logger, and asserting it
 * through `index.ts` would mean standing up the whole server with a one-element document cap.
 */

import { describe, expect, it } from 'vitest';

import { DocumentTooLargeError } from './db.js';
import { M } from './observability/index.js';
import { Metrics } from './observability/metrics.js';
import { Logger } from './observability/logger.js';
import { reportWriteFailure, type RefusalSink } from './writeFailure.js';

interface Recorded {
  readonly site: string;
  readonly code: string;
  readonly message: string;
}

function fakeRelay(): RefusalSink & { readonly sent: Recorded[] } {
  const sent: Recorded[] = [];

  return {
    sent,
    reportRefusal(site, code, message) {
      sent.push({ site, code, message });
      return true;
    },
  };
}

describe('reportWriteFailure', () => {
  it('tells the client, by site, when a document is full', () => {
    const metrics = new Metrics();
    const relay = fakeRelay();

    const wasQuota = reportWriteFailure(
      new DocumentTooLargeError('doc-1', 1_000_000),
      'doc-1',
      'site-a',
      relay,
      metrics,
      Logger.silent(),
    );

    expect(wasQuota).toBe(true);
    expect(relay.sent).toHaveLength(1);
    expect(relay.sent[0]?.site).toBe('site-a');
    expect(relay.sent[0]?.code).toBe('DOCUMENT_TOO_LARGE');
    // The message names the limit, so an operator reading the client log can match it to the
    // configured number without going back to the environment.
    expect(relay.sent[0]?.message).toContain('1000000');
  });

  it('counts the refusal, so a full document is visible in a scrape', () => {
    const metrics = new Metrics();

    reportWriteFailure(
      new DocumentTooLargeError('doc-1', 10),
      'doc-1',
      'site-a',
      fakeRelay(),
      metrics,
      Logger.silent(),
    );
    reportWriteFailure(
      new DocumentTooLargeError('doc-1', 10),
      'doc-1',
      'site-a',
      fakeRelay(),
      metrics,
      Logger.silent(),
    );

    expect(metrics.render()).toContain(`${M.documentsTooLarge} 2`);
  });

  it('says deletion still works, because that is the way out', () => {
    // The message is the only place a user learns the document is recoverable. Without it,
    // "at its limit" reads as "your work is gone", and the reasonable response to that is to
    // stop trusting the application.
    const relay = fakeRelay();

    reportWriteFailure(
      new DocumentTooLargeError('doc-9', 5),
      'doc-9',
      'site-b',
      relay,
      new Metrics(),
      Logger.silent(),
    );

    expect(relay.sent[0]?.message).toMatch(/delet/iu);
  });

  it('does NOT tell the client about an unexpected failure', () => {
    // A client cannot act on "the database fell over", and telling it so would replace a clear
    // line in the server log with a vague one in the UI.
    const relay = fakeRelay();

    const wasQuota = reportWriteFailure(
      new Error('connection terminated unexpectedly'),
      'doc-1',
      'site-a',
      relay,
      new Metrics(),
      Logger.silent(),
    );

    expect(wasQuota).toBe(false);
    expect(relay.sent).toEqual([]);
  });

  it('does not count an unexpected failure as a quota event', () => {
    const metrics = new Metrics();

    reportWriteFailure(new Error('boom'), 'doc-1', 'site-a', fakeRelay(), metrics, Logger.silent());

    // Absence of a sample, not a zero: see the note in limits.e2e.test.ts about how a
    // Prometheus counter with no increments renders.
    expect(metrics.render()).not.toContain(`${M.documentsTooLarge} `);
  });

  it('carries the custom label and extra fields through to the log', () => {
    // The encrypted path uses this, and its log line has to stay distinguishable from the
    // plaintext one - "could not persist" on an encrypted document nearly always means the mode
    // guard fired, and the two need to be told apart in an incident.
    const relay = fakeRelay();
    let logged: Record<string, unknown> | undefined;

    const logger = {
      error: (message: string, fields?: Record<string, unknown>) => {
        logged = { message, ...fields };
      },
    } as unknown as Logger;

    reportWriteFailure(new Error('boom'), 'doc-2', 'site-a', relay, new Metrics(), logger, {
      label: 'could not persist encrypted frames',
      extra: { frames: 3 },
    });

    expect(logged?.['message']).toBe('could not persist encrypted frames');
    expect(logged?.['frames']).toBe(3);
    expect(logged?.['document']).toBe('doc-2');
  });
});
