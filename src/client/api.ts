/**
 * API client used by the browser app.
 *
 * Every function returns data or throws {@link ApiError}. No function returns
 * `null` for a failure, because a caller that forgets to check `null` fails
 * silently — whereas a thrown error surfaces at the point of the mistake and can
 * be caught by the UI, which is exactly what the error states need.
 *
 * The UI never talks to `fetch` directly, so error handling lives in one place.
 */

import type { DocumentRecord } from '../server/db.js';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }

  /** True when retrying might succeed. Guides whether to offer a retry button. */
  get isRetryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }

  /** True when the document is gone and the UI should offer to create one. */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

interface ErrorPayload {
  error?: { code?: string; message?: string };
}

export interface Session {
  readonly token: string;
  readonly subject: string;
  /** Epoch milliseconds. Zero when the server does not say. */
  readonly expiresAt: number;
}

/**
 * How far ahead of expiry a token is renewed.
 *
 * Comfortably longer than a slow request takes, so a token cannot expire in flight.
 * An hour of a seven-day token is a rounding error on renewals and still leaves the
 * token valid for days.
 */
const RENEWAL_MARGIN_MS = 60 * 60 * 1000;

/**
 * Holds the session token and attaches it to every request.
 *
 * A module-level singleton rather than a parameter threaded through every call,
 * because a caller that forgets to pass it produces a 401 that looks like a server
 * bug. One place to look, one place to refresh.
 *
 * The token lives in memory only, deliberately. Persisting it to localStorage would
 * make it readable by any script on the origin, and the cost of that is a user
 * having to obtain a new session after a reload. See README for the tradeoff.
 */
class SessionStore {
  #token: string | null = null;
  #subject: string | null = null;
  #expiresAt = 0;
  #inflight: Promise<Session> | null = null;

  get token(): string | null {
    return this.#token;
  }

  get subject(): string | null {
    return this.#subject;
  }

  /**
   * Return a valid token, fetching a new one if needed.
   *
   * Concurrent callers share one request. Without that, a client that fires six
   * requests on page load would mint six subjects, and the first five documents
   * would be owned by identities the user never sees again.
   *
   * @param force discard any cached token first. Used after a 401, where the cached
   *   token is known to be bad rather than merely old.
   */
  async ensure(force = false): Promise<Session> {
    if (!force && this.#cached !== null && !this.#needsRenewal()) {
      return this.#cached;
    }

    if (this.#inflight !== null && !force) {
      return this.#inflight;
    }

    this.#inflight = this.#fetchSession();

    try {
      const session = await this.#inflight;
      this.#token = session.token;
      this.#subject = session.subject;
      this.#expiresAt = session.expiresAt;
      return session;
    } finally {
      this.#inflight = null;
    }
  }

  /** Forget the token, so the next request mints a new session. */
  invalidate(): void {
    this.#token = null;
    this.#subject = null;
    this.#expiresAt = 0;
  }

  get #cached(): Session | null {
    if (this.#token === null) {
      return null;
    }

    return { token: this.#token, subject: this.#subject ?? '', expiresAt: this.#expiresAt };
  }

  /**
   * Renew slightly before the token actually expires.
   *
   * The alternative is a request that leaves with a token valid for one more
   * millisecond and comes back 401. Renewing early turns a user-visible failure
   * into an invisible one.
   *
   * A zero `expiresAt` means "no known expiry", which open mode reports. Those are
   * never renewed early, because renewing them would mint a new subject on every
   * request and orphan every document the previous one owned.
   */
  #needsRenewal(): boolean {
    if (this.#expiresAt === 0) {
      return false;
    }

    return Date.now() >= this.#expiresAt - RENEWAL_MARGIN_MS;
  }

  async #fetchSession(): Promise<Session> {
    const response = await fetch('/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      throw new ApiError(response.status, 'NO_SESSION', 'Could not obtain a session.');
    }

    const body = (await response.json()) as Partial<Session>;

    if (typeof body.token !== 'string' || typeof body.subject !== 'string') {
      throw new ApiError(response.status, 'BAD_RESPONSE', 'Session response was malformed.');
    }

    return {
      token: body.token,
      subject: body.subject,
      expiresAt: typeof body.expiresAt === 'number' ? body.expiresAt : Date.now(),
    };
  }
}

