---
name: media-stores-delivery
description: >-
  Pluggable storage seams and delivery in @adonis-agora/media — the MediaStore SPI
  (stores.memory / stores.lucid with the published migration, custom stores via
  StoreFactory, cross-owner keyset list() with encodeMediaCursor/clampMediaListLimit),
  the ImageProcessor SPI (processors.sharp, custom processors), the structural Disk
  contract (putStream, getVisibility), createDriveBackedResolver (module namespace,
  not default export), the bundled disks.s3() with extended operations
  (copy/move/deleteMany/list/size/stat) and declarative visibility, presignS3Url,
  delivery.mode auto|public|signed|proxy, MediaDeliveryHandler and HlsDeliveryHandler
  route mounting, and the @adonis-agora/media/testing doubles. Use when choosing or
  writing a store, wiring S3, serving media, signing URLs, or testing without disks.
license: MIT
metadata:
  type: core
  library: "@adonis-agora/media"
  library_version: "0.12.1"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-media:docs/stores-and-processors.mdx"
  - "DavideCarvalho/adonis-media:docs/storage/s3-disk.mdx"
  - "DavideCarvalho/adonis-media:docs/delivery.mdx"
  - "DavideCarvalho/adonis-media:docs/testing.mdx"
  - "DavideCarvalho/adonis-media:packages/adonis/src/disks/drive.ts"
---

# Storage seams & delivery

The library delegates everything heavy to three pluggable seams — the `MediaStore`
(metadata persistence), the `ImageProcessor` (conversions), and a structural `Disk`
contract that real `@adonisjs/drive` disks satisfy directly. `delivery` is the mirror-image
strategy for **reads**.

## Setup

```ts title="config/media.ts"
import { defineConfig, stores, processors, disks } from '@adonis-agora/media'

export default defineConfig({
  disk: 's3',
  disks: { s3: disks.s3({ bucket: 'my-bucket', region: 'us-east-1' }) },
  store: 'lucid',
  stores: { lucid: stores.lucid({ connection: 'pg', table: 'media' }) },
  imageProcessor: processors.sharp(),
  delivery: { mode: 'auto', signedTtlSeconds: 300 },
})
```

```sh
node ace migration:run   # publishes the media table for stores.lucid()
npm i @aws-sdk/client-s3 # optional peer, imported only because s3 is selected
```

Source: `docs/configuration.mdx`, `docs/stores-and-processors.mdx`.

## Core patterns

### Pattern 1 — the cross-owner `MediaStore.list` read

`listByOwner` answers "what has this entity got"; `list` answers "everything, paginated,
newest first" — the read the dashboard's Collections view is built on:

```ts
import media from '@adonis-agora/media/services/main'

const page = await media.store.list({
  collection: 'gallery',
  ownerType: 'Post',
  prefix: 'Post/42/',
  limit: 50, // default 50, clamped to 200
})

page.items      // ordered createdAt desc, then id desc (stable keyset under writes)
page.nextCursor // opaque string, or null on the last page
```

Ordering is a stable keyset so paging stays consistent while rows are written underneath.
`encodeMediaCursor` / `decodeMediaCursor` / `clampMediaListLimit` and the
`DEFAULT_MEDIA_LIST_LIMIT` / `MAX_MEDIA_LIST_LIMIT` constants are exported for implementers.

Source: `docs/dashboard/collections.mdx`, `docs/stores-and-processors.mdx`.

### Pattern 2 — wire a custom store or processor

Both seams are tiny interfaces; wire them through a factory thunk so any peer loads lazily:

```ts
import { defineConfig } from '@adonis-agora/media'
import type { ImageProcessor, MediaStore, StoreFactory } from '@adonis-agora/media'

class RedisMediaStore implements MediaStore { /* save/find/listByOwner/list/delete/nextOrder */ }
class PassthroughProcessor implements ImageProcessor {
  async convert(input: Buffer, preset) {
    return { data: input, format: preset.format ?? 'webp', contentType: 'image/webp' }
  }
}

defineConfig({
  store: 'redis',
  stores: {
    redis: (() => async () => new RedisMediaStore()) as unknown as StoreFactory,
  },
  imageProcessor: new PassthroughProcessor(), // or a factory thunk
})
```

