/**
 * WebSocket sync server.
 *
 * A deliberately dumb relay. The server never merges, never orders, and never
 * decides anything: it holds a room membership list and forwards every operation
 * to everyone else in the room.
 *
 * That is not a simplification, it is the point. Every interesting decision
 * belongs to the CRDT on the client, where convergence is already proven by
 * src/core/crdt/convergence.test.ts. A server that merged would be a second,
 * untested implementation of the same algorithm, and the two would eventually
 * disagree.
 *
 * Ã¢â€â‚¬Ã¢â€â‚¬ What the server does own Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
 * - Room membership, so operations reach the right peers
 * - Connection lifecycle: heartbeat, stale-connection reaping
 * - Backpressure, so one slow client cannot stall the room
 * - Presence, which is ephemeral by nature and belongs here rather than in the
 *   CRDT
 */

import type { WebSocket } from 'ws';

import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ErrorCode,
  type JsonValue,
  type ServerMessage,
} from '../shared/protocol.js';
import { parseClientMessage } from '../shared/protocol.js';

/** One connected client. */
interface Client {
  readonly socket: WebSocket;
  /** Stable id for this connection, used as the CRDT site for local edits. */
  readonly site: string;
  readonly documentId: string;
  /** Last time we received a frame. Used to reap dead connections. */
  lastSeen: number;
  /** Consecutive frames sent while the socket buffer was full. */
  backpressureHits: number;
  /**
   * Verified subject, or null before `hello` has been authorised.
   *
   * Set once and never reassigned, so a frame arriving mid-authorisation cannot
   * re-decide it.
   */
  subject: string | null;
  /** Whether this client may receive operations or be counted in a room. */
  authenticated: boolean;
  /** True while an authorisation request is in flight, which makes `hello` idempotent. */
  admitting: boolean;
  /** When an unauthenticated socket is dropped for never saying hello. */
  helloDeadline: number | null;
}

/**
 * Outcome of an authorisation check.
 *
 * A discriminated union rather than a boolean, so the relay can forward the reason
 * the caller gave and so "allowed" cannot be confused with "allowed, but there is
 * no such document".
 */
export type AuthorizeResult =
  | { readonly ok: true; readonly subject: string }
  | {
      readonly ok: false;
      readonly code: Extract<ErrorCode, 'UNAUTHORIZED' | 'DOCUMENT_NOT_FOUND'>;
      readonly message: string;
    };

/**
 * Frames sent to one client before giving up on it.
 *
 * A client that cannot keep up is disconnected rather than buffered forever.
 * Its CRDT state is intact locally and it will resync on reconnect, which is
 * exactly what the reconnect path is for. Unbounded buffering just converts a
 * slow client into a memory leak for everyone else.
 */
const MAX_BACKPRESSURE_FRAMES = 100;

/** Reap a connection that has sent nothing for this long. */
const STALE_CONNECTION_MS = 60_000;

/** Heartbeat interval. Must be comfortably under the stale threshold. */
const HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * Operations replayed per round trip when catching a client up.
 *
 * Big enough that an ordinary reconnect is a single frame, small enough that a
 * week-long absence does not produce a megabyte-long frame that every peer in the
 * room has to wait behind.
 */
const DEFAULT_REPLAY_BATCH = 500;

/**
 * Upper bound on replay pages for one request.
 *
 * A backstop, not a design. It exists so a log that never reports a short page
 * (a bug, or a concurrent writer outpacing the reader) cannot spin this loop
 * forever and pin a socket open. At the default batch size it covers 250,000
 * operations, far beyond any realistic catch-up.
 */
const MAX_REPLAY_ROUNDS = 500;

/**
 * How long a socket may stay connected without sending hello.
 *
 * Long enough that a client on a slow connection, or one that spent its time
 * fetching a session token, is not dropped. Short enough that an unauthenticated
 * connection costs a slot and a database lookup rather than sitting forever.
 */
const HELLO_TIMEOUT_MS = 10_000;

/**
 * Read side of the durable operation log.
 *
 * A port, not the Database class, for the same reason the transport validates
 * the envelope rather than importing the CRDT (ADR-0004): the relay needs
 * "give me what this client is missing" and has no business knowing it comes
 * from Postgres. Tests supply a memory log; production supplies the database.
 */
