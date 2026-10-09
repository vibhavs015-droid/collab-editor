/**
 * Client-side sync transport.
 *
 * Owns the WebSocket connection and nothing else. It does not merge, does not
 * reorder, and does not interpret operations: it sends what the editor produced
 * and hands inbound operations to whoever subscribed. Every decision about what
 * those operations mean belongs to the CRDT, which is already proven correct by
 * src/core/crdt/convergence.test.ts.
 *
 * -- Reconnection ---------------------------------------------------------
 * A collaborative editor reconnects constantly: laptops sleep, phones change
 * network, deploys restart the server. The loop here is exponential backoff with
 * jitter, because without jitter every client disconnected by a server restart
 * would return in the same millisecond and knock it over again. That is the
 * thundering-herd failure, and it is entirely preventable.
 */

import { parseOperations } from '../../shared/operation-validation.js';
import {
  MAX_OPS_PER_FRAME,
  PROTOCOL_VERSION,
  type Capability,
  type ClientMessage,
  type EncryptedOperationFrame,
  type ServerMessage,
  type SnapshotMessage,
} from '../../shared/protocol.js';
import type { JsonValue } from '../../shared/protocol.js';
import type { Operation } from '../../core/crdt/rga.js';
import type { DocumentKey } from '../../core/crypto/documentKey.js';
import {
  DecryptionError,
  decryptOperations,
  encryptOperations,
} from '../../core/crypto/envelope.js';

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
  /**
   * Document key, from the URL fragment. See ADR-0014.
   *
   * Omit for an unencrypted document, which is the default and how every document
   * created before this feature is opened.
   */
  readonly key?: DocumentKey;

  /**
   * Produce a session token, called on every connect.
   *
   * A function rather than a string, so a reconnect presents a token that is valid
   * now. A string captured at construction would expire silently and the client
   * would reconnect forever to a server that had every reason to refuse it.
   *
   * @returns the token, or an empty string when none could be obtained. The server
   *   refuses an empty token, and the resulting reconnect is the recovery path.
   */
  readonly resolveToken?: () => Promise<string>;
  /**
   * Log sequence this client already holds when the transport is created.
   *
   * Persisted next to the operation log so a reload resumes rather than
   * re-downloading the document. Defaults to 0, which is correct and merely
   * slower for a fresh client.
   */
  readonly initialSeq?: number;
}

/**
 * Server-to-client frames this client understands, declared in every `hello`.
 *
 * `ack` is absent because it is gated on the client sending a `batchId`, which is a stronger
 * signal than a declaration: it is the specific thing being acknowledged, and it cannot be sent
 * by a client that does not intend to use it.
 */
const CLIENT_CAPABILITIES: readonly Capability[] = ['ping'];

/**
 * How long the client waits for ANY frame from the server before declaring the socket dead.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS: A HALF-OPEN SOCKET IS INVISIBLE WITHOUT IT
 * ---------------------------------------------------------------------------
 * Everything else in this file - the reconnect, the in-flight replay, the honest `Synced` -
 * depends on the socket's `close` event arriving. A TCP connection whose packets are being
 * silently dropped never closes. No error fires, no `close` fires, the browser's `readyState`
 * stays `OPEN`, and the client keeps believing it is connected while its edits pile up
 * unacknowledged.
 *
 * That is not hypothetical for this project: the browser tests had to stop the server process
 * outright to simulate an outage, because `context.setOffline(true)`, CDP
 * `Network.emulateNetworkConditions` and `routeWebSocket` all leave an ESTABLISHED WebSocket
 * connected. Real networks behave like those, not like a stopped process.
 *
 * The server pings every {@link PING_INTERVAL_MS} and the client answers, so "no frame at all
 * for this long" is a sound liveness signal.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS LONGER THAN ONE PING INTERVAL
 * ---------------------------------------------------------------------------
 * A single missed ping is a congested network, not a dead one. This is deliberately more than one
 * interval so that one lost packet does not cost a reconnect - which would replay every
 * in-flight batch for nothing.
 *
 * A backgrounded browser tab throttles its timers, which delays this check rather than causing
 * it to fire early: network events are not throttled, so a throttled tab still records frames and
 * still answers pings promptly. The result is later detection, never false detection.
 */
const SERVER_IDLE_TIMEOUT_MS = 75_000;

