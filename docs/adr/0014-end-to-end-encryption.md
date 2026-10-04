# 0014 - End-to-end encryption: the server sees ciphertext, per document

**Status:** Accepted

## Context

The server currently sees everything: operation payloads in transit, operation payloads at
rest in `document_ops`, and a plaintext `documents.content` cache it materialises by
replaying its own log.

That is coherent for a relay that is trusted with the content it carries. ADR-0007 made
the server a _relay_ rather than a merge authority, which is the property this decision
exploits: the server never needs to understand an operation in order to route it. It
validates the **envelope** and nothing more (ADR-0004).

What the server still cannot avoid today:

- **Compaction.** `createSnapshot` walks `doc.inspect()` (ADR-0011). That is plaintext.
- **The text cache.** `materializeContent` replays the log to produce `documents.content`.
  Also plaintext.

So encryption is not a transport change. It removes two server capabilities, and the
design has to decide what happens to them rather than pretend they survive.

## Decision

### 1. Encryption is per document and opt-in, not global

A document is encrypted when the URL carries a key in its **fragment**:

```
https://host/documents/abc123#k=<base64url 32 random bytes>
```

The fragment is never transmitted. Browsers do not put it in the HTTP request line or in
`Referer`, so **the server cannot know the key even in principle** - it is not asked to
keep a secret. This is the whole reason for choosing fragments over a header, a query
parameter, or a server-stored key: those are all things the server sees.

Consequences, stated rather than discovered later:

- A shared link is the credential. Whoever has the URL can read and edit the document.
- There is no key escrow and no recovery. Lose the link, lose the document.
- The key must be shared out of band, which is the same friction ADR-0012 already records
  for anonymous subjects.

Unencrypted documents keep compaction and the text cache. The mode is a property of the
link, not of the deployment, so both paths stay supported and neither is a special case
in the code.

### 2. Element keys travel in the clear

The server deduplicates with `ON CONFLICT (document_id, element_key) DO NOTHING`, deriving
`element_key` from the plaintext operation. With ciphertext it cannot, so the **client
supplies it**: `i:<site>@<clock>` for an insert, `d:<site>@<clock>` for a delete.

This leaks: the number of operations per site, and therefore roughly how much each
participant typed. It is the same class of metadata the server already has (operation
counts, ordering, timing, participant count). It does **not** leak content.

The alternative - letting the server dedupe by ciphertext, which is impossible without
decrypting - is why this is worth spelling out. `#applyInsert` is idempotent
(`if (this.#byKey.has(key)) return`), so **duplicate delivery is a storage cost, not a
correctness problem**. The cleartext key is therefore an optimisation the server is free
to keep, not something correctness depends on.

### 3. The server loses compaction and the text cache for encrypted documents

Both require plaintext. There is no way to preserve them without giving the server the
key, which is the thing being withheld.

- `maybeCompact` is skipped. The log grows for the life of the document.
- `materializeContent` is skipped. `documents.content` stays empty.

This is a real capability regression and it is the honest price of the feature. A
deployment that needs bounded storage _and_ confidentiality needs **client-produced
snapshots**: a peer holding the full history generates the snapshot, uploads it as opaque
bytes, and the server stores and serves it without validating it. That is named as the
required next step rather than pretended into this ADR, because an unverifiable upload is
its own trust decision.

### 4. AES-GCM, with the document id and element key bound as additional data

`AES-GCM`, 256-bit, 96-bit random nonce per operation, from WebCrypto. No dependency,
available in both the browser and Node.

Additional authenticated data is `documentId | elementKey`. This is not decoration:

- Without it, a ciphertext could be moved from one document to another and decrypt
  cleanly, because the key is per document and the AAD is empty.
- Without it, an insert ciphertext could be replayed as a delete, because the two have
  different shapes and therefore different plaintext lengths.

Binding both means a relocated or type-swapped frame fails authentication.

### 5. The nonce bound is documented, not assumed

Random 96-bit nonces under one key are safe to roughly 2^32 operations for that key
(the birthday bound). At the load-suite's ~1,500 ops/s that is a document-year. Beyond
it, two nonces colliding under one key would let an observer XOR two ciphertexts and
recover plaintext.

Rather than leave this implicit, the limit is written next to the code. A counter-based
scheme is not available here because multiple sites hold the same key and their counters
are unrelated, which is exactly the situation random nonces exist for.

## Rationale

The alternative was to leave the server trusted and document it. That is a perfectly
defensible product decision and it is cheaper. It was rejected because "local-first, the
server is only an optimisation" and "the operator can read every document" are in
tension, and the whole architecture of ADR-0001 - the device is authoritative - is easier
to defend when the optimisation cannot silently become the source of truth.

Choosing the URL fragment over any server-held key is what makes this more than
encryption-at-rest-with-a-trusted-third-party. The server is not trusted with the key, so
there is nothing to subpoena, no config to leak, and no way for a future operator change
to weaken it without also changing the client.

Using the existing envelope-validation boundary (ADR-0004) rather than inventing a second
one means the server's crypto work is "check the frame is shaped correctly" - which it
already does - and the CRDT work is unchanged. No new server-side parsing of a type it
cannot verify.

## Consequences

**Good**

- The server cannot read document content, at rest or in transit, and cannot be made to
- The key never reaches the server, so there is no key store to compromise or rotate
- Correctness does not depend on server dedupe, because the CRDT is idempotent
- Unencrypted documents are unaffected; both modes ship together

**Bad**

- Encrypted documents never compact server-side. The log grows without bound.
- No text cache, so a cold device replays the full history rather than fetching a string
- The server learns per-site operation counts and timing. This is real metadata leakage
  and it is not addressed by anything here.
- A wrong key produces a decryption failure, not a partial read. Users see an error where
  previously they saw their document, and the error must be legible.
- Lost link, lost document. No recovery path.

## Alternatives rejected

| Option                                  | Why rejected                                                                                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Server-held key (header or query)       | The server then holds the key, which is a configuration secret, an operational duty and something a future change can leak. The fragment avoids all three.                     |
| Transport encryption only (TLS)         | Already have it, and it does nothing against the operator. TLS hides content from the network, not from the process holding the key.                                           |
| Encrypt at rest only                    | Leaves the server reading plaintext on every relay, which is where content actually flows.                                                                                     |
| Global encryption, no opt-in            | Removes compaction and the text cache for every document, including ones where confidentiality does not matter and offline-first matters more.                                 |
| Server still compacts encrypted logs    | Requires the server to decrypt, which defeats the purpose. Client-produced snapshots is the only way to have both, and it moves trust to a peer.                               |
| Deterministic nonces per operation      | Deterministic encryption leaks equality of plaintext across documents. Counter-based nonces are not available because several sites hold the same key with unrelated counters. |
| A crypto library dependency             | WebCrypto is built into the browser and Node, audited with the platform, and adds no supply-chain surface. `jose` is already present for JWT and is not a general AEAD layer.  |
| Rolling back to plaintext for old peers | A single peer that cannot decrypt is a data-loss event, not a downgrade. Refusing is correct.                                                                                  |
