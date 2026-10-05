/**
 * The callbacks `createEditor` fires, and specifically the one that was missing.
 *
 * @vitest-environment jsdom
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE HAD NOT EXISTED
 * ---------------------------------------------------------------------------
 * There was no test for `createEditor` at all. Every callback in `EditorOptions` was exercised
 * only indirectly, if at all - and `onSelectionChange` did not exist, which is why nothing
 * noticed that presence was never sent.
 *
 * The symptom in the running application was a permanently blank collaborator count and
 * remote cursors that never moved, while `SyncTransport.sendPresence` sat fully implemented and
 * covered by its own tests. Every layer was tested; the connection between them was not.
 *
 * That is the same shape as the operations bug fixed alongside this one: a capability that is
 * correct in isolation, tested in isolation, and never invoked. The gap is always the wiring,
 * and wiring is only observable from above.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import { EditorState, EditorSelection } from '@codemirror/state';
import { afterEach, describe, expect, it } from 'vitest';

import { createEditor, type EditorHandle } from './editor.js';

/** One recorded callback invocation. */
interface SelectionEvent {
  readonly cursor: number | null;
  readonly selectedLength: number;
}

let handle: EditorHandle | null = null;
let host: HTMLElement | null = null;

/** Mount an editor and record everything it reports. */
function mount(initialContent = ''): {
  editor: EditorHandle;
  changes: number;
  docChanges: number;
  selections: SelectionEvent[];
} {
  host = document.createElement('div');
  document.body.append(host);

  let changes = 0;
  let docChanges = 0;
  const selections: SelectionEvent[] = [];

  handle = createEditor({
    parent: host,
    initialContent,
    documentTitle: 'Untitled',
    onChange: () => {
      changes += 1;
    },
    onDocChange: () => {
      docChanges += 1;
    },
    onSelectionChange: (cursor, selectedLength) => {
      selections.push({ cursor, selectedLength });
    },
  });

  return {
    editor: handle,
    get changes() {
      return changes;
    },
    get docChanges() {
      return docChanges;
    },
    selections,
  };
}

afterEach(() => {
  handle?.destroy();
  handle = null;
  host?.remove();
  host = null;
});

describe('createEditor reports document changes', () => {
  it('calls onChange with the new text', () => {
    const harness = mount();

    harness.editor.view.dispatch({ changes: { from: 0, insert: 'hello' } });

    expect(harness.changes).toBe(1);
    expect(harness.editor.view.state.doc.toString()).toBe('hello');
  });

  it('calls onDocChange once per document change', () => {
    const harness = mount();

    harness.editor.view.dispatch({ changes: { from: 0, insert: 'a' } });
    harness.editor.view.dispatch({ changes: { from: 1, insert: 'b' } });

    expect(harness.docChanges).toBe(2);
  });
});

describe('createEditor reports the cursor', () => {
  it('calls onSelectionChange when the cursor moves, with NO document change', () => {
    // THE regression test.
    //
    // A selection change produces no `docChanged`, and the update listener checked
    // `docChanged` before doing anything. So moving the cursor reported nothing at all - which
    // is why presence was never sent, and why the collaborator count stayed blank.
    //
    // This asserts the absence of the precondition as much as the presence of the callback: a
    // fix that only reported presence while typing would still pass a naive test, and still be
    // wrong, because most cursor movement is not typing.
    const harness = mount('hello world');

    expect(harness.changes).toBe(0);
    expect(harness.docChanges).toBe(0);

    // Focus first. The cursor is reported as null while the editor is unfocused, which is
    // correct - "not looking at this" is different from "looking at offset zero" - and the
    // first version of this test asserted an offset without focusing, so every expectation
    // read null.
    harness.editor.view.focus();
    harness.editor.view.dispatch({ selection: EditorSelection.cursor(4) });

    expect(harness.selections.length).toBeGreaterThan(0);

    const last = harness.selections[harness.selections.length - 1];

    expect(last?.cursor).toBe(4);
    expect(last?.selectedLength).toBe(0);

    // Still no document change. That is the whole point.
    expect(harness.changes).toBe(0);
    expect(harness.docChanges).toBe(0);
  });

  it('reports the length of a selection', () => {
    const harness = mount('hello world');

    harness.editor.view.focus();
    harness.editor.view.dispatch({
      selection: EditorSelection.range(2, 7),
    });

    const last = harness.selections[harness.selections.length - 1];

    expect(last?.cursor).toBe(7);
    expect(last?.selectedLength).toBe(5);
  });

  it('reports a null cursor when the editor is not focused', () => {
    // Null means "not looking at this", which is different from "looking at offset zero".
    // Without it every unfocused collaborator's name sits at the start of the document.
    const harness = mount('hello');

    harness.editor.view.focus();
    harness.editor.view.dispatch({ selection: EditorSelection.cursor(3) });

    expect(harness.selections[harness.selections.length - 1]?.cursor).toBe(3);

    // `EditorView` has no `blur()`. Focus is DOM state, so it is unfocused the way the browser
    // would do it - by blurring the element that holds it - rather than by a method that does
    // not exist.
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    harness.editor.view.dispatch({});

    expect(harness.selections[harness.selections.length - 1]?.cursor).toBeNull();
  });

  it('survives being given no callback at all', () => {
    // `onSelectionChange` is optional, and the listener must not assume it is present.
    const parent = document.createElement('div');

    document.body.append(parent);

    const bare = createEditor({
      parent,
      initialContent: 'x',
      documentTitle: 'Untitled',
      onChange: () => undefined,
    });

    expect(() => {
      bare.view.dispatch({ selection: EditorSelection.cursor(1) });
    }).not.toThrow();

    bare.destroy();
    parent.remove();
  });
});

describe('the editor handle', () => {
  it('exposes the initial content it was given', () => {
    const harness = mount('seeded');

    expect(harness.editor.view.state.doc.toString()).toBe('seeded');
  });

  it('destroys cleanly', () => {
    const harness = mount('x');

    expect(() => {
      harness.editor.destroy();
    }).not.toThrow();
  });
});

describe('EditorState is available for extensions', () => {
  it('is importable, which is what a caller needs to build one', () => {
    // A trivial guard on the import, because the whole point of passing ChangeSet through to
    // the caller is that they can build an extension before the state exists.
    expect(EditorState.create({ doc: 'y' }).doc.toString()).toBe('y');
  });
});
