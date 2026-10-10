/**
 * The bridge between CodeMirror and the CRDT.
 *
 * -- The one invariant that matters -----------------------------------------
 * After every turn of the event loop, `view.state.doc.toString()` equals
 * `replica.text`. Everything else here is in service of that.
 *
 * Break it and the editor is lying: what is on screen is not what will be saved,
 * and the user has no way to tell. So every dispatch in this file is followed by
 * a check, and a mismatch is repaired from the CRDT rather than tolerated.
 *
 * -- Why operations do not round-trip ---------------------------------------
 * A naive binding dispatches a change, sees the update listener fire, and
 * converts that change back into operations to broadcast. That is how a
 * collaborator's keystroke gets echoed back to them, applied again, and turned
 * into an infinite loop of no-op operations.
 *
 * The `#reflecting` flag prevents that. While it is set, the update listener
 * ignores the transaction, because those operations were already produced
 * elsewhere. This is the same class of problem as a build tool echoing its own
 * output back into its input, and the fix is the same: a one-way marker.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import type { ChangeSet } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

import {
  applyChanges,
  diffVisible,
  fullReplacement,
  snapshotText,
  type ElementChange,
} from '../../core/crdt/diff.js';
import type { Operation } from '../../core/crdt/rga.js';
import { applyLocalEdits, type LocalEdit } from '../../core/crdt/localEdits.js';
import type { Replica } from '../../core/crdt/replica.js';

/**
 * A divergence the binding detected and repaired.
 *
 * Surfaced rather than swallowed: a binding that quietly repairs itself is a
 * binding whose bug nobody will ever find.
 */
export interface BindingAnomaly {
  readonly kind: 'editor-drifted' | 'diff-failed' | 'unplaced-operations' | 'local-divergence';
  readonly detail: string;
}

export interface BindingOptions {
  readonly view: EditorView;
  readonly replica: Replica;
  /** Called with operations the user authored, for broadcast. */
  readonly onLocalOperations: (ops: readonly Operation[]) => void;
  readonly onAnomaly?: (anomaly: BindingAnomaly) => void;
  /** Called after any applied change, for counts and status. */
  readonly onChange?: (text: string) => void;
}

/** What happened when a batch of remote operations was applied. */
export interface RemoteApplyResult {
  /** Operations the replica could not place. Non-empty means a resync. */
  readonly unplaced: readonly Operation[];
  /** True when a minimal change set could not be produced and text was replaced. */
  readonly usedFallback: boolean;
}

export class EditorBinding {
  readonly #view: EditorView;
  readonly #replica: Replica;
  readonly #onLocalOperations: BindingOptions['onLocalOperations'];
  readonly #onAnomaly: BindingOptions['onAnomaly'];
  readonly #onChange: BindingOptions['onChange'];

  /** Set while this class is the one dispatching. See the note at the top. */
  #reflecting = false;
  #detached = false;

  constructor(options: BindingOptions) {
    this.#view = options.view;
    this.#replica = options.replica;
    this.#onLocalOperations = options.onLocalOperations;
    this.#onAnomaly = options.onAnomaly;
    this.#onChange = options.onChange;
  }

