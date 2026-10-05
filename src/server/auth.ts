/**
 * Session tokens.
 *
 * NOTE ON ENCODING: this file is ASCII-only by design. See the note at the top of
 * src/core/crdt/rga.ts.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PROBLEMSOLVES
 * ---------------------------------------------------------------------------
 * Before this existed, a document id was the only access control. Anyone who knew
 * or guessed an id could read and write that document. Document ids travel in
 * URLs, and URLs end up in browser history, Referer headers and screenshots, so
 * "you would have to guess it" is not a security argument.
 *
 * ---------------------------------------------------------------------------
 * WHY ANONYMOUS SESSIONS AND NOT ACCOUNTS
 * ---------------------------------------------------------------------------
 * There is no user table, no password, no email. A client asks for a session, gets
 * a signed token carrying a random subject, and keeps it. Documents record the
 * subject that created them.
 *
 * This is deliberate. Accounts would be CRUD, and CRUD is not the part of this
 * project worth building. The anonymous subject is enough to make "knowing an id
 * is enough to read the document" false, which is the actual defect.
 *
 * It is not identity. Two browser profiles are two different subjects with no way
 * to prove they are the same person. That limitation is real and is stated in
 * NOTES.md rather than papered over.
 *
 * ---------------------------------------------------------------------------
 * TWO MODES
 * ---------------------------------------------------------------------------
 * {@link TokenAuthenticator} is the real one: HS256, pinned algorithm, verified
 * issuer and audience, verified expiry.
 *
 * {@link OpenAuthenticator} exists so `npm run dev` and the test suite need no
 * secret configured. It accepts any well-formed token and treats the token itself
 * as the subject. It is NOT security and must never be reachable in production;
 * {@link resolveAuthenticator} refuses to build it there.
 */

import { SignJWT, errors as joseErrors, jwtVerify } from 'jose';

import { isValidSubject, SUBJECT_RULE_MESSAGE } from '../shared/subject.js';

/** How long an issued session token stays valid. */
export const DEFAULT_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * HS256 needs at least 256 bits of key. Anything shorter is refused here rather
 * than silently padded, because a weak key that appears to work is worse than one
 * that refuses to start.
 */
export const MIN_SECRET_BYTES = 32;

/**
 * Shape a subject must have to be usable as an owner or collaborator.
 *
 * The rule itself lives in shared/subject.ts because it is not only a token concern:
 * a subject also arrives as a collaborator grant in a request body, and validating
 * it only on the token path left arbitrary text going straight into a database key.
 */
function assertUsableSubject(subject: string): string {
  if (!isValidSubject(subject)) {
    throw new AuthError('bad-subject', SUBJECT_RULE_MESSAGE);
  }

  return subject;
}
/** Why a token was rejected. Every value maps to a 401. */
export type AuthFailure =
  'missing' | 'malformed' | 'bad-signature' | 'expired' | 'wrong-audience' | 'bad-subject';

export class AuthError extends Error {
  readonly reason: AuthFailure;

  constructor(reason: AuthFailure, message: string) {
    super(message);
    this.name = 'AuthError';
    this.reason = reason;
  }
}

export interface IssuedToken {
  readonly token: string;
  readonly subject: string;
  /** Epoch milliseconds. Zero means "does not expire", which only open mode says. */
  readonly expiresAt: number;
}

export interface Identity {
  readonly subject: string;
}

export interface Authenticator {
  /** Mint a token for a subject the caller already trusts. */
  issue(subject: string): Promise<IssuedToken>;

  /**
   * @returns the verified subject.
   * @throws {AuthError} for anything untrusted. Callers must not catch and
   *   continue with a partial identity.
   */
  verify(token: string): Promise<Identity>;

  /** False when this authenticator provides no security. Surfaced in /api/health. */
  readonly isOpen: boolean;
}

/**
 * Real authentication: a signed, expiring JWT.
 *
 * The algorithm is pinned in both directions. Passing `algorithms` to
 * `jwtVerify` is what prevents algorithm confusion, where a token claiming
 * `alg: none`, or an asymmetric algorithm verified with the public key as an HMAC
 * secret, is accepted.
 */
export class TokenAuthenticator implements Authenticator {
  readonly isOpen = false;
  readonly #key: Uint8Array;
  readonly #ttlMs: number;
  readonly #issuer: string;
  readonly #audience: string;

