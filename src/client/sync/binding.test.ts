/**
 * @vitest-environment jsdom
 *
 * Binding integration tests, against a real CodeMirror view.
 *
 * ── Why a real DOM ─────────────────────────────────────────────────────────
 * The dangerous failure mode of a CRDT/editor binding is not a crash. It is an
 * echo: the binding dispatches a change, the update listener fires, the binding
 * converts that change back into operations and broadcasts them, and the peer
 * sends them straight back. The document looks correct and the network is full of
 * no-ops forever.
 *
 * A mock editor cannot catch that, because the echo only exists when the listener
 * and the dispatch are wired to the same view. So this suite drives the actual
 * EditorView in jsdom, which is a real DOM implementation rather than a stub.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import { RgaDocument, type Operation } from '../../core/crdt/rga.js';
import { Replica, type LoggedOperation, type OperationLog } from '../../core/crdt/replica.js';
import { EditorBinding, type BindingAnomaly } from './binding.js';

class NullLog implements OperationLog {
  entries: LoggedOperation[] = [];

  load(): Promise<LoggedOperation[]> {
    return Promise.resolve([]);
  }

  append(entries: readonly LoggedOperation[]): Promise<void> {
    for (const entry of entries) {
      this.entries.push(entry);
    }
    return Promise.resolve();
  }

  truncateBefore(): Promise<void> {
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.entries = [];
    return Promise.resolve();
  }
}

interface Harness {
  readonly view: EditorView;
  readonly replica: Replica;
  readonly binding: EditorBinding;
  /** Every operation batch this client would put on the wire. */
  readonly broadcast: Operation[][];
  readonly anomalies: BindingAnomaly[];
  /** Type at the end, the way a user does. */
  type: (text: string) => void;
  replaceRange: (from: number, to: number, text: string) => void;
  text: () => string;
  destroy: () => void;
}

let harness: Harness | null = null;

/**
 * Build an editor wired the way `main.ts` wires it.
 *
 * The update listener has to be an extension, so it must exist before the
 * EditorState is created. The binding is therefore created against the view
 * afterwards; the listener resolves it through a closure, which is safe because
 * no transaction is dispatched until the harness returns.
 *
 * `broadcast` collects from ONE place: the binding's own `onLocalOperations`. Counting the
 * replica's callback instead would double-count, since the replica reports the same
 * operations.
 *
 * It used to collect from two places - this listener forwarded what `exportLocalChanges`
 * returned, AND the binding reported through `onLocalOperations`. That arrangement was the
 * reason the missing broadcast went unnoticed for so long:
 *
 *   - `main.ts` does exactly what this listener did NOT do. It calls `exportLocalChanges` and
 *     discards the result, so with the binding not broadcasting either, every keystroke's
 *     operations were computed and thrown away.
 *   - This harness forwarded them by hand, so every test exercised a wiring the application
 *     does not have. The tests were green and the application sent nothing to the server for
 *     the whole life of the project.
 *
 * So the listener here does what `main.ts` does - call `exportLocalChanges` and ignore the
 * result - and the binding broadcasts. The two are now wired identically, which is the only
 * way a test of the binding can say anything about the application.
 */
function create(site = 'local', initial = ''): Harness {
  const log = new NullLog();
  const broadcast: Operation[][] = [];
  const anomalies: BindingAnomaly[] = [];

  let binding: EditorBinding | null = null;

  const listener = EditorView.updateListener.of((update) => {
    if (!update.docChanged) {
      return;
    }

    // Deliberately ignores the return value, exactly as `main.ts` does. The binding
    // broadcasts; forwarding here as well would double-count every keystroke and would hide
    // the original bug behind a harness that was wired more carefully than the application.
    binding?.exportLocalChanges(update.changes);
  });

  const host = document.createElement('div');
  document.body.append(host);

  const view = new EditorView({
    parent: host,
    state: EditorState.create({ doc: initial, extensions: [listener] }),
  });

  const replica = new Replica({
    site,
    log,
    // No-op on purpose: the binding is the single source of broadcast operations,
    // and a second subscriber would only double-count in these tests.
    onOperations: () => undefined,
  });

  binding = new EditorBinding({
    view,
    replica,
    onLocalOperations: (ops) => broadcast.push([...ops]),
    onAnomaly: (anomaly) => anomalies.push(anomaly),
  });

  return {
    view,
    replica,
    binding,
    broadcast,
    anomalies,
    type: (value) => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: value } });
    },
    replaceRange: (from, to, text) => {
      view.dispatch({ changes: { from, to, insert: text } });
    },
    text: () => view.state.doc.toString(),
    destroy: () => {
      view.destroy();
      host.remove();
    },
  };
}

