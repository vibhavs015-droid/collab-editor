/**
 * API client used by the browser app.
 *
 * Every function returns data or throws {@link ApiError}. No function returns
 * `null` for a failure, because a caller that forgets to check `null` fails
 * silently -- whereas a thrown error surfaces at the point of the mistake and can
 * be caught by the UI, which is exactly what the error states need.
 *
 * The UI never talks to `fetch` directly, so error handling lives in one place.
 */

import { SUBJECT_PATTERN, newSubject } from '../shared/subject.js';
import type { DocumentRecord } from '../server/db.js';

/**
 * localStorage key holding this browser profile's durable subject.
 *
 * Deliberately NOT `sessionStorage`: that is per-tab, so a second tab would mint a second
 * subject and the two tabs could not collaborate - which is precisely the failure this
 * replaced. See {@link SessionStore} for the whole story.
 */
const SUBJECT_STORAGE_KEY = 'collab-editor:subject';

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
 * The token lives in memory only, deliberately: persisting a bearer token to
 * localStorage would leave a long-lived credential readable by any script on the origin.
 * The SUBJECT is persisted instead, in localStorage, because losing it loses your
 * documents - see #storedSubject for why that trade was previously backwards.
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

  /**
   * The durable half of the identity: one random subject per browser profile.
   *
   * ---------------------------------------------------------------------------
   * WHY THE SUBJECT IS PERSISTED AND THE TOKEN IS NOT
   * ---------------------------------------------------------------------------
   * This class previously kept only the token, in memory, and the comment justified it as
   * "the cost of that is a user having to obtain a new session after a reload."
   *
   * That is the right trade for accounts and the wrong one here. There are no accounts, so a
   * new session is not a re-login - it is a NEW PERSON. After one reload the browser lost
   * server-side access to every document it had ever opened, permanently and silently: the
   * local copy kept rendering from IndexedDB, so it looked like a flaky network, and the
   * server logged DOCUMENT_NOT_FOUND rejections about twice a second forever.
   *
   * Found by opening the app in a real browser. No test covered it, because every test minted
   * its own token and used it consistently.
   *
   * The fix splits the two halves of the credential:
   *
   *   - the SUBJECT is 16 random bytes, generated once, kept in localStorage, and presented to
   *     the server on every load. It is the identity. Losing it loses your documents.
   *   - the TOKEN is short-lived, minted fresh from the subject on every load, and kept in
   *     memory only. It is the receipt.
   *
   * So a script on this origin can still read localStorage and act as this user - but there is
   * no long-lived bearer token to steal and replay until it expires, which is a genuine
   * improvement over persisting the token itself.
   *
   * `localStorage` rather than `sessionStorage` is the load-bearing choice: sessionStorage is
   * per-tab, so a second tab would mint a second subject and the two tabs could not
   * collaborate. That is exactly the bug this replaces.
   */
  #storedSubject(): string | null {
    // Generated BEFORE the try, deliberately.
    //
    // The first version generated inside it, so a genuine bug - `newSubject` calling a
    // Node builtin that Vite stubs for the browser, which throws TypeError - was caught by
    // this same catch and reported as "storage unavailable". Durable identity was therefore
    // silently OFF in the browser, which is the only place it matters, and nothing said so.
    //
    // A catch that covers both "the environment says no" and "my code is broken" converts a
    // bug into a plausible-looking degradation. This one is scoped to storage alone.
    const minted = newSubject();

    try {
      const existing = window.localStorage.getItem(SUBJECT_STORAGE_KEY);

      if (existing !== null && SUBJECT_PATTERN.test(existing)) {
        return existing;
      }

      // Write rather than reuse an invalid value. A corrupt entry must not wedge the app into
      // re-reading something unusable on every load.
      window.localStorage.setItem(SUBJECT_STORAGE_KEY, minted);

      return minted;
    } catch (error) {
      // Private browsing, storage disabled, or a quota error. Returning null falls back to a
      // server-minted subject, which is the behaviour that predates durable identity - so this
      // degrades rather than breaks. Logged because a silent degradation here is exactly what
      // hid the bug above: the only symptom was that a feature quietly did nothing.
      console.warn(
        "Could not persist this browser profile's subject; a new one will be minted per load.",
        error,
      );

      return null;
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
    // Present the durable subject so the server mints a token for THIS identity rather than
    // a new one. Omitted when storage is unavailable, which falls back to a fresh subject -
    // the old behaviour, so a browser with storage disabled still works.
    const subject = this.#storedSubject();

    const response = await fetch('/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(subject === null ? {} : { body: JSON.stringify({ subject }) }),
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
    // "the server is unreachable" -- worth saying plainly.
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