export interface RelayLog {
  /**
   * Everything a client at `sinceSeq` needs to become current.
   *
   * May be a plain delta, or a snapshot baseline when the client has fallen below
   * the compaction floor and the operations it is missing no longer exist. See
   * ADR-0011.
   *
   * @param limit batch cap, so a client that has been offline for a week is
   *   caught up in several frames rather than one enormous one.
   */
  readSince(documentId: string, sinceSeq: number, limit?: number): Promise<RelayPage>;
}

export interface RelayPage {
  /**
   * Baseline the client must replace its document with, or null for an ordinary
   * delta.
   *
   * `null` is the common case and is deliberately not an empty array: "replace
   * your document with nothing" is a real and destructive instruction, and it must
   * not be expressible by accident.
   */
  readonly snapshot: readonly JsonValue[] | null;
  readonly ops: readonly JsonValue[];
  /** Sequence of the last operation in `ops`, or the snapshot's own sequence. */
  readonly seq: number;
}

export interface RelayOptions {
  /** Milliseconds between pings. Set to 0 to disable, for tests. */
  readonly heartbeatMs?: number;
  /** Durable log. Without one the relay is Phase 3 again: broadcast only. */
  readonly log?: RelayLog;
  /** Operations handed to the log in one read-replay round trip. */
  readonly replayBatchSize?: number;
  /**
   * Called whenever a client's acknowledged position changes.
   *
   * This is what makes compaction safe. The floor is the minimum cursor across
   * connected clients, and it cannot be derived from anything the relay already
   * knows — only the client knows what it has applied.
   */
  readonly onCursor?: (documentId: string, site: string, seq: number) => void;
  /** Called when a client leaves, so a departed peer stops holding the floor. */
  readonly onLeave?: (documentId: string, site: string) => void;

  /**
   * Verify a session token and check it may touch this document.
   *
   * Omit it and the relay admits every socket immediately, which is the Phase 3
   * behaviour and is only appropriate for a relay with no session tokens at all.
   * Supply it and no socket receives a single operation until it has passed.
   *
   * The relay deliberately does not know how tokens are signed, nor what a
   * document's owner is. It asks, and obeys. Both decisions live in one place
   * (`Database.canAccess`) so the HTTP path and the socket path cannot drift.
   */
  readonly authorize?: (documentId: string, token: string) => Promise<AuthorizeResult>;

  /**
   * How long a socket may stay connected without sending `hello`.
   *
   * Without this, an unauthenticated socket is indistinguishable from a slow one,
   * and a server that admits sockets before checking them has an open door that
   * nobody remembers is open.
   */
  readonly helloTimeoutMs?: number;
}

export class Relay {
  readonly #rooms = new Map<string, Set<Client>>();

  /**
   * Sockets that connected but have not been authorised.
   *
   * Held separately because they are in no room, which means every routine that
   * walks rooms would miss them: the reaper, shutdown, and the client count. A
   * client stuck between connect and hello is the resource an attacker wants to
   * accumulate, so it needs to be visible to all three.
   */
  readonly #pending = new Set<Client>();
  readonly #heartbeat: ReturnType<typeof setInterval> | null;
  readonly #log: RelayLog | null;
  readonly #onCursor: RelayOptions['onCursor'];
  readonly #onLeave: RelayOptions['onLeave'];
  readonly #authorize: RelayOptions['authorize'];
  readonly #helloTimeoutMs: number;
  readonly #replayBatchSize: number;
  #siteCounter = 0;

  constructor(options: RelayOptions = {}) {
    const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
    this.#log = options.log ?? null;
    this.#onCursor = options.onCursor;
    this.#onLeave = options.onLeave;
    this.#authorize = options.authorize;
    this.#helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
    this.#replayBatchSize = options.replayBatchSize ?? DEFAULT_REPLAY_BATCH;

    this.#heartbeat =
      heartbeatMs > 0
        ? setInterval(() => {
            this.#reapStale();
          }, heartbeatMs)
        : null;

    // Do not hold the process open for a heartbeat timer in tests or scripts.
    this.#heartbeat?.unref?.();
  }

  /** Total clients connected. Used by tests and the health endpoint. */
  get clientCount(): number {
    let total = 0;
    for (const room of this.#rooms.values()) {
      total += room.size;
    }
    return total;
  }

  /**
   * Sockets connected but not yet authorised.
   *
   * Exposed because a number that only goes up is an attack, not a bug. Watched in
   * tests and reported by the metrics endpoint.
   */
  get pendingCount(): number {
    return this.#pending.size;
  }

