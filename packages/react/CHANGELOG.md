# @adonis-agora/media-react

## 0.5.0

### Minor Changes

- [`3e3bc27`](https://github.com/DavideCarvalho/adonis-agora-media/commit/3e3bc277559b3413400932558be3d5a1f18f3de3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `useMediaUpload`/`createMediaUploadClient` — uploads TUS agora aceitam um path de create por-upload e metadata custom.

  - `UploadMeta.metadata`: pares `Upload-Metadata` extras (ex.: `{ title, examdate }`), decodificados no servidor pelo `parseTusMetadata` — deixa a rota TUS do app carregar campos de domínio no create.
  - `UploadMeta.tusPath`: override do path do create TUS por-upload, para rotas que embutem um resource id no path (ex.: `/api/exames/tus/:uploadId`) em vez de um prefixo fixo.

  Puramente aditivo — a API existente (`tusPath` global, `filename`/`filetype`) não muda.

## 0.4.0

### Minor Changes

- `useMediaUpload`/`createMediaUploadClient` — uploads TUS agora aceitam um path de create por-upload e metadata custom.

  - `UploadMeta.metadata`: pares `Upload-Metadata` extras (ex.: `{ title, examdate }`), decodificados no servidor pelo `parseTusMetadata`.
  - `UploadMeta.tusPath`: override do path do create TUS por-upload, para rotas que embutem um resource id no path (ex.: `/api/exames/tus/:uploadId`).

  Puramente aditivo — a API existente (`tusPath` global, `filename`/`filetype`) não muda.

## 0.3.0

### Minor Changes

- [`a06b2df`](https://github.com/DavideCarvalho/adonis-media/commit/a06b2df5194259be83fa08e8af15e7f9b07c48b3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `OpenMediaDashboardButton` — a drop-in launcher for the `@adonis-agora/media-dashboard` console, ported from the NestJS sibling console's `open-console-button.tsx` so both ecosystems ship the same building block.

  Three tiers, same behaviour underneath:

  - `openMediaDashboard` / `mintMediaDashboardSession` / `mediaDashboardUrl` / `mediaDashboardSessionUrl` — no React at all: mint a console session from your own app's auth and get back the URL to navigate to.
  - `useOpenMediaDashboard` (+ `openMediaDashboardMutationOptions`) — a hook exposing `open`/`isPending`/`error`, for a host that wants its own markup.
  - `OpenMediaDashboardButton` — a deliberately unstyled `<button>` that forwards `className`/`style`/every other button prop (so it inherits the host's design system) and renders a mint refusal by default rather than swallowing it.

  A refused session mint throws `ConsoleSessionError`. Purely additive — new exports only.

## 0.2.0

### Minor Changes

- [#23](https://github.com/DavideCarvalho/adonis-media/pull/23) [`77337c8`](https://github.com/DavideCarvalho/adonis-media/commit/77337c8ecde9589f9a006600420327eae5b6a0f2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - BREAKING (0.x minor): reworks the direct-upload client and hook onto the **session-backed** server contract introduced in `@adonis-agora/media@0.10.0` (requires that server version or newer).

  - `uploadDirect` now drives the session-backed routes end to end — initiate → presigned part `PUT`s → status → complete — through an injectable XHR `partUploader` seam (default `xhrPartUploader`) that reports byte-level progress, reads each part's `ETag` response header, honours `AbortSignal`, uploads parts sequentially and retries transient failures (failing fast on 4xx). The previous in-memory, stateless direct path is gone: the upload id, part size and confirmed ETags now live in a server session, so a reload no longer orphans the upload.
  - `useMediaUpload<TComplete>` is generic over the complete-response body and accepts a `storageKey` to persist an in-flight direct upload to `localStorage` and **resume it across a page reload** — resume is server-coordinated (it asks the session for the confirmed parts and re-presigns the rest) and size-gated against the stored file. A `resumable` flag and an `onSession` callback expose the session for custom persistence.
  - New client methods `directSessionStatus(id)` and `abortDirectSession(id)`, plus a typed `MediaHttpError` (carries the HTTP `status`) so callers can discriminate a gone/expired session (404/410 → start fresh) from a transient failure (→ keep the stored session and retry).
