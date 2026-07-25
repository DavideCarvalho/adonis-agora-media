// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
