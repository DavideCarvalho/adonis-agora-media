// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaUploadClient } from './client';
import { useMediaUpload } from './use-media-upload';

function fakeClient(overrides: Partial<MediaUploadClient> = {}): MediaUploadClient {
  return {
    createTusSession: vi.fn(async () => ({ location: '/media/uploads/tus/s1' })),
    tusOffset: vi.fn(async () => 0),
    abortTus: vi.fn(async () => {}),
    directSessionStatus: vi.fn(async () => ({ completedParts: [], pendingParts: [] })),
    abortDirectSession: vi.fn(async () => {}),
    uploadTus: vi.fn(async (_d, _m, opts) => {
      opts?.onProgress?.(5, 10);
      opts?.onProgress?.(10, 10);
      return { mode: 'tus', location: '/media/uploads/tus/s1' } as const;
    }),
    uploadDirect: vi.fn(
      async () => ({ mode: 'direct', uploadId: 'up', key: 'k', disk: 's3', body: {} }) as const,
    ),
    uploadProxy: vi.fn(async () => ({ mode: 'proxy', key: 'k', disk: 'local' }) as const),
    mediaUrl: (id: string) => `/media/${id}`,
    ...overrides,
  };
}

const file = new File(['hello world'], 'a.txt', { type: 'text/plain' });

describe('useMediaUpload mode routing', () => {
  it('drives the TUS strategy by default and reports success + location', async () => {
    const client = fakeClient();
    const { result } = renderHook(() => useMediaUpload({ client }));

    await act(async () => {
      await result.current.upload(file, { filename: 'a.txt', contentType: 'text/plain' });
    });

    expect(client.createTusSession).toHaveBeenCalledTimes(1);
    expect(client.uploadTus).toHaveBeenCalledTimes(1);
    expect(client.uploadDirect).not.toHaveBeenCalled();
    expect(result.current.status).toBe('success');
    expect(result.current.progress).toBe(1);
    expect(result.current.location).toBe('/media/uploads/tus/s1');
    expect(result.current.result).toEqual({ mode: 'tus', location: '/media/uploads/tus/s1' });
  });

  it('routes to the direct strategy when mode="direct"', async () => {
    const client = fakeClient();
    const { result } = renderHook(() => useMediaUpload({ client, mode: 'direct' }));

    await act(async () => {
      await result.current.upload(file, { filename: 'a.txt', key: 'u/1/a.txt' });
    });

    expect(client.uploadDirect).toHaveBeenCalledTimes(1);
    expect(client.uploadTus).not.toHaveBeenCalled();
    expect(result.current.result).toMatchObject({ mode: 'direct', key: 'k' });
  });

  it('routes to the proxy strategy when mode="proxy"', async () => {
    const client = fakeClient();
    const { result } = renderHook(() => useMediaUpload({ client, mode: 'proxy' }));

    await act(async () => {
      await result.current.upload(file, { filename: 'a.txt', key: 'u/1/a.txt' });
    });

    expect(client.uploadProxy).toHaveBeenCalledTimes(1);
    expect(result.current.result).toMatchObject({ mode: 'proxy' });
  });

  it('computes fractional progress from onProgress callbacks', async () => {
    const client = fakeClient({
      uploadTus: vi.fn(async (_d, _m, opts) => {
        opts?.onProgress?.(3, 12);
        return { mode: 'tus', location: '/media/uploads/tus/p' } as const;
      }),
    });
    const { result } = renderHook(() => useMediaUpload({ client }));
    await act(async () => {
      await result.current.upload(file, { filename: 'a.txt' });
    });
    // finishes at 1 (success), but the mid-upload value proved fractional math ran
    expect(result.current.progress).toBe(1);
  });
});

