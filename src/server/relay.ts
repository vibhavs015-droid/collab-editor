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
}

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

export interface RelayOptions {
  /** Milliseconds between pings. Set to 0 to disable, for tests. */
  readonly heartbeatMs?: number;
}

export class Relay {
  readonly #rooms = new Map<string, Set<Client>>();
  readonly #heartbeat: ReturnType<typeof setInterval> | null;
  #siteCounter = 0;

  constructor(options: RelayOptions = {}) {
    const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;

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
    const client: Client = {
      socket,
      site: this.#mintSite(),
      documentId,
      lastSeen: Date.now(),
      backpressureHits: 0,
    };

    this.#join(client);

    // Wait for 'open' before sending. When attach() runs inside a
    // handleUpgrade callback the socket's readyState is still CONNECTING, so an
    // immediate send is silently dropped by the readyState guard and the client
    // never receives its site id -- it then cannot mint unique element IDs, and
    // two clients collide on the same IDs and corrupt the document.
    const sendWelcome = (): void => {
      this.#send(client, {
        type: 'welcome',
        protocolVersion: PROTOCOL_VERSION,
        site: client.site,
        documentId,
        snapshot: [],
        clock: 0,
      });
    };

    if (socket.readyState === 1) {
      sendWelcome();
    } else {
      socket.once('open', sendWelcome);
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
    const room = this.#rooms.get(client.documentId);
    if (!room) {
      return;
    }

    room.delete(client);

    // Forget the departing client cursor. Without this, every client that ever
    // connected leaves a permanent phantom collaborator in everyone's UI.
    this.#presence.delete(presenceKey(client.documentId, client.site));

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

  #handle(
    client: Client,
    message: ClientMessage,
    onOps?: (ops: readonly JsonValue[]) => void,
  ): void {
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
        // Phase 4 replays the operation log for a reconnecting client. For now
        // the acknowledgement is enough to prove the message is handled.
        this.#send(client, {
          type: 'syncState',
          documentId: client.documentId,
          state: 'synced',
          pendingOps: 0,
          clock: 0,
        });
        return;
      }

      default: {
        return;
      }
    }
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
          client.socket.close(1001, 'Stale connection');
          this.#leave(client);
        }
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
