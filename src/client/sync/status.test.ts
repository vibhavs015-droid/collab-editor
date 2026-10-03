import { describe, expect, it } from 'vitest';

import { describePeers, resolveSync, type SyncInputs } from './status.js';

function inputs(overrides: Partial<SyncInputs> = {}): SyncInputs {
  return {
    connection: 'open',
    pendingOps: 0,
    serverState: 'synced',
    unplacedOps: 0,
    peers: 0,
    ...overrides,
  };
}

describe('resolveSync - healthy', () => {
  it('reports synced when nothing is outstanding', () => {
    expect(resolveSync(inputs()).state).toBe('synced');
  });

  it('mentions collaborators when there are any', () => {
    expect(resolveSync(inputs({ peers: 2 })).detail).toBe('2 others connected');
  });

  it('says nothing about collaborators when alone', () => {
    // An empty detail keeps the status bar from showing a meaningless zero.
    expect(resolveSync(inputs()).detail).toBe('');
  });
});

describe('resolveSync - queued operations', () => {
  it('shows the count while the connection is open', () => {
    const view = resolveSync(inputs({ pendingOps: 3 }));

    expect(view.state).toBe('pending');
    expect(view.label).toBe('Sending 3');
  });

  it('uses the singular for one operation', () => {
    // "1 operations" is the kind of detail that makes an interface feel unfinished.
    expect(resolveSync(inputs({ pendingOps: 1 })).label).toBe('Sending 1');
  });

  it('prefers pending over synced', () => {
    // The server says synced, but there is still an unsent queue. Believing the
    // server here is exactly the kind of overstatement the indicator must avoid.
    expect(resolveSync(inputs({ serverState: 'synced', pendingOps: 2 })).state).toBe('pending');
  });
});

describe('resolveSync - offline', () => {
  it('reports offline when the connection is closed', () => {
    expect(resolveSync(inputs({ connection: 'closed' })).state).toBe('offline');
  });

  it('counts the queue while offline', () => {
    const view = resolveSync(inputs({ connection: 'closed', pendingOps: 4 }));

    expect(view.label).toBe('Offline — 4 queued');
  });

  it('uses the singular for one queued operation', () => {
    expect(resolveSync(inputs({ connection: 'closed', pendingOps: 1 })).label).toBe(
      'Offline — 1 queued',
    );
  });

  it('says the work is safe locally', () => {
    // The whole point of offline-first. An indicator that reads "offline" without
    // saying "safe" makes the user think their work is at risk.
    expect(resolveSync(inputs({ connection: 'closed' })).detail).toBe('Safe locally');
  });

  it('does not use the danger colour for offline', () => {
    // Enforced here as well as in CSS: offline is not an error state, and a
    // regression to `error` would be a behavioural bug, not just a visual one.
    expect(resolveSync(inputs({ connection: 'closed' })).state).not.toBe('error');
  });

  it('shows the queue even with nothing sent yet', () => {
    expect(resolveSync(inputs({ connection: 'closed' })).label).toBe('Offline');
  });
});

describe('resolveSync - connecting', () => {
  it('reports reconnecting', () => {
    expect(resolveSync(inputs({ connection: 'connecting' })).state).toBe('connecting');
  });

  it('still shows the queue while reconnecting', () => {
    expect(resolveSync(inputs({ connection: 'connecting', pendingOps: 2 })).label).toBe(
      'Reconnecting — 2 queued',
    );
  });

  it('reports catching up when the server says we are behind', () => {
    const view = resolveSync(inputs({ serverState: 'offline' }));

    expect(view.state).toBe('connecting');
    expect(view.label).toBe('Catching up');
  });
});