/** Create and start, which is the sequence `main.ts` uses. */
async function start(initial = '', site = 'local'): Promise<Harness> {
  const h = create(site, initial);
  await h.replica.init();
  h.binding.start();
  return h;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  harness?.destroy();
  harness = null;
});

describe('EditorBinding - local editing', () => {
  it('turns typed text into operations', async () => {
    harness = await start();

    harness.type('hello');

    expect(harness.text()).toBe('hello');
    expect(harness.replica.text).toBe('hello');
    expect(harness.broadcast.flat()).toHaveLength(5);
  });

  it('keeps the editor and the CRDT in step', async () => {
    harness = await start();

    harness.type('the quick brown fox');
    harness.replaceRange(3, 8, 'slow');

    expect(harness.text()).toBe(harness.replica.text);
  });

  it('handles two cursors in one transaction', async () => {
    harness = await start('ad');

    // Both edits are expressed in the pre-transaction document, which is exactly
    // the case the running offset exists for.
    harness.view.dispatch({
      changes: [
        { from: 1, insert: 'b' },
        { from: 1, insert: 'c' },
      ],
    });

    expect(harness.text()).toBe(harness.replica.text);
    expect(harness.text().length).toBe(4);
  });

  it('does not broadcast operations it generated itself', async () => {
    harness = await start();

    harness.type('hi');

    // Exactly one batch: the user's keystroke. An echo would show up here as a
    // second batch derived from the binding's own dispatch, and in production as
    // an endless ping-pong of no-op operations.
    expect(harness.broadcast).toHaveLength(1);
  });

  it('broadcasts every keystroke, which the application depends on', async () => {
    // The regression test for the worst bug this project has had.
    //
    // `exportLocalChanges` returned the operations and left broadcasting to the caller.
    // Undo, redo and start-up go through `#dispatchLocal`, which DOES broadcast - so the
    // class looked consistent, and every path except the one that matters was covered.
    //
    // `main.ts` calls `exportLocalChanges` from the editor's change listener and discards
    // the result. So the browser never sent a single typed character to the server: the local
    // IndexedDB log was correct, the editor looked right, the sync indicator said "Synced"
    // because the outbox was empty, and 901 tests passed. Two windows could not collaborate
    // and nothing was ever persisted server-side.
    //
    // Found by opening the built application in a browser, typing, and asking the server what
    // it held - `collab_operations_received_total` was absent entirely.
    //
    // This test is only meaningful because the harness above no longer forwards the returned
    // operations itself. While it did, this suite exercised a wiring the application does not
    // have, and every one of these tests was green.
    harness = await start();

    harness.type('abc');

    // One batch, three operations, delivered through `onLocalOperations` and nowhere else.
    expect(harness.broadcast).toHaveLength(1);
    expect(harness.broadcast.flat()).toHaveLength(3);
    expect(harness.replica.text).toBe('abc');
  });

  it('broadcasts nothing for a remote change', async () => {
    harness = await start();

    harness.binding.applyRemote(new RgaDocument('peer').insertAt(0, 'abc'));

    // The peer's text must never come back out as if this user had typed it.
    expect(harness.broadcast).toHaveLength(0);
    expect(harness.text()).toBe('abc');
  });
});

