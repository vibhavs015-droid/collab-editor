# 0005 — CodeMirror 6, not a hand-rolled editor

**Status:** Accepted
**Date:** 2026-10-03
**Phase:** 1

## Context

Phase 1 needs a text editor that supports collaborative editing later. The two
options are writing one, or using CodeMirror 6.

The naive read is "a textarea is simpler". But a textarea is not an editor. It
exposes no document model, no transactions, no addressable change ranges, and no
inspectable undo history. Every one of those is required to apply a CRDT
operation as a precise, minimal edit.

## Decision

**CodeMirror 6**, used for the editing surface only. The CRDT remains
hand-written in `src/core`, and CodeMirror is wired to it in Phase 3.

## Rationale

**Collaboration needs a real document model.** When a remote insert arrives, it
must be applied as a targeted change, not by replacing the entire document and
losing the cursor and selection. CodeMirror's `EditorState`/`Transaction` model is
built for exactly this. Retrofitting that onto a textarea means building it
yourself.

**The cost of hand-rolling is a week of irrelevant work.** Caret handling,
selection across lines, IME composition for non-Latin input, clipboard behaviour,
and accessibility are all hard, all already solved, and none of them advance the
CRDT — which is the part this project exists to demonstrate.

**Scope discipline.** Only line numbers, history, bracket-free plain text,
line wrapping, and the default keymap are enabled. No syntax highlighting, no
themes, no plugins. Every unnecessary extension is surface area someone must
later justify in review.

**Undo is separable.** CodeMirror's `history()` gives correct single-user undo.
Phase 2 needs _per-user_ undo that never reverts a collaborator's edit. That work
lives in our CRDT and hooks into CodeMirror through an extension — CodeMirror
does not block it.

## Consequences

**Good**

- Phase 3 can apply CRDT operations without rewriting the editor
- Correct IME and accessibility behaviour for free — matters for a document
  editor that must handle Hindi, Arabic, and CJK input
- The CRDT stays the intellectual centre of the project

**Bad**

- 280 kB of JavaScript before any application code (91 kB gzipped). Acceptable
  for a rich text editor, and irrelevant for a tool where correctness is the point
- One external dependency in the client bundle, which must be justified in review
- CodeMirror's model is opinionated. Any CRDT design that assumes wholesale
  document replacement would need rethinking

## Alternatives rejected

| Option                    | Why rejected                                                                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<textarea>`              | No document model. Every CRDT operation would degrade to full-document replacement, destroying cursor and selection on every remote edit.                                                      |
| Monaco (VS Code's engine) | Excellent, but ~5 MB and designed as a standalone IDE. Disproportionate for a document editor.                                                                                                 |
| ProseMirror / Tiptap      | Built for rich text with a schema-driven document model. Substantially more machinery than plain-text collaboration needs, and the schema fights a character-level CRDT.                       |
| Yjs + y-codemirror.next   | The fastest path to working collaboration, and explicitly rejected — this project exists to implement the CRDT itself. Yjs is noted in `docs/benchmarks/` as a Phase 6 comparison target only. |
