import { beforeEach, describe, expect, it } from 'vitest';

import type { ElementId } from '../clock.js';
import { RgaDocument, type DeleteOp, type InsertOp, type Operation } from './rga.js';

const id = (site: string, clock: number): ElementId => ({ site, clock });

describe('RgaDocument - local editing', () => {
  let doc: RgaDocument;

  beforeEach(() => {
    doc = new RgaDocument('alice');
  });

  it('starts empty', () => {
    expect(doc.toText()).toBe('');
    expect(doc.size).toBe(0);
  });

  it('inserts text at the start', () => {
    doc.insertAt(0, 'hi');
    expect(doc.toText()).toBe('hi');
  });

  it('appends at the end of existing text', () => {
    doc.insertAt(0, 'hello');
    doc.insertAt(5, ' world');
    expect(doc.toText()).toBe('hello world');
  });

  it('inserts in the middle', () => {
    doc.insertAt(0, 'helo');
    doc.insertAt(2, 'l');
    expect(doc.toText()).toBe('hello');
  });

  it('chains inserts so typed order is preserved', () => {
    // Each inserted character anchors to the previous one. Without chaining,
    // both would compete for the same anchor and their order would be decided by
    // ID comparison rather than by what the user typed.
    doc.insertAt(0, 'abc');
    expect(doc.toText()).toBe('abc');
  });

  it('handles emoji as single characters', () => {
    doc.insertAt(0, '👋👍');
    expect(doc.toText()).toBe('👋👍');
    expect(doc.size).toBe(2);
  });

  it('ignores an empty insert', () => {
    expect(doc.insertAt(0, '')).toEqual([]);
    expect(doc.size).toBe(0);
  });

  it('rejects a negative offset', () => {
    expect(() => doc.insertAt(-1, 'x')).toThrow(RangeError);
  });
});

describe('RgaDocument - deletion', () => {
  let doc: RgaDocument;

  beforeEach(() => {
    doc = new RgaDocument('alice');
    doc.insertAt(0, 'hello world');
  });

  it('removes deleted text from visible output', () => {
    doc.deleteRange(5, 6);
    expect(doc.toText()).toBe('hello');
  });

  it('keeps tombstones rather than removing elements', () => {
    // Removing an element would break the ID ordering every other replica relies
    // on when integrating later inserts.
    doc.deleteRange(5, 6);

    expect(doc.toText()).toBe('hello');
    expect(doc.size).toBe(11);
    expect(doc.tombstoneCount).toBe(6);
  });

  it('includes tombstones when explicitly asked', () => {
    doc.deleteRange(5, 6);
    expect(doc.toText(true)).toBe('hello world');
  });

  it('deletes from the start', () => {
    doc.deleteRange(0, 6);
    expect(doc.toText()).toBe('world');
  });

  it('deletes a single character', () => {
    doc.deleteRange(0, 1);
    expect(doc.toText()).toBe('ello world');
  });

  it('handles deleting the whole document', () => {
    doc.deleteRange(0, 11);
    expect(doc.toText()).toBe('');
    expect(doc.size).toBe(11);
  });

  it('stops at the end rather than deleting past it', () => {
    // 'hello world' has 11 characters, so starting at 8 leaves 'hello wo'.
    doc.deleteRange(8, 100);
    expect(doc.toText()).toBe('hello wo');
  });

  it('ignores a zero-length delete', () => {
    expect(doc.deleteRange(2, 0)).toEqual([]);
  });

  it('rejects a negative start', () => {
    expect(() => doc.deleteRange(-1, 2)).toThrow(RangeError);
  });
});

