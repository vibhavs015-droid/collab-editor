# syntax=docker/dockerfile:1.7
#
# ---------------------------------------------------------------------------
# WHAT THIS IMAGE IS
# ---------------------------------------------------------------------------
# One process serving both the API and the built client, on one port, from one
# origin. That is not a simplification: the client derives both its API base and
# its WebSocket URL from `window.location`, so a two-container deployment would
# need the bundle told where the API is, and every origin change would be a
# second thing to configure wrong.
#
# ---------------------------------------------------------------------------
# DEBIAN, NOT ALPINE
# ---------------------------------------------------------------------------
# `node:24-bookworm-slim`, deliberately not alpine. PGlite is a WebAssembly
# build of PostgreSQL and pulls in musl-specific behaviour, while bookworm-slim
# matches what CI already runs on `ubuntu-latest`. Alpine would save roughly 20 MB
# and trade a build this project cannot run locally to verify for it.
#
# ---------------------------------------------------------------------------
# PINNED TO .nvmrc
# ---------------------------------------------------------------------------
# ARG NODE_VERSION=24 is duplicated from .nvmrc rather than read from it, because
# a Dockerfile cannot read a file outside its build context at FROM time without
# an extra copy layer. The `node-version-file: .nvmrc` in CI is what actually
# keeps them in step; this ARG is the human-readable half of that.

ARG NODE_VERSION=24

# ---------------------------------------------------------------------------
# Stage 1 - build
# ---------------------------------------------------------------------------
# Full toolchain: the compiler, Vite, and every devDependency. None of this
# reaches the final image.
FROM node:${NODE_VERSION}-bookworm-slim AS build

WORKDIR /app

# Dependencies copied before source, so `npm ci` is cached until package-lock.json
# actually changes. Without this layer ordering every source edit reinstalls.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json vite.config.ts vitest.config.ts index.html ./
COPY src ./src

# `tsc && vite build`, matching `npm run build` exactly. Reusing the npm script
# rather than restating the commands means the image and the developer are
# building the same thing, and a change to the script cannot drift from here.
#
# `--ignore-scripts` above is safe precisely because this project's dependencies
# have no install scripts. If one ever needs a native build, that layer has to
# change too - noted here so the next person does not have to rediscover it.
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 - runtime dependencies
# ---------------------------------------------------------------------------
# A separate stage so the final image gets a real production dependency tree
# rather than the full one with devDependencies deleted afterwards. `npm prune`
# leaves more behind than `npm ci --omit=dev` reinstalls, and the difference
# shows up as attack surface nobody chose to have.
FROM node:${NODE_VERSION}-bookworm-slim AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---------------------------------------------------------------------------
# Stage 3 - runtime
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

# `tini` as PID 1. Without it, Node is PID 1, and a process that is PID 1 does
# not get default signal handling: `docker stop` sends SIGTERM, the container
# ignores it for ten seconds, and then SIGKILLs the process mid-write. The
# application already handles SIGTERM and drains connections (see src/server/
# index.ts), but it can only do that if something delivers the signal and then
# reaps the children PGlite leaves behind.
RUN apt-get update \
 && apt-get install --yes --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    # 0.0.0.0, not 127.0.0.1. This is the single most common container mistake:
    # loopback inside a container is a loopback inside that container, so the
    # process starts, reports healthy to itself, and is unreachable from outside.
    HOST=0.0.0.0 \
    PORT=8080 \
    # A path, not a connection string. PGlite persists to a directory, so this
    # MUST be a mounted volume or every redeploy starts from an empty database
    # and every document is gone - which looks exactly like data loss and is not.
    PGLITE_DATA_DIR=/data \
    CLIENT_DIST=/app/dist/client

WORKDIR /app

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# The data directory is created here and owned by the unprivileged user, so a
# mounted volume inherits the ownership rather than failing to write on first
# request. Creating it as root and never chowning is why "permission denied" in a
# container usually appears minutes after start rather than at build time.
RUN mkdir -p /data && chown node:node /data

# Drop root. The process needs to write /data and read /app and nothing else.
USER node

EXPOSE 8080

VOLUME ["/data"]

# Health check against the real endpoint, not a TCP connect. A listening socket
# proves the process is up; it does not prove the database migrated, and this
# application's startup order deliberately migrates before listening, so a
# successful TCP check here would be a weaker claim than it looks.
#
# Uses Node's own fetch because bookworm-slim has no curl and adding one for a
# health check would add a package and its CVEs to every image built.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# tini reaps zombies and forwards signals. `-g` sends them to the whole process
# group, which is what reaches the Node process when PGlite has spawned helpers.
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]

# `dist/server/index.js`, not `dist/index.js`.
#
# Both exist. The latter is the Phase 0 toolchain self-check: it prints a summary of
# the CRDT primitives and exits 0, having started no server and bound no port. Verified
# rather than assumed.
#
# A CMD pointing at it is loud rather than silent -- the container exits and a
# `restart: unless-stopped` policy flaps it in a loop -- but the log shows a success
# message and no server, which reads as a very confusing crash. This is also the file CI's
# "Toolchain self-check" step runs, which is correct there and wrong here.
CMD ["node", "dist/server/index.js"]
