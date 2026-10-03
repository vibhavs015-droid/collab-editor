/**
 * CodeMirror 6 setup.
 *
 * ── Why CodeMirror and not a hand-rolled textarea ─────────────────────────
 * A textarea is not an editor. It has no document model, no transactions, and
 * no undo stack you can inspect. Collaboration requires a document model that
 * supports fine-grained changes, and CodeMirror 6 already has one built around
 * exactly that.
 *
 * The alternative would spend a week on caret handling and selection bugs and
 * produce nothing that advances the CRDT — which is the part of this project
 * that matters. Recorded in ADR-0005.
 *
 * ── Why CodeMirror's undo stack is not used ───────────────────────────────
 * Phase 1 enabled CodeMirror's `history()` extension. Phase 4 removes it.
 *
 * Two undo stacks cannot both be right. CodeMirror's records the transactions it
 * dispatched; the CRDT's records the operations the user authored. When a
 * collaborator's keystroke arrives, one of the two has to decide what it means
 * for undo, and whichever is wrong produces an editor that reverts other people's
 * work.
 *
 * So the CRDT owns undo, exclusively. That is what every production CRDT editor
 * does, and the reason is not stylistic: only the CRDT knows which operations a
 * given user created, and therefore which ones it is legitimate to reverse.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { EditorState, type ChangeSet, type Extension } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  placeholder,
  drawSelection,
  highlightActiveLine,
  rectangularSelection,
} from '@codemirror/view';

export interface EditorOptions {
  /** Element the editor mounts into. */
  readonly parent: HTMLElement;
  readonly initialContent: string;
  readonly documentTitle: string;
  /** Called on every document change, with the full current text. */
  readonly onChange: (text: string) => void;
  /**
   * Called on every document change, with the change set in pre-transaction
   * coordinates.
   *
   * Supplied by the caller rather than created here because the CRDT binding has to
   * be an extension, and an extension has to exist before `EditorState.create`.
   * Passing the change set through keeps that constraint from leaking into the
   * binding, which would otherwise have to exist before the view it dispatches to.
   */
  readonly onDocChange?: (changes: ChangeSet) => void;
  /** Extra extensions, contributed by whoever needs to observe the editor. */
  readonly extraExtensions?: readonly Extension[];
}

/**
 * Undo and redo, supplied by whoever owns history.
 *
 * `true` means "handled, stop". Returning `false` lets CodeMirror fall through to
 * its next binding, which is what makes this safe to install before the CRDT
 * binding exists.
 */
export interface HistoryBinding {
  undo: () => boolean;
  redo: () => boolean;
}

export interface EditorHandle {
  readonly view: EditorView;
  focus(): void;
  destroy(): void;
  /**
   * Hand undo and redo to the CRDT binding.
   *
   * Separate from construction because the binding needs the view that
   * construction creates. The keymap closure resolves it at dispatch time, so
   * wiring it a moment later is invisible to the user.
   */
  bindHistory: (binding: HistoryBinding) => void;
}

export function createEditor(options: EditorOptions): EditorHandle {
  let history: HistoryBinding | null = null;

  const extensions: Extension[] = [
    lineNumbers(),
    highlightActiveLine(),
    drawSelection(),
    rectangularSelection(),
    EditorView.lineWrapping,
    placeholder('Start typing…'),
    EditorState.tabSize.of(2),
    // Ctrl+Z / Ctrl+Shift+Z, routed to the CRDT. See the note at the top of this
    // file for why CodeMirror's own history is not enabled.
    keymap.of([
      {
        key: 'Mod-z',
        run: () => history?.undo() ?? false,
      },
      // Undo on Windows/Linux is also conventionally Ctrl+Y, and a user pressing
      // it must not get a "no binding" dead key.
      { key: 'Mod-y', run: () => history?.redo() ?? false },
    ]),
    // Bindings ordered last-to-first in CodeMirror, so this later entry wins for
    // anything both claim.
    keymap.of([...defaultKeymap, indentWithTab]),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) {
        return;
      }

      options.onChange(update.state.doc.toString());
      options.onDocChange?.(update.changes);
    }),
    // Caller-supplied extensions last, so a caller can always override a default
    // this file provides.
    ...(options.extraExtensions ?? []),
  ];

  const state = EditorState.create({
    doc: options.initialContent,
    extensions,
  });

  const view = new EditorView({
    parent: options.parent,
    state,
  });

  return {
    view,
    focus: () => {
      view.focus();
    },
    destroy: () => {
      // Without this the view keeps observing DOM mutations after teardown,
      // which leaks and fires change callbacks for an editor that no longer exists.
      view.destroy();
    },
    bindHistory: (binding) => {
      history = binding;
    },
  };
}