export const sessionStore = new SessionStore();

/**
 * Perform a request and unwrap the response.
 *
 * Distinguishes three failure modes deliberately, because the UI treats them
 * differently and collapsing them loses information the user needs:
 *
 * - **Network failure** (server down, CORS) → `status 0`, retryable
 * - **Non-2xx** → real status and server-supplied code
 * - **2xx with an unparseable body** → genuinely unexpected, surfaced as such
 *
 * A 401 is retried exactly once, with a fresh session. One retry, not a loop: if a
 * freshly minted token is also rejected then the server is not merely unhappy with
 * the old one, and retrying forever turns an authentication problem into a request
 * flood.
 */
async function request<T>(path: string, init?: RequestInit, retried = false): Promise<T> {
  let response: Response;

  // Every document route needs credentials. `/api/health` does not, and sending a
  // header to it costs nothing, so there is no allowlist to keep in sync.
  //
  // A failure here propagates rather than being caught: with no session there is no
  // request to make, and a 401 from an unauthenticated attempt would be a second
  // failure to report instead of the first.
  const session = await sessionStore.ensure();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };

  if (session.token !== '') {
    headers['Authorization'] = `Bearer ${session.token}`;
  }

  try {
    response = await fetch(path, { ...init, headers });
  } catch (error) {
    // fetch only rejects on a network-level failure, which for this app means
    // "the server is unreachable" — worth saying plainly.
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      error instanceof Error ? error.message : 'Could not reach the server.',
    );
  }

  if (response.status === 401 && !retried) {
    sessionStore.invalidate();
    return request<T>(path, init, true);
  }

  const text = await response.text();

  let payload: unknown;
  try {
    payload = text === '' ? {} : JSON.parse(text);
  } catch {
    if (response.ok) {
      throw new ApiError(response.status, 'BAD_RESPONSE', 'Server sent a malformed response.');
    }
    payload = {};
  }

  if (!response.ok) {
    const errorBody = payload as ErrorPayload;
    throw new ApiError(
      response.status,
      errorBody.error?.code ?? 'UNKNOWN',
      errorBody.error?.message ?? `Request failed with status ${response.status}.`,
    );
  }

  return payload as T;
}

export interface SaveResult {
  readonly updatedAt: string;
  readonly changed: boolean;
}

export const api = {
  async listDocuments(): Promise<DocumentRecord[]> {
    const body = await request<{ documents: DocumentRecord[] }>('/api/documents');
    return body.documents;
  },

  async getDocument(id: string): Promise<DocumentRecord> {
    const body = await request<{ document: DocumentRecord }>(
      `/api/documents/${encodeURIComponent(id)}`,
    );
    return body.document;
  },

  async createDocument(id: string, title: string): Promise<DocumentRecord> {
    const body = await request<{ document: DocumentRecord }>('/api/documents', {
      method: 'POST',
      body: JSON.stringify({ id, title }),
    });
    return body.document;
  },

  async saveContent(id: string, content: string): Promise<SaveResult> {
    return request<SaveResult>(`/api/documents/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ content }),
    });
  },

  async renameDocument(id: string, title: string): Promise<SaveResult> {
    return request<SaveResult>(`/api/documents/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    });
  },

  async deleteDocument(id: string): Promise<void> {
    await request<{ deleted: boolean }>(`/api/documents/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  async health(): Promise<boolean> {
    try {
      await request<{ status: string }>('/api/health');
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Generate an id for a new document.
 *
 * `crypto.randomUUID` is available in every browser that supports the features
 * this app uses, and the result matches the server's id pattern.
 */
export function newDocumentId(): string {
  return crypto.randomUUID();
}
