import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION, parseClientMessage } from './protocol.js';

/** A well-formed hello frame, used as the base for negative variations. */
const validHello = {
  type: 'hello',
  protocolVersion: PROTOCOL_VERSION,
  token: 'test-token',
  documentId: 'doc-1',
  lastAppliedSeq: 42,
};

describe('parseClientMessage', () => {
  it('accepts a well-formed hello', () => {
    const parsed = parseClientMessage(JSON.stringify(validHello));

    expect(parsed).toEqual(validHello);
  });

  it('accepts every documented client message type', () => {
    expect(
      parseClientMessage(JSON.stringify({ type: 'ops', documentId: 'd', ops: [] })),
    ).not.toBeNull();
    expect(
      parseClientMessage(
        JSON.stringify({ type: 'presence', documentId: 'd', cursor: null, selectedLength: 0 }),
      ),
    ).not.toBeNull();
    expect(
      parseClientMessage(JSON.stringify({ type: 'resync', documentId: 'd', sinceSeq: 7 })),
    ).toEqual({ type: 'resync', documentId: 'd', sinceSeq: 7 });
  });

  it('rejects malformed JSON instead of throwing', () => {
    // A WebSocket frame is arbitrary bytes from an untrusted peer. The server
    // must survive anything, including garbage.
    expect(parseClientMessage('{not json')).toBeNull();
    expect(parseClientMessage('')).toBeNull();
    expect(parseClientMessage('undefined')).toBeNull();
  });

  it('rejects non-object payloads', () => {
    for (const raw of ['null', '42', '"hello"', 'true', '[]']) {
      expect(parseClientMessage(raw)).toBeNull();
    }
  });

  it('rejects unknown message types', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'dropTables' }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: '' }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({}))).toBeNull();
  });

  it('rejects a hello missing required fields', () => {
    const { token: _t, ...missingToken } = validHello;
    expect(parseClientMessage(JSON.stringify(missingToken))).toBeNull();

    const { lastAppliedSeq: _c, ...missingClock } = validHello;
    expect(parseClientMessage(JSON.stringify(missingClock))).toBeNull();
  });

  it('rejects non-finite numbers', () => {
    // JSON.parse turns these into the literal, but a hand-built object or a
    // future serialiser could produce them. Guard regardless.
    expect(parseClientMessage(JSON.stringify({ ...validHello, lastAppliedSeq: null }))).toBeNull();
    expect(
      parseClientMessage(JSON.stringify({ ...validHello, protocolVersion: 'one' })),
    ).toBeNull();
  });

  it('rejects a presence message with a non-numeric, non-null cursor', () => {
    expect(
      parseClientMessage(
        JSON.stringify({ type: 'presence', documentId: 'd', cursor: 'here', selectedLength: 0 }),
      ),
    ).toBeNull();
  });

  it('accepts a presence message with an explicit null cursor', () => {
    // null means "client lost focus" -- a legitimate state, not a missing field.
    const parsed = parseClientMessage(
      JSON.stringify({ type: 'presence', documentId: 'd', cursor: null, selectedLength: 0 }),
    );

    expect(parsed).toEqual({ type: 'presence', documentId: 'd', cursor: null, selectedLength: 0 });
  });

  it('rejects an ops message whose payload is not an array', () => {
    expect(
      parseClientMessage(JSON.stringify({ type: 'ops', documentId: 'd', ops: 'nope' })),
    ).toBeNull();
    expect(
      parseClientMessage(JSON.stringify({ type: 'ops', documentId: 'd', ops: {} })),
    ).toBeNull();
  });

  it('never returns a value for a frame it rejects', () => {
    const hostile = [
      '{"type":"hello","protocolVersion":1}',
      '{"type":"presence","documentId":"d"}',
      '{"type":"resync"}',
      '{"type":"ops","documentId":"d"}',
      '[{"type":"resync","documentId":"d"}]',
      // A resync without a cursor is rejected rather than treated as zero. A
      // default would turn a client bug into a full re-download of the log.
      '{"type":"resync","documentId":"d"}',
      '{"type":"resync","documentId":"d","sinceSeq":-1}',
      '{"type":"resync","documentId":"d","sinceSeq":"0"}',
    ];

    for (const raw of hostile) {
      expect(parseClientMessage(raw)).toBeNull();
    }
  });

  it('does NOT inspect op payloads -- that is deliberately out of scope', () => {
    // Boundary worth stating explicitly, because it looks like an oversight and
    // is not. The envelope guarantees the *shape* of the frame; it makes no
    // claim about the operations inside. `Operation` is an opaque `JsonValue`
    // until Phase 2 defines the real insert/delete union, so `ops: [{}]` is
    // structurally valid here.
    //
    // Validating op contents is Phase 2's job, and it belongs there: the CRDT
    // must reject a malformed operation on its own terms, not because a
    // transport layer guessed at its shape. Once Phase 2 lands, this test
    // should move to asserting that the CRDT itself rejects `{}`.
    const parsed = parseClientMessage('{"type":"ops","documentId":"d","ops":[{}]}');

    expect(parsed).not.toBeNull();
    expect(parsed).toEqual({ type: 'ops', documentId: 'd', ops: [{}] });
  });
});

