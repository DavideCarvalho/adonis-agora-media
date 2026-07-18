# @adonis-agora/media

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
