/**
 * Sync status: the one place that decides what the indicator says.
 *
 * ── Why this is not just a string in main.ts ───────────────────────────────
 * The indicator is the only feedback a user gets about whether their work is safe
 * and shared. Getting it wrong is worse than not having it: a dot that says
 * "synced" while operations are queued locally teaches the user to trust a lie.
 *
 * Pulling the state machine out means it can be tested exhaustively without a DOM,
 * and it forces the states to be explicit rather than emerging from whichever
 * callback happened to run last.
 *
 * ── The states, and why they are not collapsed ─────────────────────────────
 *   synced     every operation is on the server
 *   pending    typed locally, waiting for a connection
 *   offline    no connection; the queue is growing
 *   connecting a reconnect is in progress
 *   conflict   operations arrived that this client could not place
 *   error      the server reported a problem
 *
 * "offline" and "pending" are deliberately separate. Both are safe, but one is
 * recovering on its own and the other is not, and a user needs to know which.
 * "conflict" is separate again because it needs a human: nothing will fix it but a
 * resync.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

/** Everything the indicator can report. */
export type SyncState =
  'starting' | 'connecting' | 'synced' | 'pending' | 'offline' | 'conflict' | 'error';

/** Inputs this module folds into a state. */
export interface SyncInputs {
  /** Connection state, straight from the transport. */
  readonly connection: 'connecting' | 'open' | 'closed';
  /** Operations waiting in the outbox for a connection. */
  readonly pendingOps: number;
  /** Last authoritative state the server reported. */
  readonly serverState: 'synced' | 'pending' | 'offline' | 'error' | null;
  /**
   * Operations a peer sent that this client could not place.
   *
   * Non-zero means the log has a gap, which no amount of waiting fixes.
   */
  readonly unplacedOps: number;
  /** Count of connected collaborators, excluding this client. */
  readonly peers: number;
}

/** A resolved state, ready to render. */
export interface SyncView {
  readonly state: SyncState;
  readonly label: string;
  /** Detail shown in the status bar. Empty when there is nothing worth saying. */
  readonly detail: string;
}

/**
 * Fold the inputs into the single truth the indicator shows.
 *
 * Total and side-effect free, so every combination of inputs can be asserted
 * rather than reasoned about. The ordering of the cases below IS the precedence:
 * a real problem always outranks a cosmetic one.
 */
export function resolveSync(inputs: SyncInputs): SyncView {
  const { connection, pendingOps, serverState, unplacedOps, peers } = inputs;

  // A gap in the log outranks everything. Nothing will resolve it by waiting, so
  // saying "synced" or "offline" would be actively misleading.
  if (unplacedOps > 0) {
    return {
      state: 'conflict',
      label: 'Needs catch-up',
      detail: `${unplacedOps} operation${unplacedOps === 1 ? '' : 's'} could not be applied; catching up`,
    };
  }

  if (serverState === 'error') {
    return {
      state: 'error',
      label: 'Sync problem',
      detail: 'The server reported an error',
    };
  }

  if (connection === 'closed') {
    // Queued operations are safe on disk. Say so, so "offline" does not read as
    // "lost".
    return {
      state: 'offline',
      label: pendingOps > 0 ? `Offline — ${pendingOps} queued` : 'Offline',
      detail: pendingOps > 0 ? 'Safe locally. Will send when reconnected.' : 'Safe locally',
    };
  }

  if (connection === 'connecting') {
    // The queue count is in the label, not only the detail. Two reconnect states
    // that look identical on screen but mean very different things is exactly the
    // ambiguity this indicator exists to remove.
    return {
      state: 'connecting',
      label: pendingOps > 0 ? `Reconnecting — ${pendingOps} queued` : 'Reconnecting',
      detail: 'Safe locally',
    };
  }

  if (pendingOps > 0) {
    return {
      state: 'pending',
      label: `Sending ${pendingOps}`,
      detail: 'Typed here, not yet on the server',
    };
  }

  if (serverState === 'offline') {
    // The server considers us behind. Locally we have nothing queued, so the
    // honest next step is to ask it for what is missing rather than to send.
    return {
      state: 'connecting',
      label: 'Catching up',
      detail: 'Fetching operations from the server',
    };
  }

  return {
    state: 'synced',
    label: 'Synced',
    detail: peers > 0 ? `${peers} other${peers === 1 ? '' : 's'} connected` : '',
  };
}

/** Text for the collaborator badge, or empty when alone. */
export function describePeers(peers: number): string {
  if (peers <= 0) {
    return '';
  }

  if (peers === 1) {
    return '1 collaborator';
  }

  return `${peers} collaborators`;
}
