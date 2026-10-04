/**
 * Session token tests.
 *
 * The interesting cases are the rejections, not the happy path. A round trip
 * proves the signer and verifier agree, which is a much weaker claim than "this
 * rejects everything it should".
 *
 * NOTE ON ENCODING: ASCII only. See src/core/crdt/rga.ts.
 */

import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import {
  AuthError,
  DEFAULT_TOKEN_TTL_MS,
  MIN_SECRET_BYTES,
  OpenAuthenticator,
  TokenAuthenticator,
  newSubject,
  resolveAuthenticator,
} from './auth.js';

const SECRET = 'a-test-secret-that-is-long-enough-for-hs256-padding';
const OTHER_SECRET = 'a-different-secret-of-equal-length-so-length-is-not-the-test';

function authenticator(overrides: { secret?: string; ttlMs?: number } = {}): TokenAuthenticator {
  const options: { secret: string; ttlMs?: number } = { secret: SECRET };

  if (overrides.ttlMs !== undefined) {
    options.ttlMs = overrides.ttlMs;
  }

  return new TokenAuthenticator(options);
}

async function expectAuthError(run: () => Promise<unknown>, reason: string): Promise<void> {
  await expect(run()).rejects.toBeInstanceOf(AuthError);

  try {
    await run();
    throw new Error('expected the call to reject');
  } catch (error) {
    expect((error as AuthError).reason).toBe(reason);
  }
}

describe('newSubject', () => {
  it('produces distinct, well-formed subjects', () => {
    const seen = new Set<string>();

    for (let index = 0; index < 500; index += 1) {
      const subject = newSubject();
      expect(subject).toMatch(/^[A-Za-z0-9_-]{20,30}$/u);
      expect(seen.has(subject)).toBe(false);
      seen.add(subject);
    }
  });

  it('is unguessable rather than sequential', () => {
    // A sequential counter would still be "distinct", so check the shape of the
    // distribution instead: no shared prefix across many draws.
    const subjects = Array.from({ length: 50 }, () => newSubject());
    const prefixes = new Set(subjects.map((subject) => subject.slice(0, 8)));

    expect(prefixes.size).toBe(50);
  });
});

describe('TokenAuthenticator - round trip', () => {
  it('verifies what it issues', async () => {
    const auth = authenticator();
    const issued = await auth.issue('alice');

    expect(issued.subject).toBe('alice');
    expect(issued.expiresAt).toBeGreaterThan(Date.now());
    await expect(auth.verify(issued.token)).resolves.toEqual({ subject: 'alice' });
  });

  it('reports an expiry the caller can act on', async () => {
    const auth = authenticator();
    const issued = await auth.issue('alice');

    // Not "does it verify", but "does the client get told when to refresh".
    expect(issued.expiresAt).toBeLessThanOrEqual(Date.now() + DEFAULT_TOKEN_TTL_MS);
  });

  it('honours a custom ttl', async () => {
    const auth = authenticator({ ttlMs: 60_000 });
    const issued = await auth.issue('alice');
    const lifetime = issued.expiresAt - Date.now();

    // Within a second of the requested minute. Loose because `exp` has
    // one-second resolution and the clock is not frozen.
    expect(lifetime).toBeGreaterThan(55_000);
    expect(lifetime).toBeLessThanOrEqual(60_000);
  });

  it('is not open', () => {
    expect(authenticator().isOpen).toBe(false);
  });
});

