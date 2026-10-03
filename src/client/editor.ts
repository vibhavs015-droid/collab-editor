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
 * ── Scope discipline ──────────────────────────────────────────────────────
 * Only what Phase 1 needs: plain text, undo/redo, bracket matching, and line
 * numbers. No syntax highlighting, no themes, no extensions beyond that.
 */

import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { EditorState, type Extension, type Transaction } from '@codemirror/state';
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
}

export interface EditorHandle {
  focus(): void;
  destroy(): void;
}

export function createEditor(options: EditorOptions): EditorHandle {
  const extensions: Extension[] = [
    lineNumbers(),
    highlightActiveLine(),
    drawSelection(),
    rectangularSelection(),
    // Ctrl+Z / Ctrl+Shift+Z, plus per-user tracking that Phase 2 will extend so
    // undo never reverts a collaborator's edit.
    history(),
    EditorView.lineWrapping,
    placeholder('Start typing…'),
    EditorState.tabSize.of(2),
    // Bindings ordered last-to-first in CodeMirror, so this later entry wins.
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        options.onChange(update.state.doc.toString());
      }
    }),
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
    focus: () => {
      view.focus();
    },
    destroy: () => {
      // Without this the view keeps observing DOM mutations after teardown,
      // which leaks and fires change callbacks for an editor that no longer exists.
      view.destroy();
    },
  };
}

export type { Transaction };