A `StoreFactory` receives the booted app as `StoreContext`, so a driver can resolve a peer's
service when it builds.

Source: `docs/stores-and-processors.mdx` (Writing your own store / processor).

### Pattern 3 — the bundled S3 disk and its extended operations

`disks.s3()` implements the base `Disk` contract plus `ExtendedDisk` (detected structurally
with `isExtendedDisk`) and `MultipartUploadDisk` (`isMultipartCapable`):

```ts
const s3 = media.disk('s3')

if (isExtendedDisk(s3)) {
  await s3.copy('a/photo.jpg', 'b/photo.jpg', { toBucket: 'archive' })
  await s3.deleteMany(['a/1.jpg', 'a/2.jpg'])
  await s3.stat('a/photo.jpg') // { size, contentType?, lastModified? }
  const page = await s3.list('uploads/', { delimiter: '/', limit: 100 })
  page.folders // sub-prefixes from CommonPrefixes
}
```

Key options: `endpoint` + `forcePathStyle` for MinIO/R2/Spaces, `publicEndpoint` for the
host presigned URLs are signed against (the browser's endpoint), `publicBaseUrl` for stable
`getUrl()` output, and `visibility: 'public' | 'private'` (default `private`) — declarative,
read by `delivery.mode: 'auto'`, never applied as an ACL and never probed.

Source: `docs/storage/s3-disk.mdx`.

### Pattern 4 — serve media through a delivery route you own

`delivery.mode` (`auto` default) decides what `deliver()` returns: `public`/`signed` yield
`{ kind: 'redirect', url }`; `proxy` yields `{ kind: 'stream', stream, mimeType, size,
fileName }`. `auto` asks the disk's `getVisibility` — public ⇒ public, private ⇒ signed,
unknown ⇒ signed. `MediaDeliveryHandler` is framework-agnostic: YOU mount the route behind
YOUR auth:

```ts title="start/routes.ts"
import { MediaDeliveryHandler, MediaManager } from '@adonis-agora/media'

const media = await app.container.make(MediaManager)
const delivery = new MediaDeliveryHandler({ library: media })

router.get('/media/:id', async ({ params, request, response, auth }) => {
  await authorizeMediaAccess(auth.user, params.id) // ← your rule, before handle()

  const result = await delivery.handle({ mediaId: params.id, conversion: request.input('conversion') })
  if (result.kind === 'redirect') return response.redirect(result.url)

  response.header('content-type', result.mimeType)
  if (result.size !== undefined) response.header('content-length', String(result.size))
  response.header('content-disposition', `inline; filename="${result.fileName}"`)
  return response.stream(result.stream)
}).use(middleware.auth())
```

The handler's own `mode` / `signedTtlSeconds` override the configured ones per call. For
transformer-generated HLS packages use `HlsDeliveryHandler` — playlists are rewritten per
request, segment files are validated against the persisted artifact list (no caller input
ever reaches the disk as a path).

Source: `docs/delivery.mdx`, `docs/transformers.mdx` (Serving HLS).

## Common mistakes

### [CRITICAL] Passing the drive service default export instead of the module namespace

Wrong:

```ts
import driveService from '@adonisjs/drive/services/main' // captured default
const resolve = createDriveBackedResolver({ driveService, configuredDisks: {}, defaultDisk: 's3' })
```

Correct:

```ts
import * as driveService from '@adonisjs/drive/services/main' // the NAMESPACE
const resolve = createDriveBackedResolver({ driveService, configuredDisks: {}, defaultDisk: 's3' })
```

Mechanism: Drive's service module assigns its manager inside an `app.booted()` callback, so
at import time the default export is still `undefined` — a captured value stays `undefined`
forever (writes fail with `DriveNotReadyError`), while the namespace's ESM live binding
reflects the later assignment.
Source: `docs/stores-and-processors.mdx` (createDriveBackedResolver).

### [CRITICAL] Exposing a delivery route without authorization

Wrong:

```ts
router.get('/media/:id', async ({ params, response }) => {
  const result = await delivery.handle({ mediaId: params.id })
  if (result.kind === 'redirect') return response.redirect(result.url)
  return response.stream(result.stream)
}) // no middleware — every record is public to anyone who can guess an id
```

Correct:

```ts
router.get('/media/:id', async ({ params, request, response, auth }) => {
  await authorizeMediaAccess(auth.user, params.id)
  const result = await delivery.handle({ mediaId: params.id })
  /* ... */
}).use(middleware.auth())
```

Mechanism: `MediaDeliveryHandler` resolves a media id to bytes or a URL and performs NO
authorization — the same split as `TusUploadHandler`. This is also why the provider mounts
no delivery route of its own: there is no safe default.
Source: `docs/delivery.mdx` (error callout: The handler performs NO authorization).

### [HIGH] Relying on auto delivery for storage the browser cannot reach

Wrong:

```ts
disks.s3({ bucket: 'media', endpoint: 'http://minio.internal:9000' }) // internal host
// delivery auto signs URLs against the INTERNAL host → unresolvable in the browser
```

Correct:

```ts
disks.s3({
  bucket: 'media',
  endpoint: 'http://minio.internal:9000',       // server-side operations
  publicEndpoint: 'https://files.example.com',  // what presigned URLs are signed for
  forcePathStyle: true,
})
```

Mechanism: `auto` resolves to `signed` (never `proxy`) when visibility is unknown, and
SigV4 bakes the host into the signature — presigned URLs must be signed for the endpoint
the BROWSER reaches. Proxying is a deployment decision and must be opted into explicitly.
Source: `docs/delivery.mdx` (auto never picks proxy), `docs/storage/s3-disk.mdx` (publicEndpoint).

### [MEDIUM] Implementing a custom MediaStore without a working list()

Wrong:

```ts
class MyStore implements MediaStore {
  async list() { return { items: [], nextCursor: null } } // stubbed "for now"
  // save/find/listByOwner/delete/nextOrder implemented
}
```

Correct:

```ts
class MyStore implements MediaStore {
  async list(options?: MediaListOptions): Promise<MediaListPage> {
    // keyset page over { createdAt desc, id desc } with cursor + clamped limit
  }
}
```

Mechanism: nothing inside `attach`/`url`/`delete` calls `list()`, so a stubbed
implementation surfaces only later — the dashboard's Collections view renders empty and
admin tooling sees nothing. `list` is part of the `MediaStore` interface, not optional.
Source: `docs/stores-and-processors.mdx` (The MediaStore), `docs/dashboard/collections.mdx`.

### [MEDIUM] Setting s3 visibility public and expecting an ACL to be applied

Wrong:

```ts
disks.s3({ bucket: 'media', visibility: 'public' }) // expecting objects to become readable
// → 403s from the bucket: no bucket policy grants anonymous reads
```

Correct:

```ts
// make the bucket readable via its policy/CDN, THEN declare it:
disks.s3({ bucket: 'media', visibility: 'public', publicBaseUrl: 'https://cdn.example.com' })
```

Mechanism: `visibility` is declarative metadata read by `delivery.mode: 'auto'` — the disk
never applies an ACL and never probes the bucket, so the declaration must match reality the
infrastructure already enforces.
Source: `docs/storage/s3-disk.mdx` (visibility option, getVisibility).

## References

- Testing doubles for all three seams: use `@adonis-agora/media/testing` —
  `InMemoryMediaStore`, `inMemoryDiskResolver` (with a `DiskVisibility` argument to test
  `auto` delivery's unknown-visibility branch), `FakeImageProcessor`, `InMemoryUploadSessionStore`,
  `FakeTransformer`. See `docs/testing.mdx`.

See also: `media-dashboard-console/SKILL.md` — the console browses through these same
ExtendedDisk operations and `MediaStore.list`.