/**
 * One outbound frame that has been written but not acknowledged.
 *
 * The message is held whole, rather than just the operations, so that a resend is byte-identical
 * to the original. That matters for the encrypted path: re-encrypting would produce a new
 * nonce for the same element, and the server would store two elements for one keystroke.
 */
interface InflightFrame {
  readonly batchId: string;
  readonly message: ClientMessage;
}

export class SyncTransport {
  readonly #url: string;
  readonly #documentId: string;
  readonly #handlers: TransportHandlers;
  readonly #socketFactory: (url: string) => WebSocket;
  readonly #resolveToken: () => Promise<string>;
  readonly #baseRetryMs: number;
  readonly #maxRetryMs: number;
  /**
   * Document key, or null when this document is not encrypted. See ADR-0014.
   *
   * Null is a mode, not a failure. A link with no key opens an unencrypted document,
   * which is how every document created before this feature is opened.
   *
   * Fixed at construction. A key cannot be introduced later, because a transport that
   * started relaying plaintext to a document and then gained a key would have already
   * leaked whatever it sent in between.
   */
  readonly #key: DocumentKey | null;

  #socket: WebSocket | null = null;
  #state: ConnectionState = 'closed';
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Liveness watchdog. See {@link SERVER_IDLE_TIMEOUT_MS}. */
  readonly #watchdog: ReturnType<typeof setInterval>;
  /**
   * The last `error` frame's code, kept so `onclose` can tell a permanent refusal from a
   * dropped connection.
   *
   * The server closes with 1008 for a refusal and its own comment says why: a normal close
   * code "would look like a normal shutdown and retry forever". The client has to act on
   * that, and it cannot act on a close code alone - it needs the reason, which arrives in
   * the error frame immediately before the close.
   */
  #lastErrorCode: string | null = null;

  /** Deliberately not cleared on disconnect: these are local edits awaiting relay. */
  #outbox: Operation[] = [];
  /**
   * Frames written to a socket the server has not yet acknowledged.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS IS SEPARATE FROM THE OUTBOX
   * ---------------------------------------------------------------------------
   * Before this existed, the outbox was emptied the moment `send()` returned, which is a claim
   * about the local socket and not about the server. A frame written to a socket that then died
   * was gone from memory and never arrived anywhere: measured in
   * src/server/writeDurability.test.ts, where a real relay and a real database ended up with an
   * empty document while the indicator read "Synced".
   *
   * So an operation leaves the outbox when it is WRITTEN and leaves this list when it is
   * ACKNOWLEDGED. On reconnect the two are prepended back together, in order, and resent -
   * duplicates are harmless because server persistence is idempotent, and losing an edit is not.
   *
   * The whole frame is kept, not just the operations, because the encrypted path has to resend
   * the ciphertext it actually sent. Re-encrypting would mint a fresh nonce for an operation
   * that is already in flight, and the two would be stored as two different elements.
   */
  #inflight: readonly InflightFrame[] = [];
  /**
   * Monotonic source of batch ids.
   *
   * A counter rather than a random token because the id only has to be unique within this
   * transport, and the transport is the only thing that ever sends it. It must NOT restart on
   * reconnect, because inflight frames are resent carrying their ORIGINAL ids: a counter that
   * reset would reissue an id that the server may already have acknowledged on the old socket.
   */
  #nextBatchId = 1;
  /**
   * When the last frame arrived from the server, or null while disconnected.
   *
   * The liveness signal for a socket that never closes. See {@link SERVER_IDLE_TIMEOUT_MS} for
   * why waiting for a `close` event is not enough.
   */
  #lastFrameAt: number | null = null;
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
   * True while an outbox batch is mid-encryption.
   *
   * Without it, two flushes overlapping - a reconnect arriving while a slow
   * encryptOperations is still running - would both read the same outbox and send the
   * same operations twice. Duplicates are harmless to a CRDT and wrong for
   * everyone else, because the server would store two rows for one keystroke.
   */
  #encrypting = false;
  /**
   * How many times a baseline has been refused because the outbox is not empty.
   *
   * Bounded so a client whose operations the server keeps rejecting cannot
   * resync forever. Three is enough for a transient flush failure and not enough to
   * hide a genuine disagreement.
   */
  #baselineRetries = 0;

  /**
   * True once the server has answered hello with welcome.
   *
   * Distinct from open: a socket can be open and still unauthorised, and sending
   * anything but hello in that window is refused. Reset on every close so a
   * reconnect re-runs the handshake rather than assuming the old one still holds.
   */
  #admitted = false;

