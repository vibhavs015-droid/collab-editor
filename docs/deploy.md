# Deploying

**Read the "What has and has not been verified" section before trusting this page.** The
Docker image described here has never been built, because Docker is not installed on the
machine it was written on. What _has_ been verified is the runtime contract the image
depends on, listed precisely below.

Nothing here costs money. Every option is on a free tier or self-hosted, and the
architecture is arranged so that staying free is the default rather than a compromise.

---

## What has and has not been verified

Verified by running it, on this machine, against a **production-only dependency tree** —
a real `npm ci --omit=dev` into a clean directory, `dist/` copied in, nothing else:

| Claim                                                                  | Verified how                                                                                                                                  |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci --omit=dev` yields every runtime dependency the server imports | Server started from that tree; see below                                                                                                      |
| `node dist/server/index.js` is the server entrypoint                   | Started and served requests                                                                                                                   |
| `HOST=0.0.0.0` `PORT=8080` work                                        | Started, bound `http://0.0.0.0:8080`                                                                                                          |
| `PGLITE_DATA_DIR` and `CLIENT_DIST` are honoured                       | Absolute paths outside the repo, both effective                                                                                               |
| `/api/health` answers                                                  | 200                                                                                                                                           |
| `/` serves the app shell                                               | 200, `text/html`                                                                                                                              |
| The health-check command in the Dockerfile exits 0                     | Run verbatim against the running server                                                                                                       |
| Anonymous session → create → write → read round-trips                  | Content written and read back verbatim                                                                                                        |
| Documents persist across a restart                                     | Second process saw the first process's document                                                                                               |
| One subject cannot see another's document                              | 404, not 403 (no existence oracle)                                                                                                            |
| `NODE_ENV=production` with no `JWT_SECRET` refuses to start            | Exited non-zero with a JSON error                                                                                                             |
| Logs are JSON lines                                                    | Every line of stdout parsed as JSON                                                                                                           |
| `dist/index.js` is the Phase 0 self-check, not the server              | Ran it: prints a summary, exits 0, serves nothing                                                                                             |
| The Dockerfile's `COPY` list is enough to build the image              | Built from exactly that file set in a clean directory; `dist/server/index.js`, `dist/client/index.html` and `dist/client/assets` all produced |

**Not verifiable without Docker, so now asserted at build time instead:**

Each item below was an unverified guess. Rather than leave them as comments hoping someone
reads them, the Dockerfile now checks each one _during the build_, so a wrong guess fails
loudly at the step that caused it instead of at runtime with a misleading symptom.

| Claim                                              | Now checked by                                                            | Failure it replaces                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| The build emits the files the container runs       | `test -f dist/server/index.js`, `dist/index.js`, `dist/client/index.html` | A container that starts no server and logs a cheerful summary    |
| `tini` is at `/usr/bin/tini`                       | `test -x /usr/bin/tini`                                                   | `exec /usr/bin/tini: no such file or directory` at every restart |
| The unprivileged user can write the data directory | `su node -c 'touch /data/...'`                                            | Healthy container, then EACCES on every write minutes later      |
| `.dockerignore` excludes what it should            | Still read, not built. See below.                                         | -                                                                |

What remains genuinely unverifiable without a Docker daemon:

- **The image builds at all on Linux/bookworm-slim.** No assertion can run before the
  daemon exists.
- **PGlite runs on Debian as a non-root user.** The write probe proves the _directory_ is
  writable; it does not prove the WASM module loads, which is the part that could differ.
- **`tini` receives signals.** `test -x` proves the file exists, not that it is wired as
  PID 1 correctly. That is only observable by sending SIGTERM to a running container.
- **The Linux-only `HEALTHCHECK` JSON array form parses.** The command itself is verified
  (it is what `scripts/smoke.mjs` runs), but whether the daemon accepts the exec form is a
  daemon question.

So: the build inputs, the dependency tree, the runtime contract and the health check are
verified by running them, and the four remaining guesses now fail the build instead of
failing silently. Treat the first `docker compose up --build` as a test with a real chance
of finding something, but a much smaller one.

### The production smoke test, which is now a CI gate

`scripts/smoke.mjs` starts `node dist/server/index.js` with `NODE_ENV=production`
and drives the artefact a user actually gets: the app shell, a hashed asset, the API,
authorisation on an unauthenticated read, Prometheus metrics, a real WebSocket peer pair,
cold replay from the durable log, and an encrypted document including that its frame arrives
byte-for-byte and holds no readable text.

