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

/**
 * Perform a request and unwrap the response.
 *
 * Distinguishes three failure modes deliberately, because the UI treats them
 * differently and collapsing them loses information the user needs:
 *
 * - **Network failure** (server down, CORS) → `status 0`, retryable
 * - **Non-2xx** → real status and server-supplied code
 * - **2xx with an unparseable body** → genuinely unexpected, surfaced as such
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });
  } catch (error) {
    // fetch only rejects on a network-level failure, which for this app means
    // "the server is unreachable" — worth saying plainly.
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      error instanceof Error ? error.message : 'Could not reach the server.',
    );
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