  /**
   * True once hello has actually been written.
   *
   * Both flags are required before anything else is sent. Requiring both rather than
   * relying on their order means a server frame arriving before the handshake has even
   * started cannot release the outbox.
   *
   * The server is what actually enforces authorisation: it refuses every frame except
   * hello from an unauthorised socket. This flag is about not spending a reconnect on
   * operations that would be refused.
   */
  #helloSent = false;

  constructor(options: TransportOptions) {
    this.#url = options.url;
    this.#documentId = options.documentId;
    this.#handlers = options.handlers;
    this.#baseRetryMs = options.baseRetryMs ?? 500;
    this.#maxRetryMs = options.maxRetryMs ?? 15_000;
    this.#key = options.key ?? null;
    this.#socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
    // Default produces an empty token, which the server refuses. That is the honest
    // failure for a transport constructed without credentials: it connects, is rejected,
    // and retries. Silently sending something that looks valid would be worse.
    this.#resolveToken = options.resolveToken ?? (() => Promise.resolve(''));
    this.#seq = options.initialSeq ?? 0;

    // The liveness watchdog, started once for the transport's whole life rather than per
    // connection. It is cheap when there is nothing to check: `#checkLiveness` returns
    // immediately unless there is a live socket that has gone quiet.
    //
    // Unref'd where the runtime supports it, so a pending watchdog cannot be the reason a
    // process stays alive. In a browser there is no such thing and unref does not exist.
    this.#watchdog = setInterval(
      () => {
        this.#checkLiveness();
      },
      Math.floor(SERVER_IDLE_TIMEOUT_MS / 3),
    );

    (this.#watchdog as { unref?: () => void }).unref?.();
  }

  get state(): ConnectionState {
    return this.#state;
  }

  get queuedOperationCount(): number {
    return this.#outbox.length;
  }

  /**
   * Operations sent but not yet handed to a socket.
   *
   * Exposed as the operations themselves, not just a count, because client-side log
   * compaction has to know exactly which operations the server has not seen. Anything
   * in here may still be the only record of an edit, and compaction must not drop the
   * elements those edits reference.
   *
   * Read-only by type: a caller that could mutate this would be able to silently
   * discard an edit that has never left the device.
   */
  get queuedOperations(): readonly Operation[] {
    return this.#outbox;
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

    // A new socket has not been authorised. Clearing here as well as in `onclose`
    // covers the path where `connect` is called on a live transport.
    this.#admitted = false;
    this.#helloSent = false;

    socket.onopen = () => {
      this.#attempt = 0;
      this.#lastFrameAt = Date.now();
      this.#setState('open');
      void this.#sendHello();
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      // Recorded BEFORE parsing, so a frame this client cannot understand still counts as proof
      // the server is alive. A server sending something unrecognised is alive; one sending
      // nothing at all is not, and that is the distinction being made.
      this.#lastFrameAt = Date.now();
      this.#receive(event.data);
    };

    socket.onerror = () => {
      // 'error' is always followed by 'close', which drives the retry. Handling
      // it here would double-schedule.
    };

    socket.onclose = () => {
      this.#socket = null;

      // Everything below is the shared close transition. See #onSocketClosed for why the
      // liveness watchdog calls the same thing rather than reimplementing it.
      this.#onSocketClosed();
    };
  }

