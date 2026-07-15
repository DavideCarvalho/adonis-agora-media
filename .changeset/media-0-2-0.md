---
'@adonis-agora/media': minor
---

S3 disk, direct/resumable uploads, cross-owner listing, Telescope, and fail-fast store resolution

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
  an orphan on the disk. Single-file collections delete the previous media only *after* the
  new record commits, so a failed write keeps the old file.
- A `Readable` with a known `size` and no conversions streams through `putStream` rather than
  buffering the whole file in memory.
- Typed `VariantNotFoundError` / `StoreNotConfiguredError` replace bare `Error`s.
- Dropped the internal `publishMedia` export and the empty `MemoryStoreConfig` type.