describe('EditorBinding - remote application', () => {
  it('applies a remote insert anchored to a local character', async () => {
    harness = await start('ac');

    // Anchored to the first character, so it belongs between 'a' and 'c'.
    const result = harness.binding.applyRemote([
      {
        type: 'insert',
        id: { site: 'peer', clock: 40 },
        origin: { site: 'local', clock: 1 },
        value: 'b',
      },
    ]);

    expect(harness.text()).toBe('abc');
    expect(harness.replica.text).toBe('abc');
    expect(result.unplaced).toEqual([]);
    expect(result.usedFallback).toBe(false);
  });

  it('applies a remote delete', async () => {
    harness = await start('abc');

    harness.binding.applyRemote([{ type: 'delete', target: { site: 'local', clock: 2 } }]);

    expect(harness.text()).toBe('ac');
    expect(harness.replica.text).toBe('ac');
  });

  it('reports operations it could not place', async () => {
    harness = await start('abc');

    const result = harness.binding.applyRemote([
      {
        type: 'insert',
        id: { site: 'ghost', clock: 1 },
        origin: { site: 'ghost', clock: 0 },
        value: '?',
      },
    ]);

    // Silent here would leave the client permanently behind with no way to know,
    // and no way to recover.
    expect(result.unplaced).toHaveLength(1);
  });

  it('does not move the caret when a remote edit lands before it', async () => {
    harness = await start('hello world');

    harness.view.dispatch({ selection: { anchor: 11 } });

    harness.binding.applyRemote([
      { type: 'insert', id: { site: 'peer', clock: 1 }, origin: null, value: '>' },
    ]);

    expect(harness.text()).toBe('>hello world');

    // The caret moved from 11 to 12, staying exactly where it was relative to the
    // text. A whole-document replace would have thrown it to 0, and the user would
    // lose their place on every keystroke a collaborator typed.
    expect(harness.view.state.selection.main.head).toBe(12);
  });

  it('converges with a peer given the same operations', async () => {
    harness = await start();
    harness.type('shared');

    // The peer receives exactly what this client would put on the wire, so both
    // sides hold the same element IDs and the merge is a real one.
    const peer = new RgaDocument('peer');
    peer.applyInAnyOrder(harness.broadcast.flat());

    harness.binding.applyRemote(peer.insertAt(6, '!'));

    expect(harness.replica.text).toBe(peer.toText());
    expect(harness.text()).toBe(harness.replica.text);
  });

  it('survives a burst of remote operations', async () => {
    harness = await start();
    const peer = new RgaDocument('peer');
    peer.applyInAnyOrder(harness.broadcast.flat());

    for (let round = 0; round < 25; round += 1) {
      harness.binding.applyRemote(peer.insertAt(0, 'x'));
    }

    expect(harness.text()).toBe(harness.replica.text);
    expect(harness.replica.checkInvariants()).toEqual([]);
  });
});

describe('EditorBinding - astral characters', () => {
  // CodeMirror counts UTF-16 code units and the CRDT counts code points, so an emoji is
  // two units in the editor and one element in the replica. The binding must translate,
  // or the replica and the screen drift apart without anything reporting it.
  const EMOJI = '\u{1F600}';

  it('keeps the CRDT in step when typing after an emoji, mid-text', async () => {
    harness = await start(`a${EMOJI}b`);

    harness.replaceRange(3, 3, 'X');

    expect(harness.text()).toBe(`a${EMOJI}Xb`);
    expect(harness.replica.text).toBe(harness.text());
    expect(harness.anomalies).toEqual([]);
  });

  it('deletes exactly one emoji and broadcasts exactly one delete', async () => {
    harness = await start(`${EMOJI}abc`);
    harness.broadcast.length = 0;

    harness.replaceRange(0, 2, '');

    expect(harness.text()).toBe('abc');
    expect(harness.replica.text).toBe('abc');
    expect(harness.broadcast.flat().filter((op) => op.type === 'delete')).toHaveLength(1);
  });

  it('applies a remote insert after an emoji as a minimal change, not a full replacement', async () => {
    harness = await start(`a${EMOJI}b`);

    // Elements are a=1, emoji=2, b=3, so anchoring to clock 2 puts X right after the emoji.
    const result = harness.binding.applyRemote([
      {
        type: 'insert',
        id: { site: 'peer', clock: 40 },
        origin: { site: 'local', clock: 2 },
        value: 'X',
      },
    ]);

    expect(harness.text()).toBe(`a${EMOJI}Xb`);
    expect(harness.replica.text).toBe(harness.text());
    expect(result.usedFallback).toBe(false);
    expect(harness.anomalies).toEqual([]);
  });

  it('applies a remote delete of the character after an emoji', async () => {
    harness = await start(`${EMOJI}abc`);

    // Elements are emoji=1, a=2, b=3, c=4: deleting clock 3 removes b.
    const result = harness.binding.applyRemote([
      { type: 'delete', target: { site: 'local', clock: 3 } },
    ]);

    expect(harness.text()).toBe(`${EMOJI}ac`);
    expect(harness.replica.text).toBe(harness.text());
    expect(result.usedFallback).toBe(false);
  });
});