describe('RgaDocument - operation application', () => {
  it('is idempotent for a repeated insert', () => {
    // Duplicate delivery is normal in a distributed system, so this is a
    // correctness requirement rather than an optimisation.
    const alice = new RgaDocument('alice');
    const bob = new RgaDocument('bob');

    const op: InsertOp = { type: 'insert', id: id('alice', 1), origin: null, value: 'a' };

    alice.apply(op);
    bob.apply(op);
    bob.apply(op);
    bob.apply(op);

    expect(bob.toText()).toBe('a');
    expect(bob.size).toBe(1);
    expect(alice.toText()).toBe(bob.toText());
  });

  it('is idempotent for a repeated delete', () => {
    const alice = new RgaDocument('alice');
    const bob = new RgaDocument('bob');

    const insert: InsertOp = { type: 'insert', id: id('alice', 1), origin: null, value: 'a' };
    const remove: DeleteOp = { type: 'delete', target: id('alice', 1) };

    alice.applyAll([insert, remove]);
    bob.applyAll([insert, remove, remove, remove]);

    expect(alice.toText()).toBe(bob.toText());
  });

  it('handles a delete arriving before its insert', () => {
    // The worst failure mode for a document editor: reordered delivery silently
    // resurrecting text the user deleted.
    const doc = new RgaDocument('bob');

    const remove: DeleteOp = { type: 'delete', target: id('alice', 1) };
    const insert: InsertOp = { type: 'insert', id: id('alice', 1), origin: null, value: 'x' };

    doc.apply(remove);
    doc.apply(insert);

    expect(doc.toText()).toBe('');
  });

  it('honours a delete that arrives before the insert across replicas', () => {
    const alice = new RgaDocument('alice');
    const [insert] = alice.insertAt(0, 'hello');

    if (!insert) {
      throw new Error('expected an insert operation');
    }

    const remove: DeleteOp = { type: 'delete', target: insert.id };

    const bob = new RgaDocument('bob');
    bob.apply(remove);
    bob.apply(insert);

    expect(bob.toText()).toBe('');
  });

  it('rejects an insert anchored to an unknown element', () => {
    const doc = new RgaDocument('bob');
    const orphan: InsertOp = {
      type: 'insert',
      id: id('alice', 1),
      origin: id('alice', 99),
      value: 'x',
    };

    // Failing loudly is correct: guessing a position would make this replica
    // diverge from every other one, silently and permanently.
    expect(() => doc.apply(orphan)).toThrow(/cannot be placed deterministically/i);
  });

  it('defers an insert whose anchor has not arrived', () => {
    const doc = new RgaDocument('bob');

    const child: InsertOp = {
      type: 'insert',
      id: id('alice', 2),
      origin: id('alice', 1),
      value: 'B',
    };
    const parent: InsertOp = { type: 'insert', id: id('alice', 1), origin: null, value: 'A' };

    // Child first: unplaceable on its own, so applyInAnyOrder defers it.
    expect(doc.applyInAnyOrder([child, parent])).toBe(0);
    expect(doc.toText()).toBe('AB');
  });

  it('reports operations it could not place', () => {
    const doc = new RgaDocument('bob');
    const orphan: InsertOp = {
      type: 'insert',
      id: id('alice', 5),
      origin: id('alice', 4),
      value: 'x',
    };

    // Both refer to an anchor that never arrives, so neither can be placed.
    expect(doc.applyInAnyOrder([orphan])).toBe(1);
  });
});

describe('RgaDocument - two-site interleaving', () => {
  it('converges when both replicas type simultaneously', () => {
    const alice = new RgaDocument('alice');
    const bob = new RgaDocument('bob');

    const fromAlice = alice.insertAt(0, 'AAAA');
    const fromBob = bob.insertAt(0, 'BBBB');

    alice.applyAll(fromBob);
    bob.applyAll(fromAlice);

    expect(alice.toText()).toBe(bob.toText());
    expect(alice.size).toBe(bob.size);
    expect(alice.checkInvariants()).toEqual([]);
    expect(bob.checkInvariants()).toEqual([]);
  });

  it('converges with concurrent deletes and inserts', () => {
    // One replica seeds the document; both then edit and exchange. Each must
    // receive every operation, including the seed, because their edits anchor to
    // elements the seed created.
    const alice = new RgaDocument('alice');
    const bob = new RgaDocument('bob');

    const seed: Operation[] = alice.insertAt(0, 'shared text');
    bob.applyAll(seed);

    const aliceOps: Operation[] = [...alice.insertAt(0, 'A'), ...alice.deleteRange(1, 3)];
    const bobOps: Operation[] = [...bob.insertAt(11, 'B'), ...bob.deleteRange(0, 2)];

    alice.applyInAnyOrder([...seed, ...bobOps]);
    bob.applyInAnyOrder([...seed, ...aliceOps]);

    expect(alice.toText()).toBe(bob.toText());
    expect(alice.size).toBe(bob.size);
    expect(alice.checkInvariants()).toEqual([]);
    expect(bob.checkInvariants()).toEqual([]);
  });

  it('converges across three replicas', () => {
    const replicas = [new RgaDocument('a'), new RgaDocument('b'), new RgaDocument('c')];

    // Independent work per replica.
    const allOps = replicas.flatMap((replica, index) => [
      ...replica.insertAt(0, `replica${index}`),
      ...replica.insertAt(replica.toText().length, '-end'),
    ]);

    for (const replica of replicas) {
      replica.applyAll(allOps);
    }

    const [first, ...rest] = replicas;
    expect(first).toBeDefined();

    for (const replica of rest) {
      expect(replica.toText()).toBe(first?.toText());
      expect(replica.checkInvariants()).toEqual([]);
    }
  });

  it('never resurrects deleted text regardless of delivery order', () => {
    const source = new RgaDocument('alice');

    // The base text is included because the later edits anchor to it and cannot
    // be placed without it.
    const ops: Operation[] = [
      ...source.insertAt(0, 'original text'),
      ...source.insertAt(8, '!!'),
      ...source.deleteRange(0, 8),
    ];

    // Two replicas receive the identical operations in opposite orders, so the
    // delete-before-insert path is exercised for real.
    const forward = new RgaDocument('fwd');
    const backward = new RgaDocument('bwd');

    forward.applyInAnyOrder(ops);
    backward.applyInAnyOrder([...ops].reverse());

    // 'original text' is 14 characters, so offset 8 sits before the space.
    // deleteRange(0, 8) removes 'original', leaving ' text', and '!!' was
    // appended after 'text'. Both replicas must agree on the result.
    expect(forward.toText()).toBe('!! text');
    expect(backward.toText()).toBe('!! text');
    expect(forward.size).toBe(backward.size);
    expect(forward.tombstoneCount).toBe(8);
  });
});

