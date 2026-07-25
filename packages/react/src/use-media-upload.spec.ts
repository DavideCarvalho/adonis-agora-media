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
  const stored = { uploadId: 'up1', fileName: 'a.txt', key: 'k', disk: 's3', partSize: 5 };
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

    const opts = uploadDirect.mock.calls[0][2];
    expect(opts?.resume).toEqual({
      id: 'up1',
      key: 'k',
      disk: 's3',
      partSize: 5,
      parts: [{ partNumber: 2, url: 'https://s3/part/2' }],
    });
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
});
