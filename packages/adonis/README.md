# @adonis-agora/media

Media-library for **AdonisJS**, part of the [Agora](https://github.com/DavideCarvalho) ecosystem — the
spatie/laravel-media-library feel, on top of [`@adonisjs/drive`](https://github.com/adonisjs/drive).

Attach files to entities, organize them into collections (MIME whitelist, single-file replace,
ordering), and generate image conversions (eager or lazy). Storage is delegated entirely to Drive, so
you reuse your existing `local` / `s3` / `gcs` disks — this package never reimplements disk drivers.

This is the **core library**: `MediaLibrary`, `AttachmentManager`, the `MediaStore` SPI (in-memory +
Lucid), the `ImageProcessor` SPI (sharp), the bundled `disks.s3()` driver, proxy/direct/resumable
uploads, configurable delivery, the provider + `defineConfig`, and a testing kit. Pair it with
[`@adonis-agora/media-react`](https://github.com/DavideCarvalho/adonis-media/tree/master/packages/react)
for a browser upload client, or
[`@adonis-agora/media-dashboard`](https://github.com/DavideCarvalho/adonis-media/tree/master/packages/dashboard)
for a management console.

## Subpath exports

The package uses **subpath exports** (the Agora idiom), so heavy backends stay optional:

| Subpath | What |
|---|---|
| `@adonis-agora/media` | barrel — `defineConfig`, `stores`, `processors`, `disks`, `uploadSessions`, `MediaManager`, `MediaLibrary`, `AttachmentManager`, `UploadManager`, `ResumableUploadManager`, `MediaDeliveryHandler`, SPIs, errors |
| `@adonis-agora/media/media_provider` | the service provider (binds `MediaManager`, mounts optional upload/TUS routes) |
| `@adonis-agora/media/configure` | `node ace configure` hook |
| `@adonis-agora/media/single-file` | `storeSingleFile` / `removeSingleFile` / `isSingleFileStoreAvailable` — lets other packages delegate single-file uploads (e.g. avatars) to media without a hard dependency |
| `@adonis-agora/media/stores/lucid` | the Lucid `MediaStore` (`@adonisjs/lucid` peer) |
| `@adonis-agora/media/upload_sessions/lucid` | the Lucid resumable `UploadSessionStore` (`@adonisjs/lucid` peer) |
| `@adonis-agora/media/disks/s3` | the bundled `S3Disk` (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` peers) |
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

`configure` registers the provider, publishes `config/media.ts`, and publishes the `media` table
migration (delete it if you only use the in-memory store; otherwise `node ace migration:run`).

Optional peers, loaded lazily only when selected:

- `@adonisjs/lucid` (`^22.4.0`) — the `lucid` `MediaStore` / `UploadSessionStore`
- `sharp` (`^0.33.0`) — image conversions
- `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (`^3.0.0`) — the bundled `disks.s3()` driver
- `@adonis-agora/telescope` (`^0.4.0`) — the Telescope watcher extension

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

A `ConversionPreset` is `{ name, width?, height?, fit?, format?, quality?, eager? }`. Eager presets are
generated synchronously on `attach`; the rest are generated lazily on the first `url(id, name)` and
cached on the record. `fit` and `format` map straight onto sharp.

## Uploads, S3 and delivery

Large-file uploads ship in three flavours — **proxy** (bytes stream through your app), **direct-S3
multipart** (the browser uploads straight to the bucket via presigned part URLs), and **resumable
[tus](https://tus.io)** sessions (pluggable in-memory + Lucid session stores). Opt in under `uploads`
in `config/media.ts`; the provider mounts the routes under `/media/uploads` and `/media/uploads/tus`.

```ts
export default defineConfig({
  // ...
  uploads: {
    mode: 'auto', // 'direct' | 'proxy' | 'auto'
    routes: { enabled: true },
    resumable: { routes: { enabled: true } },
  },
  delivery: { mode: 'auto' }, // 'public' | 'signed' | 'proxy' | 'auto'
})
```

`delivery` is the read-side counterpart to `uploads.mode`: `MediaLibrary.deliver(id, options?)`
resolves to a discriminated union — `{ kind: 'redirect', url }` for `public`/`signed`, or
`{ kind: 'stream', stream, mimeType, size, fileName }` for `proxy` — so a private bucket doesn't need
a hand-rolled streaming route. `MediaDeliveryHandler` and `TusUploadHandler` are the framework-agnostic
route halves your app mounts with its own middleware; **neither performs authorization** — guard the
route before calling `handle`.

The bundled `disks.s3()` driver adds extended operations (copy/move/deleteMany/list/size/stat) and
native multipart over the optional AWS SDK peer. Drive it from the browser with
[`@adonis-agora/media-react`](https://github.com/DavideCarvalho/adonis-media/tree/master/packages/react).

## Diagnostics

Lifecycle events (`attach`, `delete`, `conversion`, `attachment.create`, `attachment.delete`) are
emitted on the `agora:media:*` channel via the `@agora/diagnostics:emit` global slot — read
structurally, with **no hard dependency** on `@adonis-agora/diagnostics`. When that package isn't
installed, emitting is an inert no-op; when it is, the Telescope generic watcher (or
`@adonis-agora/media/telescope`) captures every media event automatically.

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

## Links

- Repo: https://github.com/DavideCarvalho/adonis-media
- Changelog: https://github.com/DavideCarvalho/adonis-media/blob/master/packages/adonis/CHANGELOG.md
- Sibling packages: [`@adonis-agora/media-react`](https://github.com/DavideCarvalho/adonis-media/tree/master/packages/react), [`@adonis-agora/media-dashboard`](https://github.com/DavideCarvalho/adonis-media/tree/master/packages/dashboard)

## License

MIT
