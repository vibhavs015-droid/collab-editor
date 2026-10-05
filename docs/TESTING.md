# Testing this project on your own machine

Everything below has been run at least once on the machine that wrote this file. Where a step
says "expected", that is the observed result, not a hope.

Two ways to test:

- **[Automated](#part-1-automated)** — one command, ~6 minutes, 900 tests plus 22 checks
  against the built server. Proves the machinery.
- **[By hand](#part-2-by-hand)** — a checklist in two browser windows. Proves the product.

Do both. The automated half cannot tell you the editor feels right, and the by-hand half
cannot tell you nothing is quietly broken underneath.

---

## Part 0: Get it running

Requires Node 24 (`.nvmrc` pins it). Yours was v24.16.0 when this was written.

```powershell
cd "C:\Users\ASUS\Documents\Default Project\collab-editor"
npm install          # only if you have not already
npm run start:local
```

`start:local` builds nothing, so run it once after a fresh clone:

```powershell
npm run start:local:build
```

Then open **<http://127.0.0.1:3001>**.

What you should see in the terminal:

```
starting the built server
  url      http://127.0.0.1:3001
  data     ./.data/pgdata
  auth     generated a JWT secret for this run only
```

**Why there is a secret.** Production refuses to start without `JWT_SECRET`. That is
deliberate: unset means open auth, and open auth in production is the failure where the app
looks completely healthy and every document is readable by anyone who guesses its id.

The generated secret lasts one run, so **sessions do not survive a restart**. To keep them:

```powershell
$env:JWT_SECRET = node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
npm run start:local
```

Stop with `Ctrl+C`.

### If you want hot reload while editing code

```powershell
npm run dev
```

That runs the source through `tsx` with Vite serving the client. Use `start:local` for
testing behaviour, because that is what a deployed instance runs and the two differ.

---

## Part 1: Automated

```powershell
npm run verify:all
```

Runs, in order:

| Gate         | What it proves                                                   | ~Time |
| ------------ | ---------------------------------------------------------------- | ----- |
| Typecheck    | No type errors                                                   | 10 s  |
| Lint         | No lint violations                                               | 20 s  |
| Format check | Formatting matches Prettier                                      | 5 s   |
| Line endings | No CRLF, no stray encodings                                      | 2 s   |
| **Test**     | **900 tests, including 24-replica convergence under contention** | 5 min |
| Build        | `tsc` and Vite both succeed                                      | 5 s   |
| **Smoke**    | **22 checks against the built server in production mode**        | 40 s  |

**Pass looks like:**

```
 Test Files  42 passed (42)
      Tests  900 passed (900)

22 checks, 0 failed
```

The smoke test is the interesting one. Every other test exercises source code; that one
starts `node dist/server/index.js` with `NODE_ENV=production` and drives the thing you
actually get — the page, a hashed asset, the API, authorisation, two live WebSocket peers,
cold replay from the durable log, and an encrypted document. It exists because the production
build once served nothing at all (`/` returned 401) while every other test passed.

---

## Part 2: By hand

Open **two browser windows** side by side. For most of these you want two _different_ windows,
not two tabs, because tabs share a session and the point is two independent clients.

If you use two tabs, add `&nope=1` to the second one's URL so the client treats it as a
separate tab and mints a different site id.

### 2.1 The editor works

| Step                                                | Expected                                           |
| --------------------------------------------------- | -------------------------------------------------- |
| Open <http://127.0.0.1:3001>                        | An empty editor, sync indicator showing **synced** |
| Type `hello`                                        | Characters appear as you type                      |
| Look at the bottom right                            | Word and character counts update                   |
| Click the title field, type `My notes`, press Enter | Title saves; survives a refresh                    |

**Pass:** it feels like a normal text editor. If typing stutters or characters appear out of
order, stop and report that — it is the CRDT, not the browser.

### 2.2 Real-time collaboration

| Step                             | Expected                                        |
| -------------------------------- | ----------------------------------------------- |
| Copy the URL from window 1       | It looks like `http://127.0.0.1:3001/?doc=<id>` |
| Paste into window 2, press Enter | **The same text appears** in window 2           |
| Type `XYZ` in window 1           | `XYZ` appears in window 2 within a moment       |
| Type `ABC` in window 2           | `ABC` appears in window 1                       |
| Look at the peer count           | **2 collaborators**                             |
| Move the cursor in window 1      | A remote cursor appears in window 2             |

**Pass:** both windows converge on identical text within a second.

**If one window is empty:** you probably opened the same URL but the document is new to the
second client, and it catches up from the server. Wait a second and refresh.

### 2.3 Offline-first — the claim worth testing properly

This is the feature the project is built around, so test it deliberately.

| Step                                           | Expected                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| In window 1, type `before-offline`             | Synced                                                                  |
| **Stop the server** (`Ctrl+C` in the terminal) | —                                                                       |
| Keep typing in window 1: ` and after-offline`  | Text appears normally. Indicator shows **offline**, then **pending N**  |
| Reload the page                                | **Your text is still there** — it lives in IndexedDB, not on the server |
| **Restart the server** (`npm run start:local`) | —                                                                       |
| Within a few seconds                           | Indicator returns to **synced**; the pending count drains to 0          |
| Open a **fresh** window with the same URL      | **Both** `before-offline` and ` after-offline` are there                |

**Pass:** nothing you typed was lost, at any point, including across a page reload while the
server was down. That is the offline-first claim, and the fresh-window step is the one that
proves it actually reached the server rather than only living in the browser.

### 2.4 End-to-end encryption — the headline feature

**The server cannot read these documents.** Not "we don't look" — it holds ciphertext it has
no key for.

| Step                                         | Expected                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| Click **New encrypted** in the toolbar       | URL changes to `?doc=<new-id>#k=<key>`; an **Encrypted** badge appears |
| Type `secret-zebra-1234`                     | Normal editing                                                         |
| Click **Copy link**                          | Button reads **Copied** briefly                                        |
| Paste the link into window 2 and press Enter | Same document, same text                                               |
| Type more in window 2                        | Appears in window 1                                                    |

Now prove the server cannot read it. In a **new** terminal:

```powershell
# Find your document id from the URL, then:
$env:JWT_SECRET = "<the secret your server printed at startup>"
```

Simpler — check it from the running server's own log, or just look at the URL and confirm the
**fragment is not in the address the browser sent**. The cleanest check:

```powershell
curl -s "http://127.0.0.1:3001/api/documents/<your-doc-id>" -H "Authorization: Bearer <token>"
```

You will need a token; the simplest observable proof needs none:

1. Open the **same document id without the `#k=` fragment** in a third window.
   **Expected:** an error saying the document is encrypted and this session has no key —
   _not_ a document missing what the other windows typed. That distinction is the whole
   design: the client refuses rather than silently showing you less.
2. Type in that third window anyway.
   **Expected:** your edit does **not** appear in windows 1 and 2. The server refuses
   plaintext on a document that has ever been encrypted, and says so in its log.

**Pass:** two windows share a document; a third window without the key can neither read it
nor contribute to it; and the key never left the browser.

### 2.5 Restart persistence

| Step                                            | Expected                    |
| ----------------------------------------------- | --------------------------- |
| Type `survives-restart` in a plaintext document | Synced                      |
| `Ctrl+C`, then `npm run start:local` again      | —                           |
| Open the same URL in a fresh window             | `survives-restart` is there |

Data lives in `.data/pgdata`. Delete that directory and you have a clean slate.

### 2.6 Observability

```powershell
curl -s http://127.0.0.1:3001/api/metrics | Select-String "^collab_"
```

**Expected:** counters for connections, operations received, broadcast, and errors. Compare
against what you just did — operations you typed should appear in `collab_ops_received_total`.

The server's log is JSON lines on stdout. Every line parses:

```powershell
npm run start:local 2>&1 | ForEach-Object { $_ | ConvertFrom-Json | Select-Object msg }
```

### 2.7 Optional: load, if you want numbers

Requires [k6](https://k6.io). Not installed on the machine that wrote this.

```powershell
npm run load:connect      # 100 clients connecting
npm run load:edit         # concurrent editing throughput
npm run load:divergence   # contention, then checks for unplaceable operations
```

`divergence` is the one that matters. It drives many writers into one document and asks
whether anything failed to apply. Convergence itself is verified separately in
`src/server/loadConvergence.test.ts` using the real `Replica`, because k6 cannot import this
project's TypeScript and reimplementing the CRDT in JavaScript to test it would mean testing a
second, separately wrong implementation.

---

## Part 3: What "working" does not cover

Being straight about the gaps, because a checklist that implies more coverage than exists is
worse than none:

- **One machine only.** Everything above is a single computer. Real users on real networks is
  untested, and it is the thing that matters.
- **Anonymous identities.** A session is a signed token with a random subject; there are no
  accounts. **Clearing your browser's site data loses access to your documents** — there is no
  recovery. Two browser profiles are two different people as far as the server is concerned.
- **One server instance.** Fan-out is in-process. Running two would silently split a
  document's collaborators between them, with no error.
- **Encrypted documents never compact** and have no text cache, because both need plaintext.
  Their operation log grows for the life of the document.
- **Sharing is manual.** There is no permission UI. Someone with the link can read and edit
  the document. That is the entire access model, and for encrypted documents the link _is_ the
  credential.
- **Security has not been independently reviewed.** Validation, authorisation and the crypto
  are tested; nobody outside this repository has read them.

---

## If something fails

1. **Re-run `npm run verify:all`.** Some of the heaviest tests are timing-sensitive on a
   loaded machine, and a single rerun distinguishes a flake from a real failure.
2. **Check the server's JSON log.** It names the stage that failed and why.
3. **Report what you saw**, ideally with: your Node version, the exact step, what you expected,
   what happened, and the relevant log lines.

One known flake, recorded rather than hidden: a `Test` failure in
`src/server/loadConvergence.test.ts` appeared once on a loaded CI runner and is now fixed by
waiting for actual delivery instead of a fixed 120 ms sleep. If you ever see that test fail
with one editor holding fewer characters than the others, it is delivery timing, not the CRDT —
rerun it.
