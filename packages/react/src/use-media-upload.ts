import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type DirectUploadOptions,
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
  /**
   * `localStorage` key under which a `direct` session's coordinates are persisted on initiate,
   * enabling cross-reload resume. Cleared on success/abort/reset. Ignored by `tus`/`proxy`.
   */
  storageKey?: string;
}

export type MediaUploadStatus = 'idle' | 'uploading' | 'paused' | 'success' | 'error';

export interface MediaUploadState<TComplete = unknown> {
  status: MediaUploadStatus;
  /** 0..1 */
  progress: number;
  result: MediaUploadResult<TComplete> | undefined;
  /** TUS session location, when the active/last upload used the `tus` strategy. */
  location: string | undefined;
  error: Error | undefined;
  /** A persisted `direct` session that can still be resumed (set by the mount probe). */
  resumable: { uploadId: string; fileName: string } | undefined;
}

export interface UseMediaUpload<TComplete = unknown> extends MediaUploadState<TComplete> {
  /** Start an upload with the configured strategy. */
  upload: (file: Blob, meta: UploadMeta) => Promise<MediaUploadResult<TComplete>>;
  /** Pause the in-flight upload (TUS resumes from the server offset; direct/proxy restart). */
  pause: () => void;
  /** Resume a paused upload. */
  resume: () => Promise<MediaUploadResult<TComplete> | undefined>;
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
  resumable: undefined,
};

/** The persisted coordinates of a `direct` session — exactly the `onSession` payload. */
interface StoredSession {
  uploadId: string;
  fileName: string;
  key: string;
  disk: string;
  partSize: number;
}

// SSR-safe persistence: the client stays storage-agnostic, all of it lives here. Every access guards
// against a missing `localStorage` (non-browser envs) and bad JSON, failing closed to "no session".
function readStoredSession(storageKey: string): StoredSession | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return undefined;
    return JSON.parse(raw) as StoredSession;
  } catch {
    return undefined;
  }
}

function writeStoredSession(storageKey: string, info: StoredSession): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(storageKey, JSON.stringify(info));
  } catch {
    // Quota/serialization failures must never break the upload itself.
  }
}

function clearStoredSession(storageKey: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(storageKey);
  } catch {
    // Best-effort: a stale entry is harmless (the probe clears it next mount).
  }
}

/**
 * Resumable upload with progress/status state, backed by {@link createMediaUploadClient}. Chooses a
 * strategy from `options.mode` (`tus` default). Exposes `pause`/`resume`/`abort`.
 *
 * - `tus`: true resumes — the client re-`HEAD`s the server offset and continues from there.
 * - `direct`: now a REAL resume. `pause` aborts the in-flight part PUTs; `resume` (or a fresh
 *   `upload()` of the same file) calls `directSessionStatus` and continues from the session's
 *   `pendingParts` (fresh presigned URLs). Pass `storageKey` to also persist the session coordinates
 *   to `localStorage[storageKey]` on initiate, enabling resume across a page reload; the entry is
 *   cleared on success/abort/reset. The client itself stays storage-agnostic.
 * - `proxy`: a resume restarts the single-shot transfer.
 *
 * The generic `TComplete` types the `direct` strategy's `complete` response body (`result.body`).
 */
export function useMediaUpload<TComplete = unknown>(
  options: UseMediaUploadOptions = {},
): UseMediaUpload<TComplete> {
  const [state, setState] = useState<MediaUploadState<TComplete>>(
    INITIAL as MediaUploadState<TComplete>,
  );

  const {
    mode = 'tus',
    client: injectedClient,
    storageKey,
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
    async (file: Blob, meta: UploadMeta): Promise<MediaUploadResult<TComplete>> => {
      const controller = new AbortController();
      controllerRef.current = controller;
      pausingRef.current = false;
      pendingRef.current = { file, meta };
      setState((s) => ({ ...s, status: 'uploading', error: undefined, resumable: undefined }));

      try {
        let result: MediaUploadResult<TComplete>;
        if (mode === 'tus') {
          // Pre-open the session so a pause mid-stream has a location to resume from.
          const size = meta.size ?? file.size;
          const location =
            locationRef.current ?? (await client.createTusSession({ ...meta, size })).location;
          locationRef.current = location;
          result = (await client.uploadTus(file, meta, {
            resumeFrom: location,
            signal: controller.signal,
            onProgress,
          })) as MediaUploadResult<TComplete>;
        } else if (mode === 'direct') {
          const directOptions: DirectUploadOptions = {
            signal: controller.signal,
            onProgress,
          };
          if (storageKey) {
            // Persist the coordinates on a fresh initiate so a later mount/upload can resume.
            directOptions.onSession = (info) => writeStoredSession(storageKey, info);

            // Resume a persisted session of the SAME file: re-query its status and continue from the
            // still-pending parts (fresh presigned URLs). A mismatched fileName or a fully-completed
            // session falls through to a fresh initiate.
            const stored = readStoredSession(storageKey);
            if (stored && stored.fileName === meta.filename) {
              const status = await client.directSessionStatus(stored.uploadId);
              if (status.pendingParts.length > 0) {
                directOptions.resume = {
                  id: stored.uploadId,
                  key: stored.key,
                  disk: stored.disk,
                  partSize: stored.partSize,
                  parts: status.pendingParts,
                };
              }
            }
          }
          result = (await client.uploadDirect(
            file,
            meta,
            directOptions,
          )) as MediaUploadResult<TComplete>;
        } else {
          result = (await client.uploadProxy(file, meta, {
            signal: controller.signal,
            onProgress,
          })) as MediaUploadResult<TComplete>;
        }

        pendingRef.current = undefined;
        locationRef.current = undefined;
        if (storageKey) clearStoredSession(storageKey);
        setState({
          status: 'success',
          progress: 1,
          result,
          location: result.mode === 'tus' ? result.location : undefined,
          error: undefined,
          resumable: undefined,
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
    [client, mode, onProgress, storageKey],
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
    if (storageKey) clearStoredSession(storageKey);
    controllerRef.current = undefined;
    locationRef.current = undefined;
    pendingRef.current = undefined;
    setState(INITIAL as MediaUploadState<TComplete>);
  }, [client, storageKey]);

  const reset = useCallback(() => {
    controllerRef.current = undefined;
    locationRef.current = undefined;
    pendingRef.current = undefined;
    pausingRef.current = false;
    if (storageKey) clearStoredSession(storageKey);
    setState(INITIAL as MediaUploadState<TComplete>);
  }, [storageKey]);

  // Mount probe: for a persisted `direct` session, surface `resumable` if the server still has pending
  // parts; otherwise the session is stale (completed/expired) — drop it. A `cancelled` flag guards
  // against setState after unmount.
  useEffect(() => {
    if (mode !== 'direct' || !storageKey) return;
    const stored = readStoredSession(storageKey);
    if (!stored) return;
    let cancelled = false;
    client
      .directSessionStatus(stored.uploadId)
      .then((status) => {
        if (cancelled) return;
        if (status.pendingParts.length > 0) {
          setState((s) => ({
            ...s,
            resumable: { uploadId: stored.uploadId, fileName: stored.fileName },
          }));
        } else {
          clearStoredSession(storageKey);
        }
      })
      .catch(() => {
        if (!cancelled) clearStoredSession(storageKey);
      });
    return () => {
      cancelled = true;
    };
  }, [client, mode, storageKey]);

  return { ...state, upload, pause, resume, abort, reset };
}
