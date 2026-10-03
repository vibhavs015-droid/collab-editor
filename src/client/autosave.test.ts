import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Autosave, type SaveStatus } from './autosave.js';

/** Collects every status transition so assertions can inspect the sequence. */
function recorder(): {
  statuses: SaveStatus[];
  onChange: (s: SaveStatus) => void;
  last: () => SaveStatus;
} {
  const statuses: SaveStatus[] = [];
  return {
    statuses,
    onChange: (status) => {
      statuses.push(status);
    },
    last: () => {
      const last = statuses.at(-1);
      if (!last) {
        throw new Error('no status was emitted');
      }
      return last;
    },
  };
}

describe('Autosave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts idle with nothing saved', () => {
    const rec = recorder();
    const autosave = new Autosave({ documentId: 'doc-1', onStatusChange: rec.onChange });

    expect(autosave.status.state).toBe('idle');
    expect(autosave.status.lastSavedAt).toBeNull();
    expect(autosave.hasUnsavedChanges).toBe(false);
  });

  it('marks the document dirty immediately on change', () => {
    const rec = recorder();
    const autosave = new Autosave({ documentId: 'doc-1', onStatusChange: rec.onChange });

    autosave.schedule('hello');

    expect(autosave.status.state).toBe('dirty');
    expect(autosave.hasUnsavedChanges).toBe(true);
  });

  it('collapses a burst of keystrokes into one save', async () => {
    const saveFn = vi.fn().mockResolvedValue({ updatedAt: '2026-01-01T00:00:00.000Z' });
    const rec = recorder();
    const autosave = new Autosave({
      documentId: 'doc-1',
      debounceMs: 500,
      onStatusChange: rec.onChange,
      saveFn,
    });

    // Ten keystrokes in rapid succession.
    for (let i = 1; i <= 10; i += 1) {
      autosave.schedule('x'.repeat(i));
      vi.advanceTimersByTime(50);
    }

    expect(saveFn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);

    // One write, not ten. This is the entire point of the debounce.
    expect(saveFn).toHaveBeenCalledTimes(1);
    expect(saveFn).toHaveBeenCalledWith('doc-1', 'xxxxxxxxxx');
  });

  it('reports saving then saved', async () => {
    const saveFn = vi.fn().mockResolvedValue({ updatedAt: '2026-01-01T00:00:00.000Z' });
    const rec = recorder();
    const autosave = new Autosave({
      documentId: 'doc-1',
      debounceMs: 10,
      onStatusChange: rec.onChange,
      saveFn,
    });

    autosave.schedule('content');
    await vi.advanceTimersByTimeAsync(10);

    expect(rec.statuses.map((s) => s.state)).toContain('saving');
    expect(autosave.status.state).toBe('saved');
    expect(autosave.status.lastSavedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(autosave.hasUnsavedChanges).toBe(false);
  });

  it('flush saves immediately, ignoring the debounce', async () => {
    const saveFn = vi.fn().mockResolvedValue({ updatedAt: '2026-01-01T00:00:00.000Z' });
    const rec = recorder();
    const autosave = new Autosave({
      documentId: 'doc-1',
      debounceMs: 10_000,
      onStatusChange: rec.onChange,
      saveFn,
    });

    autosave.schedule('urgent');
    await autosave.flush();

    // Critical for beforeunload: waiting 10s there loses the edit entirely.
    expect(saveFn).toHaveBeenCalledTimes(1);
    expect(autosave.hasUnsavedChanges).toBe(false);
  });

  it('flush does nothing when there are no unsaved changes', async () => {
    const saveFn = vi.fn().mockResolvedValue({ updatedAt: '2026-01-01T00:00:00.000Z' });
    const rec = recorder();
    const autosave = new Autosave({
      documentId: 'doc-1',
      onStatusChange: rec.onChange,
      saveFn,
    });

    await autosave.flush();

    expect(saveFn).not.toHaveBeenCalled();
  });

  it('returns to idle when the user undoes back to the saved state', () => {
    const saveFn = vi.fn().mockResolvedValue({ updatedAt: '2026-01-01T00:00:00.000Z' });
    const rec = recorder();
    const autosave = new Autosave({
      documentId: 'doc-1',
      debounceMs: 10,
      onStatusChange: rec.onChange,
      saveFn,
    });

    autosave.markClean('original');
    autosave.schedule('original changed');
    expect(autosave.status.state).toBe('dirty');

    // Undo back to exactly what the server has.
    autosave.schedule('original');

    expect(autosave.status.state).toBe('idle');
    expect(autosave.hasUnsavedChanges).toBe(false);
  });

  describe('out-of-order responses', () => {
    it('does not mark newer edits as saved when an older request resolves', async () => {
      // The classic race: edit A is sent, the user types more, A's response
      // arrives late. Marking 'saved' here would claim A's content is current
      // when it is not.
      let resolveFirst: ((value: { updatedAt: string }) => void) | undefined;
      const saveFn = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<{ updatedAt: string }>((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockResolvedValue({ updatedAt: '2026-01-01T00:00:02.000Z' });

      const rec = recorder();
      const autosave = new Autosave({
        documentId: 'doc-1',
        debounceMs: 10,
        onStatusChange: rec.onChange,
        saveFn,
      });

      autosave.schedule('first');
      await vi.advanceTimersByTimeAsync(10);

      // Newer edit arrives while the first save is still in flight.
      autosave.schedule('second');
      expect(autosave.status.state).toBe('dirty');

      // The stale response resolves. Because a newer revision is pending, the
      // acknowledged content must NOT be adopted as the persisted baseline.
      resolveFirst?.({ updatedAt: '2026-01-01T00:00:01.000Z' });
      await vi.advanceTimersByTimeAsync(20);

      // Second save (mock #2) must have run and persisted 'second'.
      expect(saveFn).toHaveBeenCalledTimes(2);
      expect(saveFn).toHaveBeenLastCalledWith('doc-1', 'second');

      // Nothing left outstanding, so 'saved' with a clean tree is correct here.
      expect(autosave.status.state).toBe('saved');
      expect(autosave.hasUnsavedChanges).toBe(false);
    });

    it('keeps the dirty flag when a stale response arrives and no newer save follows', async () => {
      // Isolates the revision guard from the second-save timing above: a stale
      // acknowledgement must never claim newer content is persisted.
      let resolveSave: ((value: { updatedAt: string }) => void) | undefined;
      const saveFn = vi.fn().mockImplementationOnce(
        () =>
          // Non-async on purpose: the promise must stay pending until the test
          // resolves it explicitly, so that a newer edit can land mid-flight.
          new Promise<{ updatedAt: string }>((resolve) => {
            resolveSave = resolve;
          }),
      );

      const rec = recorder();
      const autosave = new Autosave({
        documentId: 'doc-1',
        debounceMs: 10_000,
        onStatusChange: rec.onChange,
        saveFn,
      });

      autosave.schedule('first');

      // Do NOT await flush() — it blocks until the unresolved promise settles,
      // and with fake timers that deadlocks. Start it, let it dispatch, then
      // make the newer edit before resolving.
      const flushPromise = autosave.flush();
      await vi.advanceTimersByTimeAsync(0);

      // A second edit lands; the debounce is long, so it stays pending.
      autosave.schedule('second');
      expect(autosave.hasUnsavedChanges).toBe(true);

      resolveSave?.({ updatedAt: '2026-01-01T00:00:01.000Z' });
      await flushPromise;

      // Still dirty: 'first' was acknowledged but 'second' was not.
      expect(autosave.hasUnsavedChanges).toBe(true);
      expect(saveFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('failure handling', () => {
    it('surfaces the error and keeps content recoverable', async () => {
      const saveFn = vi.fn().mockRejectedValue(new Error('Network unreachable'));
      const rec = recorder();
      const autosave = new Autosave({
        documentId: 'doc-1',
        debounceMs: 10,
        onStatusChange: rec.onChange,
        saveFn,
      });

      autosave.schedule('precious work');
      await vi.advanceTimersByTimeAsync(10);

      expect(autosave.status.state).toBe('error');
      expect(autosave.status.error).toBe('Network unreachable');
      // Content must remain flagged as unsaved so a retry can rescue it.
      expect(autosave.hasUnsavedChanges).toBe(true);
    });

    it('marks a 5xx failure as retryable', async () => {
      const { ApiError } = await import('./api.js');
      const saveFn = vi.fn().mockRejectedValue(new ApiError(503, 'INTERNAL', 'Server error'));
      const rec = recorder();
      const autosave = new Autosave({
        documentId: 'doc-1',
        debounceMs: 10,
        onStatusChange: rec.onChange,
        saveFn,
      });

      autosave.schedule('content');
      await vi.advanceTimersByTimeAsync(10);

      expect(autosave.status.state).toBe('error');
      expect(autosave.status.retryable).toBe(true);
    });

    it('marks a 4xx failure as not retryable', async () => {
      const { ApiError } = await import('./api.js');
      const saveFn = vi
        .fn()
        .mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Document does not exist.'));
      const rec = recorder();
      const autosave = new Autosave({
        documentId: 'doc-1',
        debounceMs: 10,
        onStatusChange: rec.onChange,
        saveFn,
      });

      autosave.schedule('content');
      await vi.advanceTimersByTimeAsync(10);

      // Retrying a 404 forever helps nobody; the UI should offer a different action.
      expect(autosave.status.retryable).toBe(false);
    });

    it('recovers on a later successful retry', async () => {
      const saveFn = vi
        .fn()
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValueOnce({ updatedAt: '2026-01-01T00:00:03.000Z' });

      const rec = recorder();
      const autosave = new Autosave({
        documentId: 'doc-1',
        debounceMs: 10,
        onStatusChange: rec.onChange,
        saveFn,
      });

      autosave.schedule('content');
      await vi.advanceTimersByTimeAsync(10);
      expect(autosave.status.state).toBe('error');

      await autosave.flush();

      expect(autosave.status.state).toBe('saved');
      expect(autosave.status.error).toBeNull();
      expect(autosave.hasUnsavedChanges).toBe(false);
    });
  });

  describe('markClean', () => {
    it('establishes the persisted baseline after loading', () => {
      const rec = recorder();
      const autosave = new Autosave({ documentId: 'doc-1', onStatusChange: rec.onChange });

      autosave.markClean('loaded from server');

      expect(autosave.hasUnsavedChanges).toBe(false);
      expect(autosave.status.state).toBe('idle');
    });

    it('does not save content that already matches the server', async () => {
      const saveFn = vi.fn().mockResolvedValue({ updatedAt: '2026-01-01T00:00:00.000Z' });
      const rec = recorder();
      const autosave = new Autosave({
        documentId: 'doc-1',
        debounceMs: 10,
        onStatusChange: rec.onChange,
        saveFn,
      });

      autosave.markClean('unchanged');
      autosave.schedule('unchanged');
      await vi.advanceTimersByTimeAsync(50);

      expect(saveFn).not.toHaveBeenCalled();
    });
  });
});
