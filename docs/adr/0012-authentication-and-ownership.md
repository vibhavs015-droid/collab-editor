# ADR-0012: Anonymous sessions, document ownership, and authorisation at the edge

- **Status**: accepted
- **Date**: 2026-10-04
- **Phase**: 5

## Context

Until now a document id was the only access control. Anyone who knew or guessed an
id could read and write that document through both the HTTP API and the WebSocket
relay.

That is not a weak control, it is the absence of one. Document ids appear in URLs,
and URLs end up in browser history, `Referer` headers, proxy access logs, shared
links and screenshots. Guessing is not the threat; _having_ the id is.

The WebSocket made it worse than a typical REST API. A REST caller has to send a
request to receive a response, so a document is only exposed to someone who already
has it. A room-based relay pushes to every member, so joining a room is enough to
receive everything in it — including every keystroke, live, unasked.

The `hello` frame already carried a `token` field, hardcoded to the string
`'phase-3-no-auth'`.

## Decision

### 1. Anonymous signed sessions, not accounts

A client asks `POST /api/auth/session` and receives an HS256 JWT carrying a random
128-bit subject, valid for seven days. There is no user table, no password, no
email, no email verification, no password reset.

Documents record the subject that created them, plus an explicit grant table.

**Why anonymous.** Accounts are CRUD, and CRUD is not the part of this project
worth building. An anonymous subject is enough to make "knowing an id is enough to
read the document" false, which is the actual defect. Adding identity later is a
schema migration; adding it now buys nothing about the vulnerability.

**What this is not.** Two browser profiles are two different subjects with no way to
prove they are the same person. There is no recovery: clear site data and you have a
new subject and no access to your old documents. That is a real limitation and it is
stated in NOTES.md rather than smoothed over.

### 2. Authorisation happens at `hello`, and the socket is not in the room until it passes

The relay used to `join()` a client the moment it attached. Authorising after that
would mean an unauthorised socket sits in a room and receives broadcasts — the exact
leak this is meant to close, and a bigger one than before because it would be
automatic.

So `attach` creates a **pending** client. It is in no room, and it lives in a separate
set that the reaper, the shutdown path and the client count all have to see. `hello`
verifies the token, checks `canAccess`, and only then admits.

The gate for "no frame but `hello` is accepted" sits **above** the message switch,
not inside each case. A check inside each case is a check someone eventually forgets
to add when they add the next frame type.

A socket that never sends `hello` is closed after `helloTimeoutMs` (10s, default).

### 3. One authorisation decision, two call sites

`Database.canAccess(documentId, subject)` is the only thing that answers "may I touch
this document". Both the HTTP API and the relay call it. Two implementations of that
question would eventually disagree, and the disagreement nobody notices is the
permissive one.

### 4. Unowned means world-writable, and `claim` is how that ends

`documents.owner` is nullable, and `NULL` means unowned, which means anyone may read
and write. This preserves every document created before this migration rather than
making it unreachable, and it means documents created by scripts or tests are not
born locked to a caller that no longer exists.

`POST /api/documents/:id/claim` takes ownership, with `owner IS NULL` in the `WHERE`
clause. Without that guard it would be a takeover: any subject could seize any
document and lock out its creator.

An unowned document can also be claimed by whoever chooses, so there is a race. That
race is the price of backwards compatibility and it is a deliberate one; the
alternative is `NOT NULL` plus a backfill that assigns every existing document to an
arbitrary sentinel owner, which is ownership by accident rather than by decision.

### 5. 404, not 403, for "not yours"

A `403` confirms that a document id is real. A real id is the first half of
everything an attacker needs. So `canAccess` returns false for both "does not exist"
and "not yours", and both are `404 DOCUMENT_NOT_FOUND`.

The cost is that a user following a link to a document they cannot see is told it
does not exist. The message is `"Document does not exist, or you do not have access
to it."` — honest rather than merely reassuring.

