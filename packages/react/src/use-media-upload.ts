import { useCallback, useMemo, useRef, useState } from 'react';
import {
  type MediaUploadClient,
  type MediaUploadClientOptions,
  type MediaUploadResult,
  type UploadMeta,
  createMediaUploadClient,
} from './client.js';

/** Which server strategy the hook drives. `tus` is resumable and the default. */
export type MediaUploadMode = 'tus' | 'direct' | 'proxy';

export interface UseMediaUploadOptions extends MediaUploadClientOptions {
  /** Upload strategy. `tus` (resumable, default) | `direct` (presigned S3 multipart) | `proxy`. */
  mode?: MediaUploadMode;
  /** Inject a pre-built client (tests / shared instance). Overrides the client-building options. */
  client?: MediaUploadClient;
}

export type MediaUploadStatus = 'idle' | 'uploading' | 'paused' | 'success' | 'error';

export interface MediaUploadState {
  status: MediaUploadStatus;
  /** 0..1 */
  progress: number;
  result: MediaUploadResult | undefined;
  /** TUS session location, when the active/last upload used the `tus` strategy. */
  location: string | undefined;
  error: Error | undefined;
}

export interface UseMediaUpload extends MediaUploadState {
  /** Start an upload with the configured strategy. */
  upload: (file: Blob, meta: UploadMeta) => Promise<MediaUploadResult>;
  /** Pause the in-flight upload (TUS resumes from the server offset; direct/proxy restart). */
  pause: () => void;
  /** Resume a paused upload. */
  resume: () => Promise<MediaUploadResult | undefined>;
  /** Abort the upload; terminates the TUS session server-side when applicable. */
  abort: () => void;
  /** Reset back to the idle state. */
  reset: () => void;
}

const INITIAL: MediaUploadState = {
  status: 'idle',
  progress: 0,
  result: undefined,
  location: undefined,
  error: undefined,
};

/**
 * Resumable upload with progress/status state, backed by {@link createMediaUploadClient}. Chooses a
 * strategy from `options.mode` (`tus` default). Exposes `pause`/`resume`/`abort` — for the `tus`
 * strategy these are true resumes (the client re-`HEAD`s the server offset and continues from
 * there); for `direct`/`proxy` a resume restarts the transfer.
 */
export function useMediaUpload(options: UseMediaUploadOptions = {}): UseMediaUpload {
  const [state, setState] = useState<MediaUploadState>(INITIAL);

  const {
    mode = 'tus',
    client: injectedClient,
    baseUrl,
    tusPath,
    uploadsPath,
    chunkSize,
    concurrency,
    retries,
    fetchImpl,
    headers,
    getHeaders,
  } = options;

  const client = useMemo(
    () =>
      injectedClient ??
      createMediaUploadClient({
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(tusPath !== undefined ? { tusPath } : {}),
        ...(uploadsPath !== undefined ? { uploadsPath } : {}),
        ...(chunkSize !== undefined ? { chunkSize } : {}),
        ...(concurrency !== undefined ? { concurrency } : {}),
        ...(retries !== undefined ? { retries } : {}),
        ...(fetchImpl !== undefined ? { fetchImpl } : {}),
        ...(headers !== undefined ? { headers } : {}),
        ...(getHeaders !== undefined ? { getHeaders } : {}),
      }),
    [
      injectedClient,
      baseUrl,
      tusPath,
      uploadsPath,
      chunkSize,
      concurrency,
      retries,
      fetchImpl,
      headers,
      getHeaders,
    ],
  );

  // Mutable refs shared across upload/pause/resume without re-triggering the callbacks.
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const locationRef = useRef<string | undefined>(undefined);
  const pendingRef = useRef<{ file: Blob; meta: UploadMeta } | undefined>(undefined);
  const pausingRef = useRef(false);

  const onProgress = useCallback((sent: number, total: number) => {
    setState((s) => ({ ...s, progress: total ? sent / total : 0 }));
  }, []);

  const run = useCallback(
    async (file: Blob, meta: UploadMeta): Promise<MediaUploadResult> => {
      const controller = new AbortController();
      controllerRef.current = controller;
      pausingRef.current = false;
      pendingRef.current = { file, meta };
      setState((s) => ({ ...s, status: 'uploading', error: undefined }));

      try {
        let result: MediaUploadResult;
        if (mode === 'tus') {
          // Pre-open the session so a pause mid-stream has a location to resume from.
          const size = meta.size ?? file.size;
          const location =
            locationRef.current ?? (await client.createTusSession({ ...meta, size })).location;
          locationRef.current = location;
          result = await client.uploadTus(file, meta, {
            resumeFrom: location,
            signal: controller.signal,
            onProgress,
          });
        } else if (mode === 'direct') {
          result = await client.uploadDirect(file, meta, {
            signal: controller.signal,
            onProgress,
          });
        } else {
          result = await client.uploadProxy(file, meta, {
            signal: controller.signal,
            onProgress,
          });
        }

        pendingRef.current = undefined;
        locationRef.current = undefined;
        setState({
          status: 'success',
          progress: 1,
          result,
          location: result.mode === 'tus' ? result.location : undefined,
          error: undefined,
        });
        return result;
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          // A pause aborts the same controller — settle into `paused`. An explicit `abort()`
          // (pausingRef cleared) has already reset the state, so leave it untouched.
          if (pausingRef.current) {
            setState((s) => ({ ...s, status: 'paused', location: locationRef.current }));
          }
          throw err;
        }
        setState((s) => ({
          ...s,
          status: 'error',
          error: err as Error,
          location: locationRef.current,
        }));
        throw err;
      }
    },
    [client, mode, onProgress],
  );

  const upload = useCallback(
    (file: Blob, meta: UploadMeta) => {
      locationRef.current = undefined; // a fresh upload never resumes a stale session
      return run(file, meta);
    },
    [run],
  );

  const pause = useCallback(() => {
    if (!controllerRef.current) return;
    pausingRef.current = true;
    controllerRef.current.abort();
    setState((s) => (s.status === 'uploading' ? { ...s, status: 'paused' } : s));
  }, []);

  const resume = useCallback(async () => {
    const pending = pendingRef.current;
    if (!pending) return undefined;
    try {
      return await run(pending.file, pending.meta);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return undefined;
      throw err;
    }
  }, [run]);

  const abort = useCallback(() => {
    pausingRef.current = false;
    controllerRef.current?.abort();
    const location = locationRef.current;
    if (location) void client.abortTus(location).catch(() => {});
    controllerRef.current = undefined;
    locationRef.current = undefined;
    pendingRef.current = undefined;
    setState(INITIAL);
  }, [client]);

  const reset = useCallback(() => {
    controllerRef.current = undefined;
    locationRef.current = undefined;
    pendingRef.current = undefined;
    pausingRef.current = false;
    setState(INITIAL);
  }, []);

  return { ...state, upload, pause, resume, abort, reset };
}