  constructor(options: {
    readonly secret: string;
    readonly ttlMs?: number;
    readonly issuer?: string;
    readonly audience?: string;
  }) {
    const key = new TextEncoder().encode(options.secret);

    if (key.byteLength < MIN_SECRET_BYTES) {
      throw new Error(
        `JWT_SECRET must be at least ${MIN_SECRET_BYTES} bytes for HS256; got ${key.byteLength}.`,
      );
    }

    if (options.ttlMs !== undefined && (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0)) {
      throw new Error('Token TTL must be a positive number of milliseconds.');
    }

    this.#key = key;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TOKEN_TTL_MS;
    this.#issuer = options.issuer ?? 'collab-editor';
    this.#audience = options.audience ?? 'collab-editor';
  }

  async issue(subject: string): Promise<IssuedToken> {
    const usable = assertUsableSubject(subject);
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAtSeconds = issuedAt + Math.ceil(this.#ttlMs / 1000);

    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(usable)
      .setIssuer(this.#issuer)
      .setAudience(this.#audience)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAtSeconds)
      .sign(this.#key);

    return { token, subject: usable, expiresAt: expiresAtSeconds * 1000 };
  }

  async verify(token: string): Promise<Identity> {
    if (typeof token !== 'string' || token.trim() === '') {
      throw new AuthError('missing', 'No session token was supplied.');
    }

    try {
      const { payload } = await jwtVerify(token, this.#key, {
        // Pinned. Without this, verification accepts whatever the token claims.
        algorithms: ['HS256'],
        issuer: this.#issuer,
        audience: this.#audience,
        // No clock tolerance. A token that expired one second ago is expired.
        clockTolerance: 0,
        // REQUIRED, and the single most important line in this method.
        //
        // A JWT without an `exp` claim is valid forever, and `jwtVerify` accepts
        // that by default: expiry is checked when present, not demanded. So a
        // signed token with the expiry stripped would be a permanent credential,
        // and nothing would ever report it. Anything that can be signed is only
        // trustworthy while the signer is trusted, so the claims that bound a
        // token's power are required rather than optional.
        requiredClaims: ['exp', 'sub', 'iss', 'aud'],
      });

      if (typeof payload.sub !== 'string' || payload.sub === '') {
        throw new AuthError('bad-subject', 'Token carries no subject.');
      }

      return { subject: assertUsableSubject(payload.sub) };
    } catch (error) {
      // Translate library errors into the small set the caller can respond to.
      // The message is deliberately generic: it goes to a client, and a
      // verification library's error text can describe the token's structure.
      if (error instanceof AuthError) {
        throw error;
      }

      if (error instanceof joseErrors.JWTExpired) {
        throw new AuthError('expired', 'Session token has expired.');
      }

      if (error instanceof joseErrors.JWTInvalid) {
        throw new AuthError('malformed', 'Session token is not valid.');
      }

      if (error instanceof joseErrors.JWSSignatureVerificationFailed) {
        throw new AuthError('bad-signature', 'Session token signature is not valid.');
      }

      throw new AuthError('malformed', 'Session token is not valid.');
    }
  }
}

/**
 * No security at all: the token IS the subject.
 *
 * Two jobs, and only two:
 *
 *   1. `npm run dev` works with nothing configured.
 *   2. The test suite exercises one authorization code path instead of two.
 *
 * It is deliberately a different CLASS, not a flag on TokenAuthenticator. That is
 * what makes {@link resolveAuthenticator}'s production refusal hard to get wrong:
 * there is no configuration that turns TokenAuthenticator into this.
 */
export class OpenAuthenticator implements Authenticator {
  readonly isOpen = true;
  readonly #ttlMs: number;

  constructor(options: { readonly ttlMs?: number } = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TOKEN_TTL_MS;
  }

  issue(subject: string): Promise<IssuedToken> {
    // Rejection, not a synchronous throw, for the same reason verify() does it.
    try {
      const usable = assertUsableSubject(subject);

      return Promise.resolve({
        token: usable,
        subject: usable,
        expiresAt: Date.now() + this.#ttlMs,
      });
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new AuthError('bad-subject', 'Subject is not usable.'),
      );
    }
  }

  verify(token: string): Promise<Identity> {
    // Every failure here is a REJECTION, never a synchronous throw, including the
    // shape check below. A caller writing `auth.verify(t).catch(...)` must not be
    // able to miss one path and take the exception somewhere else.
    try {
      if (typeof token !== 'string' || token.trim() === '') {
        throw new AuthError('missing', 'No session token was supplied.');
      }

      // The token is the subject. Anyone can present any subject, which is the
      // entire point: this mode is not security and never pretends to be.
      return Promise.resolve({ subject: assertUsableSubject(token.trim()) });
    } catch (error) {
      if (error instanceof AuthError) {
        return Promise.reject(error);
      }

      return Promise.reject(
        new AuthError('malformed', error instanceof Error ? error.message : 'Token is not valid.'),
      );
    }
  }
}

/**
 * Build an options object that omits ttlMs rather than passing undefined.
 *
 * `exactOptionalPropertyTypes` is on deliberately: an explicit `undefined` and an
 * absent property are different things, and collapsing them is how "I meant to
 * override this and passed undefined" becomes a silent no-op.
 */
function ttlOption(ttlMs: number | undefined): { readonly ttlMs?: number } {
  return ttlMs === undefined ? {} : { ttlMs };
}

export interface AuthEnvironment {
  readonly JWT_SECRET?: string | undefined;
  readonly AUTH_MODE?: string | undefined;
  readonly NODE_ENV?: string | undefined;
  readonly JWT_TTL_MS?: string | undefined;
}

export interface ResolvedAuth {
  readonly authenticator: Authenticator;
  /** One line suitable for a startup log. */
  readonly summary: string;
}

/**
 * Decide which authenticator this process runs with.
 *
 * The order matters and is the security policy:
 *
 *   - `AUTH_MODE=open` is honoured in development, and REFUSED in production.
 *     Being able to turn authentication off is necessary for local work; being
 *     able to turn it off on a public server is not something to leave lying
 *     around.
 *   - A secret present means real authentication, whatever NODE_ENV says.
 *   - No secret outside production means open mode, with a loud warning, so a
 *     fresh clone runs.
 *   - No secret in production is a startup failure. Failing to start is the only
 *     safe answer: a server that starts and silently serves everyone's documents
 *     to anyone who knows an id is worse than one that does not start.
 */
export function resolveAuthenticator(env: AuthEnvironment): ResolvedAuth {
  const isProduction = env.NODE_ENV === 'production';
  const secret = env.JWT_SECRET?.trim() ?? '';
  const requestedMode = env.AUTH_MODE?.trim().toLowerCase() ?? '';

  if (requestedMode !== '' && requestedMode !== 'open' && requestedMode !== 'required') {
    throw new Error(`AUTH_MODE must be "open" or "required"; got "${requestedMode}".`);
  }

  if (requestedMode === 'open') {
    if (isProduction) {
      throw new Error(
        'AUTH_MODE=open is refused when NODE_ENV=production. Authentication is not optional on a public server.',
      );
    }

    return {
      authenticator: new OpenAuthenticator(ttlOption(parseTtl(env.JWT_TTL_MS))),
      summary: 'auth: OPEN (development only; tokens are not verified)',
    };
  }

  if (secret !== '') {
    return {
      authenticator: new TokenAuthenticator({ secret, ...ttlOption(parseTtl(env.JWT_TTL_MS)) }),
      summary: 'auth: HS256 sessions',
    };
  }

  // Two independent reasons to insist on a secret, and both are checked here
  // rather than letting one silently win. "required" must mean required in
  // development too, otherwise the flag is decorative and a developer who sets
  // it gets open mode without being told.
  if (isProduction) {
    throw new Error(
      'JWT_SECRET is required when NODE_ENV=production. Generate one with: openssl rand -base64 48',
    );
  }

  if (requestedMode === 'required') {
    throw new Error(
      'AUTH_MODE=required but JWT_SECRET is not set. Set it, or remove AUTH_MODE to run unauthenticated in development.',
    );
  }

  return {
    authenticator: new OpenAuthenticator(ttlOption(parseTtl(env.JWT_TTL_MS))),
    summary: 'auth: OPEN (no JWT_SECRET set; development only)',
  };
}

function parseTtl(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }

  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`JWT_TTL_MS must be a positive number; got "${raw}".`);
  }

  return parsed;
}