describe('useMediaUpload error handling', () => {
  it('captures the error and sets status=error', async () => {
    const client = fakeClient({
      uploadTus: vi.fn(async () => {
        throw new Error('network down');
      }),
    });
    const { result } = renderHook(() => useMediaUpload({ client }));

    await act(async () => {
      await expect(result.current.upload(file, { filename: 'a.txt' })).rejects.toThrow(
        'network down',
      );
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error?.message).toBe('network down');
  });
});

describe('useMediaUpload pause / resume / abort (TUS)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pause aborts the in-flight request and settles into paused', async () => {
    let sawSignal: AbortSignal | undefined;
    const client = fakeClient({
      uploadTus: vi.fn((_d, _m, opts) => {
        sawSignal = opts?.signal;
        return new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            const err = new Error('Upload aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }),
    });
    const { result } = renderHook(() => useMediaUpload({ client }));

    let uploadPromise: Promise<unknown>;
    act(() => {
      uploadPromise = result.current.upload(file, { filename: 'a.txt' }).catch(() => {});
    });
    await waitFor(() => expect(sawSignal).toBeInstanceOf(AbortSignal));

    act(() => {
      result.current.pause();
    });
    await act(async () => {
      await uploadPromise;
    });

    expect(result.current.status).toBe('paused');
    expect(sawSignal?.aborted).toBe(true);
  });

  it('resume re-invokes the strategy reusing the same TUS session location', async () => {
    const createTusSession = vi.fn(async () => ({ location: '/media/uploads/tus/keep' }));
    let attempt = 0;
    const client = fakeClient({
      createTusSession,
      uploadTus: vi.fn((_d, _m, opts) => {
        attempt += 1;
        if (attempt === 1) {
          return new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener('abort', () => {
              const err = new Error('Upload aborted');
              err.name = 'AbortError';
              reject(err);
            });
          });
        }
        opts?.onProgress?.(10, 10);
        return Promise.resolve({ mode: 'tus', location: '/media/uploads/tus/keep' } as const);
      }),
    });
    const { result } = renderHook(() => useMediaUpload({ client }));

    let first: Promise<unknown>;
    act(() => {
      first = result.current.upload(file, { filename: 'a.txt' }).catch(() => {});
    });
    await waitFor(() => expect(client.uploadTus).toHaveBeenCalledTimes(1));
    act(() => result.current.pause());
    await act(async () => {
      await first;
    });
    expect(result.current.status).toBe('paused');

    await act(async () => {
      await result.current.resume();
    });

    // The session was opened once; resume reused its location (no second create).
    expect(createTusSession).toHaveBeenCalledTimes(1);
    expect(client.uploadTus).toHaveBeenCalledTimes(2);
    const secondCallOpts = (client.uploadTus as ReturnType<typeof vi.fn>).mock.calls[1][2];
    expect(secondCallOpts.resumeFrom).toBe('/media/uploads/tus/keep');
    expect(result.current.status).toBe('success');
  });

  it('abort terminates the session and resets to idle', async () => {
    const abortTus = vi.fn(async () => {});
    const client = fakeClient({
      abortTus,
      uploadTus: vi.fn((_d, _m, opts) => {
        return new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            const err = new Error('Upload aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }),
    });
    const { result } = renderHook(() => useMediaUpload({ client }));

    act(() => {
      void result.current.upload(file, { filename: 'a.txt' }).catch(() => {});
    });
    await waitFor(() => expect(client.uploadTus).toHaveBeenCalled());

    act(() => result.current.abort());

    expect(abortTus).toHaveBeenCalledWith('/media/uploads/tus/s1');
    expect(result.current.status).toBe('idle');
    expect(result.current.progress).toBe(0);
  });
});

describe('useMediaUpload direct cross-reload resume (storageKey)', () => {
  const storageKey = 'media.direct.session';
  // `file` ("hello world") is 11 bytes, so a matching session stores size: 11.
  const stored = {
    uploadId: 'up1',
    fileName: 'a.txt',
    key: 'k',
    disk: 's3',
    partSize: 5,
    size: 11,
  };
  const statusWithPending = {
    id: 'up1',
    key: 'k',
    disk: 's3',
    partSize: 5,
    size: 11,
    totalParts: 3,
    completedParts: [{ partNumber: 1, etag: 'e1' }],
    pendingParts: [{ partNumber: 2, url: 'https://s3/part/2' }],
  };

  // This vitest+jsdom build exposes no `localStorage` (opaque origin, no config-level URL), so install
  // a faithful in-memory double. It exercises the hook's real code path: the `typeof localStorage`
  // guard plus JSON.stringify/parse and setItem/removeItem/clear.
  const storage = (() => {
    let store: Record<string, string> = {};
    return {
      getItem: (key: string) => (key in store ? store[key] : null),
      setItem: (key: string, value: string) => {
        store[key] = String(value);
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        store = {};
      },
    };
  })();

  beforeAll(() => vi.stubGlobal('localStorage', storage));
  afterAll(() => vi.unstubAllGlobals());
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
  });

  it('persists the session coordinates on initiate', async () => {
    // The upload hangs after onSession so we can observe the persisted coordinates before the
    // success path clears them (a successful upload always clears storage).
    const client = fakeClient({
      uploadDirect: vi.fn((_d, _m, opts) => {
        opts?.onSession?.({
          uploadId: 'up1',
          fileName: 'a.txt',
          key: 'k',
          disk: 's3',
          partSize: 5,
        });
        return new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            const err = new Error('Upload aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }),
    });
    const { result } = renderHook(() => useMediaUpload({ client, mode: 'direct', storageKey }));

    act(() => {
      void result.current.upload(file, { filename: 'a.txt' }).catch(() => {});
    });
    await waitFor(() => expect(client.uploadDirect).toHaveBeenCalled());

    expect(JSON.parse(localStorage.getItem(storageKey) ?? 'null')).toEqual({
      uploadId: 'up1',
      fileName: 'a.txt',
      key: 'k',
      disk: 's3',
      partSize: 5,
      size: 11,
    });
  });

  it('clears the stored session on success', async () => {
    const client = fakeClient({
      uploadDirect: vi.fn(async (_d, _m, opts) => {
        opts?.onSession?.({
          uploadId: 'up1',
          fileName: 'a.txt',
          key: 'k',
          disk: 's3',
          partSize: 5,
        });
        return { mode: 'direct', uploadId: 'up1', key: 'k', disk: 's3', body: {} } as const;
      }),
    });
    const { result } = renderHook(() => useMediaUpload({ client, mode: 'direct', storageKey }));

    await act(async () => {
      await result.current.upload(file, { filename: 'a.txt' });
    });

    expect(result.current.status).toBe('success');
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  it('resumes a persisted session using fresh URLs from directSessionStatus', async () => {
    localStorage.setItem(storageKey, JSON.stringify(stored));
    const directSessionStatus = vi.fn(async () => statusWithPending);
    const uploadDirect = vi.fn(
      async () => ({ mode: 'direct', uploadId: 'up1', key: 'k', disk: 's3', body: {} }) as const,
    );
    const client = fakeClient({ directSessionStatus, uploadDirect });
    const { result } = renderHook(() => useMediaUpload({ client, mode: 'direct', storageKey }));

    await act(async () => {
      await result.current.upload(file, { filename: 'a.txt' });
    });

    expect(directSessionStatus).toHaveBeenCalledWith('up1');
    const opts = uploadDirect.mock.calls[0][2];
    expect(opts?.resume).toEqual({
      id: 'up1',
      key: 'k',
      disk: 's3',
      partSize: 5,
      parts: [{ partNumber: 2, url: 'https://s3/part/2' }],
    });
  });

  it('prefers the server-authoritative coordinates over the stored ones when resuming', async () => {
    // Stored coordinates are stale; the server status is the source of truth for key/disk/partSize.
    localStorage.setItem(
      storageKey,
      JSON.stringify({ ...stored, key: 'stale-key', disk: 'stale-disk', partSize: 99 }),
    );
    const directSessionStatus = vi.fn(async () => statusWithPending);
    const uploadDirect = vi.fn(
      async () => ({ mode: 'direct', uploadId: 'up1', key: 'k', disk: 's3', body: {} }) as const,
    );
    const client = fakeClient({ directSessionStatus, uploadDirect });
    const { result } = renderHook(() => useMediaUpload({ client, mode: 'direct', storageKey }));

    await act(async () => {
      await result.current.upload(file, { filename: 'a.txt' });
    });

    const opts = uploadDirect.mock.calls[0][2];
    expect(opts?.resume).toMatchObject({ id: 'up1', key: 'k', disk: 's3', partSize: 5 });
  });

  it('does not resume a same-named file whose size differs from the stored session', async () => {
    localStorage.setItem(storageKey, JSON.stringify(stored));
    const directSessionStatus = vi.fn(async () => statusWithPending);
    const uploadDirect = vi.fn(
      async () => ({ mode: 'direct', uploadId: 'up1', key: 'k', disk: 's3', body: {} }) as const,
    );
    const client = fakeClient({ directSessionStatus, uploadDirect });
    const { result } = renderHook(() => useMediaUpload({ client, mode: 'direct', storageKey }));

    // Same name as the stored session but a different size (1 byte) — a revised export of "a.txt".
    const revised = new File(['x'], 'a.txt', { type: 'text/plain' });
    await act(async () => {
      await result.current.upload(revised, { filename: 'a.txt' });
    });

    // The size gate fails before any status query, so a fresh initiate happens (no resume).
    const opts = uploadDirect.mock.calls[0][2];
    expect(opts?.resume).toBeUndefined();
  });

  it('does not resume when the server-reported size disagrees with the file', async () => {
    localStorage.setItem(storageKey, JSON.stringify(stored));
    // Stored size matches the file, but the authoritative server size does not — refuse to resume.
    const directSessionStatus = vi.fn(async () => ({ ...statusWithPending, size: 999 }));
    const uploadDirect = vi.fn(
      async () => ({ mode: 'direct', uploadId: 'up1', key: 'k', disk: 's3', body: {} }) as const,
    );
    const client = fakeClient({ directSessionStatus, uploadDirect });
    const { result } = renderHook(() => useMediaUpload({ client, mode: 'direct', storageKey }));

    await act(async () => {
      await result.current.upload(file, { filename: 'a.txt' });
    });

    const opts = uploadDirect.mock.calls[0][2];
    expect(opts?.resume).toBeUndefined();
  });

  it('does not resume when the file name differs from the stored session', async () => {
    localStorage.setItem(storageKey, JSON.stringify(stored));
    const directSessionStatus = vi.fn(async () => statusWithPending);
    const uploadDirect = vi.fn(
      async () => ({ mode: 'direct', uploadId: 'up1', key: 'k', disk: 's3', body: {} }) as const,
    );
    const client = fakeClient({ directSessionStatus, uploadDirect });
    const { result } = renderHook(() => useMediaUpload({ client, mode: 'direct', storageKey }));

    await act(async () => {
      await result.current.upload(file, { filename: 'OTHER.txt' });
    });

    const opts = uploadDirect.mock.calls[0][2];
    expect(opts?.resume).toBeUndefined();
  });

  it('mount probe surfaces a resumable persisted session', async () => {
    localStorage.setItem(storageKey, JSON.stringify(stored));
    const directSessionStatus = vi.fn(async () => statusWithPending);
    const client = fakeClient({ directSessionStatus });
    const { result } = renderHook(() => useMediaUpload({ client, mode: 'direct', storageKey }));

    await waitFor(() =>
      expect(result.current.resumable).toEqual({ uploadId: 'up1', fileName: 'a.txt' }),
    );
  });

  it('mount probe clears a stale session with no pending parts', async () => {
    localStorage.setItem(storageKey, JSON.stringify(stored));
    const directSessionStatus = vi.fn(async () => ({ ...statusWithPending, pendingParts: [] }));
    const client = fakeClient({ directSessionStatus });
    const { result } = renderHook(() => useMediaUpload({ client, mode: 'direct', storageKey }));

    await waitFor(() => expect(localStorage.getItem(storageKey)).toBeNull());
    expect(result.current.resumable).toBeUndefined();
  });

  it('abort clears the stored session', async () => {
    localStorage.setItem(storageKey, JSON.stringify(stored));
    const client = fakeClient({
      directSessionStatus: vi.fn(async () => statusWithPending),
      uploadDirect: vi.fn((_d, _m, opts) => {
        return new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            const err = new Error('Upload aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }),
    });
    const { result } = renderHook(() => useMediaUpload({ client, mode: 'direct', storageKey }));

    act(() => {
      void result.current.upload(file, { filename: 'a.txt' }).catch(() => {});
    });
    await waitFor(() => expect(client.uploadDirect).toHaveBeenCalled());
    expect(localStorage.getItem(storageKey)).not.toBeNull();

    act(() => result.current.abort());

    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(result.current.status).toBe('idle');
  });

  it('abort tears down the live direct session server-side', async () => {
    const abortDirectSession = vi.fn(async () => {});
    const client = fakeClient({
      abortDirectSession,
      uploadDirect: vi.fn((_d, _m, opts) => {
        opts?.onSession?.({
          uploadId: 'up1',
          fileName: 'a.txt',
          key: 'k',
          disk: 's3',
          partSize: 5,
        });
        return new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            const err = new Error('Upload aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }),
    });
    const { result } = renderHook(() => useMediaUpload({ client, mode: 'direct', storageKey }));

    act(() => {
      void result.current.upload(file, { filename: 'a.txt' }).catch(() => {});
    });
    await waitFor(() => expect(client.uploadDirect).toHaveBeenCalled());

    act(() => result.current.abort());

    expect(abortDirectSession).toHaveBeenCalledWith('up1');
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  it('abort tears down a persisted session even without an upload (mount-then-abort)', async () => {
    localStorage.setItem(storageKey, JSON.stringify(stored));
    const abortDirectSession = vi.fn(async () => {});
    const directSessionStatus = vi.fn(async () => statusWithPending);
    const client = fakeClient({ abortDirectSession, directSessionStatus });
    const { result } = renderHook(() => useMediaUpload({ client, mode: 'direct', storageKey }));

    // Let the probe settle (pending parts -> resumable, storage kept) without ever uploading.
    await waitFor(() =>
      expect(result.current.resumable).toEqual({ uploadId: 'up1', fileName: 'a.txt' }),
    );

    act(() => result.current.abort());

    // No upload ran; the probe claimed ownership of the persisted session, so abort tears it down.
    expect(abortDirectSession).toHaveBeenCalledWith('up1');
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  it('mount probe does not clobber a session written by a later upload (race)', async () => {
    localStorage.setItem(storageKey, JSON.stringify(stored)); // up1, a.txt
    // Control when the probe's status query resolves so we can interleave an upload before it.
    let resolveProbe!: (status: typeof statusWithPending) => void;
    const probePending = new Promise<typeof statusWithPending>((resolve) => {
      resolveProbe = resolve;
    });
    const directSessionStatus = vi.fn(() => probePending);
    const client = fakeClient({
      directSessionStatus,
      uploadDirect: vi.fn((_d, _m, opts) => {
        // A different file -> fresh initiate; persist its coordinates, then hang (no success-clear).
        opts?.onSession?.({
          uploadId: 'up2',
          fileName: 'b.txt',
          key: 'k2',
          disk: 's3',
          partSize: 5,
        });
        return new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            const err = new Error('Upload aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }),
    });
    const { result } = renderHook(() => useMediaUpload({ client, mode: 'direct', storageKey }));

    // The probe fires for up1 and stays pending.
    await waitFor(() => expect(directSessionStatus).toHaveBeenCalledWith('up1'));

    // Start an upload of a DIFFERENT file before the probe resolves: bumps the epoch, writes up2.
    const other = new File(['different content'], 'b.txt', { type: 'text/plain' });
    act(() => {
      void result.current.upload(other, { filename: 'b.txt' }).catch(() => {});
    });
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(storageKey) ?? 'null')).toMatchObject({
        uploadId: 'up2',
      }),
    );

    // The probe now resolves saying up1 has no pending parts. Without the epoch guard it would wipe
    // up2's freshly-written coordinates; with it, the probe bails and up2 survives.
    await act(async () => {
      resolveProbe({ ...statusWithPending, pendingParts: [] });
    });

    expect(JSON.parse(localStorage.getItem(storageKey) ?? 'null')).toMatchObject({
      uploadId: 'up2',
    });
  });

  it('mount probe keeps the stored session when the status query fails', async () => {
    localStorage.setItem(storageKey, JSON.stringify(stored));
    const directSessionStatus = vi.fn(async () => {
      throw new Error('network blip');
    });
    const client = fakeClient({ directSessionStatus });
    renderHook(() => useMediaUpload({ client, mode: 'direct', storageKey }));

    await waitFor(() => expect(directSessionStatus).toHaveBeenCalledWith('up1'));
    // Flush the rejected promise's catch.
    await act(async () => {});

    // A transient failure must not discard a resumable session.
    expect(localStorage.getItem(storageKey)).not.toBeNull();
  });

  it('abort tears down the probed session, not one another instance later wrote into storage', async () => {
    localStorage.setItem(storageKey, JSON.stringify(stored)); // up1
    const abortDirectSession = vi.fn(async () => {});
    const directSessionStatus = vi.fn(async () => statusWithPending);
    const client = fakeClient({ abortDirectSession, directSessionStatus });
    const { result } = renderHook(() => useMediaUpload({ client, mode: 'direct', storageKey }));

    // The probe claims ownership of up1 (the session this instance would resume).
    await waitFor(() =>
      expect(result.current.resumable).toEqual({ uploadId: 'up1', fileName: 'a.txt' }),
    );

    // A different instance/tab overwrites storage with its own live session up2.
    localStorage.setItem(storageKey, JSON.stringify({ ...stored, uploadId: 'up2' }));

    act(() => result.current.abort());

    // We tear down the session THIS instance owns (up1) and never the stranger's (up2): abort must not
    // re-read storage.
    expect(abortDirectSession).toHaveBeenCalledWith('up1');
    expect(abortDirectSession).not.toHaveBeenCalledWith('up2');
  });

  it('abort invalidates an in-flight probe so it cannot resurrect a torn-down session', async () => {
    localStorage.setItem(storageKey, JSON.stringify(stored)); // up1
    let resolveProbe!: (status: typeof statusWithPending) => void;
    const probePending = new Promise<typeof statusWithPending>((resolve) => {
      resolveProbe = resolve;
    });
    const directSessionStatus = vi.fn(() => probePending);
    const abortDirectSession = vi.fn(async () => {});
    const client = fakeClient({ directSessionStatus, abortDirectSession });
    const { result } = renderHook(() => useMediaUpload({ client, mode: 'direct', storageKey }));

    // The probe fires for up1 (claiming ownership synchronously) and stays pending.
    await waitFor(() => expect(directSessionStatus).toHaveBeenCalledWith('up1'));

    // Abort before the probe resolves: tears down up1, clears storage, bumps the epoch.
    act(() => result.current.abort());
    expect(abortDirectSession).toHaveBeenCalledWith('up1');
    expect(localStorage.getItem(storageKey)).toBeNull();

    // The probe now resolves claiming up1 still has pending parts. Without the epoch bump it would
    // re-set `resumable` for a session we already tore down.
    await act(async () => {
      resolveProbe(statusWithPending);
    });

    expect(result.current.resumable).toBeUndefined();
    expect(result.current.status).toBe('idle');
  });

  it('falls through to a fresh initiate when the stored session is gone server-side', async () => {
    localStorage.setItem(storageKey, JSON.stringify(stored)); // up1, matches name + size
    // The server no longer knows the session (expired/deleted) -> the status query throws.
    const directSessionStatus = vi.fn(async () => {
      throw new Error('Not Found');
    });
    const uploadDirect = vi.fn(
      async () => ({ mode: 'direct', uploadId: 'up9', key: 'k9', disk: 's3', body: {} }) as const,
    );
    const client = fakeClient({ directSessionStatus, uploadDirect });
    const { result } = renderHook(() => useMediaUpload({ client, mode: 'direct', storageKey }));
    // Flush the mount probe's rejected status query so it does not interfere.
    await act(async () => {});

    await act(async () => {
      await result.current.upload(file, { filename: 'a.txt' });
    });

    // The throwing status query did NOT reject the upload; it dropped the stale entry and initiated
    // fresh (no resume), so an expired session can never brick this storageKey.
    expect(result.current.status).toBe('success');
    const opts = uploadDirect.mock.calls[0][2];
    expect(opts?.resume).toBeUndefined();
  });

  it('does not tear down the session on a post-success abort', async () => {
    const abortDirectSession = vi.fn(async () => {});
    const client = fakeClient({
      abortDirectSession,
      uploadDirect: vi.fn(async (_d, _m, opts) => {
        opts?.onSession?.({
          uploadId: 'up1',
          fileName: 'a.txt',
          key: 'k',
          disk: 's3',
          partSize: 5,
        });
        return { mode: 'direct', uploadId: 'up1', key: 'k', disk: 's3', body: {} } as const;
      }),
    });
    const { result } = renderHook(() => useMediaUpload({ client, mode: 'direct', storageKey }));

    await act(async () => {
      await result.current.upload(file, { filename: 'a.txt' });
    });
    expect(result.current.status).toBe('success');

    // The session is completed; a later abort must not DELETE it.
    act(() => result.current.abort());
    expect(abortDirectSession).not.toHaveBeenCalled();
  });

  it('pause keeps the direct session alive for a later resume (no teardown)', async () => {
    const abortDirectSession = vi.fn(async () => {});
    const client = fakeClient({
      abortDirectSession,
      uploadDirect: vi.fn((_d, _m, opts) => {
        opts?.onSession?.({
          uploadId: 'up1',
          fileName: 'a.txt',
          key: 'k',
          disk: 's3',
          partSize: 5,
        });
        return new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            const err = new Error('Upload aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }),
    });
    const { result } = renderHook(() => useMediaUpload({ client, mode: 'direct', storageKey }));

    let uploadPromise: Promise<unknown>;
    act(() => {
      uploadPromise = result.current.upload(file, { filename: 'a.txt' }).catch(() => {});
    });
    await waitFor(() => expect(client.uploadDirect).toHaveBeenCalled());

    act(() => result.current.pause());
    await act(async () => {
      await uploadPromise;
    });

    expect(result.current.status).toBe('paused');
    expect(abortDirectSession).not.toHaveBeenCalled();
  });

  it('ignores a malformed stored session (wrong field types) and initiates fresh', async () => {
    // Valid JSON but `size` has the wrong type -> readStoredSession's shape guard rejects it.
    localStorage.setItem(storageKey, JSON.stringify({ ...stored, size: '11' }));
    const directSessionStatus = vi.fn(async () => statusWithPending);
    const uploadDirect = vi.fn(
      async () => ({ mode: 'direct', uploadId: 'up9', key: 'k', disk: 's3', body: {} }) as const,
    );
    const client = fakeClient({ directSessionStatus, uploadDirect });
    const { result } = renderHook(() => useMediaUpload({ client, mode: 'direct', storageKey }));

    await act(async () => {
      await result.current.upload(file, { filename: 'a.txt' });
    });

    // A malformed entry must never drive a resume (no status query) — it falls through to fresh initiate.
    expect(directSessionStatus).not.toHaveBeenCalled();
    const opts = uploadDirect.mock.calls[0][2];
    expect(opts?.resume).toBeUndefined();
  });
});
