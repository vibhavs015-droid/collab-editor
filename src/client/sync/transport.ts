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
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../../shared/protocol.js';
import type { Operation } from '../../core/crdt/rga.js';

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface TransportHandlers {
  /** Inbound operations, already decoded by the server envelope. */
  onOps: (ops: readonly Operation[]) => void;
  onPresence: (cursors: Readonly<Record<string, number>>) => void;
  onSyncState: (state: 'synced' | 'pending' | 'offline' | 'error', pendingOps: number) => void;
  onWelcome: (site: string) => void;
  onError: (code: string, message: string) => void;
  onStateChange: (state: ConnectionState, attempt: number) => void;
}

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
  /** Set while disconnect is intentional, so no reconnect is scheduled. */
  #closedByUser = false;
  #disposed = false;

  constructor(options: TransportOptions) {
    this.#url = options.url;
    this.#documentId = options.documentId;
    this.#handlers = options.handlers;
    this.#baseRetryMs = options.baseRetryMs ?? 500;
    this.#maxRetryMs = options.maxRetryMs ?? 15_000;
    this.#maxQueuedOps = options.maxQueuedOps ?? 5_000;
    this.#socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
  }

  get state(): ConnectionState {
    return this.#state;
  }

  get queuedOperationCount(): number {
    return this.#outbox.length;
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
        lastAppliedClock: 0,
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

  /** Ask the server to replay what this client is missing. */
  requestResync(): void {
    if (this.#state !== 'open') {
      return;
    }

    this.#send({ type: 'resync', documentId: this.#documentId });
  }

  #flushOutbox(): void {
    if (this.#outbox.length === 0 || this.#state !== 'open') {
      return;
    }

    const batch = this.#outbox;
    this.#outbox = [];

    this.#send({ type: 'ops', documentId: this.#documentId, ops: batch });
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
      case 'presence':
        this.#handlers.onPresence(parsed.cursors);
        return;
      case 'syncState':
        this.#handlers.onSyncState(parsed.state, parsed.pendingOps);
        return;
      case 'error':
        this.#handlers.onError(parsed.code, parsed.message);
        return;
      default:
        return;
    }
  }

  #send(message: ClientMessage): void {
    if (this.#state !== 'open' || !this.#socket) {
      return;
    }

    this.#socket.send(JSON.stringify(message));
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