  /** Number of rooms with at least one client. */
  get roomCount(): number {
    return this.#rooms.size;
  }

  /**
   * Mint a unique site ID for a new connection.
   *
   * Site identity must be unique across the whole document set, not merely
   * within one server process, or two clients could be assigned the same site
   * and collide on element IDs. A random component plus a counter makes that
   * safe across restarts and multiple instances.
   */
  #mintSite(): string {
    this.#siteCounter += 1;
    const entropy = Math.random().toString(36).slice(2, 8);
    return `c${this.#siteCounter}-${entropy}`;
  }

  /**
   * Register a socket and begin relaying for it.
   *
   * @param onOps receives each batch of inbound operations after it has been
   *   broadcast, so a caller can persist them.
   *
   *   The payload is deliberately typed as opaque `JsonValue[]` rather than
   *   `Operation[]`. This layer does not know what an operation contains, and
   *   casting to a shape it has not checked would be a lie that TypeScript
   *   correctly refuses. Validation belongs to the CRDT (ADR-0004); a caller
   *   that needs real operations validates them there.
   */
  attach(socket: WebSocket, documentId: string, onOps?: (ops: readonly JsonValue[]) => void): void {
    const requiresAuth = this.#authorize !== undefined;

    const client: Client = {
      socket,
      site: this.#mintSite(),
      documentId,
      lastSeen: Date.now(),
      backpressureHits: 0,
      subject: null,
      // No authoriser configured means there is nothing to wait for, so the client
      // is admitted straight away. One flag, one code path.
      authenticated: !requiresAuth,
      admitting: false,
      helloDeadline: requiresAuth ? Date.now() + this.#helloTimeoutMs : null,
    };

    if (client.authenticated) {
      // #admit joins the room and sends the welcome, deferring until the socket is
      // open. That deferral matters: attach() runs inside a handleUpgrade callback
      // where readyState is still CONNECTING, and an immediate send would be
      // silently dropped -- so the client would never learn its site id, could not
      // mint unique element IDs, and two clients would collide on the same IDs.
      this.#admit(client);
    } else {
      this.#pending.add(client);
    }

    socket.on('message', (data: Buffer) => {
      client.lastSeen = Date.now();

      const parsed = this.#parse(data.toString('utf8'));
      if (parsed === null) {
        // Unparseable or hostile input: drop it. Never echo the payload back,
        // which would let a client reflect arbitrary bytes at the server log.
        this.#send(client, {
          type: 'error',
          code: 'BAD_MESSAGE',
          message: 'Frame could not be parsed.',
        });
        return;
      }

      this.#handle(client, parsed, onOps);
    });

    socket.on('close', () => {
      this.#leave(client);
    });

    socket.on('error', () => {
      // The close handler does the cleanup. An unhandled 'error' event on a
      // WebSocket throws, so this listener must exist even though it does
      // nothing.
      this.#leave(client);
    });
  }

  /**
   * Bring an authorised client into the room and greet it.
   *
   * Everything that makes a client able to affect or observe a document happens
   * here and nowhere else: joining the room, which is what broadcasts reach, and
   * the welcome that carries its site.
   *
   * Deliberately NOT clearing the hello deadline here. If the client was admitted
   * without ever having sent `hello` (no authoriser configured), the deadline is
   * already null; and if it was admitted by a real `hello`, the reaper has nothing
   * left to reap.
   */
  #admit(client: Client): void {
    if (!client.authenticated || client.admitting) {
      return;
    }

    client.admitting = true;

    try {
      // Admitted, so it must stop counting against the hello deadline whether or not
      // the join succeeds.
      this.#pending.delete(client);
      this.#join(client);
      this.#sendWelcome(client);
    } finally {
      client.admitting = false;
    }
  }

  /**
   * Send the welcome frame once the socket can actually carry it.
   *
   * Separate from {@link admit} because the two concerns differ: admission is a
   * decision, the socket's readiness is a fact about the network.
   */
  #sendWelcome(client: Client): void {
    const frame = {
      type: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      site: client.site,
      documentId: client.documentId,
      snapshot: [],
      seq: 0,
    } as const;

    if (client.socket.readyState === 1) {
      this.#send(client, frame);
      return;
    }

    client.socket.once('open', () => {
      this.#send(client, frame);
    });
  }

  /**
   * The single parse boundary.
   *
   * Nothing reaches the relay without passing through `parseClientMessage`, so
   * a hostile payload is rejected here rather than deeper in. Wrapping it keeps
   * that guarantee in one place and makes it obvious to a reviewer that no other
   * path exists.
   */
  #parse(raw: string): ClientMessage | null {
    return parseClientMessage(raw);
  }

  #join(client: Client): void {
    const room = this.#rooms.get(client.documentId) ?? new Set<Client>();
    room.add(client);
    this.#rooms.set(client.documentId, room);
  }

  #leave(client: Client): void {
    // Always, first. A pending client was never in a room, and a rejected one was
    // just removed from one, so returning early on "no room" would strand it here.
    this.#pending.delete(client);

    const room = this.#rooms.get(client.documentId);
    if (!room) {
      return;
    }

    room.delete(client);

    // Forget the departing client cursor. Without this, every client that ever
    // connected leaves a permanent phantom collaborator in everyone's UI.
    this.#presence.delete(presenceKey(client.documentId, client.site));

    // And forget its acknowledged position, so a closed tab stops holding the
    // compaction floor down. Otherwise one abandoned tab would block compaction
    // for a document forever.
    this.#onLeave?.(client.documentId, client.site);

    if (room.size === 0) {
      // Do not accumulate empty rooms: a long-lived server would otherwise leak
      // one entry per document ever opened.
      this.#rooms.delete(client.documentId);
      return;
    }

    // Tell the remaining clients someone left, so their cursors can be cleaned up.
    this.#broadcast(client.documentId, client.site, {
      type: 'presence',
      documentId: client.documentId,
      cursors: this.#cursorsFor(client.documentId),
    });
  }

  /**
   * Verify a token, and admit the client if it holds up.
   *
   * Failure closes the socket rather than merely refusing this one frame. A
   * connection that failed authorisation has no reason to send another, and
   * leaving it open means every future frame re-runs the same database lookup --
   * an unauthenticated client becomes a way to generate load for free.
   *
   * A repeated `hello` while this is in flight is ignored rather than queued. Two
   * concurrent authorisations for one socket would both admit, and admitting twice
   * would send two welcomes and two replays.
   */
  async #authenticate(client: Client, token: string, lastAppliedSeq: number): Promise<void> {
    const authorize = this.#authorize;

    if (authorize === undefined) {
      client.authenticated = true;
      this.#admit(client);
      void this.#replayFrom(client, lastAppliedSeq);
      return;
    }

    if (client.admitting) {
      return;
    }

    client.admitting = true;

    let result: AuthorizeResult;

    try {
      result = await authorize(client.documentId, token);
    } catch (error) {
      // An authoriser that throws has not said yes. Failing closed is the only safe
      // reading: the alternative is that a database blip grants access.
      process.stderr.write(
        `[relay] authorisation failed for ${client.documentId}: ${String(error)}\n`,
      );
      this.#reject(client, 'UNAUTHORIZED', 'Could not verify the session.');
      return;
    } finally {
      client.admitting = false;
    }

    if (!result.ok) {
      this.#reject(client, result.code, result.message);
      return;
    }

    // Anything that closed the socket while the check was in flight must not be
    // admitted afterwards. A client whose connection has already gone should not
    // be left in a room it can no longer be reached in.
    if (client.socket.readyState !== 1) {
      return;
    }

    client.subject = result.subject;
    client.helloDeadline = null;
    client.authenticated = true;

    this.#admit(client);

    // The client has just declared how much of the log it holds. Everything after
    // that point goes down the socket in one frame, so an offline client is current
    // again before it sends a single keystroke.
    void this.#replayFrom(client, lastAppliedSeq);
  }

  /** Tell a client why it is being disconnected, then disconnect it. */
  #reject(client: Client, code: ErrorCode, message: string): void {
    this.#send(client, { type: 'error', code, message });

    // 1008 is RFC 6455's "policy violation". The code is the part a client can act
    // on: 1000 would look like a normal shutdown and retry forever.
    this.#close(client, 1008, 'Unauthorized');
  }

  /**
   * Close a socket and take it out of every room.
   *
   * Goes through `#leave` rather than trusting the socket's own `close` event,
   * because that event may never arrive for a socket that was never fully open.
   */
  #close(client: Client, code: number, reason: string): void {
    this.#leave(client);

    try {
      if (client.socket.readyState === 0 || client.socket.readyState === 1) {
        client.socket.close(code, reason);
      } else {
        // Already closing or closed. `terminate()` is still needed to release the
        // handle, and is safe to call on a socket in any state.
        client.socket.terminate();
      }
    } catch {
      // A socket that refuses to close is already broken; nothing useful is left
      // to do and the reaper will clean up.
    }
  }

  #handle(
    client: Client,
    message: ClientMessage,
    onOps?: (ops: readonly JsonValue[]) => void,
  ): void {
    // Nothing but `hello` is accepted from a client that has not been authorised.
    //
    // This is the gate, and it is above the switch on purpose: a check inside each
    // case is a check someone eventually forgets to add. `hello` itself is exempt
    // because it is the frame that produces authorisation.
    if (!client.authenticated && message.type !== 'hello') {
      this.#reject(client, 'UNAUTHORIZED', 'Send hello before anything else.');
    }

    switch (message.type) {
      case 'hello': {
        if (message.protocolVersion !== PROTOCOL_VERSION) {
          this.#send(client, {
            type: 'error',
            code: 'BAD_MESSAGE',
            message: `Unsupported protocol version ${message.protocolVersion}; this server speaks ${PROTOCOL_VERSION}.`,
          });
          return;
        }

        if (client.authenticated) {
          // Already admitted: either there is no authoriser, or this is a second
          // hello on a live socket. Either way the client just wants catching up
          // again, which is harmless and cheaper than re-authorising.
          void this.#replayFrom(client, message.lastAppliedSeq);
          return;
        }

        void this.#authenticate(client, message.token, message.lastAppliedSeq);
        return;
      }

      case 'ops': {
        // The relay does not interpret operations. It forwards them verbatim.
        // Interpreting them here would duplicate the CRDT and create a second
        // source of truth.
        this.#broadcast(client.documentId, client.site, {
          type: 'ops',
          documentId: message.documentId,
          ops: message.ops,
        });

        // The operations are opaque JSON at this layer, so validating their shape
        // belongs to the CRDT rather than here. Narrowing the type is therefore a
        // cast, justified by that boundary: the relay genuinely has no opinion
        // about what an operation contains.
        onOps?.(message.ops);
        return;
      }

      case 'presence': {
        this.#presence.set(`${client.documentId}:${client.site}`, message.cursor);
        this.#broadcast(client.documentId, client.site, {
          type: 'presence',
          documentId: client.documentId,
          cursors: this.#cursorsFor(client.documentId),
        });
        return;
      }

      case 'resync': {
        // A client asking for a specific range, not for "everything since you
        // last saw me". The cursor travels with the request, so a reconnect onto a
        // different socket resumes from the client's own state rather than from
        // whatever the server happened to remember.
        void this.#replayFrom(client, message.sinceSeq);
        return;
      }

      default: {
        return;
      }
    }
  }

  /**
   * Send everything after `sinceSeq`, then acknowledge the new cursor.
   *
   * When the client has fallen below the compaction floor, the operations it is
   * missing no longer exist, so the first page is a snapshot baseline and the
   * client is told to REPLACE its document. Serving it a delta instead gives it a
   * document missing everything that was compacted away, with no error anywhere.
   *
   * Loops until a short page comes back. Only the short page terminates the loop:
   * stopping on an empty page instead would stop early whenever a batch happened
   * to divide evenly, leaving the client silently behind while the server reported
   * it as caught up.
   */
  async #replayFrom(client: Client, sinceSeq: number): Promise<void> {
    if (this.#log === null) {
      // No durable log configured. Say so honestly rather than reporting "synced"
      // for a catch-up that never happened.
      this.#send(client, {
        type: 'syncState',
        documentId: client.documentId,
        state: 'synced',
        pendingOps: 0,
        seq: sinceSeq,
      });
      return;
    }

    let cursor = sinceSeq;
    let baselineSent = false;

    try {
      for (let round = 0; round < MAX_REPLAY_ROUNDS; round += 1) {
        const page = await this.#log.readSince(client.documentId, cursor, this.#replayBatchSize);

        if (page.snapshot !== null && !baselineSent) {
          // Sent alone, ahead of any delta. If a delta arrived first the client
          // would apply it to a document it is about to discard.
          this.#send(client, {
            type: 'snapshot',
            documentId: client.documentId,
            elements: page.snapshot,
            ops: page.ops,
            seq: page.seq,
          });

          baselineSent = true;
          cursor = page.seq;

          if (page.ops.length < this.#replayBatchSize) {
            break;
          }

          continue;
        }

        if (page.ops.length > 0) {
          this.#send(client, {
            type: 'ops',
            documentId: client.documentId,
            ops: page.ops,
          });
        }

        cursor = page.seq;

        if (page.ops.length < this.#replayBatchSize) {
          break;
        }
      }
    } catch {
      // A storage failure must not leave the client believing it is current. It
      // will retry with jittered backoff, which is the recovery path that exists.
      this.#send(client, {
        type: 'error',
        code: 'INTERNAL',
        message: 'Could not read the operation log.',
      });
      return;
    }

    this.#send(client, {
      type: 'syncState',
      documentId: client.documentId,
      state: 'synced',
      pendingOps: 0,
      seq: cursor,
    });

    // Only now is this client actually current, so this is the moment its cursor
    // can be trusted. Reporting it earlier would let compaction prune below a
    // position the client has not reached.
    this.#onCursor?.(client.documentId, client.site, cursor);
  }

  /** Cursor offset by `${documentId}:${site}`, covering every open room. */
  readonly #presence = new Map<string, number | null>();

  #cursorsFor(documentId: string): Record<string, number> {
    const cursors: Record<string, number> = {};

    for (const [key, cursor] of this.#presence) {
      if (cursor === null || !key.startsWith(`${documentId}:`)) {
        continue;
      }
      const site = key.slice(documentId.length + 1);
      cursors[site] = cursor;
    }

    return cursors;
  }

  /**
   * Send to every client in a room except the sender.
   *
   * @param excludeSite the author, who already has the operation.
   */
  #broadcast(documentId: string, excludeSite: string, payload: ServerMessage): void {
    const room = this.#rooms.get(documentId);
    if (!room) {
      return;
    }

    for (const client of room) {
      if (client.site === excludeSite) {
        continue;
      }
      this.#send(client, payload);
    }
  }

  #send(client: Client, payload: ServerMessage): void {
    const readyState = client.socket.readyState;

    // 1 === WebSocket.OPEN. Compared numerically so this module needs no
    // runtime import of the ws package in tests that stub the socket.
    if (readyState !== 1) {
      return;
    }

    // bufferedAmount above this threshold means the client is not draining its
    // socket. Count consecutive hits and disconnect rather than buffer forever.
    if (client.socket.bufferedAmount > 1_000_000) {
      client.backpressureHits += 1;

      if (client.backpressureHits > MAX_BACKPRESSURE_FRAMES) {
        client.socket.close(1013, 'Client too slow');
        return;
      }
    } else {
      client.backpressureHits = 0;
    }

    client.socket.send(JSON.stringify(payload));
  }

  /*
   * Synchronous by design. It closes sockets and mutates in-memory sets, so there
   * is nothing to await. Declaring it async would imply a scheduling boundary
   * that does not exist and would make every call site need a floating promise.
   */
  #reapStale(): void {
    const cutoff = Date.now() - STALE_CONNECTION_MS;

    for (const room of [...this.#rooms.values()]) {
      for (const client of [...room]) {
        if (client.lastSeen < cutoff) {
          this.#close(client, 1001, 'Stale connection');
        }
      }
    }

    // Sockets that connected and never said hello are in no room, so the loop above
    // cannot see them. They are exactly the connections nobody is waiting for, so
    // they are the ones that must be swept.
    for (const client of [...this.#pending]) {
      if (client.helloDeadline !== null && Date.now() > client.helloDeadline) {
        this.#close(client, 1008, 'No hello');
      }
    }
  }

  /** Close every socket and stop the heartbeat. Synchronous by design. */
  close(): void {
    if (this.#heartbeat) {
      clearInterval(this.#heartbeat);
    }

    for (const room of this.#rooms.values()) {
      for (const client of room) {
        client.socket.close(1001, 'Server shutting down');
      }
    }

    // Pending sockets are in no room, so the loop above misses them. Leaving them
    // open would keep the process alive after close() returned.
    for (const client of this.#pending) {
      client.socket.close(1001, 'Server shutting down');
    }

    this.#pending.clear();
    this.#rooms.clear();
    this.#presence.clear();
  }
}

/**
 * Composite key for the presence map.
 *
 * Factored out because three separate sites read and write this map, and
 * building the key inline at each one invites a prefix-length mismatch that would
 * silently mis-attribute a cursor to the wrong document.
 */
function presenceKey(documentId: string, site: string): string {
  return `${documentId}:${site}`;
}
