# @adonis-agora/media

## 0.13.0

### Minor Changes

- [`dbae909`](https://github.com/DavideCarvalho/adonis-agora-media/commit/dbae909703578e6aa8cc231cf5a33005e136feb4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add an `authorize` option to the media dashboard config — an access-decision hook
  gating the whole console (SPA + JSON API), same shape as the other `@adonis-agora`
  dashboards (telescope, durable, agent):

  ```ts
  // config/media_dashboard.ts
  import { defineConfig } from "@adonis-agora/media/dashboard";
  import { authorizeByRoles } from "@adonis-agora/authz";

  export default defineConfig({
    authorize: authorizeByRoles({ roles: ["ADMIN"] }),
  });
  ```

  - Receives the real `HttpContext`; return `true` to allow, `false` to deny.
  - Runs **before** `middleware` and composes with the built-in `auth` session guard
    (all must pass).
  - A denied request answers `401`/`403` — or honors a redirect the hook wrote (a
    `location` header), so a hook can send visitors to the app's login page.
  - A throwing hook fails closed (denied), never leaks the console.
  - When omitted, behavior is unchanged (console open unless you gate with
    `middleware`/`auth`).

  New exported type: `DashboardAuthorize`.

## 0.12.2

### Patch Changes

- [#57](https://github.com/DavideCarvalho/adonis-agora-media/pull/57) [`331f53f`](https://github.com/DavideCarvalho/adonis-agora-media/commit/331f53f6294f3b7e4261bdbf65fb8090063aa673) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Ship TanStack Intent agent skills with every package. Each package now publishes a
  `skills/` directory (`media-*` SKILL.md files) that lands in `node_modules` on install, so
  AI coding agents can discover them via `npx @tanstack/intent list`; adds `@tanstack/intent`
  as a devDependency for `intent validate` in CI.

## 0.12.1

### Patch Changes

- [#52](https://github.com/DavideCarvalho/adonis-agora-media/pull/52) [`4d9651d`](https://github.com/DavideCarvalho/adonis-agora-media/commit/4d9651d29863f2823f426a38588305528e8da699) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **Fixes a hard `npm install` failure.** Two peer ranges used a caret over a 0.x dependency, which under semver does not cross a minor — `^0.4.0` means `>=0.4.0 <0.5.0`. Every later minor of those peers fell out of range.

  pnpm downgrades an unsatisfied peer to a warning, so this was invisible inside the monorepo. **npm treats it as `ERESOLVE` and refuses to install**, even though both peers are declared optional:

  ```
  While resolving: @adonis-agora/media@0.12.0
  Found: @adonis-agora/telescope@0.8.1
  Conflicting peer dependency: @adonis-agora/telescope@0.4.0
  ```

  - `@adonis-agora/telescope`: `^0.4.0` → `>=0.4.0 <1.0.0`. Telescope is at 0.8.1, so any consumer on a current telescope could not install this package under npm. The floor stays at 0.4.0: bisecting the published tarballs shows the extension contract `mediaTelescopeExtension()` implements has been type-compatible since 0.1.0, so 0.4.0 was never too high — only the ceiling was wrong.
  - `sharp`: `^0.33.0` → `>=0.33.0 <1.0.0`. Same defect, same `ERESOLVE`; sharp is at 0.35.3. The processor only uses `resize`/`toFormat`/`quality`/`toBuffer`, verified end to end against sharp 0.35.3 outside the monorepo.

  No runtime behaviour changes, and no dependency is bumped — this only widens what a consumer is _allowed_ to have installed.

## 0.12.0

### Minor Changes

- [#46](https://github.com/DavideCarvalho/adonis-agora-media/pull/46) [`e2baf99`](https://github.com/DavideCarvalho/adonis-agora-media/commit/e2baf993dae1a7d3574128085abe1cf48087a023) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **Behaviour change — omitting `disk` now really uses Drive's default disk.** Read this if your `config/media.ts` does not set `disk`.

  The documented fallback ("omit `disk` and the provider uses the `default` of your `config/drive.ts`") had never worked in any environment. `MediaProvider` read it as `app.config.get('drive').default`, but `app.config.get('drive')` returns the value your config file exported — Drive's `defineConfig()` returns an **unresolved `ConfigProvider`** (`{ type: 'provider', resolver }`), so `.default` was always `undefined` and the fallback always returned the literal string `'default'`. (Reading `.config.default` instead does not help either: `{ config: { default, fakes, services } }` is the shape the provider's resolver _returns_, never the shape of the provider itself.) The provider now resolves the config provider — the same thing `@adonisjs/drive`'s own provider does before it builds its manager — and reads the default disk name off the resolved config. Drive's `DriveManager` cannot be asked instead: it keeps that config in a `#private` field and exposes no accessor.

  **Am I affected?** Look at the `default` key of your `config/drive.ts`:

  - `default: 'default'` (or you set `disk` in `config/media.ts`, or you have no Drive config at all) → nothing changes.
  - `default` is anything else _and_ your `services` map has **no** disk named `default` → media was hard-broken for you (every disk operation threw inside flydrive, because it was asked for a service named `'default'` that does not exist). This release fixes it; there is nothing to migrate.
  - `default` is anything else _and_ your `services` map **does** have a disk named `default` → **this moves where your files are written and read.** New objects now go to your real Drive default (e.g. `s3`) instead of the disk named `default`.

  **Migration.** Objects already written under the `'default'` disk will not be found on the new disk — nothing copies them. Media records persist their own `disk`, so rows attached before this upgrade keep resolving to `'default'` and stay readable as long as that disk still exists in `config/drive.ts`; anything that recomputes a location from the _current_ default (or any object you wrote outside the media record store) will look on the new disk and miss. To keep the old behaviour exactly, pin it explicitly:

  ```ts
  // config/media.ts
  export default defineConfig({
    disk: "default", // was implicit before this release
  });
  ```

  Otherwise, move the existing objects to your real default disk (or point that Drive service at the same bucket/location) before upgrading.

  This is a minor, not a major: the package is pre-1.0, where minor is the breaking-change channel, and a `1.0.0` would signal an API stability this package has not declared. The affected surface is narrow (a host that both omits `disk` and keeps a Drive disk literally named `default` alongside a different Drive `default`), the alternative for most affected hosts was a crash, and pinning the old behaviour is a one-line config change.

## 0.11.0

### Minor Changes

- [`ad61387`](https://github.com/DavideCarvalho/adonis-agora-media/commit/ad61387aba714ba85ce6a6cf810b97259db46a93) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The management console now ships **embedded** — `@adonis-agora/media/dashboard_provider` mounts the same React SPA + JSON API `@adonis-agora/media-dashboard` always has, straight from this package. `node ace configure @adonis-agora/media` registers it automatically (alongside publishing `config/media_dashboard.ts`); no separate `@adonis-agora/media-dashboard` install is required to get the console.

  New subpath exports:

  - `@adonis-agora/media/dashboard_provider` — the provider (routes: SPA + assets, JSON API, session auth). Reads the same `media_dashboard` config key `@adonis-agora/media-dashboard`'s provider always did, so an existing `config/media_dashboard.ts` keeps working unchanged if you switch to this provider.
  - `@adonis-agora/media/dashboard` — `defineConfig`/`MediaDashboardConfig` for authoring `config/media_dashboard.ts`, `DashboardService`/`DashboardError`, the built-in session-auth helpers (`resolveConsoleAuth`, `signSessionCookie`, `verifySessionCookie`), `ObjectInsightProvider`/`sanitizeInsight`, and the dashboard's JSON API types.

  `MediaDashboardConfig` also gains `enabled` (default `true`) — set `false` to register the provider without mounting any route.

  At build time, `pnpm build` copies `@adonis-agora/media-dashboard`'s built SPA (`dist/spa`) into this package's own `dist/assets/spa`, mirroring `@adonis-agora/durable`'s embedded-dashboard pattern. `@adonis-agora/media-dashboard` remains published, standalone-installable, and its own provider (`@adonis-agora/media-dashboard/media_dashboard_provider`) still works — see that package's own changeset for what changed there. Register only one of the two dashboard providers in a given app.

## 0.10.4

### Patch Changes

- [`a06b2df`](https://github.com/DavideCarvalho/adonis-media/commit/a06b2df5194259be83fa08e8af15e7f9b07c48b3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Widen the `@adonisjs/drive` peer dependency from `^3.0.0` to `^3.0.0 || ^4.0.0`.

  Verified compatible by running the real test suite against `@adonisjs/drive@4` (the package's dev dependency is bumped accordingly). No source changes were needed — this is a non-breaking relaxation of the accepted peer range, so consumers can adopt Drive v4 without waiting on a major bump here.

## 0.10.3

### Patch Changes

- [`fdfafea`](https://github.com/DavideCarvalho/adonis-media/commit/fdfafeabf618b2787a970c4b104af822dcec03fe) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `services/main` no longer throws when imported before `MediaProvider.register()`

  The `@adonis-agora/media/services/main` singleton used a provider-captured `getBootedApp()` with a
  top-level `await` — importing it before `MediaProvider.register()` ran (e.g. the ace command loader
  reading command metadata during `node ace list`) threw `app accessed before MediaProvider registered`.

  It now follows the ecosystem-standard pattern used by `@adonisjs/lucid`, `@adonisjs/drive` and
  `@adonisjs/queue`: read the app from `@adonisjs/core/services/app` (whose binding is set by
  `bin/server`/`bin/console` before any command module is imported) and capture the `MediaManager`
  inside `app.booted(...)`. Importing the singleton is now safe at any time; the manager resolves once
  the app boots.

## 0.10.2

### Patch Changes

- [`4ca013b`](https://github.com/DavideCarvalho/adonis-media/commit/4ca013b722fc621c5465e4ad766166d373c6b05d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Normalize generic/truncated MIME declarations from the file extension, and list the accepted types in the rejection

  **Better error message.** `MimeNotAllowedError` (code `E_MEDIA_MIME_NOT_ALLOWED`) now includes the collection's `acceptsMimeTypes`, so a rejected upload is instantly diagnosable: `MIME type "text" is not allowed in collection "dataset". Allowed: text/csv, text/plain.` The error also carries the list on a new `accepted` field.

  **MIME normalization.** Adonis multipart sometimes reports a bare top-level type (`"text"` instead of `"text/csv"`), which used to be rejected outright. Now `attach` / `attachExisting` treat a generic or non-whitelisted declaration as ambiguous and try to pin a concrete MIME from the file extension via a small built-in map (`.csv` → `text/csv`, `.tsv`, `.txt`, `.xlsx`/`.xls`, `.json`, raster images, `.svg`, `.pdf`, common video containers). When the extension resolves to a type the collection **does** whitelist, that normalized value is what the record stores (and what the disk's `Content-Type` and the content-signature check use). The whitelist stays authoritative — the resolved type must be on it, and the magic-byte check still runs — so nothing is loosened; an unresolvable or non-whitelisted result still throws `MimeNotAllowedError` with the allowed list.

## 0.10.1

### Patch Changes

- [`1a5bac3`](https://github.com/DavideCarvalho/adonis-media/commit/1a5bac365b7ed806a08c65a7b30c2c39f056b72d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix the direct-upload `policy` default export being usable as a class.

  `uploads.direct.routes.policy` is a lazy `() => import(...)`, and the idiomatic AdonisJS policy is a `default export class`. Until now the provider handed the module's default export straight to the handler **without instantiating it**, so a class policy crashed at runtime — the handler called `policy.onInitiate(...)` on the constructor, not on an instance. The provider now instantiates a class default export (no arguments) and passes a ready object through unchanged, so both forms work.

  The config seam is typed accordingly: the new `DirectUploadPolicyModule` accepts either a policy class or a ready policy object. It is typed `<any, any>` on purpose — `DirectUploadPolicy` is invariant in its context and record generics, so `<unknown, unknown>` would reject every concretely-typed policy; the `any` is contained at this config boundary and the handler still sees a fully-typed policy.

## 0.10.0

### Minor Changes

- [#23](https://github.com/DavideCarvalho/adonis-media/pull/23) [`77337c8`](https://github.com/DavideCarvalho/adonis-media/commit/77337c8ecde9589f9a006600420327eae5b6a0f2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `DirectUploadPolicy` — the business-logic extension point for session-backed direct uploads.

  The 0.9.0 `media.direct` flow knew how to move bytes straight to S3 and persist the session, but every consuming app still had to wrap the built-in routes to answer the questions that are always the same shape yet always app-specific: _is this caller allowed to upload here, does the declared file pass my rules, which record do I create up front, and what do I do once the bytes land?_ `DirectUploadPolicy` lifts that seam into the lib. An app implements one object — `onInitiate` (validate + open the multipart upload + return the `InitiateDecision`: key, collection/disk overrides, visibility, part size, metadata, an optional JSON `response` merged into the 201, and an optional `rollback` ran if the initiate later fails), `resolveComplete` (map the session id back to the app's pending record + the `attachExisting` target) and `onComplete` (run after the bytes are attached — flip status, probe duration, dispatch the transcode job — and return the response body) — plus the optional `onInitiated` (persist the session id on the record), `onAbort` (clean up the pending record) and `mapError` (translate a thrown error into a typed HTTP response, e.g. a validation failure → 422 or incomplete-parts / session-not-found → 409).

  The policy is wired through two new `uploads.direct.routes` config seams: `policy` (a lazy `() => import(...)` so the app's models load only when an upload actually happens) and `middleware`. **The built-in routes remain unguarded by default** — exactly as before — so an app that wants auth sets `middleware: [middleware.auth()]` itself; the lib never silently adds a guard. The provider forwards the request context into the handler (`handle(toRequest(ctx), ctx)`) and adopts the completed bytes via `completeDirectUploadToLibrary`, so the collection whitelist is still re-verified against the **real** bytes on complete. A per-decision `disk`/`collection` falls back to the manager-level default when the policy doesn't override it.

  Also new: `traceMedia` observability hooks that republish the direct-upload lifecycle as spans through `@adonis-agora/diagnostics`' global `TRACE_SLOT` **structurally** — no hard dependency, no-op when diagnostics is absent.

## 0.9.0

### Minor Changes

- [#20](https://github.com/DavideCarvalho/adonis-media/pull/20) [`a44014e`](https://github.com/DavideCarvalho/adonis-media/commit/a44014eb05c1aea460c163b1dd68c98bee01c284) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Session-backed direct uploads (`media.direct`) and a hand-rolled SigV4 presigner with split internal/public endpoints

  **Why a third upload flow.** For video-sized files the deciding cost is bandwidth _through the app_. The TUS path resumes beautifully but streams every chunk client→app→S3 — 2× the bytes, and the app pays for both directions. The raw direct primitives (`media.uploads.initiateDirect` & friends) send bytes straight to S3, but they are stateless: `uploadId`, the part size and every collected `ETag` live only in the client's memory, so a page reload orphans the upload — and every consuming app was growing its own tracking table to compensate. `DirectUploadManager` (`media.direct`, config `uploads.direct`) combines the halves: the browser `PUT`s multipart parts straight to S3 through presigned URLs (the app moves **no** payload), while the session — `uploadId`, the agreed `partSize`, every confirmed part ETag — persists in the existing `UploadSessionStore` SPI. Same SPI, and with `uploadSessions.lucid()` the same tables, as TUS: **zero new migrations**; a part-size marker in the session metadata keeps the two flows from ever misreading each other's sessions in a shared store. TUS remains the right tool when the disk isn't S3 or bytes must flow through the app; direct sessions when they mustn't.

  The lifecycle is deliberately front-loaded and resumable at every step:

  - **`initiate`** validates part-size geometry (S3's 5 MiB floor and 10,000-part cap — caught here as the new `UploadPartSizeError`, instead of as S3's `EntityTooSmall` _after_ the whole file crossed the wire) and, given a `collection`, the declared `contentType` against that collection's `acceptsMimeTypes` — read from the same registry `attach` uses, so the gate and the barrier cannot drift — before the multipart upload even opens. Then it persists the session and presigns every part URL in one local batch.
  - **`confirmPart`** records each uploaded part's ETag server-side — the resume currency. Everything else is disposable client state.
  - **`status`** is the resume answer: confirmed ETags plus **fresh** presigned URLs for the parts still missing — which is also why the presign TTL no longer has to be sized to "the whole upload on a slow connection"; an expired URL costs one status round-trip, not the upload.
  - **`complete(id, parts?)`** merges caller-supplied and confirmed parts and fails fast naming the exact missing part numbers (`UploadPartsIncompleteError`) instead of letting S3 return an opaque `InvalidPart`; **`abort`** frees the parts S3 is storing (best-effort — a lifecycle-reaped upload must still be deletable locally); expired sessions are reaped on access exactly like TUS.

  `DirectUploadHandler` is the framework-neutral HTTP half in the `TusUploadHandler` mold — the provider mounts it under `uploads.direct.routes` (default `/media/uploads/direct/sessions`), it performs **no authorization** (the app guards the route), and the client sends a `fileName`, never a key: the key is resolved server-side via `keyFor`. `MediaManager.completeDirectUploadToLibrary(sessionId, input, parts?)` mirrors `completeUploadToLibrary`: complete + `attachExisting` in one step, zero-copy, with the collection whitelist re-validated against the **real** bytes (`verifyContentAgainstWhitelist` on a 16-byte head read) — the initiate gate checked what the client _declared_; this remains the barrier that checks what it _sent_.

  **Presigned URLs are now hand-rolled SigV4 (query auth, `UNSIGNED-PAYLOAD`) — the `@aws-sdk/s3-request-presigner` peer is gone.** Presigning is pure local crypto (an HMAC chain over a canonical request; no round-trip to S3), so the SDK package bought nothing except a hard coupling of the signature to the client's configured endpoint. That coupling is precisely what breaks browser-consumed URLs behind a private network: SigV4 bakes the `Host` into the signature, and a URL signed for the internal MinIO FQDN is invalid on the public one — with the SDK the only fix is constructing a second client per endpoint. Owning the signer makes it a parameter: the new `publicEndpoint` option on `disks.s3()` signs **browser-facing** URLs (direct-upload part `PUT`s, signed `GET`s) for the public host while server-side operations — including the ListObjectsV2 XML-fallback fetch — stay on the internal `endpoint`. The signer (`presignS3Url`, exported) is verified byte-for-byte against AWS's published `examplebucket` presigned-GET test vector, plus an independently recomputed `UploadPart` vector locked as a regression pin; strict RFC 3986 encoding (including the `!'()*` set `encodeURIComponent` skips) and STS session tokens are covered. Credentials and region still resolve from the SDK client's own config, so every credential source (static, env, shared config, IAM role) keeps working.

  Also new: typed `UploadPartOutOfRangeError` (a confirmed part number outside the agreed slicing) and `DirectUploadsNotConfiguredError` (accessing `media.direct` without `uploads.direct`), both alongside the errors above; `direct.partSize`/`direct.presignTtlSeconds` fall back to the shared `uploads.*` knobs, with a 20 MiB default part size (direct parts occupy no app memory, so a bigger part only enlarges the retry unit). Requires bucket CORS that allows `PUT` from the app's origin and exposes the `ETag` response header — the browser must read it to confirm parts.

- [#21](https://github.com/DavideCarvalho/adonis-media/pull/21) [`75649a9`](https://github.com/DavideCarvalho/adonis-media/commit/75649a9c6793f9f8fc83da07ee2418ab9ff8432b) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Transformers — transformações de conteúdo plugáveis persistidas como conversions — com HLS de vídeo como implementação de referência

  **O contrato `Transformer`.** Conversions de imagem respondem "mesma imagem, outro tamanho/formato". Tudo o mais que deriva de uma mídia — um pacote HLS, uma faixa de áudio extraída, metadados sondados, um blurhash — agora passa por um contrato único: um `Transformer` recebe um `TransformerContext` (o record, leitura do original via `getBytes`/`getStream`, o `storage` para assets auxiliares em outros disks) e produz artefatos + metadados persistidos como uma conversion nomeada no `MediaRecord`. O contrato foi validado contra os shapes possíveis antes de nascer: N artefatos com entry (HLS), 1 artefato (otimizar imagem, extrair áudio), **zero artefato** (probe/placeholder — só `meta`), input auxiliar (watermark via `context.storage`) e requisito de runtime declarável (`TransformerRuntimeMissingError` tipado para WebCodecs/peer ausente).

  O sandbox é do context, não do transformer: todo `write(relativePath, contents)` cai sob o prefixo `…/conversions/<name>/`, é validado (sem `..`/caminho absoluto — `TransformerOutputError`) e **registrado** — a lista `files` persistida vem do que foi de fato escrito, nunca da contabilidade do transformer. É isso que torna um pacote de centenas de segmentos deletável (batch via `deleteMany` em disks capazes) e servível arquivo a arquivo sem aritmética de path sobre input do caller. `MediaConversion` ganhou o shape para isso: `path`/`disk` agora opcionais (transform metadata-only não tem artefato), mais `prefix`, `files` e `meta` — as conversions de imagem existentes seguem `{ path, disk }` sem migração (colunas JSON).

  **Registro e disparo.** Transformers declaram-se por collection (`transformers: [transformers.hls()]`), no mesmo namespace de nomes das presets — colisão falha no boot com `TransformerConflictError`. Vídeo é pesado e assíncrono por natureza, então nada roda no attach por padrão: o app dispara `media.library.transform(id, 'hls')` do job dele (a lib não assume sistema de filas). A chamada é **idempotente** — conversion existente ⇒ skip — e falha no meio varre os artefatos parciais e nunca persiste entry, então retry recomeça limpo. `eager: true` (para transforms baratos) roda dentro de `attach` **e** `attachExisting` — o caminho do finalize TUS via `completeUploadToLibrary`, fechando o fluxo "TUS larga os bytes, transformers derivam depois" sem fiação extra — com o mesmo rollback das conversions eager (mídia nova desfeita inteira, a anterior de uma collection `single` fica de pé). Leitura nunca gera transform: `url()`/`deliver()` numa conversion de transformer ausente lançam `TransformNotReadyError` em vez de prender um request atrás de um remux (presets de imagem continuam lazy).

  **`transformers.hls()` — o transformer de vídeo.** Remuxa o vídeo para HLS (segmentos MPEG-TS + playlists de mídia atrás de um master) com [mediabunny](https://mediabunny.dev) — TypeScript puro, **sem binário ffmpeg**, peer OPCIONAL importado só no primeiro `transform()` (padrão `processors.sharp()`/`disks.s3()`; ausente ⇒ `TransformerRuntimeMissingError` com hint de install, não `ERR_MODULE_NOT_FOUND` cinco imports abaixo). Incorpora os gotchas provados em produção no protótipo do eduliberta:

  - **Remux-only por padrão, com o porquê documentado**: encodar exige WebCodecs, que o Node não expõe. h264/aac copia sem re-encode (sem perda, rápido); codec que o MPEG-TS não carrega (vp9/av1) falha com `HlsSourceUnsupportedError` listando codec e razão por track — definitivo para o arquivo, não retryável.
  - **O trim do AAC priming**: áudio AAC com edit list começa em timestamp NEGATIVO; o default do mediabunny corta em t=0, o que tiraria a track do fast path de cópia. A conversão corta no `getFirstTimestamp()` real — todas as tracks deslocam igual, sync intacto, tudo continua stream-copy.
  - **WebCodecs injetável**: `transformers.hls({ webcodecs: () => import('@napi-rs/webcodecs') })` instala a implementação em `globalThis` (só o que falta; nativo nunca é sobrescrito) e destrava o fallback de re-encode do mediabunny para fontes incompatíveis. `resolveWebCodecsSupport()` reporta `native`/`injected`/`absent`. Multi-qualidade (ladder 360p/480p/720p via fan-out) fica como evolução documentada no roadmap sobre esse mesmo seam — não é fingida hoje.

  Meta persistida: duração, resolução, codecs, contagem de segmentos/playlists, targetDuration. O engine é injetável (`HlsRemuxEngine`), então a orquestração inteira (temp files, upload streaming com contentLength, content types) é testada sem mediabunny — e um teste de integração roda o mediabunny REAL contra uma fixture h264/aac de 12 KB no CI (JS puro, funciona no ubuntu-latest), provando o caminho de produção inclusive o trim.

  **`transformers.probe()` — o transformer metadata-only.** Sonda duração/resolução/codecs/sample rate e persiste só `meta`, zero artefato — a prova real do shape "sem artefato" do contrato, e o substituto do serviço manual de "baixa o arquivo e lê a duração" que todo app de mídia acaba criando.

  **Delivery HLS-aware.** Playlists são armazenadas com referências relativas ao layout do storage e precisam de rewrite a cada serve. `rewriteHlsPlaylist(content, rewrite)` cobre todos os lugares onde o RFC 8216 põe uma URI — linhas de URI, atributos `URI="…"` de `#EXT-X-MEDIA` (renditions de áudio), `#EXT-X-MAP`, `#EXT-X-I-FRAME-STREAM-INF`, `#EXT-X-KEY` — reescreve só referências **relativas** (absolutas/rooted ficam como estão), preserva o resto byte a byte (CRLF incluso) e aceita rewriter async. Em cima dela, `HlsDeliveryHandler` é a rota-metade framework-agnóstica no padrão `MediaDeliveryHandler`/`TusUploadHandler`: o app monta UMA rota `(:mediaId, :file?)` com o middleware dele — **a lib não decide autorização** — e o handler serve o pacote inteiro: playlist pedida ⇒ conteúdo reescrito (sub-playlists via `urlForPlaylist` do app, para cada hop voltar pela auth; segmentos via `urlForSegment` ou, por padrão, **presigned URL direto do disk** com TTL — o caso comum pronto); segmento pedido ⇒ `redirect` presigned ou `stream` proxied (`segmentDelivery`). Arquivo pedido é validado por pertencimento à lista `files` persistida — traversal estruturalmente impossível.

  **Tipos inferidos da config.** `defineConfig` agora é `<const T>` e preserva nomes literais; `InferTransformers<typeof config>` / `InferConversions<typeof config>` extraem as unions de nomes (presets + transformers) para tipar payloads de job e rotas — o padrão `InferConverters` do @jrmc/adonis-attachment, sem `as const`.

  **Testing kit**: `FakeTransformer` (registra contexts, escreve artefatos configurados, `behavior` custom) ao lado do `FakeImageProcessor`.

  **Cortes explícitos** (registrados no roadmap, não neste PR): multi-qualidade/ladder (exige o WebCodecs injetado; seam pronto), PosterFrame (exige decoder — idem), watermark/audio-extract/image-optimize/placeholder/transcription (o contrato acomoda os seis shapes; nada de stubs mortos), DRM/EXT-X-KEY com criptografia, HLS live/low-latency (só VOD), decorator Lucid `@media` no model do app (API desenhada no roadmap; o shape novo de `MediaConversion` já a suporta sem refactor) e a rota de delivery nomeada com inferência Tuyau + helpers Edge (idem).

  Sem breaking para consumidores existentes além do type de `MediaConversion` (`path`/`disk` opcionais — 0.x, sem shim): stores existentes leem os records antigos como sempre.

- [#19](https://github.com/DavideCarvalho/adonis-media/pull/19) [`f81478e`](https://github.com/DavideCarvalho/adonis-media/commit/f81478e7a683347fa4ba56c9fb8d5614c2e95477) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Magic-byte signatures for the common video containers — and with them, video collections finally get a real whitelist

  The signature table covered PNG/JPEG/GIF/WEBP/PDF and **no video format**. That had two concrete consequences for any collection gating video:

  - No video was ever _detectable_, so a whitelist like `['video/mp4']` could never be **closed** (see 0.8.0): the closed-whitelist rejection for unrecognisable content simply never activated, and anything without a known signature — a `.txt`, an executable, random bytes — sailed through `attach`/`attachExisting`/TUS as long as the caller declared `video/mp4`.
  - `attachExisting` could not catch content disguised as a video: a PNG uploaded as `clip.mp4` produced no `ContentTypeMismatchError`, because the detector had no idea what an MP4 looks like.

  The table now recognises:

  - **`video/mp4`** — ISO-BMFF `ftyp` box (bytes 4–7; the first 4 bytes are the box _size_ and vary per file, so they are skipped — the existing `[offset, hex]` parts mechanism already expresses this) with a major brand from the recognised set: `isom`, `iso2`–`iso6`, `mp41`, `mp42`, `avc1`, `av01`, `dash`. One table entry per brand, the GIF87a/GIF89a pattern.
  - **`video/quicktime`** — the same `ftyp` box with major brand `qt  `. Same container, different type: a `.mov` relabeled `video/mp4` is now a positive **mismatch**, not a pass.
  - **`video/webm`** / **`video/x-matroska`** — EBML magic `1A45DFA3` at offset 0, discriminated by the `DocType` element (`webm` vs `matroska`). DocType sits inside a variable-length EBML header, so its offset depends on the muxer — the one thing fixed offsets cannot express. The signature mechanism gained a minimal `scan` field: a byte run (element id + size + doc type string, so it cannot fire on stray text) that must appear _anywhere_ in the head, checked only **after** the fixed parts already identified the container. No EBML parser, no new dependency.
  - **`video/x-msvideo`** — `RIFF` + `AVI ` form type (bytes 4–7 are the chunk size and skipped, exactly like WEBP).
  - **`video/mp2t`** — MPEG transport stream. There is no magic number, only the `0x47` sync byte opening every 188-byte packet; one byte would collide with anything starting with `G`, so the sync byte is required at the start of the first **two** packets (offsets 0 and 188). It is the weakest signature and sits last in the table, so it can never shadow a stronger match.

  `SIGNATURE_HEAD_BYTES` grows from 16 to **189** (the second TS sync byte). All the sniffing paths already read exactly this constant and handle short payloads: `attach` still peeks and replays the head without buffering the payload, `attachExisting` still tears the disk stream down after one short read, and a head shorter than a signature's deepest offset degrades to _unrecognised_, never to a false positive.

  Deliberate non-guesses, so a legitimate file never turns into a false mismatch: an `ftyp` brand outside the set above (3GPP's `3gp*`, Apple's `M4A `/`M4V `) and an EBML DocType that is neither `webm` nor `matroska` stay **unrecognised** — under an open whitelist they fall back to the declared type exactly as before.

  **Behaviour change to review if you gate video:** a whitelist made up entirely of the types above — `['video/mp4']` being the canonical case — was open and is now **closed**. Three things follow:

  1. Content whose signature contradicts the declared type is rejected with `ContentTypeMismatchError` (`E_MEDIA_CONTENT_TYPE_MISMATCH`) — the PNG-disguised-as-MP4 case, previously accepted.
  2. Content matching _no_ signature is rejected with `ContentSignatureUnrecognizedError` (`E_MEDIA_CONTENT_SIGNATURE_UNRECOGNIZED`), per the 0.8.0 closed-whitelist rule that never activated for video before.
  3. Legitimate videos whose real container differs from the declared type — `.mov`/`.mkv`/`.avi` files uploaded under a blanket `video/mp4` — now fail instead of slipping through. If your collection genuinely accepts them, list what you accept: `acceptsMimeTypes: ['video/mp4', 'video/quicktime', 'video/webm']`.

  Applies uniformly to `attach`, `attachExisting` and the TUS first-chunk check, which all share `verifyContentAgainstWhitelist`.

## 0.8.2

### Patch Changes

- [#17](https://github.com/DavideCarvalho/adonis-media/pull/17) [`e911880`](https://github.com/DavideCarvalho/adonis-media/commit/e911880969a28dd6bdbc0c56181462628eec1a4d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Corrige dois pontos onde este pacote ainda capturava um singleton do `@adonisjs/core` via `import`
  de módulo em vez de recebê-lo do provider — o mesmo formato de dual-package hazard que já havia
  derrubado o `Database` do Lucid em produção (ver o changeset `lucid-string-token`), só que agora nos
  singletons `app` e `router` do próprio core.

  **1 — `app` capturado eager em `services/main.ts` e `single_file_store.ts`.** Ambos faziam
  `import app from '@adonisjs/core/services/app'` no topo do módulo. Esse binding só é preenchido via
  `setApp()` chamado pelo Ignitor da app hospedeira; se a árvore de dependências contiver DUAS cópias
  físicas de `@adonisjs/core` (pnpm workspace hoisting, pins divergentes, ou até a mesma versão
  resolvida sob peer-sets diferentes), a cópia que este pacote importa nunca recebe esse `setApp()` — o
  `app` fica `undefined` e qualquer uso quebra com um `Cannot read properties of undefined` opaco.

  A correção segue o padrão já usado pelo `@adonis-agora/authz` (`services/booted_app.ts`): o
  `MediaProvider.register()` agora captura a instância de `ApplicationService` que a própria aplicação
  lhe entrega — que é sempre a cópia correta, seja qual for a duplicação na árvore — e a expõe via um
  módulo interno (`src/services/booted_app.ts`) para `services/main.ts` e `single_file_store.ts`
  lerem. Nenhuma mudança de API: `media.library.attach(...)` e as funções `storeSingleFile` /
  `removeSingleFile` / `isSingleFileStoreAvailable` continuam idênticas por fora.

  **2 — `router` resolvido eager e usado síncrono em `providers/media_provider.ts`.** O provider
  importava `router` de `@adonisjs/core/services/router` no topo do módulo e chamava `router.get(...)`
  / `router.post(...)` direto dentro de `boot()`. Esse serviço específico só é atribuído dentro de um
  hook `app.booted(...)` no próprio módulo `services/router.ts` do core — que dispara estritamente
  DEPOIS do `boot()` de todos os providers. Ou seja, mesmo numa árvore com uma única cópia do core,
  usar esse import de forma síncrona em `boot()` já é uma corrida contra o próprio mecanismo que o
  preenche; numa árvore duplicada o problema se soma ao caso 1.

  A montagem das rotas (`/media/uploads/direct/*`, `/media/uploads/proxy`, `/media/uploads/tus/*`)
  agora é adiada para dentro de `app.booted(...)` — o mesmo padrão já documentado e em produção no
  `DashboardProvider` do `@adonis-agora/durable`. Verificado que isso é seguro para o ciclo de vida do
  Adonis: os hooks `booted` de TODOS os providers disparam antes do `Server#boot()` do
  `@adonisjs/http-server` (que roda dentro de `app.start()`) chamar `router.commit()` — o último ponto
  em que rotas ainda podem ser adicionadas. Dentro do hook, o `router` é resolvido pelo container
  (`app.container.make('router')`) a partir do `this.app` do provider, imune à duplicação da mesma
  forma que o caso 1.

  Nenhuma mudança de comportamento observável: as mesmas rotas são montadas, só que um instante mais
  tarde no boot (antes do servidor HTTP subir, nunca depois).

  Também adicionado `prepack` ao `package.json` do pacote publicável, espelhando o `build`.

## 0.8.1

### Patch Changes

- [#14](https://github.com/DavideCarvalho/adonis-media/pull/14) [`9224651`](https://github.com/DavideCarvalho/adonis-media/commit/922465168256b7b248347639edaa322cf53cfeec) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Resolve the Lucid `Database` by its string alias `'lucid.db'` instead of importing
  `@adonisjs/lucid/services/db`, making the library immune to the dual-package hazard.

  The service module resolves the `Database` **class** and uses it as the container token, while
  Lucid's provider registers `container.singleton(Database, ...)` keyed on that same class object. A
  class token only matches when the consumer and the booting provider loaded the _same physical copy_
  of `@adonisjs/lucid`. When a host app's tree contains two copies — different version pins, or even
  the same version resolved under different peer sets, which pnpm materializes as separate directories
  — the tokens differ, no binding is found, and the container tries to _construct_ `Database`, which
  has no `@inject()`:

  ```
  RuntimeException: Cannot construct "[class Database]" class.
  Container is not able to resolve its dependencies. Did you forget to use @inject() decorator?
  ```

  This took down every TUS upload in a production app while its local test suite passed, because the
  duplication existed only in the `pnpm deploy` artifact and not in the workspace.

  `'lucid.db'` is a string, so it cannot be duplicated: whichever copy boots registers the alias, and
  any copy resolves it. The library no longer depends on the host app's dependency tree being
  perfectly deduplicated. Both `stores.lucid()` and `uploadSessions.lucid()` are fixed, and a
  regression test asserts on the resolved _token_ rather than the returned store — asserting on the
  store would pass with either implementation and let the hazard back in silently.

  No API change: both factories already received the application in their context.

## 0.8.0

### Minor Changes

- [#12](https://github.com/DavideCarvalho/adonis-media/pull/12) [`92006a0`](https://github.com/DavideCarvalho/adonis-media/commit/92006a032290c6d7e61d4b34184553127992ea5c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Collection-aware TUS validation, a stricter closed-whitelist rule, and a fix for a non-deterministic Drive resolution race

  **Fix: the Drive manager was captured before it existed.** The provider read `(await import('@adonisjs/drive/services/main')).default` once, while building the `MediaManager` singleton. Drive's service module only assigns that manager inside `await app.booted(...)`, which resolves immediately when the app has not booted yet — so the value captured was `undefined`, permanently, and every media call died with `Cannot read properties of undefined (reading 'use')`. It depended on whether the import won the race against boot, which made it non-deterministic: one run 500s, the identical rerun passes. The Drive manager is now resolved **lazily, at the first disk resolution that actually needs it**, and memoized, so it is still resolved exactly once — just not too early. An app whose disks all come from `config.disks` never touches Drive at all, and resolving genuinely before boot now throws `DriveNotReadyError` (`E_MEDIA_DRIVE_NOT_READY`) instead of a bare `TypeError`. The resolver is exported as `createDriveBackedResolver` for wiring media outside AdonisJS.

  **`TusUploadHandler` can enforce a collection's `acceptsMimeTypes`.** `acceptsMimeTypes` belongs to a collection and used to apply only at `attach`, while TUS knew nothing about collections and accepted any binary (only `maxSize`) — so a user uploaded a whole 20 MB file over a resumable protocol and learned it was the wrong type at finalize. Set `uploads.resumable.routes.collection` (or pass `collection` + `collections` to the handler) and the whitelist is enforced at the two earliest points the protocol allows:

  - **`POST`** — the `filetype` the client declares in `Upload-Metadata`, rejected with `415` before a single byte is uploaded, with no session created.
  - **first `PATCH`** — the real magic-byte signature of the leading bytes, using the existing detector. Catches a client that lied in `filetype`; the session and any partial object are aborted, so the liar pays for one chunk instead of the whole file. Later chunks are not sniffed.

  You name the collection, never the MIME list: the collection config stays the single source of truth, so the upload gate and the attach-time check cannot drift. This is bandwidth economy and fast feedback, **not** the security boundary — `attach` / `attachExisting` re-validate the assembled object and remain the final barrier. `MediaManager.collections` now exposes the registry, and `resumable.status()` additionally returns the declared `contentType`.

  **Unrecognised signatures are now rejected under a closed whitelist.** Treating "no signature matched" as "no evidence" is right for SVG/CSV/text, but it leaked work to apps: a collection accepting only `application/pdf` still let a `.txt` through `attach`/`attachExisting`, so the consuming app had to reimplement `detectMimeType(...) === undefined` by hand. Now, if **every** type in `acceptsMimeTypes` is signature-detectable, unrecognisable content cannot be any of them and is rejected with the new `ContentSignatureUnrecognizedError` (`E_MEDIA_CONTENT_SIGNATURE_UNRECOGNIZED`), distinct from `ContentTypeMismatchError`. If **any** accepted type has no signature (`image/svg+xml`, `text/csv`, `text/plain`, office formats), the previous permissive behaviour is unchanged. Applies to `attach`, `attachExisting` and the TUS first-chunk check alike; `isDetectableMimeType`, `isClosedSignatureWhitelist` and `verifyContentAgainstWhitelist` are exported so the same reasoning is available outside the library.

## 0.7.0

### Minor Changes

- [#10](https://github.com/DavideCarvalho/adonis-media/pull/10) [`afdc1f4`](https://github.com/DavideCarvalho/adonis-media/commit/afdc1f4ec0b46d5b8ed29e3e586e443dd28d940d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Configurable delivery, and `acceptsMimeTypes` now validates the real file content

  **Configurable delivery (`delivery`).** The library had a configurable strategy for writes (`uploads.mode`) but nothing for reads, so every consuming app re-derived the same decision by hand — and on a private bucket whose storage isn't internet-reachable, hand-rolled its own streaming route. New `delivery: { mode, signedTtlSeconds }` config (`'auto' | 'public' | 'signed' | 'proxy'`, default `auto`) plus `MediaLibrary.deliver(id, options?)`, returning a discriminated union: `{ kind: 'redirect', url }` for `public`/`signed`, `{ kind: 'stream', stream, mimeType, size, fileName }` for `proxy`.

  `MediaDeliveryHandler` is the framework-agnostic route half, mirroring `TusUploadHandler`: your app mounts one route with its own middleware and delegates. Like `TusUploadHandler`, **it performs no authorization** — guard the route before calling `handle`, which is also why the provider mounts no delivery route of its own.

  `auto` resolves by asking the disk for the object's visibility (`Disk.getVisibility`, optional and implemented by every Drive disk): public ⇒ `public`, otherwise ⇒ `signed`. A disk that can't answer falls back to `signed`. The bundled `disks.s3()` gained a declarative `visibility` option (default `private`) to answer it without an ACL round-trip.

  **Real content validation.** A collection's `acceptsMimeTypes` used to check the caller-declared `mimeType` — which the app itself writes, routinely hardcoded — so it validated nothing about the bytes. It now also detects the type from the file's magic-byte signature and rejects content that contradicts the declaration, with a new `ContentTypeMismatchError` (`E_MEDIA_CONTENT_TYPE_MISMATCH`). Content with no recognisable signature (SVG, CSV, text, office formats) falls back to the declared type rather than being rejected.

  Only the first 16 bytes are read, never the whole file: `attach` peeks the head and replays it in front of the rest, so a `Readable` payload stays streaming, and `attachExisting` does a short disk read that is torn down immediately — adopting a large object in place still never downloads it. The signature table (PNG, JPEG, GIF, WEBP, PDF) is embedded; no new dependency.

## 0.6.0

### Minor Changes

- [#8](https://github.com/DavideCarvalho/adonis-media/pull/8) [`5ffebf8`](https://github.com/DavideCarvalho/adonis-media/commit/5ffebf8173a5aa69a83eb13675927da2107fa323) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Bridge already-stored objects into the media library without copying their bytes.

  - `MediaLibrary.attachExisting({ ownerType, ownerId, collection, key, disk?, fileName, mimeType, size?, ... })` registers an object that already exists on a disk as a `MediaRecord` — zero-copy: the bytes are never downloaded or rewritten, and `size` is resolved from the object's metadata when omitted. Everything after storage matches `attach()` (collection resolution, `acceptsMimeTypes`, `single: true` atomic replace, ordering, eager conversions, `attach` diagnostics), which both paths now share. A missing key throws the new `MediaObjectMissingError`. Opt into `moveIntoLayout: true` to relocate the object into the library's key layout via the disk's native server-side move (`ExtendedDisk`, e.g. `disks.s3()`); it never streams bytes through the app to emulate one.
  - `MediaManager.completeUploadToLibrary(sessionId, input)` finishes a resumable (TUS) session and attaches the assembled object in one step. `resumable.complete()` is unchanged and remains the raw primitive.
  - `MediaLibrary.for(...)` bindings expose `attachExisting` alongside `attach`.

## 0.5.0

### Minor Changes

- [#6](https://github.com/DavideCarvalho/adonis-media/pull/6) [`256a11e`](https://github.com/DavideCarvalho/adonis-media/commit/256a11e034118435b2c29a1b7ac7c0c6c05ac5b6) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add the `@adonis-agora/media/single-file` helper (`storeSingleFile` / `removeSingleFile` / `isSingleFileStoreAvailable`) for storing exactly one file per owner through a `single: true` collection, returning the stable public URL (plus an optional `thumb` conversion URL). Lets other packages delegate single-file uploads such as avatars to media without taking a hard dependency on it.

## 0.4.0

### Minor Changes

- Parity sync from nestjs-media: harden S3 GetObject streams against connection death (no more permanent hang), caller-supplied deterministic `id` on `attach` for idempotent overwrites, lazy `stubsRoot` (importing the package is side-effect-free), and a media-specific Telescope watcher recording richer per-operation entries + claiming its channels.

## 0.3.2

### Patch Changes

- [`e6cbb1a`](https://github.com/DavideCarvalho/adonis-media/commit/e6cbb1aca6c30a203dd2949e825b9ed79309dd5a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `attach` numa collection `single` não destrói mais a mídia anterior quando uma conversion eager falha.

  A ordem era: grava bytes → salva registro → **apaga a anterior** → gera as conversions eager. O
  docblock do próprio método prometia o contrário ("a failed write leaves the old media intact"), mas
  a conversion rodava depois do delete. Um upload que o processador não consegue decodificar — um PNG
  truncado, por exemplo — apagava a mídia antiga e então lançava, e como o chamador nunca chegava a
  persistir o id novo, o dono ficava **sem nada**.

  As conversions eager agora rodam antes do delete, e uma falha nelas reverte a mídia nova inteira
  (bytes, conversions já escritas e a linha), deixando a anterior de pé.

## 0.3.1

### Patch Changes

- [`e019163`](https://github.com/DavideCarvalho/adonis-media/commit/e019163ae2c1d35c0fed48352c6cfa3ae04f246b) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Conserta o `node ace configure @adonis-agora/media`, que nunca funcionou em nenhuma versão.

  Dois bugs independentes, os dois provados contra o compilador real:

  - **O hook não era alcançável.** O `configure.ts` existia e o `package.json` exportava
    `./configure`, mas o ace chega no hook pelo entry point principal — e o `src/index.ts` não o
    reexportava. `import('@adonis-agora/media').configure` era `undefined`.
  - **Nenhum stub renderizava.** O tempura trata crase como início de template literal, inclusive
    dentro de comentário. Os 3 stubs usavam crase no docblock e morriam com `Unexpected identifier`
    antes de gerar qualquer arquivo. As crases dos comentários viraram aspas simples; os template
    literals de verdade do código do stub continuam intactos.

  Nada no build pegava isso: stub é dado, o tsc nunca o compila, e nenhum teste os tocava. Agora
  um teste renderiza todo stub pelo tempura e afirma que o index reexporta o `configure`.

## 0.3.0

### Minor Changes

- [`aa73ece`](https://github.com/DavideCarvalho/adonis-media/commit/aa73ecef27a829287fdf18597f66afa20b7d7e5a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `signedUrl` agora aceita as opções de resposta do disk (`contentDisposition`, `contentType`).

  **Breaking:** o 3º parâmetro posicional virou um objeto de opções.

  - `library.signedUrl(id, '1h', 'thumbnail')` → `library.signedUrl(id, '1h', { conversion: 'thumbnail' })`
  - `attachments.signedUrl(att, '1h', 'thumb')` → `attachments.signedUrl(att, '1h', { variant: 'thumb' })`

  Forçar download com um nome de arquivo (`attachment; filename="..."`) é o caso canônico de URL
  assinada e não tinha como ser expresso pela library — só pelo disk, o que obrigava o chamador a
  conhecer disk e path.

## 0.2.1

### Patch Changes

- [`00b6ed9`](https://github.com/DavideCarvalho/adonis-media/commit/00b6ed976c5afb43c93f91be939611b8a371914a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix: streaming a file to an S3 disk always failed

  The streaming fast-path (a `Readable` with a known size and no conversions, added in 0.2.0)
  never worked against real S3 — every write threw:

  ```
  Invalid value "undefined" for header "x-amz-decoded-content-length"
  ```

  S3 cannot size a stream, so it needs `ContentLength` up front, and `S3Disk.putStream` never
  sent it. `MediaLibrary.attach` and `AttachmentManager.createFromFile` made it worse: both
  _gate_ the fast-path on `input.size` being known and then dropped that size instead of
  passing it to the disk. So the one path that had the size threw it away, and the buffered
  path (which doesn't need it) is the only one that worked.

  `DiskWriteOptions` gains `contentLength`; both call sites forward the size that made them
  eligible; `S3Disk.putStream` sends it as `ContentLength` and throws a named error up front
  when it is missing, instead of failing deep inside the AWS SDK's header layer.

  If you implement a custom `Disk`, `putStream` now receives `contentLength` in its options.
  Ignoring it stays valid for disks that can size their own payload.

  Why the tests missed it: `s3_disk.spec.ts` asserted with `aws-sdk-client-mock`, which
  intercepts the command _before_ the SDK's header middleware runs, so the mocked call
  happily accepted a payload the real SDK rejects. The library/attachment tests use the
  in-memory disk, which holds the bytes and never needs the declaration. Both now assert the
  size reaches the disk, and the in-memory disk records the `contentLength` it was handed —
  but the bug was only ever visible against a live S3/MinIO.

## 0.2.0

### Minor Changes

- [`803e1b7`](https://github.com/DavideCarvalho/adonis-media/commit/803e1b719fefd47349518e32900a72c56927add8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - S3 disk, direct/resumable uploads, cross-owner listing, Telescope, and fail-fast store resolution

  **Storage**

  - `disks.s3({ bucket, region?, credentials?, endpoint?, forcePathStyle?, keyPrefix?, publicBaseUrl? })`
    — an S3 disk with the extended operations the library needs. The AWS SDK is an
    optional peer, imported lazily only when this disk is selected. `endpoint` +
    `forcePathStyle` make it work against MinIO and R2, not just AWS.
  - `services/main` — an idiomatic singleton import (`import media from
'@adonis-agora/media/services/main'`).

  **Uploads**

  - Direct-to-S3 multipart, in `proxy` and `direct` modes, via
    `uploads: { mode, partSize, presignTtlSeconds }` and the
    `initiateDirectUpload` / `completeDirectUpload` / `abortDirectUpload` / `proxyUpload`
    methods on the manager.
  - Resumable uploads over the TUS protocol (`uploads.resumable`), with an in-memory or
    Lucid session store (`upload_sessions/lucid`).
  - Built-in routes for both are **opt-in** (`routes.enabled`, default `false`) and take the
    object key from the request. They are a development convenience: in a real app leave them
    off and mount your own routes over the manager methods, resolving the key server-side per
    user/tenant so a client cannot point an upload at someone else's object.

  **Reads**

  - `media.store.list(options)` — cursor-paginated cross-owner listing (newest first,
    default page 50, max 200), for admin/collection views. Owner-scoped reads stay on
    `media.library`.
  - `./telescope` — a Telescope watcher extension (optional peer).

  **Robustness** — these change behavior:

  - Naming a `store` that has no matching factory now **throws** `StoreNotConfiguredError`
    instead of silently falling back to the in-memory store. The old fallback looked fine and
    then lost every record on restart. Only the zero-config path (no `store` at all) still
    resolves to memory.
  - The Lucid store writes via an atomic `insert().onConflict('id').merge()` upsert instead of
    read-then-branch.
  - `ownerId` accepts `string | number` on `attach`/`list`, coerced internally — no more
    `String(post.id)` at the call site.
  - A failed store write now best-effort deletes the object it just wrote, instead of leaving
    an orphan on the disk. Single-file collections delete the previous media only _after_ the
    new record commits, so a failed write keeps the old file.
  - A `Readable` with a known `size` and no conversions streams through `putStream` rather than
    buffering the whole file in memory.
  - Typed `VariantNotFoundError` / `StoreNotConfiguredError` replace bare `Error`s.
  - Dropped the internal `publishMedia` export and the empty `MemoryStoreConfig` type.
