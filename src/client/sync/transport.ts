/**
 * Client-side sync transport.
 *
 * Owns the WebSocket connection and nothing else. It does not merge, does not
 * reorder, and does not interpret operations: it sends what the editor produced
 * and hands inbound operations to whoever subscribed. Every decision about what
 * those operations mean belongs to the CRDT, which is already proven correct by
 * src/core/crdt/convergence.test.ts.
 *
 * ── Reconnection ─────────────────────────────────────────────────────────
 * A collaborative editor reconnects constantly: laptops sleep, phones change
 * network, deploys restart the server. The loop here is exponential backoff with
 * jitter, because without jitter every client disconnected by a server restart
 * would return in the same millisecond and knock it over again. That is the
 * thundering-herd failure, and it is entirely preventable.
 */

import { parseOperations } from '../../shared/operation-validation.js';
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
  type SnapshotMessage,
} from '../../shared/protocol.js';
import type { JsonValue } from '../../shared/protocol.js';
import type { Operation } from '../../core/crdt/rga.js';

export type ConnectionState = 'connecting' | 'open' | 'closed';

/** A baseline the client must adopt, because it is too far behind for a delta. */
export interface Baseline {
  /** Live elements at the snapshot's sequence. */
  readonly elements: readonly JsonValue[];
  /** Operations recorded after the snapshot. */
  readonly ops: readonly Operation[];
  readonly seq: number;
}

export interface TransportHandlers {
  /** Inbound operations, already decoded by the server envelope. */
  onOps: (ops: readonly Operation[]) => void;
  /**
   * A baseline to adopt, because this client is below the compaction floor.
   *
   * Called only when the outbox is EMPTY. A client holding unsent operations must
   * never be handed one: a baseline replaces the document, so applying it would
   * discard work the user believes is saved. The transport refuses rather than
   * relying on every caller to check, because the failure would be silent.
   */
  onBaseline: (baseline: Baseline) => void;
  onPresence: (cursors: Readonly<Record<string, number>>) => void;
  onSyncState: (state: 'synced' | 'pending' | 'offline' | 'error', pendingOps: number) => void;
  onWelcome: (site: string) => void;
  onError: (code: string, message: string) => void;
  onStateChange: (state: ConnectionState, attempt: number) => void;
}

/**
 * How many times a baseline may be refused before the client gives up.
 *
 * A client whose operations the server keeps rejecting would otherwise resync
 * forever. Three is enough for a transient flush failure and not enough to hide a
 * genuine disagreement.
 */
const MAX_BASELINE_RETRIES = 3;

export interface TransportOptions {
  readonly documentId: string;
  readonly url: string;
  readonly handlers: TransportHandlers;
  /** Injected for tests so timing does not have to be real. */
  readonly socketFactory?: (url: string) => WebSocket;
  readonly baseRetryMs?: number;
  readonly maxRetryMs?: number;
  /** Max operations buffered while disconnected before the oldest are dropped. */
  readonly maxQueuedOps?: number;
  /**
   * Log sequence this client already holds when the transport is created.
   *
   * Persisted next to the operation log so a reload resumes rather than
   * re-downloading the document. Defaults to 0, which is correct and merely
   * slower for a fresh client.
   */
  readonly initialSeq?: number;
}

export class SyncTransport {
  readonly #url: string;
  readonly #documentId: string;
  readonly #handlers: TransportHandlers;
  readonly #socketFactory: (url: string) => WebSocket;
  readonly #baseRetryMs: number;
  readonly #maxRetryMs: number;
  readonly #maxQueuedOps: number;

  #socket: WebSocket | null = null;
  #state: ConnectionState = 'closed';
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Deliberately not cleared on disconnect: these are local edits awaiting relay. */
  #outbox: Operation[] = [];
  /**
   * Highest server sequence this client holds.
   *
   * Advanced only after inbound operations have been handed to the CRDT, never
   * before. Advancing first would mean a crash between the two loses exactly the
   * operations the client promised the server it already had.
   */
  #seq: number;
  /** Set while disconnect is intentional, so no reconnect is scheduled. */
  #closedByUser = false;
  #disposed = false;
  /**
   * How many times a baseline has been refused because the outbox is not empty.
   *
   * Bounded so a client whose operations the server keeps rejecting cannot
   * resync forever. Three is enough for a transient flush failure and not enough to
   * hide a genuine disagreement.
   */
  #baselineRetries = 0;

  constructor(options: TransportOptions) {
    this.#url = options.url;
    this.#documentId = options.documentId;
    this.#handlers = options.handlers;
    this.#baseRetryMs = options.baseRetryMs ?? 500;
    this.#maxRetryMs = options.maxRetryMs ?? 15_000;
    this.#maxQueuedOps = options.maxQueuedOps ?? 5_000;
    this.#socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
    this.#seq = options.initialSeq ?? 0;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  get queuedOperationCount(): number {
    return this.#outbox.length;
  }