  /**
   * Open the document.
   *
   * If the editor already holds text and the CRDT does not, the editor's content
   * wins and becomes operations. That case is "the user pasted into an editor
   * before the binding existed", and dropping it would lose their work silently.
   */
  start(): void {
    const editorText = this.#view.state.doc.toString();

    if (this.#replica.text === '' && editorText !== '') {
      this.#dispatchLocal(() => {
        if (editorText === '') {
          return [];
        }
        return this.#replica.insertAt(0, editorText);
      });
    }

    if (this.#view.state.doc.toString() !== this.#replica.text) {
      // A discrepancy here means the editor and the CRDT came up holding different
      // documents. Reporting it is what makes the next occurrence debuggable rather
      // than mysterious.
      this.#report({
        kind: 'editor-drifted',
        detail: 'editor text did not match the CRDT at start-up; rebuilt from the CRDT',
      });
    }

    // Whatever the source, the two must agree before anything else happens.
    this.#reconcile();
  }

  /**
   * Apply operations from a peer.
   *
   * @returns what could not be placed, which the caller turns into a resync
   *   request. Reporting it is essential: an operation anchored to an element
   *   this client has never seen will never apply on its own, and without a
   *   resync the client is silently, permanently behind.
   */
  applyRemote(ops: readonly Operation[]): RemoteApplyResult {
    const before = this.#replica.visibleElements();
    const beforeText = this.#view.state.doc.toString();

    if (beforeText !== snapshotText(before)) {
      // Already out of step before this batch arrived. Repair first, so the diff
      // below is computed against text the replica actually believes in.
      this.#report({
        kind: 'editor-drifted',
        detail: 'editor text did not match the CRDT before applying remote operations',
      });
      this.#reconcile();
    }

    const unplaced = this.#replica.applyRemote(ops);

    if (unplaced.length > 0) {
      this.#report({
        kind: 'unplaced-operations',
        detail: `${unplaced.length} operation(s) could not be placed; a resync is required`,
      });
    }

    const usedFallback = this.#reflect(before, this.#view.state.doc.toString());
    return { unplaced, usedFallback };
  }

  /**
   * Undo the most recent local edit.
   *
   * @returns true when something was undone, which is what the keymap needs to
   *   stop CodeMirror from trying anything else.
   */
  undo(): boolean {
    const before = this.#replica.visibleElements();

    const ops = this.#dispatchLocal(() => this.#replica.undo());

    if (ops.length === 0) {
      return false;
    }

    this.#reflect(before, this.#view.state.doc.toString());
    return true;
  }

  redo(): boolean {
    const before = this.#replica.visibleElements();

    const ops = this.#dispatchLocal(() => this.#replica.redo());

    if (ops.length === 0) {
      return false;
    }

    this.#reflect(before, this.#view.state.doc.toString());
    return true;
  }

  get canUndo(): boolean {
    return this.#replica.canUndo;
  }

  get canRedo(): boolean {
    return this.#replica.canRedo;
  }

  detach(): void {
    this.#detached = true;
  }

  /**
   * Convert the changes in an update into operations, apply them, and BROADCAST them.
   *
   * CodeMirror's ChangeSet reports positions in the coordinates of the state the
   * transaction started from, and every change in one set uses those same
   * coordinates. The translation into the running document lives in
   * `applyLocalEdits`, which is tested without a DOM.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS CALLS `onLocalOperations`, AND WHY IT USED NOT TO
   * ---------------------------------------------------------------------------
   * It used to RETURN the operations and let the caller send them. Every other mutation
   * path here - undo, redo, title - goes through `#dispatchLocal`, which broadcasts. This one
   * did not, and it is the path EVERY KEYSTROKE takes.
   *
   * The consequence was that the browser never sent a single typed character to the server.
   * The local IndexedDB log was correct, so offline-first worked, the document looked right,
   * the sync indicator said "Synced" because the outbox was empty, and 901 tests passed. Two
   * windows could not collaborate, nothing was ever persisted server-side, and a raw
   * WebSocket was the only thing in the entire investigation that ever reached the store.
   *
   * Found by opening the built application in a browser, typing, and asking the server what
   * it had: `collab_operations_received_total` was absent, meaning the counter had never been
   * incremented by anything except a hand-written probe.
   *
   * Returning the operations as well is kept, because it is useful and costs nothing. But the
   * broadcast is no longer the caller's responsibility: a binding that can be used without
   * knowing to forward its output is a footgun, and this one was stepped in.
   */
  exportLocalChanges(changes: ChangeSet): Operation[] {
    if (this.#reflecting || this.#detached) {
      return [];
    }

    const edits: LocalEdit[] = [];

    changes.iterChanges((fromBefore, toBefore, _fromAfter, _toAfter, inserted) => {
      edits.push({ from: fromBefore, to: toBefore, inserted: inserted.toString() });
    });

    const ops = applyLocalEdits(edits, this.#replica);

    if (ops.length > 0) {
      this.#onLocalOperations(ops);
    }

    // The self-check the remote path already has, and this one did not.
    //
    // `applyLocalEdits` is the one place both coordinate systems are visible at once - it
    // converts the editor's UTF-16 offsets to element indices - so it is exactly where a
    // conversion bug can put the wrong character in the document. The remote path has compared
    // the editor against the replica since Phase 4; the local path did not, which meant a
    // misplacement would be invisible until some LATER remote operation happened to expose it,
    // long after the keystroke that caused it.
    //
    // Reported as its own kind rather than as `editor-drifted`, because the repair is the same
    // but the CAUSE is not: drifted means the replica changed underneath the editor, and this
    // means the editor and replica disagreed immediately after a local edit, which points at the
    // offset conversion rather than at anything the network did.
    //
    // Cost is one string comparison per keystroke that produced operations. `doc.toString()` is
    // the document; at 20,000 characters that is a single ~20 kB build and compare, which is
    // noise next to the diff CodeMirror already does for the same text. Measured rather than
    // assumed - see the note in binding.test.ts.
    if (ops.length > 0 && this.#view.state.doc.toString() !== this.#replica.text) {
      this.#report({
        kind: 'local-divergence',
        detail:
          `the editor disagreed with the replica immediately after a local edit ` +
          `(${String(edits.length)} edit(s), ${String(ops.length)} operation(s)); replaced the document`,
      });

      this.#reconcile();
    }

    return ops;
  }

  /** Run a replica mutation, broadcast its operations, and keep the editor out of it. */
  #dispatchLocal(produce: () => Operation[]): Operation[] {
    this.#reflecting = true;
    let ops: Operation[];

    try {
      ops = produce();
    } finally {
      this.#reflecting = false;
    }

    if (ops.length > 0) {
      this.#onLocalOperations(ops);
    }

    return ops;
  }

  /**
   * Make the editor show what the CRDT now says, with the smallest change set
   * that does it.
   *
   * @param before the visible elements as they were before the mutation
   * @returns true when the minimal path failed and the whole document was
   *   replaced. That should be impossible; it is reported rather than hidden.
   */
  #reflect(before: ReturnType<Replica['visibleElements']>, beforeText: string): boolean {
    const after = this.#replica.visibleElements();
    const target = snapshotText(after);

    if (beforeText === target) {
      // No visible change. Still worth reporting, because selection and history
      // are unaffected and dispatching an empty transaction would not be.
      this.#onChange?.(target);
      return false;
    }

    let changes = diffVisible(before, after);

    if (changes !== null && applyChanges(beforeText, changes) !== target) {
      // Belt and braces. The diff is constructed to be exact, and verifying its
      // output costs one string build. Cheap insurance against putting text on
      // screen that disagrees with what gets saved.
      changes = null;
      this.#report({
        kind: 'diff-failed',
        detail: 'minimal change set did not reproduce the CRDT text; replaced the document',
      });
    }

    if (changes === null) {
      changes = fullReplacement(beforeText, target);
      this.#dispatch(changes);

      if (this.#view.state.doc.toString() !== target) {
        this.#report({
          kind: 'editor-drifted',
          detail: 'full replacement still did not match the CRDT',
        });
      }

      return true;
    }

    this.#dispatch(changes);
    return false;
  }

  /**
   * Force the editor to match the CRDT.
   *
   * The repair path. Used once at startup, and whenever a mismatch is detected:
   * at that point the CRDT is authoritative because its operation log is
   * durable and the editor's text is not.
   */
  #reconcile(): void {
    const target = this.#replica.text;
    const current = this.#view.state.doc.toString();

    if (current === target) {
      this.#onChange?.(target);
      return;
    }

    this.#dispatch(fullReplacement(current, target));
    this.#onChange?.(target);
  }

  #dispatch(changes: readonly ElementChange[]): void {
    if (changes.length === 0) {
      return;
    }

    this.#reflecting = true;
    try {
      // CodeMirror maps the selection and scroll position through a change set,
      // which is the entire reason for the minimal-diff approach: a whole-document
      // replace would throw the caret to the top of the file on every keystroke
      // from a collaborator.
      this.#view.dispatch({ changes: changes.map((change) => ({ ...change })) });
    } finally {
      this.#reflecting = false;
    }

    this.#onChange?.(this.#view.state.doc.toString());
  }

  #report(anomaly: BindingAnomaly): void {
    this.#onAnomaly?.(anomaly);
  }
}