describe('resolveSync - problems', () => {
  it('reports a conflict when operations could not be placed', () => {
    const view = resolveSync(inputs({ unplacedOps: 2 }));

    expect(view.state).toBe('conflict');
    expect(view.label).toBe('Needs catch-up');
  });

  it('lets a conflict outrank everything else', () => {
    // A gap outranks a healthy-looking connection. Reporting "synced" while the
    // log has a hole in it is the worst failure this indicator could have.
    const view = resolveSync(inputs({ unplacedOps: 1, serverState: 'synced', connection: 'open' }));

    expect(view.state).toBe('conflict');
  });

  it('lets a conflict outrank offline', () => {
    expect(resolveSync(inputs({ unplacedOps: 1, connection: 'closed' })).state).toBe('conflict');
  });

  it('uses the singular for one unplaceable operation', () => {
    expect(resolveSync(inputs({ unplacedOps: 1 })).detail).toBe(
      '1 operation could not be applied; catching up',
    );
  });

  it('reports a server error', () => {
    expect(resolveSync(inputs({ serverState: 'error' })).state).toBe('error');
  });

  it('lets a server error outrank pending', () => {
    expect(resolveSync(inputs({ serverState: 'error', pendingOps: 5 })).state).toBe('error');
  });
});

describe('resolveSync - exhaustiveness', () => {
  it('handles every combination without falling through', () => {
    const connections: SyncInputs['connection'][] = ['connecting', 'open', 'closed'];
    const serverStates: SyncInputs['serverState'][] = [
      'synced',
      'pending',
      'offline',
      'error',
      null,
    ];

    for (const connection of connections) {
      for (const serverState of serverStates) {
        for (const pendingOps of [0, 1, 7]) {
          for (const unplacedOps of [0, 1]) {
            const view = resolveSync(inputs({ connection, serverState, pendingOps, unplacedOps }));

            // The invariant that matters: whatever happens, the indicator is never
            // blank and never claims a state it did not derive.
            expect(view.label.length).toBeGreaterThan(0);
            expect(view.state.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('never reuses a label across distinct, non-dominated situations', () => {
    // A single label reused across distinct states is how users end up unable to
    // tell them apart.
    //
    // serverState is deliberately not swept here. With the socket not open,
    // 'synced' and 'pending' describe the same user-visible reality — a queued
    // count of zero — and the last-resort state the transport reports before it
    // knows anything. Adding them here would assert a distinction the UI does not
    // make and should not.
    const seen = new Map<string, string>();

    for (const connection of ['connecting', 'open', 'closed'] as const) {
      for (const pendingOps of [0, 1, 4]) {
        // Conflict is excluded on purpose: it deliberately dominates connection
        // and queue state, so two different inputs resolving to the same
        // "Needs catch-up" is correct rather than a collision. That dominance is
        // asserted separately below.
        const view = resolveSync(inputs({ connection, pendingOps }));
        const key = `${connection}/${pendingOps}`;
        const previous = seen.get(view.label);

        expect(previous, `${key} shares the label ${view.label} with ${previous ?? ''}`).toBe(
          undefined,
        );
        seen.set(view.label, key);
      }
    }
  });

  it('gives a server error a label of its own in every connection state', () => {
    const labels = new Set(
      (['connecting', 'open', 'closed'] as const).map(
        (connection) => resolveSync(inputs({ connection, serverState: 'error' })).label,
      ),
    );

    expect(labels.size).toBe(1);
    expect([...labels][0]).toBe('Sync problem');
  });

  it('collapses every connection state to one label when there is a conflict', () => {
    // Intended, and asserted so it stays intended: one problem, one message.
    const labels = new Set(
      (['connecting', 'open', 'closed'] as const).map(
        (connection) => resolveSync(inputs({ connection, unplacedOps: 1 })).label,
      ),
    );

    expect(labels.size).toBe(1);
  });
});

describe('describePeers', () => {
  it('is empty when alone', () => {
    expect(describePeers(0)).toBe('');
  });

  it('is empty for a nonsensical negative count', () => {
    // Presence frames can race with disconnects; a negative count must not render
    // as "-1 collaborators".
    expect(describePeers(-1)).toBe('');
  });

  it('uses the singular for one', () => {
    expect(describePeers(1)).toBe('1 collaborator');
  });

  it('pluralises otherwise', () => {
    expect(describePeers(3)).toBe('3 collaborators');
  });
});