**Delete is the exception.** `canAccess` is about writing; delete is disposal, not an
edit. A collaborator may write a document and must not be able to remove it, so
delete is owner-only and answers `403`. By then the caller has already proved access,
so confirming existence discloses nothing.

### 6. Expiry is a non-event by construction

A token is only ever read at `hello`, which happens on every connect. So the client
resolves the token _per connect_ (`resolveToken: () => Promise<string>`) rather than
capturing one at construction, and an expired token is simply replaced before the next
handshake. There is no refresh endpoint, no timer, and no re-authentication in flight.

Capturing a token at construction would expire silently, and the client would
reconnect forever to a server that had every reason to refuse it.

### 7. `hello` and `welcome` form a handshake, and nothing is sent until it completes

Making the hello send asynchronous exposed a race that had been invisible: queued
operations flushed immediately after `hello` was written, while the server's
authorisation check was still awaiting the database. The server refused them and
closed the socket.

The fix is a real state machine — **open**, then **hello written**, then **welcome
received**, and only then may anything else be sent. Both flags are required rather
than relying on their order, so a server frame arriving before the handshake has even
started cannot release the outbox.

### 8. `AUTH_MODE=open` is refused in production

`resolveAuthenticator` decides between two implementations:

- `TokenAuthenticator` — HS256, pinned algorithm, required claims, verified issuer
  and audience, verified expiry.
- `OpenAuthenticator` — a _different class_, not a flag. The token is the subject.
  It exists so `npm run dev` and the test suite need nothing configured.

`OpenAuthenticator` being a separate class is the point: there is no configuration
that turns `TokenAuthenticator` into it. And `AUTH_MODE=open` throws when
`NODE_ENV=production`, so the switch that makes local work possible cannot leave a
public server open.

`/api/health` reports `auth: 'open' | 'required'`, because a health check that only
says "ok" cannot distinguish a secured server from an open one.

## Things this deliberately does not do

- **No rate limiting on session issuance.** Signing HS256 costs microseconds; a limit
  there is overhead pretending to be protection. The endpoints worth limiting are the
  ones that touch the database, and `helloTimeout` already bounds how often a socket
  can make the server do that.
- **No refresh tokens.** With a 7-day TTL and per-connect re-resolution, a refresh
  flow would be complexity for a case the design already avoids.
- **No token in the query string.** It would work and it would leak: query strings
  reach proxy logs and `Referer` headers.
- **No per-request authorisation cache.** A cached decision outlives the revocation.

## Consequences

**Positive**

- "Knowing an id is enough" is false for every document created through the API.
- An unauthorised socket receives nothing, and cannot even tell whether the document
  exists.
- Reconnect after expiry is a non-event.
- `npm run dev` and the test suite still need zero configuration.

**Negative**

- Documents created before this migration remain world-writable until claimed.
- There is a race on claiming an unowned document.
- Clearing site data loses access. There is no recovery path.
- Collaborating means sharing a subject out of band. There is no share UI, because a
  share UI is CRUD.
- Every document route needs a token, including from the browser, which adds a session
  round trip before first paint.

## Alternatives considered

**Username and password.** Rejected. It is CRUD, it needs a password store and a
reset flow, and none of it changes the vulnerability being fixed.

**Tokens in the WebSocket query string.** Rejected: they leak into logs and `Referer`.

**Authorise at the HTTP upgrade.** Better in principle — an unauthorised socket never
opens. Not possible with a browser WebSocket API, which cannot set an `Authorization`
header. It would need a cookie, which brings its own CSRF surface.

**Server-side buffering of frames during authorisation.** Would work and is what a
protocol purist would do. Rejected in favour of the client handshake: one rule,
enforced in one place, with no per-client buffer to leak.

**`NOT NULL` owner with a backfill.** Rejected: ownership by accident.

**403 for "not yours".** Rejected: it turns the API into an existence oracle.
