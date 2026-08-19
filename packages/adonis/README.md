# @adonis-agora/media

Media-library for **AdonisJS**, part of the [Agora](https://github.com/DavideCarvalho) ecosystem — the
spatie/laravel-media-library feel, on top of [`@adonisjs/drive`](https://github.com/adonisjs/drive).

Attach files to entities, organize them into collections (MIME whitelist, single-file replace,
ordering), and generate image conversions (eager or lazy) — plus **content transformers**, the same
seam driven beyond images: the bundled `transformers.hls()` packages a video into an HLS ladder and
`transformers.probe()` records duration/codecs as metadata, both persisted into the same
`record.conversions` map. Storage is delegated entirely to Drive, so you reuse your existing
`local` / `s3` / `gcs` disks — this package never reimplements disk drivers.

This is the **core library**: `MediaLibrary`, `AttachmentManager`, the `MediaStore` SPI (in-memory +
Lucid), the `ImageProcessor` SPI (sharp), the `Transformer` SPI (HLS video packaging + metadata
probe), the bundled `disks.s3()` driver, proxy/direct/resumable uploads, configurable delivery, the
provider + `defineConfig`, and a testing kit. The management
**console ships embedded** — registering `@adonis-agora/media/dashboard_provider` is all a consuming
app needs (see [Dashboard](#dashboard) below); no separate install. Pair it with
[`@adonis-agora/media-react`](https://github.com/DavideCarvalho/adonis-media/tree/master/packages/react)
for a browser upload client.

## Subpath exports

The package uses **subpath exports** (the Agora idiom), so heavy backends stay optional:

| Subpath | What |
|---|---|
| `@adonis-agora/media` | barrel — `defineConfig`, `stores`, `processors`, `disks`, `uploadSessions`, `MediaManager`, `MediaLibrary`, `AttachmentManager`, `UploadManager`, `ResumableUploadManager`, `MediaDeliveryHandler`, SPIs, errors |
| `@adonis-agora/media/services/main` | the app-bound `MediaManager` singleton — `import media from '@adonis-agora/media/services/main'`, importable at any time (it resolves lazily on first use) |
| `@adonis-agora/media/media_provider` | the service provider (binds `MediaManager`, mounts optional upload/TUS routes) |
| `@adonis-agora/media/dashboard_provider` | the embedded management-console provider (React SPA + JSON API) |
| `@adonis-agora/media/dashboard` | `defineConfig` + types for `config/media_dashboard.ts`, `DashboardService`, the session-auth helpers, `ObjectInsightProvider` |
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

`configure` registers the media provider **and the dashboard provider**, publishes `config/media.ts`
and `config/media_dashboard.ts`, and publishes **two** migrations — the `media` table for the `lucid`
store and the session table for the `lucid` upload-session store. Delete the ones you don't need (the
in-memory equivalents need no table); otherwise `node ace migration:run`. The management console is
live at `/media/dashboard` the moment your app boots — see [Dashboard](#dashboard).

Required peers: `@adonisjs/core` (`^7.3.0`) and `@adonisjs/drive` — **either major**, `^3.0.0` or
`^4.0.0`.

Optional peers, loaded lazily only when selected:

- `@adonisjs/lucid` (`^22.4.0`) — the `lucid` `MediaStore` / `UploadSessionStore`
- `sharp` (`^0.33.0`) — image conversions
- `@aws-sdk/client-s3` (`^3.0.0`) — the bundled `disks.s3()` driver (presigned URLs are hand-rolled SigV4, no presigner package)
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

## Transformers and HLS video

Image conversions answer "same image, different size". **Transformers** answer everything else:
*transform this content into that*. A transformer takes a stored media's bytes and produces many
files (an HLS package), one file (an extracted audio track), or none at all (a metadata probe) —
persisted into the same `record.conversions` map, so presets and transformers share one namespace
per collection.

Two ship with the package, both over the optional `mediabunny` peer (pure TypeScript — **no ffmpeg
binary**), imported lazily inside the first `transform()` call:

```ts
// config/media.ts
import { defineConfig, transformers } from '@adonis-agora/media'

export default defineConfig({
  collections: [
    {
      name: 'videos',
      acceptsMimeTypes: ['video/mp4'],
      transformers: [
        transformers.hls({ targetDuration: 4 }), // MPEG-TS segments behind a master playlist
        transformers.probe({ eager: true }),     // duration / resolution / codecs, no artifact
      ],
    },
  ],
})
```

Transformations are assumed heavy, so nothing runs on attach unless you mark it `eager`. Trigger one
from your own job — `transform(id, name)` is idempotent, so a retry skips straight through:

```ts
await media.library.transform(mediaId, 'hls')
```

Serving the result is `HlsDeliveryHandler`: playlists come back with every reference rewritten (each
sub-playlist hop through your own route, so your auth stays in the path), and segments as presigned
URLs or streamed bytes. Like every handler here it performs **no authorization** — you mount the
route and guard it. Writing your own transformer is one interface (`name` + `transform(context)`);
the context hands you the record, the original's bytes/stream, and a sandboxed `write()` that keys
every artifact under the conversion's own prefix.


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

## Dashboard

A management console — browse buckets, watch resumable uploads in progress, upload objects, and
copy/move/delete across buckets — ships **embedded** in this package: registering
`@adonis-agora/media/dashboard_provider` (done automatically by `node ace configure`) is all a
consuming app needs. No separate package install, no separate provider registration.

```ts
// adonisrc.ts
providers: [
  () => import('@adonis-agora/media/media_provider'),
  () => import('@adonis-agora/media/dashboard_provider'),
]
```

```ts
// config/media_dashboard.ts
import { defineConfig } from '@adonis-agora/media/dashboard'
import { middleware } from '#start/kernel'

export default defineConfig({
  basePath: '/media/dashboard',   // where the SPA mounts (default)
  actions: true,                  // enable copy/move/delete (default: false — read-only)
  disks: ['s3', 'backups'],       // browsable disks (default: derived from media config)
  middleware: middleware.auth(),  // gate the whole console — SPA + API
})
```

The console reads/writes through the real `@adonis-agora/media` surface (disk
`list`/`stat`/`copy`/`move`/`deleteMany`, the resumable session store, the `MediaStore`) — nothing
about storage is reimplemented. Full config reference, routes, and folder-operations semantics are
documented in [`@adonis-agora/media-dashboard`](https://github.com/DavideCarvalho/adonis-media/tree/master/packages/dashboard),
which is now the **build-time source** of the console's SPA bundle (embedded here at build time) and
remains installable **standalone** — its own provider is a thin delegate to this one, kept for hosts
that already register it directly. Don't register both providers in the same app.

## Diagnostics

All nine lifecycle events — `attach`, `delete`, `conversion`, `attachment.create`,
`attachment.delete`, `upload.start`, `upload.progress`, `upload.complete`, `upload.abort` — are
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