describe('TokenAuthenticator - rejections', () => {
  it('rejects a token signed with a different secret', async () => {
    const issued = await authenticator().issue('alice');
    const attacker = new TokenAuthenticator({ secret: OTHER_SECRET });

    await expectAuthError(() => attacker.verify(issued.token), 'bad-signature');
  });

  it('rejects a token that has already expired', async () => {
    const key = new TextEncoder().encode(SECRET);

    // Signed here rather than by the authenticator under test, so this exercises
    // the verifier's expiry check instead of the signer's.
    const expired = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('alice')
      .setIssuer('collab-editor')
      .setAudience('collab-editor')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(key);

    await expectAuthError(() => authenticator().verify(expired), 'expired');
  });

  it('rejects a token with no expiry at all', async () => {
    const key = new TextEncoder().encode(SECRET);

    // A non-expiring token is not a lesser version of a session; it is a
    // permanent credential. One that verifies would silently outlive the design.
    const forever = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('alice')
      .setIssuer('collab-editor')
      .setAudience('collab-editor')
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .sign(key);

    await expectAuthError(() => authenticator().verify(forever), 'malformed');
  });

  it('rejects a token minted for a different audience', async () => {
    const key = new TextEncoder().encode(SECRET);

    const elsewhere = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('alice')
      .setIssuer('collab-editor')
      .setAudience('some-other-service')
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(key);

    await expectAuthError(() => authenticator().verify(elsewhere), 'malformed');
  });

  it('rejects a token minted by a different issuer', async () => {
    const key = new TextEncoder().encode(SECRET);

    const elsewhere = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('alice')
      .setIssuer('some-other-service')
      .setAudience('collab-editor')
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(key);

    await expectAuthError(() => authenticator().verify(elsewhere), 'malformed');
  });

  it('rejects an unsigned token', async () => {
    // Hand-built, because no library will helpfully produce one. This is the
    // alg:none attack: a token that declares no algorithm and carries no
    // signature. Verification must refuse rather than read alg from the token.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'alice',
        iss: 'collab-editor',
        aud: 'collab-editor',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url');

    await expectAuthError(() => authenticator().verify(`${header}.${payload}.`), 'malformed');
  });

  it('rejects a token whose payload was edited after signing', async () => {
    const issued = await authenticator().issue('alice');
    const parts = issued.token.split('.');
    const rawHeader = parts[0];
    const signature = parts[2];

    const tampered = Buffer.from(
      JSON.stringify({
        sub: 'mallory',
        iss: 'collab-editor',
        aud: 'collab-editor',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url');

    await expectAuthError(
      () => authenticator().verify(`${rawHeader}.${tampered}.${signature}`),
      'bad-signature',
    );
  });

  it('rejects a token with no subject', async () => {
    const key = new TextEncoder().encode(SECRET);

    const anonymous = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('collab-editor')
      .setAudience('collab-editor')
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(key);

    // Caught by `requiredClaims` before the explicit check below it, so the
    // reason is "malformed" rather than "bad-subject". Both are 401s; the
    // distinction only matters for the log line.
    await expectAuthError(() => authenticator().verify(anonymous), 'malformed');
  });

  it('rejects a subject that is not a safe shape', async () => {
    const key = new TextEncoder().encode(SECRET);

    // A correctly signed token carrying a subject with a quote and a newline. The
    // signature is valid, so only the shape check can catch this.
    const hostile = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject("alice'; DROP TABLE documents;--\n")
      .setIssuer('collab-editor')
      .setAudience('collab-editor')
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(key);

    await expectAuthError(() => authenticator().verify(hostile), 'bad-subject');
  });

  it('rejects an over-long subject', async () => {
    const key = new TextEncoder().encode(SECRET);

    const long = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('a'.repeat(129))
      .setIssuer('collab-editor')
      .setAudience('collab-editor')
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(key);

    await expectAuthError(() => authenticator().verify(long), 'bad-subject');
  });

  it('rejects an absent or blank token', async () => {
    const auth = authenticator();

    await expectAuthError(() => auth.verify(''), 'missing');
    await expectAuthError(() => auth.verify('   '), 'missing');
    await expectAuthError(() => auth.verify('not.a.jwt'), 'malformed');
  });

  it('does not echo token structure in its error message', async () => {
    const issued = await authenticator().issue('alice');
    const [header] = issued.token.split('.');
    let message = '';

    try {
      await new TokenAuthenticator({ secret: OTHER_SECRET }).verify(issued.token);
    } catch (error) {
      message = (error as Error).message;
    }

    // The client sees this text. It must not help them reconstruct a token.
    expect(message).not.toContain(header);
  });
});

describe('TokenAuthenticator - construction', () => {
  it('refuses a secret shorter than HS256 requires', () => {
    expect(MIN_SECRET_BYTES).toBe(32);

    expect(() => new TokenAuthenticator({ secret: 'too-short' })).toThrow(/at least 32 bytes/u);
  });

  it('accepts a secret of exactly the minimum length', () => {
    expect(() => new TokenAuthenticator({ secret: 'x'.repeat(MIN_SECRET_BYTES) })).not.toThrow();
  });

  it('refuses a non-positive ttl', () => {
    expect(() => new TokenAuthenticator({ secret: SECRET, ttlMs: 0 })).toThrow(/positive/u);
    expect(() => new TokenAuthenticator({ secret: SECRET, ttlMs: -1 })).toThrow(/positive/u);
    expect(() => new TokenAuthenticator({ secret: SECRET, ttlMs: Number.NaN })).toThrow(
      /positive/u,
    );
  });

  it('refuses to issue a token for an unusable subject', async () => {
    const auth = authenticator();

    await expect(auth.issue('')).rejects.toBeInstanceOf(AuthError);
    await expect(auth.issue('has space')).rejects.toBeInstanceOf(AuthError);
    await expect(auth.issue('a'.repeat(129))).rejects.toBeInstanceOf(AuthError);
  });

  it('accepts every character the subject pattern allows', async () => {
    const auth = authenticator();
    const subject = 'aZ09_.-:';

    await expect(auth.issue(subject)).resolves.toMatchObject({ subject });
  });
});

describe('OpenAuthenticator', () => {
  it('treats the token as the subject', async () => {
    const auth = new OpenAuthenticator();

    await expect(auth.verify('phase-3-no-auth')).resolves.toEqual({
      subject: 'phase-3-no-auth',
    });
  });

  it('admits it is not security', () => {
    expect(new OpenAuthenticator().isOpen).toBe(true);
  });

  it('still refuses an absent token', async () => {
    await expect(new OpenAuthenticator().verify('')).rejects.toBeInstanceOf(AuthError);
  });

  it('still refuses an unusable subject shape', async () => {
    // The shape check is not auth, but it is input validation, and open mode is
    // not a reason to let an arbitrary string become a document owner.
    await expect(new OpenAuthenticator().verify('has space')).rejects.toBeInstanceOf(AuthError);
  });

  it('accepts a generated subject', async () => {
    const auth = new OpenAuthenticator();
    const issued = await auth.issue(newSubject());

    await expect(auth.verify(issued.token)).resolves.toEqual({ subject: issued.subject });
  });
});

describe('resolveAuthenticator', () => {
  it('uses real authentication when a secret is present', () => {
    const resolved = resolveAuthenticator({ JWT_SECRET: SECRET });

    expect(resolved.authenticator.isOpen).toBe(false);
    expect(resolved.summary).toContain('HS256');
  });

  it('falls back to open mode outside production', () => {
    // So a fresh clone runs with nothing configured.
    const resolved = resolveAuthenticator({ NODE_ENV: 'development' });

    expect(resolved.authenticator.isOpen).toBe(true);
    expect(resolved.summary).toContain('development only');
  });

  it('refuses to start in production with no secret', () => {
    expect(() => resolveAuthenticator({ NODE_ENV: 'production' })).toThrow(
      /JWT_SECRET is required/u,
    );
  });

  it('refuses AUTH_MODE=open in production', () => {
    // Even with a secret configured: the request is explicit, and honouring it
    // is how a staging box ends up serving everyone's documents.
    expect(() =>
      resolveAuthenticator({
        NODE_ENV: 'production',
        AUTH_MODE: 'open',
        JWT_SECRET: SECRET,
      }),
    ).toThrow(/refused when NODE_ENV=production/u);
  });

  it('honours AUTH_MODE=open in development', () => {
    const resolved = resolveAuthenticator({ NODE_ENV: 'development', AUTH_MODE: 'open' });

    expect(resolved.authenticator.isOpen).toBe(true);
  });

  it('honours AUTH_MODE=required, refusing an absent secret', () => {
    // Required means required. Development is not an excuse, and the error says
    // which of the two ways out is available.
    expect(() => resolveAuthenticator({ NODE_ENV: 'development', AUTH_MODE: 'required' })).toThrow(
      /AUTH_MODE=required but JWT_SECRET is not set/u,
    );
  });

  it('treats a blank secret as absent', () => {
    const resolved = resolveAuthenticator({ NODE_ENV: 'development', JWT_SECRET: '   ' });

    expect(resolved.authenticator.isOpen).toBe(true);
  });

  it('rejects an unrecognised mode rather than ignoring it', () => {
    expect(() => resolveAuthenticator({ AUTH_MODE: 'maybe' })).toThrow(
      /must be "open" or "required"/u,
    );
  });

  it('rejects a nonsense ttl rather than using it', () => {
    expect(() => resolveAuthenticator({ JWT_SECRET: SECRET, JWT_TTL_MS: 'forever' })).toThrow(
      /JWT_TTL_MS must be a positive number/u,
    );
    expect(() => resolveAuthenticator({ JWT_SECRET: SECRET, JWT_TTL_MS: '-5' })).toThrow(
      /JWT_TTL_MS must be a positive number/u,
    );
  });

  it('passes a configured ttl through to the authenticator', async () => {
    const resolved = resolveAuthenticator({ JWT_SECRET: SECRET, JWT_TTL_MS: '60000' });
    const issued = await resolved.authenticator.issue('alice');

    expect(issued.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it('treats a blank ttl as unset', () => {
    // Same reasoning as a blank secret: empty means "not configured", not "zero".
    expect(() => resolveAuthenticator({ JWT_SECRET: SECRET, JWT_TTL_MS: '  ' })).not.toThrow();
  });
});