  /**
   * Close the connection and stop reconnecting.
   *
   * Queued operations are deliberately discarded: the caller owns document
   * persistence, and holding operations in memory after teardown would leak them
   * when the page unloads.
   */
  /**
   * Stop syncing, permanently, and discard anything still queued.
   *
   * ---------------------------------------------------------------------------
   * WHY THE OUTBOX IS CLEARED HERE AND NOWHERE ELSE
   * ---------------------------------------------------------------------------
   * There are two ways a connection ends here and they are not the same decision.
   *
   *   - RECOVERABLE: the socket dies, the server stops answering, the watchdog fires. That path
   *     runs {@link #onSocketClosed}, which calls {@link #requeueInflight} and KEEPS the outbox. The
   *     reconnect resends it. This is the path ADR-0008 is about, and it is where any real risk of
   *     losing work lives.
   *
   *   - TERMINAL: this method, which sets `#closedByUser` and suppresses the retry loop. The only
   *     production caller is {@link dispose}; everything else in the tree that calls it is a test
   *     simulating a user who pressed "disconnect". There is no code path from a network event to
   *     here.
   *
   * So clearing is a consequence of the terminal decision rather than a second, independent one. The
   * user asked to stop syncing this document; holding a queue for a transport that has been told it
   * will never reconnect is a leak, and the retry loop that would have drained it is switched off one
   * line above.
   *
   * ---------------------------------------------------------------------------
   * WHY NOTHING IS ACTUALLY LOST
   * ---------------------------------------------------------------------------
   * The outbox is a DELIVERY queue, not the store of record. Every operation in it was already
   * applied to the local CRDT and appended to the local `IndexedDbOperationLog` by `Replica` itself,
   * before the transport ever saw it. The document on this device is correct and survives a reload
   * either way; what the outbox holds is only the attempt to tell the server about it.
   *
   * What is genuinely given up is the ATTEMPT. Once this returns, those operations are not resent by
   * this transport, and the server cannot learn about them from here - on a later reload the client
   * announces the sequence it already holds and asks for what comes after it, and a server-side gap
   * below that point is invisible to both sides. Recovering that needs a reconciliation this project
   * does not have, which is a further reason not to reach this method by accident.
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
    // The watchdog outlives every connection, so disposing the transport has to stop it. A
    // live interval here would be a timer firing forever on a disposed transport, holding a
    // closure that holds the socket - which is the leak this class is careful about elsewhere.
    clearInterval(this.#watchdog);
    this.disconnect();
  }

  /** Send operations to peers, queueing them if currently offline. */
  send(ops: readonly Operation[]): void {
    if (ops.length === 0) {
      return;
    }

    this.#outbox.push(...ops);

    // There is deliberately no cap here, and in particular nothing is dropped.
    //
    // The outbox used to keep only the newest 5,000 operations. Typed text is a chain,
    // each character anchored to the one before it, so discarding the oldest operations
    // left every survivor anchored to something the relay never received. The relay
    // accepted them as well formed, could not place them, and a peer saw an empty
    // document, while this client reported itself synced. A single paste of 5,001
    // characters was enough to trigger it. The relay needs the whole log, not a tail.
    //
    // The memory the cap protected is mostly not extra: the outbox holds references to
    // operation objects the replica already keeps for every element, so a queued
    // operation costs one pointer. Frame size is bounded where it matters, at send time,
    // by MAX_OPS_PER_FRAME.

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
   * Requires that the server has said `welcome`. Sending before that is the one
   * thing this client must never do: the server refuses any frame other than
   * `hello` from an unauthenticated socket, and its authorisation check is
   * asynchronous, so operations sent in the gap between `hello` and `welcome` are
   * rejected and the socket closed. Waiting for the handshake turns what would be a
   * silent race into an ordinary wait.
   *
   * The outbox is cleared only after the frame is actually accepted. That ordering
   * matters too: the transport's own state can say `open` while the socket underneath
   * is already gone - a browser has not yet fired `close` on a connection the network
   * has dropped. Clearing first would drop the user's keystrokes on the floor,
   * silently, in exactly the window where the server is unreachable and they are most
   * needed.
   */
  #flushOutbox(): void {
    if (this.#outbox.length === 0 || this.#state !== 'open') {
      return;
    }

    if (!this.#helloSent || !this.#admitted) {
      return;
    }

    if (this.#key !== null) {
      // Encrypt before sending, and deliberately NOT before queueing.
      //
      // The outbox holds PLAINTEXT operations on purpose: they are the local user's own
      // edits, in this process's memory, and keeping them readable means a retry does not
      // need the key and a bug report can be reasoned about. Encrypting at the queue
      // boundary would also mean a partially-encrypted outbox if encryption failed
      // midway, which is a state nothing else knows how to handle.
      //
      // `void` because `#flushOutbox` is called from synchronous reconnect paths. The
      // batch is NOT removed from the outbox until encryption has finished, so an
      // overlapping flush cannot send it twice; `#encrypting` guards that.
      if (this.#encrypting) {
        return;
      }

      this.#encrypting = true;

      // Copied, not aliased.
      //
      // `const batch = this.#outbox` looks equivalent and is not: it binds the ARRAY, so
      // an operation queued during the await appears in `batch` too and gets encrypted
      // and sent by this batch. That happened to be harmless, because both operations then
      // went out in one frame - but it is timing-dependent, not designed, and
      // `disconnect()` replaces the outbox outright, which would leave `batch` pointing
      // at an array nothing else can see.
      const batch = this.#outbox.slice(0, MAX_OPS_PER_FRAME);

      // True only when the socket refused the frame. Used below so a refused write is
      // not retried at once: the transport may still believe the socket is open for a few
      // event-loop turns, and retrying would re-encrypt the same batch in a loop until
      // the close event arrived.
      let writeFailed = false;

      void encryptOperations(this.#key, this.#documentId, batch)
        .then((frames) => {
          if (this.#disposed) {
            return;
          }

          // Write first, promote second. The batch used to be removed before the write, so
          // a socket that dropped while encryption was running took the batch with it:
          // the comment said "left queued" and the code had already dequeued it.
          const batchId = `b${String(this.#nextBatchId)}`;
          this.#nextBatchId += 1;

          const message: ClientMessage = {
            type: 'ops-enc',
            documentId: this.#documentId,
            frames,
            batchId,
          };

          if (!this.#send(message)) {
            writeFailed = true;

            // Left queued. The reconnect path flushes it.
            return;
          }

          this.#promote(batchId, message, batch.length);
        })
        .catch((error: unknown) => {
          // Left in the outbox, still plaintext, and retried on the next flush. The user
          // sees the sync indicator stay pending, which is accurate: their edit has not
          // been sent.
          this.#handlers.onError(
            'ENCRYPT_FAILED',
            error instanceof Error ? error.message : 'Could not encrypt an operation.',
          );
        })
        .finally(() => {
          this.#encrypting = false;

          // Anything queued while the encryption ran still needs sending, and nothing
          // else will come along to flush it: `send()` returned early on the `#encrypting`
          // guard. Without this the second keystroke would sit in the outbox until the
          // next edit or a reconnect, which looks like a lost keystroke to the user.
          if (!writeFailed && this.#outbox.length > 0 && this.#state === 'open') {
            this.#flushOutbox();
          }

          this.#reportPending();
        });

      return;
    }

    // In order, MAX_OPS_PER_FRAME at a time. The next chunk is sliced off a new array
    // rather than spliced out of this one, so a caller still holding the array from
    // `queuedOperations` is not emptied underneath it.
    while (this.#outbox.length > 0) {
      const chunk = this.#outbox.slice(0, MAX_OPS_PER_FRAME);
      const batchId = `b${String(this.#nextBatchId)}`;

      this.#nextBatchId += 1;

      const message: ClientMessage = {
        type: 'ops',
        documentId: this.#documentId,
        ops: chunk,
        batchId,
      };

      if (!this.#send(message)) {
        // Kept queued. The reconnect path flushes it, and the indicator keeps
        // reporting them as pending.
        return;
      }

      this.#promote(batchId, message, chunk.length);
    }

    this.#reportPending();
  }

