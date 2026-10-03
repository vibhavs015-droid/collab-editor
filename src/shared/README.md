# `src/shared`

Code used by **both** client and server. Anything here must stay free of
platform-specific APIs — no DOM, no Node built-ins.

| File          | Phase | Purpose                                         |
| ------------- | ----- | ----------------------------------------------- |
| `protocol.ts` | 3     | WebSocket message envelope + runtime validation |
| `document.ts` | 2     | Document-level shared types (title, membership) |
| `errors.ts`   | 5     | Error codes shared across the wire              |

## Why this layer exists

The wire format is the one contract where a mismatch causes silent, hard-to-debug
divergence: the server serialises, the client deserialises, and if the types drift
apart nothing throws — operations just quietly fail to apply.

Sharing the definitions from one file makes that failure mode very unlikely, and
makes it a compile error when it happens.

## Rule

If it needs `window` or `require`, it does not belong here. Platform code belongs
in `src/client` or `src/server`.

## Validation note

TypeScript types vanish at runtime. `parseClientMessage` is what actually
guarantees the server never receives a malformed frame — see the comment in
`protocol.ts`. Defining the type is not the same as enforcing it.