  /** Highest log sequence this client has been told it holds. */
  get serverSeq(): number {
    return this.#seq;
  }

  connect(): void {
    if (this.#disposed || this.#state === 'connecting' || this.#state === 'open') {
      return;
    }

    this.#closedByUser = false;
    this.#setState('connecting');

    let socket: WebSocket;

    try {
      socket = this.#socketFactory(this.#url);
    } catch {
      // A factory that throws (bad URL, blocked by policy) must not leave the UI
      // stuck in 'connecting' forever.
      this.#setState('closed');
      this.#scheduleRetry();
      return;
    }

    this.#socket = socket;

    socket.onopen = () => {
      this.#attempt = 0;
      this.#setState('open');
      this.#send({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        token: 'phase-3-no-auth',
        documentId: this.#documentId,
        // `#seq` is what the SERVER has numbered, not what this client has typed. Queued
        // local operations have no server sequence yet, so claiming them here would
        // ask the server to skip operations this client has never seen.
        lastAppliedSeq: this.#seq,
      });
      this.#flushOutbox();
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      this.#receive(event.data);
    };

    socket.onerror = () => {
      // 'error' is always followed by 'close', which drives the retry. Handling
      // it here would double-schedule.
    };

    socket.onclose = () => {
      this.#socket = null;

      if (this.#disposed || this.#closedByUser) {
        this.#setState('closed');
        return;
      }

      this.#setState('closed');
      this.#handlers.onSyncState('offline', this.#outbox.length);
      this.#scheduleRetry();
    };
  }

  /**
   * Close the connection and stop reconnecting.
   *
   * Queued operations are deliberately discarded: the caller owns document
   * persistence, and holding operations in memory after teardown would leak them
   * when the page unloads.
   */
  disconnect(): void {
    this.#closedByUser = true;

    if (this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }

    this.#socket?.close();
    this.#socket = null;
    this.#outbox = [];
    this.#setState('closed');
  }

  /** Permanent shutdown. Used on page teardown and in tests. */
  dispose(): void {
    this.#disposed = true;
    this.disconnect();
  }

  /** Send operations to peers, queueing them if currently offline. */
  send(ops: readonly Operation[]): void {
    if (ops.length === 0) {
      return;
    }

    this.#outbox.push(...ops);

    if (this.#outbox.length > this.#maxQueuedOps) {
      // Drop the oldest rather than growing without bound. Local edits are
      // durable in the CRDT and in local storage; the relay only needs a
      // reasonable tail to bring peers current.
      this.#outbox = this.#outbox.slice(-this.#maxQueuedOps);
    }

    if (this.#state === 'open') {
      this.#flushOutbox();
    } else {
      this.#handlers.onSyncState('pending', this.#outbox.length);
    }
  }

  /** Announce this client's cursor position to peers. */
  sendPresence(cursor: number | null, selectedLength: number): void {
    if (this.#state !== 'open') {
      return;
    }

    this.#send({
      type: 'presence',
      documentId: this.#documentId,
      cursor,
      selectedLength,
    });
  }

  /** A baseline the client must adopt, because it is too far behind for a delta. */
  requestResync(): void {
    if (this.#state !== 'open') {
      return;
    }

    // The cursor travels with the request. A reconnect opens a new socket, and a
    // server-side per-connection cache would not survive that.
    this.#send({ type: 'resync', documentId: this.#documentId, sinceSeq: this.#seq });
  }

  /**
   * Push whatever is queued, right now.
   *
   * Used on page unload. Best effort, and the transport is honest about that: a
   * browser may discard a WebSocket frame sent during teardown, so this is a latency
   * optimisation rather than a durability mechanism. Nothing is lost if it fails,
   * because every queued operation is already in the durable local log.
   *
   * @returns true when the queue was empty or fully handed to the socket.
   */
  flushNow(): boolean {
    if (this.#outbox.length === 0) {
      return true;
    }

    if (this.#state !== 'open') {
      return false;
    }

    this.#flushOutbox();
    return this.#outbox.length === 0;
  }

  /**
   * Hand everything queued to the socket.
   *
   * The outbox is cleared only after the frame is actually accepted. That ordering
   * matters: the transport's own state can say `open` while the socket underneath
   * is already gone — a browser has not yet fired `close` on a connection the
   * network has dropped. Clearing first would drop the user's keystrokes on the
   * floor, silently, in exactly the window where the server is unreachable and
   * they are most needed.
   */
  #flushOutbox(): void {
    if (this.#outbox.length === 0 || this.#state !== 'open') {
      return;
    }

    const batch = this.#outbox;

    if (!this.#send({ type: 'ops', documentId: this.#documentId, ops: batch })) {
      // Kept queued. The reconnect path flushes it, and the indicator keeps
      // reporting them as pending.
      return;
    }

    this.#outbox = [];
    this.#handlers.onSyncState('synced', 0);
  }

  #receive(raw: string): void {
    let parsed: ServerMessage;

    try {
      parsed = JSON.parse(raw) as ServerMessage;
    } catch {
      this.#handlers.onError('BAD_RESPONSE', 'Server sent a malformed frame.');
      return;
    }

    if (typeof parsed !== 'object' || parsed === null || typeof parsed.type !== 'string') {
      this.#handlers.onError('BAD_RESPONSE', 'Server sent an unrecognised frame.');
      return;
    }

    switch (parsed.type) {
      case 'welcome':
        this.#handlers.onWelcome(parsed.site);
        return;
      case 'ops':
        // Operations arrive as opaque JSON. parseOperations is the real narrowing
        // step; a cast here would be a lie the compiler is right to reject.
        this.#handlers.onOps(parseOperations(parsed.ops));
        return;
      case 'snapshot':
        this.#receiveBaseline(parsed);
        return;
      case 'presence':
        this.#handlers.onPresence(parsed.cursors);
        return;
      case 'syncState':
        // The server's sequence is authoritative and only ever moves forward. A
        // stale frame arriving after a newer one must not walk the cursor back and
        // force a pointless re-replay.
        if (parsed.seq > this.#seq) {
          this.#seq = parsed.seq;
        }
        this.#handlers.onSyncState(parsed.state, parsed.pendingOps);
        return;
      case 'error':
        this.#handlers.onError(parsed.code, parsed.message);
        return;
      default:
        return;
    }
  }

  /**
   * Handle a baseline the server sent because this client is below the floor.
   *
   * The refusal is the important part. A baseline REPLACES the document, so
   * applying one while holding unsent operations would discard work the user
   * believes is saved — and nothing would report it, because the client's own log
   * would look consistent right up until the next reload.
   *
   * So: flush first, then ask again. The retry is bounded, and a client that
   * genuinely cannot empty its outbox reports an error rather than discarding
   * anything.
   */
  #receiveBaseline(message: SnapshotMessage): void {
    if (this.#outbox.length > 0) {
      if (!this.#stateIsOpen()) {
        // Cannot flush while disconnected. Retry once the socket is back; the
        // reconnect path re-sends `hello`, which triggers a fresh catch-up.
        return;
      }

      if (this.#baselineRetries >= MAX_BASELINE_RETRIES) {
        this.#handlers.onError(
          'BASELINE_REFUSED',
          'Cannot adopt the server baseline while unsent operations are queued.',
        );
        return;
      }

      this.#baselineRetries += 1;
      this.#flushOutbox();
      // Deliberate: the outbox is only marked empty optimistically, so this is a
      // second request rather than an assumption that the flush landed.
      this.#send({ type: 'resync', documentId: this.#documentId, sinceSeq: this.#seq });
      return;
    }

    this.#baselineRetries = 0;

    if (typeof message.seq === 'number' && message.seq > this.#seq) {
      this.#seq = message.seq;
    }

    this.#handlers.onBaseline({
      elements: message.elements,
      ops: parseOperations(message.ops),
      seq: message.seq,
    });
  }

  #stateIsOpen(): boolean {
    return this.#state === 'open';
  }

  /**
   * Write one frame.
   *
   * @returns false when there was no usable socket, so the caller can keep its
   *   work queued rather than assume it was delivered.
   */
  #send(message: ClientMessage): boolean {
    if (this.#state !== 'open' || !this.#socket || this.#socket.readyState !== 1) {
      return false;
    }

    this.#socket.send(JSON.stringify(message));
    return true;
  }

  /**
   * Exponential backoff with full jitter.
   *
   * Jitter is the important part. Without it, every client disconnected by the
   * same server restart computes the same delay and returns simultaneously, which
   * is how a restarted server gets knocked over by the reconnect storm it caused.
   */
  #scheduleRetry(): void {
    if (this.#disposed || this.#closedByUser) {
      return;
    }

    this.#attempt += 1;

    const exponential = Math.min(this.#baseRetryMs * 2 ** (this.#attempt - 1), this.#maxRetryMs);
    const delay = Math.round(exponential * (0.5 + Math.random() * 0.5));

    this.#setState('closed', this.#attempt);

    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.connect();
    }, delay);
  }

  #setState(state: ConnectionState, attempt = this.#attempt): void {
    if (this.#state === state) {
      return;
    }

    this.#state = state;
    this.#handlers.onStateChange(state, attempt);
  }
}