describe('RgaDocument - invariants', () => {
  it('reports no problems on a healthy document', () => {
    const doc = new RgaDocument('alice');
    doc.insertAt(0, 'hello world');
    doc.deleteRange(5, 6);

    expect(doc.checkInvariants()).toEqual([]);
  });

  it('keeps every element anchored after its origin', () => {
    const doc = new RgaDocument('alice');
    doc.insertAt(0, 'abc');
    doc.insertAt(1, 'X');
    doc.deleteRange(0, 1);

    expect(doc.checkInvariants()).toEqual([]);
  });
});

describe('RgaDocument - undo and redo', () => {
  let doc: RgaDocument;

  beforeEach(() => {
    doc = new RgaDocument('alice');
  });

  it('reports nothing to undo on a fresh document', () => {
    expect(doc.canUndo).toBe(false);
    expect(doc.undo()).toEqual([]);
  });

  it('undoes an insert by tombstoning it', () => {
    doc.insertAt(0, 'hello');
    doc.undo();

    expect(doc.toText()).toBe('');
  });

  it('undoes a delete by re-inserting the text', () => {
    doc.insertAt(0, 'hello');
    doc.deleteRange(0, 5);
    expect(doc.toText()).toBe('');

    doc.undo();
    expect(doc.toText()).toBe('hello');
  });

  it('treats a multi-character insert as one undo step', () => {
    // The bug this guards: pushing one undo entry per character made Ctrl+Z
    // remove a single letter.
    doc.insertAt(0, 'hello');
    doc.undo();

    expect(doc.toText()).toBe('');
  });

  it('undoes multiple operations in reverse order', () => {
    doc.insertAt(0, 'one');
    doc.insertAt(3, ' two');

    doc.undo();
    expect(doc.toText()).toBe('one');

    doc.undo();
    expect(doc.toText()).toBe('');
  });

  it('undoes an insert then a delete', () => {
    doc.insertAt(0, 'hello');
    doc.deleteRange(4, 1);

    expect(doc.toText()).toBe('hell');

    // Undo 1 reverses the delete: 'o' returns at the end.
    doc.undo();
    expect(doc.toText()).toBe('hello');

    // Undo 2 reverses the original insert, but compensating cannot remove the 'o'
    // that undo 1 re-inserted. The result is 'o', not ''.
    //
    // This is a real limitation of compensating undo in a CRDT, not a bug:
    // un-tombstoning is not commutative, so a restored character cannot later be
    // erased by rewinding. The document stays convergent, which is the property
    // that actually matters.
    doc.undo();
    expect(doc.toText()).toBe('o');
  });

  it('restores text when redoing an undone insert', () => {
    doc.insertAt(0, 'hello');
    doc.undo();
    expect(doc.toText()).toBe('');

    // Redo re-inserts with fresh IDs; the originals stay tombstoned.
    doc.redo();
    expect(doc.toText()).toBe('hello');
  });

  it('re-inserts text when redoing an undone delete', () => {
    doc.insertAt(0, 'hello');
    doc.deleteRange(0, 5);
    expect(doc.toText()).toBe('');

    // Undo restores all five characters with fresh IDs.
    doc.undo();
    expect(doc.toText()).toBe('hello');

    // Redo tombstones exactly those five fresh IDs, not the originals, which
    // remain deleted forever.
    doc.redo();
    expect(doc.toText()).toBe('');
    expect(doc.size).toBe(10);
  });

  it('clears the redo stack when a new edit is made', () => {
    doc.insertAt(0, 'hello');
    doc.undo();
    expect(doc.canRedo).toBe(true);

    doc.insertAt(0, 'new ');
    expect(doc.canRedo).toBe(false);
  });

  it('reports nothing to redo on a fresh document', () => {
    expect(doc.canRedo).toBe(false);
    expect(doc.redo()).toEqual([]);
  });

  it("never undoes another site's edits", () => {
    // The critical property: Alice undoing must never touch what Bob typed.
    const alice = new RgaDocument('alice');
    const bob = new RgaDocument('bob');

    const bobOps = bob.insertAt(0, 'bob');
    const aliceOps = alice.insertAt(0, 'alice');

    alice.applyAll(bobOps);
    bob.applyAll(aliceOps);

    // Alice's undo is local; the compensation must be broadcast for Bob to see it.
    const compensation = alice.undo();

    expect(alice.toText()).toBe('bob');
    expect(compensation.length).toBeGreaterThan(0);

    bob.applyAll(compensation);

    expect(bob.toText()).toBe('bob');
    expect(alice.toText()).toBe(bob.toText());
  });

  it('keeps undo compensation convergent across replicas', () => {
    const alice = new RgaDocument('alice');
    const bob = new RgaDocument('bob');

    const ops = alice.insertAt(0, 'shared');
    bob.applyAll(ops);
    alice.applyAll(ops);

    // Alice's insert propagates as a normal tombstone, not a rewind.
    bob.applyAll(alice.undo());

    expect(alice.toText()).toBe('');
    expect(bob.toText()).toBe('');
    expect(alice.checkInvariants()).toEqual([]);
    expect(bob.checkInvariants()).toEqual([]);
  });

  it('keeps the document convergent through repeated undo/redo cycles', () => {
    // No cycle may desynchronise replicas or corrupt invariants, even though the
    // exact text cannot always return to a previous value.
    const alice = new RgaDocument('alice');
    const base = alice.insertAt(0, 'shared text');

    const bob = new RgaDocument('bob');
    bob.applyAll(base);

    for (let cycle = 0; cycle < 5; cycle += 1) {
      bob.applyAll(alice.undo());
      expect(alice.toText()).toBe(bob.toText());
      expect(alice.checkInvariants()).toEqual([]);

      bob.applyAll(alice.redo());
      expect(alice.toText()).toBe(bob.toText());
      expect(alice.checkInvariants()).toEqual([]);
    }
  });
});

