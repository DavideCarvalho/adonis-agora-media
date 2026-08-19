# adonis-media

Media-library for **AdonisJS**, part of the [Agora](https://github.com/DavideCarvalho) ecosystem — the
spatie/laravel-media-library feel, on top of [`@adonisjs/drive`](https://github.com/adonisjs/drive).

Attach files to entities, organize them into collections (MIME whitelist, single-file replace,
ordering), and generate image conversions (eager or lazy) — plus **content transformers**, the same
seam driven beyond images: the bundled `transformers.hls()` packages a video into an HLS ladder and
`transformers.probe()` records duration/codecs as metadata, both persisted into the same
`record.conversions` map. Storage is delegated entirely to Drive, so you reuse your existing
`local` / `s3` / `gcs` disks — this package never reimplements disk drivers.

## Packages

| Package | Role |
|---|---|
| [`@adonis-agora/media`](./packages/adonis) | The core library: `MediaLibrary`, `AttachmentManager`, `MediaStore` SPI (in-memory + Lucid), `ImageProcessor` SPI (sharp), the `Transformer` SPI (HLS video + metadata probe), the bundled `disks.s3()` driver, proxy/direct/resumable uploads, configurable delivery, the embedded management console, provider + `defineConfig`, testing kit |
| [`@adonis-agora/media-react`](./packages/react) | Browser upload client: `useMediaUpload`, `MediaUploader`, framework-free `createMediaUploadClient` (TUS / direct-S3 / proxy) |
| [`@adonis-agora/media-dashboard`](./packages/dashboard) | Management console (React SPA): browse buckets, watch resumable uploads, copy/move/delete objects. **Ships embedded in `@adonis-agora/media`** (`./dashboard_provider`) — this package is now the SPA's build-time source + a standalone install for hosts that prefer it |

The core package uses **subpath exports** (the Agora idiom), so heavy backends stay optional:

| Subpath | What |
|---|---|
| `@adonis-agora/media` | barrel — `defineConfig`, `stores`, `processors`, `disks`, `uploadSessions`, `MediaManager`, `MediaLibrary`, `AttachmentManager`, `UploadManager`, `ResumableUploadManager`, `MediaDeliveryHandler`, SPIs, errors |
| `@adonis-agora/media/services/main` | the app-bound `MediaManager` singleton — `import media from '@adonis-agora/media/services/main'`, importable at any time (it resolves lazily on first use) |
| `@adonis-agora/media/media_provider` | the service provider (binds `MediaManager`, mounts optional upload/TUS routes) |
| `@adonis-agora/media/dashboard_provider` | the embedded management-console provider (React SPA + JSON API) |
| `@adonis-agora/media/dashboard` | `defineConfig` + types for `config/media_dashboard.ts`, `DashboardService`, session-auth helpers, `ObjectInsightProvider` |
| `@adonis-agora/media/configure` | `node ace configure` hook |
| `@adonis-agora/media/single-file` | `storeSingleFile` / `removeSingleFile` / `storeSingleFileWith` / `removeSingleFileWith` / `isSingleFileStoreAvailable` — lets other packages delegate single-file uploads (e.g. avatars) to media without a hard dependency |
| `@adonis-agora/media/stores/lucid` | the Lucid `MediaStore` (`@adonisjs/lucid` peer) |
| `@adonis-agora/media/upload_sessions/lucid` | the Lucid resumable `UploadSessionStore` (`@adonisjs/lucid` peer) |
| `@adonis-agora/media/disks/s3` | the bundled `S3Disk` (`@aws-sdk/client-s3` peer; presigning is hand-rolled SigV4) |
| `@adonis-agora/media/processors/sharp` | the sharp `ImageProcessor` (`sharp` peer) |
| `@adonis-agora/media/telescope` | `mediaTelescopeExtension` (`@adonis-agora/telescope` optional peer) |
| `@adonis-agora/media/testing` | `InMemoryMediaStore`, `InMemoryDisk`, `inMemoryDiskResolver`, `FakeImageProcessor`, `InMemoryUploadSessionStore` |
| `@adonis-agora/media/types` | the structural `Disk` / `DiskResolver` / `ExtendedDisk` / `MultipartUploadDisk` contracts |

## Install

```sh
node ace add @adonisjs/drive   # storage backend (required)
npm i @adonis-agora/media
node ace configure @adonis-agora/media
```

`configure` registers **both** providers (the library and the embedded console), publishes
`config/media.ts` and `config/media_dashboard.ts`, and publishes **two** migrations — the `media`
table for the `lucid` store and the session table for the `lucid` upload-session store. Delete the
ones you don't need (the in-memory equivalents need no table); otherwise `node ace migration:run`.

Optional peers, loaded lazily only when selected: `@adonisjs/lucid` (the `lucid` store) and `sharp`
(image conversions).

## Configure

```ts
// config/media.ts
import { defineConfig, stores, processors } from '@adonis-agora/media'

export default defineConfig({
  // disk: 's3',                 // omit to use Drive's default disk
  store: 'lucid',
  stores: {
    memory: stores.memory(),
    lucid: stores.lucid({ connection: 'pg' }),
  },
  imageProcessor: processors.sharp(),
  collections: [
    { name: 'avatar', single: true, acceptsMimeTypes: ['image/png', 'image/jpeg'] },
    {
      name: 'gallery',
      conversions: [
        { name: 'thumb', width: 200, height: 200 },
        { name: 'og', width: 1200, eager: true },
      ],
    },
  ],
})
```

## Use

The provider binds a singleton `MediaManager`; reach it with the service import (or `@inject()` it).
A real upload controller loads the owner, validates the file, and streams its tmp bytes into a
collection:

```ts
// app/controllers/post_images_controller.ts
import { createReadStream } from 'node:fs'
import Post from '#models/post'
import media from '@adonis-agora/media/services/main'
import type { HttpContext } from '@adonisjs/core/http'

export default class PostImagesController {
  async store({ request, response, params }: HttpContext) {
    const post = await Post.findOrFail(params.id)

    const image = request.file('image', { size: '5mb', extnames: ['jpg', 'png', 'webp'] })
    if (!image) return response.badRequest({ error: 'An "image" file is required' })

    const record = await media.library.attach({
      ownerType: 'Post',
      ownerId: post.id, // string | number — coerced for you
      collection: 'gallery',
      fileName: image.clientName,
      mimeType: image.type!,
      contents: createReadStream(image.tmpPath!), // Buffer | Readable
    })

    return response.created({ id: record.id, url: await media.library.url(record.id) })
  }
}
```

Reading, listing and deleting go through the same `media` singleton:

```ts
await media.library.url(record.id)            // public url of the original
await media.library.url(record.id, 'thumb')   // generated lazily on first call, then cached
await media.library.list('Post', post.id, 'gallery')
await media.library.delete(record.id)

// Or bind an owner once for a bulk upload
const gallery = media.library.for('Post', post.id)
await gallery.attach({ collection: 'gallery', fileName: image.clientName, mimeType: image.type!, contents })

// Column attachments (adonis-attachment style) — store the value object on a JSON column
const att = await media.attachments.createFromFile(
  { fileName: image.clientName, mimeType: image.type!, contents },
  { variants: [{ name: 'thumb', width: 100 }] },
)
user.avatarData = att.toJSON()
await media.attachments.url(att, 'thumb')
```

### Image conversions

A `ConversionPreset` is `{ name, width?, height?, fit?, format?, quality?, eager? }`. Eager presets are
generated synchronously on `attach`; the rest are generated lazily on the first `url(id, name)` and
cached on the record. `fit` and `format` map straight onto sharp.

## Diagnostics

All nine lifecycle events — `attach`, `delete`, `conversion`, `attachment.create`,
`attachment.delete`, `upload.start`, `upload.progress`, `upload.complete`, `upload.abort` — are
emitted on the `agora:media:*` channel via the `@agora/diagnostics:emit` global slot — read
structurally, with **no hard dependency** on `@adonis-agora/diagnostics`. When that package isn't
installed, emitting is an inert no-op; when it is, the Telescope generic watcher captures every media
event automatically.

## Testing

`@adonis-agora/media/testing` ships in-memory doubles for the SPIs so you can exercise the library
without a disk, database, or sharp:

```ts
import { MediaLibrary, StorageManager } from '@adonis-agora/media'
import { InMemoryMediaStore, inMemoryDiskResolver, FakeImageProcessor } from '@adonis-agora/media/testing'

const { resolve, disks } = inMemoryDiskResolver(['fs'])
const library = new MediaLibrary({
  storage: new StorageManager({ default: 'fs', resolve }),
  store: new InMemoryMediaStore(),
  imageProcessor: new FakeImageProcessor(),
})
```

In a real app you can also `drive.fake()` from `@adonisjs/drive` to back the disks with an in-memory
fake while keeping the rest of the wiring intact.

## Uploads, S3 and the dashboard

Large-file uploads ship in three flavours — **proxy** (bytes stream through your app), **direct-S3
multipart** (the browser uploads straight to the bucket via presigned part URLs), and **resumable
[tus](https://tus.io)** sessions (pluggable in-memory + Lucid session stores). Opt in under `uploads`
in `config/media.ts`; the provider mounts the routes under `/media/uploads` and `/media/uploads/tus`.
The bundled `disks.s3()` driver adds extended operations (copy/move/deleteMany/list/size/stat) and
native multipart over the optional AWS SDK peer. Drive it from the browser with
[`@adonis-agora/media-react`](./packages/react), and manage it all from the dashboard — embedded in
`@adonis-agora/media` (`node ace configure` wires it up for free), with
[`@adonis-agora/media-dashboard`](./packages/dashboard) as its standalone/advanced install.

## Roadmap (deferred)

These seams exist in the SPIs but are intentionally **not built** yet:

- Additional `MediaStore` drivers (document / Redis).
- Video/PDF thumbnail conversions, responsive `srcset`, and an antivirus/scanning hook in `attach`.
- A first-party collection reordering API (ordering is append-only today).

## Develop

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## License

MIT
