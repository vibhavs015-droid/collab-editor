/**
 * Turning a persistence failure into something the client can act on.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ITS OWN MODULE
 * ---------------------------------------------------------------------------
 * It was inline in `index.ts` first. That put the metric increment and the error-frame decision
 * behind `main()`, which is unreachable from a test: there is no way to start the process with a
 * one-element document cap and a real socket without standing up the whole server.
 *
 * So the decision moved out, and `main()` calls it. Nothing about the behaviour changed; what
 * changed is that a quota decision is now something a test can watch rather than something a
 * code reviewer has to take on trust.
 */

import { DocumentTooLargeError } from './db.js';
import { M } from './observability/index.js';
import type { Logger } from './observability/logger.js';
import type { Metrics } from './observability/metrics.js';

/** The minimum Relay needs for this, so a test can pass a stub instead of a whole relay. */
export interface RefusalSink {
  reportRefusal(site: string, code: 'DOCUMENT_TOO_LARGE', message: string): boolean;
}

export interface WriteFailureOptions {
  /** Log line for anything that is not a quota decision. */
  readonly label?: string;
  /** Extra fields for that log line. */
  readonly extra?: Record<string, unknown>;
}

/**
 * Report a failed write.
 *
 * Two shapes, and the split is the whole point:
 *
 *   - `DocumentTooLargeError` is EXPECTED and RECOVERABLE. The document is full, growth is
 *     refused, and deleting from it still works. So it gets a named error frame the client can
 *     display, a counter, and a warning rather than an error. Treating a quota decision as an
 *     incident buries it under noise; treating it as silently ignorable leaves a user typing
 *     into a document that is throwing their edits away.
 *   - Anything else is genuinely unexpected, and gets no frame. A client cannot act on "the
 *     database fell over", and telling it so would replace a clear error in the log with a
 *     vague one in the UI.
 *
 * @returns true when the failure was a quota refusal, so a caller can tell the two apart.
 */
export function reportWriteFailure(
  error: unknown,
  documentId: string,
  site: string,
  relay: RefusalSink,
  metrics: Metrics,
  logger: Logger,
  options: WriteFailureOptions = {},
): boolean {
  if (error instanceof DocumentTooLargeError) {
    metrics.increment(M.documentsTooLarge);

    logger.warn('document refused: at its element limit', {
      document: documentId,
      limit: error.limit,
    });

    relay.reportRefusal(
      site,
      'DOCUMENT_TOO_LARGE',
      `This document is at its ${error.limit} character limit. Deleting from it still works.`,
    );

    return true;
  }

  logger.error(options.label ?? 'could not persist', {
    document: documentId,
    ...options.extra,
    error,
  });

  return false;
}