describe('EditorBinding - undo and redo', () => {
  it('undoes a local insert', async () => {
    harness = await start();

    harness.type('hello');
    expect(harness.binding.undo()).toBe(true);

    expect(harness.text()).toBe('');
    expect(harness.replica.text).toBe('');
  });

  it('redoes what it undid', async () => {
    harness = await start();

    harness.type('hello');
    harness.binding.undo();
    harness.binding.redo();

    expect(harness.text()).toBe('hello');
    expect(harness.replica.text).toBe('hello');
  });

  it('reports false when there is nothing to undo', async () => {
    harness = await start();

    expect(harness.binding.undo()).toBe(false);
    expect(harness.binding.redo()).toBe(false);
  });

  it("undoes only the local user's work, not a collaborator's", async () => {
    harness = await start();

    harness.type('mine');
    harness.binding.applyRemote(new RgaDocument('peer').insertAt(0, 'theirs '));

    expect(harness.text()).toBe('theirs mine');

    harness.binding.undo();

    // The peer's text must survive. Undoing "my" edit cannot mean deleting
    // somebody else's work, which is the failure a two-undo-stack editor
    // produces and the reason the CRDT owns history exclusively.
    expect(harness.text()).toBe('theirs ');
  });

  it('broadcasts the undo compensation', async () => {
    harness = await start();

    harness.type('hi');
    const before = harness.broadcast.length;
    harness.binding.undo();

    // The compensation has to reach peers, or their copy keeps the text.
    expect(harness.broadcast.length).toBe(before + 1);
  });
});

describe('EditorBinding - start-up and recovery', () => {
  it('adopts editor text the CRDT does not have', async () => {
    // The user pasted before the binding existed. Dropping it would lose their
    // work silently, which is the worst possible failure at start-up.
    const h = create('local', 'pasted text');
    harness = h;
    await h.replica.init();
    h.binding.start();

    expect(h.replica.text).toBe('pasted text');
    expect(h.broadcast.flat()).toHaveLength('pasted text'.length);
  });

  it('shows a restored document the editor did not have', async () => {
    const h = create('local', '');
    harness = h;
    await h.replica.init();

    // What a reload from IndexedDB looks like: the CRDT has a document, the
    // editor starts empty.
    h.replica.applyRemote(new RgaDocument('previous-session').insertAt(0, 'restored'));
    h.binding.start();

    expect(h.text()).toBe('restored');
    expect(h.replica.text).toBe('restored');
  });

  it('repairs an editor that has drifted from the CRDT', async () => {
    const h = await start();

    h.type('correct');

    // Simulate the bug this exists for: something writes to a view without telling
    // the CRDT. A second view has no listener attached, so the CRDT genuinely does
    // not learn about the extra characters.
    const rogue = new EditorView({
      state: EditorState.create({ doc: `${h.text()}DRIFT` }),
    });

    const anomalies: BindingAnomaly[] = [];
    const probe = new EditorBinding({
      view: rogue,
      replica: h.replica,
      onLocalOperations: () => undefined,
      onAnomaly: (anomaly) => anomalies.push(anomaly),
    });

    probe.start();

    // The CRDT is authoritative: its log is durable and the rogue view is not.
    expect(rogue.state.doc.toString()).toBe(h.replica.text);
    expect(anomalies.map((a) => a.kind)).toContain('editor-drifted');
    rogue.destroy();
  });
});

describe('create helper', () => {
  it('builds an editor the tests can drive', async () => {
    // Guards the harness itself: if this broke, every other test in the file
    // would fail for a reason that has nothing to do with the binding.
    const h = create('local', 'abc');
    harness = h;
    await h.replica.init();

    expect(h.text()).toBe('abc');
    expect(h.replica.text).toBe('');

    h.binding.start();
    expect(h.replica.text).toBe('abc');
  });
});
