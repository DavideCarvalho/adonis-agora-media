# @adonis-agora/media

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