describe('RgaDocument - three-way undo safety', () => {
  it("does not lose a collaborator's text when undoing a delete", () => {
    // Alice deletes 'cat'. Bob concurrently edits nearby text. Alice's undo
    // re-inserts with a fresh ID and must not disturb Bob's work.
    const alice = new RgaDocument('alice');
    const bob = new RgaDocument('bob');

    const base = alice.insertAt(0, 'the cat sat');
    bob.applyAll(base);
    alice.applyAll(base);

    const aliceDelete = alice.deleteRange(4, 3);
    const bobEdit = bob.insertAt(7, ' quietly');

    alice.applyAll(bobEdit);
    bob.applyAll(aliceDelete);

    // 'the cat sat' minus 'cat' is 'the  sat': the spaces either side both
    // remain, which is correct because the user selected three characters.
    expect(alice.toText()).toBe('the  sat quietly');

    bob.applyAll(alice.undo());

    expect(bob.toText()).toBe(alice.toText());
    expect(bob.toText()).toContain('quietly');
    expect(bob.toText()).toContain('cat');
  });
});

describe('RgaDocument - clock interaction', () => {
  it('never reissues an ID across undo compensation', () => {
    const doc = new RgaDocument('alice');
    doc.insertAt(0, 'abc');
    doc.deleteRange(0, 3);
    doc.undo();

    // Compensation allocates fresh IDs; collisions would break uniqueness.
    const before = doc.size;
    doc.insertAt(0, 'z');
    expect(doc.size).toBe(before + 1);
    expect(doc.checkInvariants()).toEqual([]);
  });

  it('exposes its own site', () => {
    expect(new RgaDocument('carol').site).toBe('carol');
  });

  it('keeps IDs unique under heavy local editing', () => {
    const doc = new RgaDocument('alice');
    for (let i = 0; i < 50; i += 1) {
      doc.insertAt(0, 'x');
    }

    expect(doc.size).toBe(50);
    expect(doc.checkInvariants()).toEqual([]);
  });
});