It exists because of `ae27a82`: the production build served nothing, `/` returned 401, and
every source-level test passed, because they all reached the API directly and never asked the
server for a page. A routing table with no static branch looks perfectly correct right up
until a browser asks for a document.

Run it with `npm run smoke` (needs `npm run build` first) or `npm run verify:built`. It is a
separate CI step rather than part of `npm test`, because it needs `dist/` and a build in the
unit suite would make the fast suite slow.

Two things it caught while being written, both of which had been passing:

- The port was read with `/listening[^0-9]*(\d+)/`, which captures `127` out of `127.0.0.1`.
  It now parses the JSON log line the server already emits and reads its own reported `url`.
- It used a single socket and asserted an echo. The relay deliberately does not echo to the
  sender, so a single socket receives nothing and the check fails against a _correct_ server.
  Two peers now, and the same mistake was made in the convergence harness hours earlier.

### Two probes that were wrong before the third passed

Worth recording, because both looked exactly like a broken deployment:

- The first end-to-end probe reported an empty title and empty content. The API nests its
  responses under `document`, and the probe read `body.id` and `body.content`. The probe was
  wrong, not the server. Check the response shape before believing a failure.
- The second probe reused a document id from the first run, got `ALREADY_EXISTS`, then
  `DOCUMENT_NOT_FOUND` - which looks exactly like a broken deployment and was in fact the
  existence-oracle protection working: a _different_ anonymous subject could not see the
  first run's document, which is the intended behaviour.

`scripts/smoke.mjs` reads `body.document.id` and asserts on it, so the first mistake is
compiled out of the gate rather than remembered by whoever runs it next.

---

## Before you install Docker: check the disk

**Docker was not installed on the machine this was written on**, and WSL was present but not
enabled. That combination is worth spelling out because the failure lands after the reboot,
not before it:

1. `wsl --install` needs Administrator, and **a reboot**.
2. WSL2 itself takes a few GB. The Docker Desktop WSL2 backend takes several more.
3. Building this image needs room for the build stages, the dependency trees for both stages,
   and the final layer.

Realistically that wants **15-20 GB free before you start**. Installing Docker with less and
then hitting the wall at `docker compose up --build` reads as a Dockerfile problem - a full
disk during `npm ci` produces output about space that has nothing to do with packaging.

Also note what enabling WSL2 implies, independent of disk: virtualisation must be available
in firmware. On a machine where it is not, the WSL install succeeds and the kernel never
boots, which is a harder problem than a full disk.

Check first, with no changes:

```powershell
Get-PSDrive C | Select-Object @{n='freeGB';e={[math]::Round($_.Free/1GB,1)}}
wsl --status          # "not installed" means the reboot-and-enable path
```

## Locally, with Docker

```bash
# 1. Generate a signing secret. The server refuses to start in production without one.
openssl rand -base64 48
#    Windows PowerShell:
#    [Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Maximum 256 }))

# 2. Put it in the environment for this shell. Not in docker-compose.yml — see below.
export JWT_SECRET='<paste>'

# 3. Build and run.
docker compose up --build
```

Then open <http://127.0.0.1:3001>.

**`JWT_SECRET` is read from the host environment, not from `docker-compose.yml`.** The
compose file contains `${JWT_SECRET:-}`, so the value comes from your shell and never
enters a file that could be committed. The alternative — pasting a real secret into a
tracked YAML — is the single easiest way to leak a deployment credential.

Check it is actually up:

```bash
curl -s localhost:3001/api/health          # {"status":"ok","auth":"required"}
docker compose ps                           # STATUS should show (healthy)
docker compose logs -f app                  # JSON lines
```

Stop it, keeping the data:

```bash
docker compose down
```

Stop it and **destroy the data**:

```bash
docker compose down -v
```

---

## Without Docker

The same production path, on the host:

```bash
npm ci
npm run build
JWT_SECRET=$(openssl rand -base64 48) \
NODE_ENV=production HOST=0.0.0.0 PORT=3001 \
  node dist/server/index.js
```

`npm run serve` is the same command without the environment.

And to check that path automatically, without starting anything by hand:

```bash
npm run verify:built   # build, then run the production smoke test against it
```

That is the closest thing to a container test available without a Docker daemon: the same
built artefact, the same `NODE_ENV=production` and a temporary data directory,
across the page, the API, authorisation, two live WebSocket peers, cold replay and an
encrypted document.

The script reports its own total on the last line (`N checks, 0 failed`), so there is no
number to keep in step here - it was "21" in an earlier draft of this file while the script
actually ran 22.

---

## Deploying for free

### The constraint that shapes everything

