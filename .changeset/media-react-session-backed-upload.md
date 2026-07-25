---
"@adonis-agora/media-react": minor
---

BREAKING (0.x minor): reworks the direct-upload client and hook onto the **session-backed** server contract introduced in `@adonis-agora/media@0.10.0` (requires that server version or newer).

- `uploadDirect` now drives the session-backed routes end to end — initiate → presigned part `PUT`s → status → complete — through an injectable XHR `partUploader` seam (default `xhrPartUploader`) that reports byte-level progress, reads each part's `ETag` response header, honours `AbortSignal`, uploads parts sequentially and retries transient failures (failing fast on 4xx). The previous in-memory, stateless direct path is gone: the upload id, part size and confirmed ETags now live in a server session, so a reload no longer orphans the upload.
- `useMediaUpload<TComplete>` is generic over the complete-response body and accepts a `storageKey` to persist an in-flight direct upload to `localStorage` and **resume it across a page reload** — resume is server-coordinated (it asks the session for the confirmed parts and re-presigns the rest) and size-gated against the stored file. A `resumable` flag and an `onSession` callback expose the session for custom persistence.
- New client methods `directSessionStatus(id)` and `abortDirectSession(id)`, plus a typed `MediaHttpError` (carries the HTTP `status`) so callers can discriminate a gone/expired session (404/410 → start fresh) from a transient failure (→ keep the stored session and retry).