  /**
   * Move a written batch from the outbox to the in-flight list.
   *
   * @param count how many operations left the outbox. Re-read from the captured length rather
   *   than trusting the array, so an edit queued mid-encryption is neither sent twice nor lost.
   */
  #promote(batchId: string, message: ClientMessage, count: number): void {
    this.#outbox.splice(0, count);
    this.#inflight = [...this.#inflight, { batchId, message }];
  }

  /**
   * Operations the server has not confirmed, in flight and still queued.
   *
   * Both lists, because both are unsent as far as the user is concerned: an operation sitting in
   * memory because the server has not acknowledged it is exactly as unsafe as one that was never
   * written.
   */
  #unacknowledged(): number {
    let inFlight = 0;

    for (const frame of this.#inflight) {
      const ops =
        frame.message.type === 'ops'
          ? frame.message.ops
          : frame.message.type === 'ops-enc'
            ? frame.message.frames
            : [];

      inFlight += ops.length;
    }

    return this.#outbox.length + inFlight;
  }

  /**
   * Tell the UI what is actually outstanding.
   *
   * "Synced" means BOTH lists are empty. Reporting synced on the strength of `send()` returning
   * was the reason this bug was silent: the application asserted something it could not know,
   * at the exact moment the user's work was least safe.
   */
  #reportPending(): void {
    const outstanding = this.#unacknowledged();

    this.#handlers.onSyncState(outstanding > 0 ? 'pending' : 'synced', outstanding);
  }

  /**
   * A batch the server has confirmed.
   *
   * An id this client does not recognise is ignored rather than treated as an error: the server
   * is a different version, or a frame was duplicated in transit, and neither is something the
   * user can act on.
   */
  #acknowledge(batchId: string): void {
    const before = this.#inflight.length;

    this.#inflight = this.#inflight.filter((frame) => frame.batchId !== batchId);

    if (this.#inflight.length === before) {
      return;
    }

    this.#reportPending();
  }

  /**
   * Put unacknowledged batches back at the FRONT of the outbox.
   *
   * Front, and in order, because these were written before everything still queued. Replaying
   * them after later edits would give the server operations whose causal anchors have not
   * arrived yet - which it tolerates, and which the CRDT then has to repair.
   */
  #requeueInflight(): void {
    if (this.#inflight.length === 0) {
      return;
    }

    const recovered: Operation[] = [];

    for (const frame of this.#inflight) {
      if (frame.message.type === 'ops') {
        recovered.push(...(frame.message.ops as Operation[]));
      } else if (frame.message.type === 'ops-enc') {
        // An encrypted batch cannot go back through the plaintext outbox: the outbox is
        // deliberately plaintext (see #flushOutbox), and putting ciphertext in it would make
        // the next flush re-encrypt already-encrypted frames. They are resent verbatim as
        // their own frame instead.
        this.#resendEncrypted(frame);
        continue;
      }
    }

    this.#inflight = [];
    this.#outbox = [...recovered, ...this.#outbox];
  }

  /**
   * Resend an encrypted frame exactly as it was written.
   *
   * Verbatim rather than re-encrypted, because the ciphertext already exists and its nonce is
   * already committed to. Encrypting again would produce a different frame for the same
   * elements, and the server would store both.
   *
   * Failure here is not an error: it means the socket died again, and the frame is still in the
   * in-flight list because the promotion only happens on a successful write.
   */
  #resendEncrypted(frame: InflightFrame): void {
    if (this.#state !== 'open' || !this.#admitted) {
      return;
    }

    if (this.#send(frame.message)) {
      this.#inflight = [...this.#inflight, frame];
    }
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
        // The handshake is complete. Anything queued while it was in flight can go
        // now, and not before.
        this.#admitted = true;
        this.#handlers.onWelcome(parsed.site);
        this.#flushOutbox();
        return;
      case 'ack': {
        // The server has stored a batch. Only now does the client stop owing it.
        //
        // Validated here rather than trusted because `parsed` is `JSON.parse` output and the
        // protocol type is erased at runtime - exactly the boundary protocol.ts exists to
        // police, and the one direction it does not police.
        if (typeof parsed.batchId !== 'string') {
          this.#handlers.onError('BAD_RESPONSE', 'Server sent a malformed acknowledgement.');
          return;
        }

        this.#acknowledge(parsed.batchId);
        return;
      }
      case 'ops':
        // Operations arrive as opaque JSON. parseOperations is the real narrowing
        // step; a cast here would be a lie the compiler is right to reject.
        this.#handlers.onOps(parseOperations(parsed.ops));
        return;
      case 'ops-enc': {
        // Encrypted operations. See ADR-0014.
        //
        // A document's mode is decided by its first frame and never changes, so
        // receiving `ops-enc` while this client has no key is a real configuration
        // mistake rather than something to paper over: the document is encrypted and
        // this session was opened without its key.
        //
        // Reporting that is far better than the alternative, which is silently dropping
        // the frames and showing a document that is missing whatever the other
        // participants typed.
        if (this.#key === null) {
          this.#handlers.onError(
            'ENCRYPTED_NO_KEY',
            'This document is encrypted, and this session was opened without its key.',
          );
          return;
        }

        void this.#decryptAndDeliver(parsed.frames);
        return;
      }
      case 'snapshot':
        this.#receiveBaseline(parsed);
        return;
      case 'ping': {
        // Answered immediately and synchronously. That is the whole point: the reply must not
        // depend on anything that could be slow, throttled or queued, or the server would time
        // out a client that is perfectly alive.
        //
        // The token is echoed verbatim. The server matches it against the ping it actually
        // sent, so a pong that arrives late cannot be mistaken for a current one.
        if (typeof parsed.t !== 'number' || !Number.isFinite(parsed.t)) {
          this.#handlers.onError('BAD_RESPONSE', 'Server sent a malformed ping.');
          return;
        }

        this.#send({ type: 'pong', t: parsed.t });
        return;
      }
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
        // Remembered so `onclose` can distinguish a refusal from a dropped connection.
        // Without this the two look identical and the retry loop cannot make a decision.
        this.#lastErrorCode = parsed.code;
        this.#handlers.onError(parsed.code, parsed.message);
        return;
      default:
        return;
    }
  }

  /**
   * Decrypt a batch of frames and hand the operations to the editor.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS IS ASYNCHRONOUS AND NOT AWAITED BY #receive
   * ---------------------------------------------------------------------------
   * WebCrypto is promise-based and `#receive` is synchronous, because it is called from a
   * socket event. So the delivery is deferred.
   *
   * The ordering consequence is real and is flagged rather than hidden: two encrypted
   * batches arriving back to back can decrypt out of order, because each is an
   * independent promise chain. That is harmless for a CRDT, which is explicitly
   * order-independent (`applyInAnyOrder`). What does matter is that no batch is applied
   * twice, and that the caller receives each batch exactly once.
   *
   * On failure the whole batch is reported and NONE of it is applied. Half a keystroke
   * batch would leave the document in a state nobody typed, with no record that anything
   * was rejected.
   */
  async #decryptAndDeliver(frames: readonly EncryptedOperationFrame[]): Promise<void> {
    const key = this.#key;

    if (key === null) {
      return;
    }

    try {
      const ops = await decryptOperations(key, this.#documentId, frames);

      this.#handlers.onOps(ops);
    } catch (error) {
      this.#handlers.onError(
        error instanceof DecryptionError && error.reason === 'wrong-key'
          ? 'WRONG_KEY'
          : 'DECRYPT_FAILED',
        error instanceof Error ? error.message : 'Could not decrypt an operation.',
      );
    }
  }

  /**
   * Handle a baseline the server sent because this client is below the floor.
  /**
   * Handle a baseline the server sent because this client is below the floor.
   *
   * The refusal is the important part. A baseline REPLACES the document, so
   * applying one while holding unsent operations would discard work the user
   * believes is saved -- and nothing would report it, because the client's own log
   * would look consistent right up until the next reload.
   *
   * So: flush first, then ask again. The retry is bounded, and a client that
   * genuinely cannot empty its outbox reports an error rather than discarding
   * anything.
   */
  #receiveBaseline(message: SnapshotMessage): void {
    // An encrypted client cannot adopt a baseline. See ADR-0014.
    //
    // The server cannot produce one for an encrypted document - it holds no elements -
    // so this should be unreachable. Refusing is the right response anyway, because the
    // alternative is `resetTo` on elements this client has no way to have derived, and
    // the result would be a document the user did not write with no error shown.
    if (this.#key !== null) {
      this.#handlers.onError(
        'BASELINE_REFUSED',
        'The server offered a plaintext baseline for an encrypted document. Refusing it.',
      );
      return;
    }

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
   * Say hello, with whatever token is valid right now.
   *
   * A function, not a string, and that is the whole design of token expiry here. The
   * token is only ever read at `hello`, which happens on every connect, so an expired
   * token can never be "noticed mid-session" -- it is simply replaced before the next
   * handshake. That makes expiry a non-event with no timer, no refresh endpoint and
   * no re-authentication in flight, which is the cheapest correct answer.
   */
  async #sendHello(): Promise<void> {
    let token = '';

    try {
      token = await this.#resolveToken();
    } catch {
      // No token could be obtained. Send hello with an empty one so the server closes
      // the connection and the retry loop runs. Inventing a token here would turn a
      // session problem into a confusing authorisation failure.
    }

    const sent = this.#send({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      token,
      documentId: this.#documentId,
      // `#seq` is what the SERVER has numbered, not what this client has typed. Queued
      // local operations have no server sequence yet, so claiming them here would
      // ask the server to skip operations this client has never seen.
      lastAppliedSeq: this.#seq,
      // Declaring the capability is what opts this client into being pinged. Without it the
      // server sends nothing new, so a client that does not understand `ping` never sees one.
      capabilities: CLIENT_CAPABILITIES,
    });

    if (sent) {
      this.#helloSent = true;
      this.#flushOutbox();
    }
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
   * Give up on a socket that has gone quiet, so a half-open connection is noticed.
   *
   * Called from a timer rather than from any event, because there IS no event: a connection
   * whose packets are being dropped never fires `error`, never fires `close`, and leaves
   * `readyState` at OPEN. Waiting for `close` is waiting for a thing that does not happen.
   *
   * The socket is closed deliberately rather than abandoned, because closing it runs `onclose`,
   * which is where the reconnect, the in-flight replay and the honest offline state all live.
   * Abandoning it would need all of that duplicated here, and would be a second code path for
   * the same transition - which is how the two drift apart.
   */
  #checkLiveness(): void {
    if (this.#disposed || this.#closedByUser || this.#socket === null) {
      return;
    }

    if (this.#lastFrameAt === null) {
      return;
    }

    if (Date.now() - this.#lastFrameAt < SERVER_IDLE_TIMEOUT_MS) {
      return;
    }

    this.#handlers.onError('SERVER_UNREACHABLE', 'Lost contact with the server. Reconnecting.');

    const socket = this.#socket;

    // Cleared BEFORE closing, so the close handler cannot re-enter with a socket it believes
    // is live. `close()` on a socket that never closes is safe; `terminate()` is not available
    // on the DOM type and would be wrong here anyway - this socket still looks healthy.
    this.#socket = null;

    try {
      socket.close();
    } catch {
      // Already gone. The close handler below still runs the reconnect.
    }

    // The browser may never deliver `close` for a half-open socket - that is the entire
    // problem - so the transition is driven here rather than left to the event.
    this.#onSocketClosed();
  }

  /**
   * The close transition, shared by the real `close` event and the liveness watchdog.
   *
   * Extracted so both routes run identical logic. When this was inlined in `onclose`, the
   * watchdog would have needed its own copy of the in-flight replay and the refusal check, and
   * the two would have been free to diverge - which is exactly how a reconnect ends up working
   * in one case and silently losing work in the other.
   */
  #onSocketClosed(): void {
    this.#lastFrameAt = null;
    this.#admitted = false;
    this.#helloSent = false;

    this.#requeueInflight();

    if (this.#disposed || this.#closedByUser) {
      this.#setState('closed');
      return;
    }

    const refusal = permanentRefusal(this.#lastErrorCode);

    this.#lastErrorCode = null;

    if (refusal !== null) {
      this.#setState('closed');
      this.#handlers.onError(refusal.code, refusal.message);

      return;
    }

    this.#setState('closed');
    this.#handlers.onSyncState('offline', this.#unacknowledged());
    this.#scheduleRetry();
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

/**
 * Error codes that a retry cannot fix.
 *
 * Split from the transport's knowledge of HTTP and WebSocket mechanics deliberately: this is
 * a statement about which SERVER ANSWERS are final.
 *
 *   - DOCUMENT_NOT_FOUND is the existence-oracle 404 (ADR-0012). It is returned both for a
 *     document that does not exist and for one this identity may not see, so it is
 *     deliberately unhelpful - but either way, repeating the request cannot change it.
 *   - UNAUTHORIZED means the token did not verify. A refresh might fix that, and the
 *     transport already re-resolves its token on every connect, so the next attempt is
 *     genuinely different. It is listed as permanent only in the sense that THIS connection
 *     is finished; the client still retries a bounded number of times and then reports.
 *
 * Everything else - a dropped socket, a timeout, a 500, a rate limit - is transient by
 * definition and keeps the jittered exponential backoff of ADR-0008.
 *
 * ---------------------------------------------------------------------------
 * THE TWO QUOTA CODES ARE BOTH DELIBERATELY ABSENT, AND THE SECOND ONE IS THE INTERESTING CASE
 * ---------------------------------------------------------------------------
 * RATE_LIMITED is obvious: the server closed the connection for going too fast, and a faster
 * reconnect is the wrong response to that.
 *
 * DOCUMENT_TOO_LARGE is the one worth writing down. The refusal genuinely cannot be retried
 * away - the document is full and stays full - so "a retry cannot fix it, therefore treat it as
 * permanent" reads as obvious and is wrong. The client's only route out of a full document is to
 * DELETE from it, and deletion needs a live connection. A client that refused to reconnect would
 * strand a user who filled a document: the tab could never empty it again.
 *
 * So neither code goes in this list. Both are reported to the user through onError, and both
 * reconnect with backoff. The backoff is what keeps that from being a loop.
 */
const PERMANENT_ERROR_CODES: Readonly<Record<string, string>> = {
  DOCUMENT_NOT_FOUND:
    'This document is not available to this browser. It belongs to a different session, or the link is wrong.',
};

function permanentRefusal(code: string | null): { code: string; message: string } | null {
  if (code === null) {
    return null;
  }

  const message = PERMANENT_ERROR_CODES[code];

  return message === undefined ? null : { code, message };
}