**PGlite is the database, and it is a directory on disk.** There is no separate database to
provision, no connection string, no host to pay for, and no idle timeout to fight. That
was chosen for local development (ADR-0006) and it turns out to be the single biggest
reason a free deployment is possible at all.

Its cost is equally real: **state lives in the container's filesystem.** So a free
deployment must attach durable storage, and the platform must not put the app behind
something that assumes a stateless process.

### Option A — Fly.io (recommended, if you want it to stay up)

- Free allowance exists; a single `shared-cpu-1x` machine is small and this application
  is not demanding.
- **Attach a volume.** `fly volumes create collab_data` then mount it at `/data`. Without
  this, `fly deploy` replaces the machine and every document is gone.
- WebSockets work: Fly terminates TLS and passes `Upgrade` through.
- Set `HOST=0.0.0.0` and `PORT=8080` (Fly allocates a port and passes it in `$PORT`).
- Set `JWT_SECRET` as a Fly secret: `fly secrets set JWT_SECRET=...`. Never in
  `fly.toml`.

Sketch:

```toml
# fly.toml
[build]
  dockerfile = "Dockerfile"

[mounts]
  source = "collab_data"
  destination = "/data"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true

[[vm]]
  size = "shared-cpu-1x"
```

### Option B — Render, Railway, or any OCI host

The image is a plain OCI image, so it runs anywhere that does. The requirements are the
same everywhere:

1. A **persistent disk** mounted at `/data`, or `PGLITE_DATA_DIR` pointed at it.
2. `HOST=0.0.0.0`, `PORT` from the platform.
3. `JWT_SECRET` in the platform's secret store.
4. WebSocket support enabled. Some hosts disable it or terminate it without passing
   `Upgrade`; check before assuming.

### Option C — your own machine

```bash
docker compose up -d --build
```

Behind a tunnel for HTTPS if you want a real certificate (`cloudflared tunnel --url
http://localhost:3001` needs no account and no domain).

### What none of these give you

Stated rather than left to be discovered:

- **Horizontal scaling.** One process, one event loop (ADR-0007). Two replicas would each
  hold their own in-memory connections and their own PGlite, and a document edited on both
  would diverge silently. **Run exactly one instance** until the Phase 6 pub/sub question is
  answered.
- **A free tier that stays free under load.** Free tiers have CPU and memory caps, and a
  public URL attracts traffic that is not yours.
- **Backups.** The volume is the database. Copy `/data` and that is the entire backup
  story — there is no point-in-time recovery.
- **Secrets rotation.** Changing `JWT_SECRET` invalidates every outstanding session, so
  every open editor becomes a 401 until the client re-authenticates. The client does handle
  that (`resolveToken` runs per connect), but a rotation is still every user reloading.

---

## The three container traps

Each of these produces a container that starts cleanly, reports healthy, and serves
nothing. They are the reason the Dockerfile sets them explicitly rather than relying on
defaults.

### 1. `HOST` defaults to `127.0.0.1`

Inside a container, loopback is the container's own loopback namespace. A server bound to
it is unreachable from the host and from the platform's proxy, while still being perfectly
able to reach itself — so a health check that runs _inside_ the container passes. The
Dockerfile sets `HOST=0.0.0.0`.

### 2. `PGLITE_DATA_DIR` needs a volume

The default is `./.data/pgdata`, which inside the image is inside the container's
writable layer. Every `docker compose up --build`, every image replacement and every
platform deploy starts from an empty database. The data is not "lost" in any recoverable
sense — it was never written anywhere durable — but the symptom is identical to data loss
and the logs say nothing about it.

The Dockerfile declares `VOLUME ["/data"]` and compose attaches a named volume.

### 3. `dist/index.js` is not the server

Two entrypoints exist. `dist/index.js` is the Phase 0 toolchain self-check: it prints a
CRDT summary and exits 0 without binding a port. It is the right thing for CI's
self-check step and the wrong thing for `CMD`.

---

## Environment variables

`.env.example` is the reference, and it documents exactly the variables the code reads —
enforced by [`env-example.test.ts`](../scripts/env-example.test.ts), which compares the
file against the code and fails on drift in either direction.

There are deliberately **no** `DATABASE_URL`, `SUPABASE_*` or `REDIS_URL` entries. An
earlier version of that file listed all six; no code read them. A variable that does
nothing is worse than an absent one, because setting it and seeing the server start
convinces you it took effect.

### The four limits, and why you should think before raising them

These are the write quotas, added after the review that found writes were unbounded. They exist so
that one client cannot exhaust the server's memory, so each has a default chosen to be generous for
a human and finite for a program:

| Variable                | Default | Bounds            | What it stops                                            |
| ----------------------- | ------- | ----------------- | -------------------------------------------------------- |
| `MAX_TITLE_LENGTH`      | 200     | characters        | A title long enough to be a document body                |
| `OPS_BURST`             | 100000  | operations        | A single client sending an unbounded batch before refill |
| `OPS_PER_SECOND`        | 5000    | operations/second | Sustained flooding                                       |
| `MAX_DOCUMENT_ELEMENTS` | 1000000 | elements          | One document growing without limit                       |

Three things to know before tuning them:

- **`OPS_BURST` and `OPS_PER_SECOND` are per CONNECTION, not per subject.** A subject that
  reconnects gets a fresh bucket. That is deliberate — it is the same property that lets a
  reconnecting client recover — but it means the rate limit is not an identity-level limit and
  cannot be used as one.
- **Neither quota refuses permanently.** Both report a retryable error and keep the connection.
  A permanent refusal would leave a user unable to delete the document that hit the cap, which is
  strictly worse than letting them finish.
- **The defaults have never been tuned against real traffic**, because there has been none. They
  are reasoned, not measured. Watch `collab_ops_rate_limited_total` and
  `collab_documents_too_large_total` in `/api/metrics` before changing them; a counter with no
  increments renders as nothing at all, so its absence is the signal that nobody hit the limit.

Raise `MAX_DOCUMENT_ELEMENTS` only with a reason. It is the one that bounds memory, and the
server's measured idle footprint on the development machine — an empty database, one health
request — was already **257 MB** resident before serving any document.

---

## TLS and HSTS belong to the proxy, not the app

The application sends **no** `Strict-Transport-Security` header, and that is deliberate.

HSTS is a promise a site makes to browsers about the whole origin, and the only party that can
keep it is the thing that actually terminates TLS. This process listens on plain HTTP and is
usually reached through a proxy that terminates TLS in front of it. If the app sent HSTS:

- The header would be attached to HTTP responses too, which is not what the header is for, and
  a client that reached the origin directly would be told to demand HTTPS from a port that does
  not offer it — locking itself out until the browser cache expired.
- Turning it off would mean redeploying the application, rather than changing proxy
  configuration. Certificates rotate; reverse proxies get rebuilt; neither should need an image
  release to adjust transport policy.

So: **terminate TLS at the proxy, and send HSTS there.** Fly.io does this with
`force_https = true` plus its automatic redirect, and adds HSTS itself; on a plain VPS, Caddy
does it in three lines and enables HSTS by default.

Two things the proxy must get right, both already covered by the headers the application sends
(see [`securityHeaders.ts`](../src/server/securityHeaders.ts)):

- **WebSocket upgrade.** `connect-src` allows `ws:` and `wss:`. A proxy that does not pass
  `Upgrade` and `Connection` through will leave the editor permanently "connecting" while every
  REST call succeeds, which is a confusing failure rather than an obvious one.
- **Long timeouts on the socket.** The relay holds connections open; a 30-second read timeout is
  enough to produce a reconnect every 30 seconds on an idle document.

There is also `CSP_MODE`, which is `enforce` by default and takes `report-only` if you want to
watch for violations before enforcing. The policy is verified to produce **zero** violations
across all six browser scenarios, so `enforce` is the shipped default rather than a caution.

---

## Operational notes

**Logs.** JSON lines on stdout, one per line, including the last. Every level is JSON, so
a log parser never has to cope with a human-readable warning in the middle of a stream.
`LOG_LEVEL=debug` for more. Tokens are redacted.

**Metrics.** `GET /api/metrics`, Prometheus text format, unauthenticated. It contains
counters only, never document content, so a scraper needs no session and its existence
discloses nothing. Route labels are templated: `/api/documents/:id`, `/assets/index-*.js`,
`/index.html`. This matters more than it looks — an untemplated asset label is one dead
time series per deploy, forever.

**Health.** `GET /api/health` returns `{status, auth}`. It is unauthenticated, because
that is what a load balancer or an orchestrator has. It proves the process is up _and_ the
database migrated, since startup migrates before listening.

**Shutdown.** `SIGTERM` drains connections and closes the database before exiting.
`tini` is PID 1 so the signal is delivered and children are reaped; without it a container
stop is a ten-second wait followed by `SIGKILL` mid-write.

**Upgrades.** `fly deploy` rebuilds from the Dockerfile. The image is immutable and the
volume is not, so a deploy preserves documents. There is no schema migration step to
remember — `Database.open` runs migrations itself, on a cold volume too.
