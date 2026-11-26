# @adonis-agora/media-react

## 1.0.0-rc.2

### Minor Changes

- [`68c904e`](https://github.com/DavideCarvalho/adonis-agora-media/commit/68c904e832c91ab8d17edaedbeb5143349163bbe) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Security fixes (found in an internal security audit). **Breaking**, see each item.
  
  **The federated console's Redis channel is authenticated.** Every request (reads included: listing disks and objects and signing URLs for any key used to run for anyone who could publish on Redis) and every answer is authenticated; a request over a minute old is refused, a replay runs once, a forged answer is ignored.
  
  - **Zero configuration with `@adonis-agora/crypto`**: when crypto runs in both apps, requests are sealed with the crypto key `console-media` in the owning app's crypto partition, with no auth line in either config. The Hub (crypto embedded) creates the key and encrypts as `media:console`; a console that is a crypto tenant seals through its own crypto channel (`crypto:seal:console-*`); the owning app decrypts with its own (`crypto:decrypt:console-*`) and creates the key at boot when it may, or logs the exact command to run. A federated app's new `partition` option (default: its key) names its crypto partition.
  - **Zero configuration with authkit's calls between apps**: the console sends its app-call token for the app, which the app verifies (audience-bound); the capabilities authkit granted the console app cap the request. With crypto too, the request is sealed and carries the token.
  - Explicit modes stay: `crypto` (any cipher, `owns` for a KMS of your own), `token` + `publicKey` / `verifyTenant` (authkit service-tenant tokens or your own verifier; a control plane's own `verifyTenant` is the fallback), and the shared `secret`. Explicit options win; `crypto: false`, `token: false` and `verifyTenant: false` turn a detection off. New: `node ace media:console-key`.
  - **Breaking:** the default crypto key is `console-media` (was `media-console`). An app with `consoleCommands` and no way to authenticate now **fails to boot** (web processes) with the line to add, and so does a console entry that may run actions (`actions: false` only warns). The console always sends the viewer's capabilities (`authorize` may return `capabilities`, narrowed to `media:objects:read`/`write`, also `media:console:read`/`write`/`*`), and the app refuses a request without them. Upgrade the console and its apps together.
  - New `agora:doctor` checks: `media.console-commands` (the mode each side resolved, matching what boot does) and the deep `media.console-commands-key` (in crypto mode, a probe encrypted and decrypted).
  - **Breaking:** a console's `apps` entries default `actions` to `true` (they used to follow the console's own `actions`); the app's `consoleCommands.actions` still decides, and `actions: false` makes an entry browse-only. A refusal for a missing viewer capability set has the code `capabilities-required`; refusals say who lacks a capability ("the console's token lacks …" / "the viewer lacks …"). `anyAuthorize` keeps the deciding authorizer's `capabilities`, and `authorize` may answer `access: 'read'`. A viewer's `capabilities` / `access: 'read'` now restrict the console's actions on its own app too (`403` "the viewer lacks media:objects:write", action buttons disabled); an `authorize` that says nothing keeps full access.
  
  **A control plane no longer crashes on a crafted query.** `?conversion=` and `?w=` were written into the `ETag` before validation, so a control character or a non-latin-1 character killed the process when the response was written, reachable by tenant tokens and, with proxy delivery, by anonymous visitors of a tenant. They are now validated first (`400`: a conversion name, `w` in 1–8192, `q` in 1–100), the ETag is always header-safe (and distinct per quality), and every `Content-Type` this package sends from a record, a disk or another app is checked. A declared `mimeType` (`x-media-attach`, `x-media-mime-type`) must be a bare `type/subtype`.
  
  **Generating a conversion needs write**: `POST /records/:id/conversions/:conversion` and `GET /records/:id/image?generate=1` on a control plane need `media:write` (read-only tokens get `403`).
  
  **Breaking: the built-in upload routes (`uploads.routes`) never take a key or a free disk from the client.** The client sends a `fileName`; the key is derived on the server (`routes.keyFor`, default `uploads/<uuid>/<fileName>`), the disk is `routes.disk` or one of `routes.disks`, and the multipart parts/complete/abort calls need the `uploadToken` the initiate answered. A client `visibility` is no longer read. New `routes.middleware`: without it the routes do not mount in production (the boot says what to add; `allowUnguarded: true` when a global middleware guards them) and warn elsewhere. The same guard (`middleware`, `allowUnguarded`) now applies to the TUS (`uploads.resumable.routes`) and direct-session (`uploads.direct.routes`) routes: without middleware they do not mount in production either. Upload tokens and the account console's upload tickets are signed with `APP_KEY` (or the new `uploads.secret`); without either the app fails to boot in production when it mounts them (a per-process key, with a warning, only outside production). `@adonis-agora/media-react`'s proxy upload sends `fileName` and uses the key the server answers (`meta.key` is ignored).
  
  **The console access contract is the one every Agora lib shares** (`console_authorize.ts`, identical across the libs). Breaking for code that reads decisions directly: `resolveConsoleAuthorize`/`normalizeConsoleAuthorizeResult` answer a sign-in redirect as `{ allowed: false, status: 302, redirectTo }` (was `401` + `redirectTo`; the console still answers the API with `401 { error: 'unauthenticated', redirectTo }` and redirects pages), a refusal from a throwing check carries its `error`, `anyAuthorize` rethrows it when every check refused, `apps`/`tenants` lists are kept as given (numbers as strings, empty names dropped), and `access` is kept as a field (`viewerConsoleCapabilities(decision)` turns it into media's capabilities). Media's additions (`capabilityAllows`, `capabilitiesAllow`, `MEDIA_OBJECTS_*`, `authorizeAgoraCaller` and the app-caller helpers) moved to `console_apps.ts`; `@adonis-agora/media/dashboard` exports them as before. `authorizeByToken` accepts `apps`, `tenants`, `capabilities` and `access`.
  
  **Console capabilities use the one matcher every Agora lib shares** (`console_capabilities.ts`): `*`, `media:*`, `media:console:*`, `media:console:write` (reads and writes), `media:console:read` (reads), the exact name, or a hierarchical grant like `media:objects:*`. **Breaking (security):** a `*` anywhere else grants nothing (`media:*:write`, `*:objects:write`, `*:console:*` used to widen). This applies to console tokens, viewer capabilities, app callers over HTTP (`permitTokenCapabilities`) and the console's own actions; `capabilityAllows` / `capabilitiesAllow` follow it. The owning app checks a command in a fixed order: capabilities present, the console's token, the viewer, the token's partition, then `consoleCommands.actions`.
  
  **Uniform messages across the Agora libs.** The boot errors (`ConsoleAuthConfigError`), the mode labels (`crypto (auto, key console-media)`, `token checked when sent (…)`, `token (…; sealed to <id>)`, `secret`), the `; actions on|off` boot line and the console-side timeout (`no instance of "<app>" answered within <n>s — …`) follow one template. The boot log no longer prints the app's command public key (only its short id, in token mode; `node ace media:console-key` prints it). The Hub creates each app's `console-media` key at boot (not on the first command), and `media.console-commands-key` checks it from the console too. A garbage or refused message on the channel is logged once per reason and dropped.
  
  **Libs coordinate through their siblings.** With authkit's calls between apps and no crypto, an app in token mode publishes its command public key in authkit's key directory at boot (purpose `console:media`) and the console fetches it from there: no `controlPlane.publicKey` to copy (an explicit one still wins). An app opens its own `console-*` crypto keys with no grant (the `crypto:decrypt:console-*` grant is no longer needed, harmless if present); a key not created yet on a crypto tenant is one info line (the crypto server creates it on the console's first seal). Zero config: together with the Hub's crypto, no lines and no grants; a separate crypto app, only the console's `crypto:seal:console-*`; authkit without crypto, no lines and one authkit grant (the console app gets `media:console:*`, or narrower, on the owning app: the token is mandatory there and caps every command).
  
  A refused command is logged once per reason as `console commands: refused a command (<reason>)` (`not JSON`, `no command id`, `did not open with this app's key`, `bad signature`, `stale`, `replayed`, `token refused`, `capabilities-required`, `mode not accepted here (…)`); the token mode shows its key as `sealed to key <8-char id>`; the doctor uses the boot log's sentences. Media opens no long-lived connection in a console (ace) process.
  
  **Mixed Hubs.** A console with crypto and authkit picks the way to each app lazily (the app's key in authkit's directory → token mode, else crypto), cached and decided again after 5 minutes or a refused command. In crypto mode a failing app-call token never blocks a command (it goes crypto-only, one warning with the grant to add, retried in 5 minutes). The APP_KEY is read from `config/app.ts`, else `config/encryption.ts` (AdonisJS 7), else the environment. An app publishes its key in authkit's directory only when token mode is its only way in; with crypto active it says nothing about it. The crypto key check uses crypto's `hasKey` when available (no decrypt error rows in the crypto audit).

## 1.0.0-rc.1

### Major Changes

- [#284](https://github.com/DavideCarvalho/adonis-agora-media/pull/284) [`ddf507b`](https://github.com/DavideCarvalho/adonis-agora-media/commit/ddf507bf477c00e89f8ca4ab033f56efd56519ad) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The media console is closed in production until you set `authorize`. Without `authorize` in `config/media_dashboard.ts`, the console is open outside production and in production answers `403` to every page and API request. Either way it logs once at boot: ``[@adonis-agora/media] console has no `authorize` configured: it is open outside production and denies every request in production. Set `authorize` in config/media_dashboard.ts.`` Before, it was open in every environment unless `middleware` or `auth` closed it. `authorize` runs before `middleware`, so a console guarded only by `middleware` needs `authorize` too, for example `authorize: () => true` to keep your middleware as the gate.
  
  `authorize` now takes the access contract shared by every Agora console, in three forms: an inline function `(ctx) => result`, a `ConsoleAuthorizer` class (built through the container, so `@inject()` works), or a lazy import of one (`() => import('#policies/console_access')`, loaded once). A check may also answer `{ redirectTo: '/login' }`: page navigations are redirected there and API calls get `401`. Every result the hook accepted before keeps working, and a check that throws is still a `403`.
  
  API refusals now answer `{ error: 'forbidden' }` (`403`) and `{ error: 'unauthenticated' }` (`401`, plus `redirectTo` when the check asked for a redirect), the same bodies as every other Agora console. Before they were `{ error: 'Forbidden' }` and `{ error: 'Unauthorized' }`.
  
  New `authorizeByToken({ token })` for machine access: `authorize: authorizeByToken({ token: env.get('CONSOLE_TOKEN') })` allows requests with `Authorization: Bearer <token>` and answers `401` otherwise. An empty or missing token throws when the config loads.
  
  The `DashboardAuthorize`, `AuthorizeResult` and `AuthorizeDecision` types are replaced by `ConsoleAuthorize`, `ConsoleAuthorizeResult` and `ConsoleAuthorizer`, exported from `@adonis-agora/media/dashboard` together with `resolveConsoleAuthorize` and `authorizeByToken`.
  
  The console no longer has a login of its own: the `auth` option of `config/media_dashboard.ts` is removed, with no alias. Gone with it: the console's login screen and sign out button, the `GET /me`, `POST /login`, `POST /session` and `POST /logout` API routes, the `media_dashboard_session` cookie and its `secret`/`ttl`/`session`/`login`/`revalidate` hooks, and the exports `resolveConsoleAuth`, `signSessionCookie`, `verifySessionCookie` and the types `ConsoleAuthOptions`, `ResolvedConsoleAuth`, `ConsoleSession`, `ConsoleSessionUser`, `ConsoleSessionUserInfo`, `AuthMode`, `SessionHook`, `LoginHook`, `RevalidateHook`, `MeResponse` and `LoginBody` (from `@adonis-agora/media/dashboard` and `@adonis-agora/media-dashboard`). Sign-in is your app's own: gate the console in `authorize` and return `{ redirectTo: '/login' }` for a signed-out visitor. When one of the console's API calls answers `401`, the console follows that `redirectTo`, or reloads the page when there is none. `@adonis-agora/media-dashboard`'s client drops `me()`, `login()`, `logout()` and `ConsoleAuthState`, and takes an `onUnauthenticated` option (default `followUnauthenticated`).
  
  `@adonis-agora/media-react` drops the console launcher, which only minted the removed console session: `OpenMediaDashboardButton`, `useOpenMediaDashboard`, `openMediaDashboardMutationOptions`, `openMediaDashboard`, `mintMediaDashboardSession`, `mediaDashboardSessionUrl`, `mediaDashboardUrl`, `ConsoleSessionError` and their types. Link to the console's `basePath` instead.

## 1.0.0-rc.0

### Major Changes

- [#281](https://github.com/DavideCarvalho/adonis-agora-media/pull/281) [`94f8af1`](https://github.com/DavideCarvalho/adonis-agora-media/commit/94f8af12bb87bf614a8ff0262958dd6120708851) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Release 1.0. Every export, option, subpath and ace command of `@adonis-agora/media` and `@adonis-agora/media-react` from 0.x works unchanged (see "Migrating to 1.0" in the docs). One behaviour is gone: the embedded console no longer reads a `window.__MEDIA_DASHBOARD__` global, only the JSON data block the provider injects.
  
  - Node.js 24 or later is required (`engines.node: ">=24"`, unchanged).
  - `@adonis-agora/media` accepts `@adonis-agora/authz`, `@adonis-agora/authkit-client`, `@adonis-agora/authkit-server` and `@adonis-agora/telescope` 1.x, including the 1.0 release candidates (`<lower> <2.0.0 || >=1.0.0-rc.0 <2.0.0`, lower bounds unchanged).

## 0.8.1

### Patch Changes

- [#228](https://github.com/DavideCarvalho/adonis-agora-media/pull/228) [`98ae7c1`](https://github.com/DavideCarvalho/adonis-agora-media/commit/98ae7c1af1187943eff5215e41196bff36e508f0) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Direct-S3 uploads `PUT` their parts in parallel, four at a time by default. The `concurrency` client option (and the per-upload one) now sets that bound; it was accepted but ignored. A failed part stops new parts from starting and rejects once the running ones settle.

## 0.8.0

### Minor Changes

- [#218](https://github.com/DavideCarvalho/adonis-agora-media/pull/218) [`9cc5f45`](https://github.com/DavideCarvalho/adonis-agora-media/commit/9cc5f455f136025370c4405500977b0de938e48e) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Video streaming, HLS and DASH:
  
  - `transformers.dash()` packages CMAF with the system ffmpeg: a DASH manifest and an HLS master playlist over the same fragmented-MP4 segments (`hls: false` for DASH only). `engines.ffmpegDash({ ladder })` encodes an ABR ladder.
  - `media.access.streamRoute()` serves HLS/DASH packages at `/media/:id/stream/:conversion/*`. It authorizes every request with the collection's `access.read`, checks the file against the package, and redirects or streams segments per `delivery.mode`. `serveStream()` is the same for your own controller.
  - `media.library.stream(id)` / `media.access.stream(ctx, id)` return the manifest URLs for a player, HLS first. With `delivery.signing` they are signed for the whole package, the route carries the signature onto every manifest reference, and it never expires before the video plus an hour.
  - `delivery.streamPath` sets where those URLs point.
  - `useMediaStream(ref, stream, { hls, dash })` in `@adonis-agora/media-react` plays HLS/DASH in your own `<video>`, headless. hls.js and dash.js are loaded on demand, iOS falls back to native HLS, and the hook exposes quality levels, `setLevel`, errors and the player instance.

## 0.7.0

### Minor Changes

- [#199](https://github.com/DavideCarvalho/adonis-agora-media/pull/199) [`0bee4fd`](https://github.com/DavideCarvalho/adonis-agora-media/commit/0bee4fd8ffbf3385f2bcf61baf5c50411af96e9b) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `next/image` for stored images, and the features of other image libraries (Nuxt Image/IPX, Astro, Unpic, spatie, imgproxy) that were worth having.
  
  **Rendering (`@adonis-agora/media-react`)**
  - `<MediaImage>` renders one `<img>`. It loads lazily by default, `priority` marks the LCP image (React 19 also preloads it), and `fill` sizes it to the parent box. A blurred preview is painted behind it until it loads; this works with SSR, survives hydration, and stays in place if the image fails. Three ways to feed it:
    - `image={await media.library.image(id)}`: a descriptor built on the server.
    - `src="/a.jpg"`: a plain URL, with your own `srcSet`, `blurDataURL` and `placeholderColor`.
    - `src={mediaId} loader={mediaImageLoader()}`: a loader, with `next/image`'s algorithm and widths.
  - `layout` (`constrained` / `fullWidth` / `fixed`) derives the box style and `sizes`. A lazy image gets `sizes="auto, …"`.
  - `focalPoint` becomes `object-position`.
  - `<MediaPicture>` does art direction with `<source>`s, each with its own size.
  - `placeholderStyle()` paints the preview on other components.
  
  **Server (`@adonis-agora/media`)**
  - `media.library.image(id)` returns `src`, a `srcSet` of same-picture presets, the intrinsic size, the placeholder and the focal point. An explicit `conversions` list forms its own art-directed group, and `onDemand` switches to resize URLs.
  - On-demand resize through `MediaDeliveryHandler` (`?w=`/`?q=`): each size is resized once and cached as a conversion, never enlarged, and limited to the `delivery.images` whitelist. The format (AVIF/WebP) is negotiated from `Accept`, and the result carries `vary: 'Accept'`.
  - Signed delivery URLs (`delivery.signing`, `media.library.deliveryUrl()`): an HMAC over the record, the conversion, the size and the expiry. Expiries are rounded so URLs stay cacheable. Unsigned requests are refused by default. With signing configured, `image()` only hands out signed route URLs.
  - Focal points (`media.library.setFocalPoint()`) and preset `position` (`'attention'`/`'entropy'`) for content-aware crops.
  - `responsive: true` collections: presets at standard widths (skipping those wider than the original) and the placeholder, from one flag.
  - `stripMetadata: true` collections: the original is rewritten without EXIF/GPS/XMP/IPTC, with the orientation baked in and the colour profile kept.
  - Generated image conversions record their output size in `meta`. Presets gain `withoutEnlargement`, `onlyDownscale` and `position`. `ImageProcessor` gains optional `dimensions()`/`stripMetadata()` and a `focalPoint` convert option.
  - Fixes: animated GIF/WebP keep their frames when converted to WebP. Concurrent conversions of one record no longer drop each other.
  - New errors: `ImageSizeNotAllowedError`, `NotAnImageError`, `DeliverySignatureError`.

## 0.6.0

### Minor Changes

- [#171](https://github.com/DavideCarvalho/adonis-agora-media/pull/171) [`637411b`](https://github.com/DavideCarvalho/adonis-agora-media/commit/637411b387062f27ba1261c72e928f8dd64ab0cc) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Drop Node.js 20 and 22: `engines.node` is now `>=24`. Node 20 reached end-of-life on 2026-04-30, and AdonisJS 7, which these packages require as a peer, needs Node 24 or later (`@adonisjs/core` declares `engines.node >=24.0.0`). The supported lines are the ones Node still maintains that AdonisJS 7 accepts: 24 and 26, both tested in CI.

## 0.5.2

### Patch Changes

- [#114](https://github.com/DavideCarvalho/adonis-agora-media/pull/114) [`932a8ff`](https://github.com/DavideCarvalho/adonis-agora-media/commit/932a8ff67109e353ad9d89655aff89f7105c22b1) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **`Upload-Metadata` values are now Base64 of their UTF-8 bytes**, which is what the server side (`parseTusMetadata`) decodes.
  
  The client used `btoa(value)` directly. `btoa` takes a one-byte-per-char string, so an accented title reached the server garbled (`Hemograma março` became `Hemograma mar�o`), and anything past U+00FF — an em dash, curly quotes, an emoji — threw `InvalidCharacterError` and failed the upload outright. Filenames and titles are exactly where those characters show up. Found in an end-to-end test of an app uploading lab reports in Portuguese.

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
