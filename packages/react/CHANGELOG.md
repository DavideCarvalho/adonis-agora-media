# @adonis-agora/media-react

## 0.5.1

### Patch Changes

- [#57](https://github.com/DavideCarvalho/adonis-agora-media/pull/57) [`331f53f`](https://github.com/DavideCarvalho/adonis-agora-media/commit/331f53f6294f3b7e4261bdbf65fb8090063aa673) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Ship TanStack Intent agent skills with every package. Each package now publishes a
  `skills/` directory (`media-*` SKILL.md files) that lands in `node_modules` on install, so
  AI coding agents can discover them via `npx @tanstack/intent list`; adds `@tanstack/intent`
  as a devDependency for `intent validate` in CI.

## 0.5.0

### Minor Changes

- [#49](https://github.com/DavideCarvalho/adonis-agora-media/pull/49) [`33d0861`](https://github.com/DavideCarvalho/adonis-agora-media/commit/33d086131f53744819b57df9cae3f0f70ff5da75) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **`mode: 'direct'` now works with no configuration at all.** Read this if you set `uploadsPath`.

  A stock `createMediaUploadClient()` talking to a stock `@adonis-agora/media` server could not upload: the client sent its direct-upload requests to `uploadsPath` (default `/media/uploads`), but the provider mounts the direct-session routes at `uploads.direct.routes.prefix`, whose default is `/media/uploads/direct/sessions`. Every direct upload 404'd on the initiate. The two packages were each internally consistent and disagreed with each other, so no unit test on either side could see it.

  The client now has a separate `directPath` option for the direct-session routes, defaulting to `/media/uploads/direct/sessions` — the server's own default — while `uploadsPath` keeps addressing the core upload routes, where the proxy endpoint (`<uploadsPath>/proxy`) actually lives. They were never the same server prefix; only the client conflated them.

  **Am I affected?**

  - **You never set `uploadsPath`** → direct uploads were broken and now work. Nothing to do.
  - **You set `uploadsPath` (the common case, and the only way direct uploads worked)** → `directPath` falls back to it, so every URL your client produces is byte-for-byte what it produced before. Nothing to do. You may now split the two if you want the proxy endpoint as well:

    ```ts
    createMediaUploadClient({
      uploadsPath: "/media/uploads", // proxy lives here
      directPath: "/api/v1/upload-video", // direct sessions live here
    });
    ```

  - **You left `uploadsPath` at its default AND moved the server** to `uploads.direct.routes.prefix: '/media/uploads'` to meet it → this is the one configuration that changes. Either drop that server override (the defaults now line up on their own), or pin the old client behaviour explicitly:

    ```ts
    createMediaUploadClient({ directPath: "/media/uploads" });
    ```

  `useMediaUpload` and `<MediaUploader>` accept `directPath` too, and forward it unchanged.

  Minor rather than major: the package is pre-1.0, where minor is this repo's breaking-change channel, and the only behaviour that changes is a path that previously produced a `404` — with the single narrow exception above, which is a one-line pin. A major would force a version bump on every consumer for a fix that leaves working configurations untouched.

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
