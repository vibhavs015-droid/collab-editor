/**
 * The one shape used to talk about "what the document currently shows".
 *
 * A separate module so diff.ts, the CodeMirror binding, and the tests all agree
 * on the type without importing each other. Importing the binding from core
 * would invert the dependency direction and put CodeMirror inside the CRDT's
 * blast radius.
 *
 * ASCII only. See the encoding note in rga.ts.
 */

/** One visible character, identified the way the CRDT identifies it. */
export interface ElementSnapshot {
  /** Canonical element ID string. Unique within a document, stable forever. */
  readonly key: string;
  /** Exactly one character. */
  readonly value: string;
}
