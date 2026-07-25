import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type DirectUploadOptions,
  type DirectUploadSessionStatus,
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

/** The persisted coordinates of a `direct` session — the `onSession` payload plus the file `size`. */
interface StoredSession {
  uploadId: string;
  fileName: string;
  key: string;
  disk: string;
  partSize: number;
  /** The file's byte size at initiate time — a same-named but different-sized file must not resume. */
  size: number;
}

// SSR-safe persistence: the client stays storage-agnostic, all of it lives here. Every access guards
// against a missing `localStorage` (non-browser envs) and bad JSON, failing closed to "no session".
function readStoredSession(storageKey: string): StoredSession | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    // A malformed/partial entry must never drive a resume (it would issue a garbled status query).
    if (
      typeof parsed.uploadId !== 'string' ||
      typeof parsed.fileName !== 'string' ||
      typeof parsed.key !== 'string' ||
      typeof parsed.disk !== 'string' ||
      typeof parsed.partSize !== 'number' ||
      typeof parsed.size !== 'number'
    ) {
      return undefined;
    }
    return {
      uploadId: parsed.uploadId,
      fileName: parsed.fileName,
      key: parsed.key,
      disk: parsed.disk,
      partSize: parsed.partSize,
      size: parsed.size,
    };
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
 * That body is the server's raw JSON and is NOT validated at this boundary — narrow it yourself
 * (e.g. parse it with a schema) before relying on its shape.
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
  // Bumped on every upload so an in-flight mount probe can tell it lost the race and bail out.
  const epochRef = useRef(0);
  // The live `direct` session id, so an explicit abort can tear it down server-side (pause must not).
  const directSessionIdRef = useRef<string | undefined>(undefined);

  const onProgress = useCallback((sent: number, total: number) => {
    setState((s) => ({ ...s, progress: total ? sent / total : 0 }));
  }, []);

  const run = useCallback(
    async (file: Blob, meta: UploadMeta): Promise<MediaUploadResult<TComplete>> => {
      const controller = new AbortController();
      controllerRef.current = controller;
      pausingRef.current = false;
      pendingRef.current = { file, meta };
      epochRef.current += 1; // invalidate any in-flight mount probe
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
          const size = meta.size ?? file.size;
          const directOptions: DirectUploadOptions = {
            signal: controller.signal,
            onProgress,
          };
          if (storageKey) {
            // Persist the coordinates (incl. size) on a fresh initiate so a later mount/upload can
            // resume, and remember the live session id so an explicit abort can tear it down.
            directOptions.onSession = (info) => {
              directSessionIdRef.current = info.uploadId;
              writeStoredSession(storageKey, { ...info, size });
            };

            // Resume a persisted session of the SAME file — same name AND same size, so a revised
            // same-named file can never splice its bytes into the old session. Re-query the server for
            // fresh presigned URLs and continue from the still-pending parts, trusting the server's
            // authoritative coordinates/size over the (possibly stale) stored ones. Any mismatch, a
            // fully-completed session, OR a session the server no longer knows (expired/deleted, so the
            // status query throws) drops the stale entry and falls through to a fresh initiate — an
            // expired session must never brick this storageKey.
            const stored = readStoredSession(storageKey);
            if (stored && stored.fileName === meta.filename && stored.size === size) {
              let status: DirectUploadSessionStatus | undefined;
              try {
                status = await client.directSessionStatus(stored.uploadId);
              } catch {
                clearStoredSession(storageKey); // abandon an expired/missing session, initiate fresh below
              }
              if (status && status.pendingParts.length > 0 && status.size === size) {
                directSessionIdRef.current = stored.uploadId;
                directOptions.resume = {
                  id: stored.uploadId,
                  key: status.key,
                  disk: status.disk,
                  partSize: status.partSize,
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
        directSessionIdRef.current = undefined; // completed — a later abort must not DELETE it
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
      locationRef.current = undefined; // a fresh upload never resumes a stale TUS location
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
    epochRef.current += 1; // invalidate any in-flight mount probe
    controllerRef.current?.abort();
    const location = locationRef.current;
    if (location) void client.abortTus(location).catch(() => {});
    // Tear down a live `direct` session server-side (mirrors `abortTus`) so its PENDING server record is
    // cleaned up instead of lingering until expiry. We only ever tear down the session THIS instance owns
    // — the one it started (`onSession`), resumed, or probed at mount (`directSessionIdRef`) — and never
    // re-read storage, so a different instance/tab that later overwrote storage is left untouched. `pause`
    // is a separate path and never reaches here.
    if (mode === 'direct' && directSessionIdRef.current) {
      void client.abortDirectSession(directSessionIdRef.current).catch(() => {});
    }
    if (storageKey) clearStoredSession(storageKey);
    controllerRef.current = undefined;
    locationRef.current = undefined;
    pendingRef.current = undefined;
    directSessionIdRef.current = undefined;
    setState(INITIAL as MediaUploadState<TComplete>);
  }, [client, mode, storageKey]);

  const reset = useCallback(() => {
    epochRef.current += 1; // invalidate any in-flight mount probe
    controllerRef.current = undefined;
    locationRef.current = undefined;
    pendingRef.current = undefined;
    pausingRef.current = false;
    directSessionIdRef.current = undefined;
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
    // Claim ownership of the probed session synchronously so an explicit `abort()` — which never re-reads
    // storage — tears down exactly the session THIS instance would resume, never one another instance/tab
    // wrote into storage afterwards.
    directSessionIdRef.current = stored.uploadId;
    const epoch = epochRef.current;
    let cancelled = false;
    // Bail if unmounted, an upload started, or the session was aborted/reset since (epoch moved). Only
    // clear storage when it still holds THIS session — another tab/upload may have overwritten it.
    const stale = () => cancelled || epoch !== epochRef.current;
    const stillThisSession = () => readStoredSession(storageKey)?.uploadId === stored.uploadId;
    client
      .directSessionStatus(stored.uploadId)
      .then((status) => {
        if (stale()) return;
        if (status.pendingParts.length > 0) {
          setState((s) => ({
            ...s,
            resumable: { uploadId: stored.uploadId, fileName: stored.fileName },
          }));
        } else if (stillThisSession()) {
          // Fully completed/expired server-side: drop the entry and release ownership so a later abort
          // does not DELETE a finished session.
          clearStoredSession(storageKey);
          directSessionIdRef.current = undefined;
        }
      })
      .catch(() => {
        // Transient failure (network blip / 5xx): keep the entry so a later mount can still resume.
      });
    return () => {
      cancelled = true;
    };
  }, [client, mode, storageKey]);

  return { ...state, upload, pause, resume, abort, reset };
}