describe('the optional batchId (ADR-0015)', () => {
  it('accepts an ops frame with no batchId, and omits the field entirely', () => {
    // THE compatibility property. A client from before acknowledgements existed sends no id and
    // must parse to exactly the message it used to, with no `batchId: undefined` key in the way
    // of a `toEqual` comparison anywhere.
    const parsed = parseClientMessage(JSON.stringify({ type: 'ops', documentId: 'd', ops: [] }));

    expect(parsed).toEqual({ type: 'ops', documentId: 'd', ops: [] });
    expect(parsed).not.toHaveProperty('batchId');
  });

  it('accepts an ops frame that carries one', () => {
    expect(
      parseClientMessage(JSON.stringify({ type: 'ops', documentId: 'd', ops: [], batchId: 'b7' })),
    ).toEqual({ type: 'ops', documentId: 'd', ops: [], batchId: 'b7' });
  });

  it('accepts an ops-enc frame with and without one', () => {
    const frame = {
      v: 1,
      key: 'i:s@1',
      type: 'insert',
      site: 's',
      iv: 'AAAAAAAAAAAAAAAA',
      ct: 'AAAAAAAAAAAAAAAAAAAAAA',
    };

    expect(
      parseClientMessage(JSON.stringify({ type: 'ops-enc', documentId: 'd', frames: [frame] })),
    ).toEqual({ type: 'ops-enc', documentId: 'd', frames: [frame] });

    expect(
      parseClientMessage(
        JSON.stringify({ type: 'ops-enc', documentId: 'd', frames: [frame], batchId: 'b1' }),
      ),
    ).toEqual({ type: 'ops-enc', documentId: 'd', frames: [frame], batchId: 'b1' });
  });

  it('rejects a batchId that is not a string', () => {
    // The relay echoes this value back in an `ack`, so it is untrusted text on the way out as
    // well as on the way in. A number or an object is refused rather than coerced.
    for (const bad of [7, null, true, { id: 'b1' }, ['b1']]) {
      expect(
        parseClientMessage(JSON.stringify({ type: 'ops', documentId: 'd', ops: [], batchId: bad })),
        `accepted batchId ${JSON.stringify(bad)}`,
      ).toBeNull();
    }
  });

  it('rejects a batchId long enough to be worth bounding', () => {
    // The relay stores nothing about it and does echo it, so an unbounded string is an
    // amplification the client gets for free.
    expect(
      parseClientMessage(
        JSON.stringify({ type: 'ops', documentId: 'd', ops: [], batchId: 'x'.repeat(129) }),
      ),
    ).toBeNull();

    expect(
      parseClientMessage(
        JSON.stringify({ type: 'ops', documentId: 'd', ops: [], batchId: 'x'.repeat(128) }),
      ),
    ).not.toBeNull();
  });

  it('rejects a malformed ops-enc frame even when the batchId is fine', () => {
    // Otherwise a client could satisfy the new check and slip a bad frame through, which is the
    // kind of thing that makes a validation branch look covered when it is not.
    expect(
      parseClientMessage(
        JSON.stringify({ type: 'ops-enc', documentId: 'd', frames: [{ v: 2 }], batchId: 'b1' }),
      ),
    ).toBeNull();
  });
});
