/**
 * Session tokens, minted inside k6.
 *
 * The load suite sends REAL signed tokens rather than trusting the load server to run
 * unauthenticated. Two reasons, and the second is the one that matters:
 *
 *   1. The benchmark then measures the HMAC verification cost every real request pays.
 *   2. It exercises the same authorisation path production uses, so a load test cannot
 *      pass against a server that has quietly stopped checking anything.
 *
 * ASCII only, per the convention in src/core/crdt/rga.ts.
 */

import crypto from 'k6/crypto';
import encoding from 'k6/encoding';

const ISSUER = 'collab-editor';
const AUDIENCE = 'collab-editor';
const HEADER = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

function base64url(input) {
  return encoding.b64encode(input, 'rawurl');
}

/**
 * k6's `hmac` has no raw-bytes output mode, so it returns a base64 STRING.
 *
 * Base64url is that string with the URL-unsafe characters swapped and the padding
 * removed. Getting this wrong produces a well-formed token with a signature the server
 * will never accept, which looks exactly like "the load test is just slow" and is not.
 */
function base64ToBase64url(standard) {
  return standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Mint an HS256 token for a subject.
 *
 * Claim set must match src/server/auth.ts exactly, including the issuer and audience
 * the server verifies. The server also REQUIRES `exp`, `sub`, `iss` and `aud`; a token
 * missing any of them is rejected before it is ever looked at.
 *
 * @param secret the server's JWT_SECRET
 * @param subject the identity this token speaks for
 * @param ttlSeconds how long it should be valid for
 */
export function mintToken(secret, subject, ttlSeconds = 3600) {
  const issuedAt = Math.floor(Date.now() / 1000);

  const payload = base64url(
    JSON.stringify({
      sub: subject,
      iss: ISSUER,
      aud: AUDIENCE,
      iat: issuedAt,
      exp: issuedAt + ttlSeconds,
    }),
  );

  const signingInput = `${HEADER}.${payload}`;
  const signature = base64ToBase64url(crypto.hmac('sha256', secret, signingInput, 'base64'));

  return `${signingInput}.${signature}`;
}
