---
name: media-library-collections
description: >-
  Attach files to owner collections with @adonis-agora/media — media.library.attach /
  attachExisting / for(ownerType, ownerId), the MediaCollectionConfig policy layer
  (acceptsMimeTypes exact-match whitelist plus magic-byte signature verification,
  single:true atomic replace, append-only ordering, per-collection disk), eager vs lazy
  ConversionPresets (width/height/fit/format/quality, webp default), ensureConversion,
  url/signedUrl resolution, delete semantics, deterministic id retries, customProperties,
  and the MediaRecord.conversions map shared with transformers. Use when uploading files
  to entities, defining collections, generating thumbnails, or fixing
  MimeNotAllowedError / ConversionNotDefinedError / ImageProcessorMissingError /
  TransformNotReadyError.
license: MIT
metadata:
  type: core
  library: "@adonis-agora/media"
  library_version: "0.12.1"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-media:docs/getting-started.mdx"
  - "DavideCarvalho/adonis-media:docs/collections-and-conversions.mdx"
  - "DavideCarvalho/adonis-media:docs/transformers.mdx"
  - "DavideCarvalho/adonis-media:packages/adonis/src/media_library.ts"
---

# Media library: collections, policy, and conversions

`media.library` is the spatie/laravel-media-library shape: files belong to an owner
(`ownerType` + `ownerId`, both just stored strings — the library never loads your models)
inside named collections that carry the policy. Attach writes bytes to a Drive disk and a
metadata record to the configured `MediaStore`.

## Setup

```ts title="app/controllers/post_images_controller.ts"
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

The file lands at `${ownerType}/${ownerId}/${collection}/${id}/${fileName}` on the resolved
disk (per-call `disk` → collection `disk` → storage default). Eager conversions are
generated synchronously inside `attach`; lazy ones wait for the first `url(id, name)`.

Source: `docs/getting-started.mdx` (Step 3).

## Core patterns

### Pattern 1 — declare the collection policy in config

Collections are opt-in constraints: an undeclared collection is permissive (no whitelist,
not single, no conversions). Declare one to constrain it:

```ts title="config/media.ts"
defineConfig({
  collections: [
    { name: 'avatar', single: true, acceptsMimeTypes: ['image/png', 'image/jpeg'] },
    { name: 'invoices', disk: 'private-s3', acceptsMimeTypes: ['application/pdf'] },
    {
      name: 'gallery',
      conversions: [
        { name: 'thumb', width: 200, height: 200, fit: 'cover' },
        { name: 'card', width: 600, format: 'webp', quality: 80 },
        { name: 'og', width: 1200, height: 630, eager: true },
      ],
    },
  ],
})
```

`acceptsMimeTypes` is checked **before anything is written** (no orphan files on rejection)
and is an exact string match — list each type. When a whitelist is present the library also
verifies the file's magic-byte signature: a mismatch throws `ContentTypeMismatchError`, and
on a **closed** whitelist (every accepted type is signature-detectable, e.g.
`['application/pdf']`) unrecognizable bytes throw `ContentSignatureUnrecognizedError`. An
**open** whitelist (any type without a signature, e.g. `['application/pdf', 'image/svg+xml']`)
falls back to the declared type.

Source: `docs/collections-and-conversions.mdx`.

### Pattern 2 — eager vs lazy conversions

`ConversionPreset` maps straight onto sharp. `eager: true` generates synchronously on
`attach`; the default is lazy — generated on the **first** `url(id, name)` and then cached on
the record, so every later call is a pure lookup.

```ts
const m = await media.library.attach({ ...input, collection: 'gallery' })

await media.library.url(m.id, 'og')    // eager → already on disk, pure lookup
await media.library.url(m.id, 'thumb') // lazy → generated NOW, then cached
await media.library.ensureConversion(m.id, 'thumb') // force it ahead of time (idempotent)
```

Conversions are written under `conversions/` next to the original, recorded on
`record.conversions` keyed by preset name, and removed by `delete()` together with the
original. `format` defaults to `webp`; `fit` defaults to `cover`.

Source: `docs/collections-and-conversions.mdx` (Eager vs lazy).

### Pattern 3 — bind an owner once with `for()`, adopt existing objects with `attachExisting`

```ts
const gallery = media.library.for('Post', post.id)

for (const image of images) {
  await gallery.attach({ collection: 'gallery', fileName: image.clientName, mimeType: image.type!, contents })
}

// zero-copy adoption of an object ALREADY on the disk (finished TUS / direct upload):
await gallery.attachExisting({
  collection: 'gallery',
  key: 'uploads/9f2a/clip.mp4',
  fileName: 'clip.mp4',
  mimeType: 'video/mp4',
})
```

`attachExisting` never reads or rewrites bytes; the size comes from a disk HEAD when
omitted, and the collection's MIME + signature checks still run against a short head read.
Pass `moveIntoLayout: true` to relocate into the canonical layout using the disk's native
server-side move.

Source: `docs/getting-started.mdx` (Bind an owner once), `docs/uploads/resumable-tus.mdx`.

### Pattern 4 — deterministic `id` for retry-safe overwrites

```ts
await media.library.attach({
  ownerType: 'Invoice',
  ownerId: invoice.id,
  collection: 'pdf',
  id: `invoice-${invoice.id}`, // fixed key → retry-safe overwrite, no orphaned UUIDs
  fileName: 'invoice.pdf',
  mimeType: 'application/pdf',
  contents: renderedPdf,
})
```

The `id` is used verbatim as the record key and the storage-key segment — you own
uniqueness. Retries overwrite in place instead of minting a fresh UUID path.

Source: `docs/getting-started.mdx` (Idempotent overwrites).

## Common mistakes

### [CRITICAL] Assuming attach replaces an existing file without single:true

Wrong:

```ts
// 'avatar' declared WITHOUT single: true — each call appends another file
await media.library.attach({ ownerType: 'User', ownerId: '1', collection: 'avatar', ... }) // v1
await media.library.attach({ ownerType: 'User', ownerId: '1', collection: 'avatar', ... }) // v2
await media.library.list('User', '1', 'avatar') // [v1, v2] — "the avatar" is now a list
```

Correct:

```ts
// config/media.ts
defineConfig({ collections: [{ name: 'avatar', single: true, acceptsMimeTypes: ['image/png'] }] })
```

Mechanism: replacement is a property of the **collection**, not the call. `single: true`
deletes the previous file (original + conversions) only AFTER the new one is safely
persisted, so a failed upload leaves the old media intact; without it ordering is
append-only and every attach takes the next slot.
Source: `docs/collections-and-conversions.mdx` (Single-file collections), `docs/single-file.mdx` (warn callout).

### [HIGH] Using wildcard MIME types in acceptsMimeTypes

Wrong:

```ts
defineConfig({
  collections: [{ name: 'images', acceptsMimeTypes: ['image/*'] }],
})
```

Correct:

```ts
defineConfig({
  collections: [{ name: 'images', acceptsMimeTypes: ['image/png', 'image/jpeg', 'image/webp'] }],
})
```

Mechanism: the whitelist is an exact string match against the declared `mimeType` — there is
no wildcard expansion, so `'image/*'` matches nothing and every attach throws
`MimeNotAllowedError` (`E_MEDIA_MIME_NOT_ALLOWED`) before anything is written.
Source: `docs/collections-and-conversions.mdx` (MIME whitelist).

### [HIGH] Requesting conversions with no imageProcessor configured

Wrong:

```ts
defineConfig({
  collections: [{ name: 'gallery', conversions: [{ name: 'thumb', width: 200 }] }],
  // no imageProcessor
})
```

Correct:

```ts
import { defineConfig, processors } from '@adonis-agora/media'

defineConfig({
  imageProcessor: processors.sharp(),
  collections: [{ name: 'gallery', conversions: [{ name: 'thumb', width: 200 }] }],
})
```

Mechanism: `imageProcessor` is required only when conversions exist, but asking for one
without a configured processor throws `ImageProcessorMissingError`
(`E_MEDIA_IMAGE_PROCESSOR_MISSING`) instead of silently skipping.
Source: `docs/configuration.mdx` (`imageProcessor`), `docs/errors.mdx`.

### [CRITICAL] Reading url() on a transformer conversion expecting lazy generation

Wrong:

```ts
// 'videos' collection declares transformers.hls()
const url = await media.library.url(videoId, 'hls') // throws before any transform ran
```

Correct:

```ts
// run the transform explicitly (usually from a job), then read
await media.library.transform(videoId, 'hls') // idempotent — retries skip through
const record = await media.library.find(videoId)
record!.conversions.hls // { path, prefix, files, meta }
```

Mechanism: image presets generate lazily on first read, but reads NEVER generate transforms —
`url()`/`deliver()` throw `TransformNotReadyError` so a request never stalls behind a remux.
The split is deliberate.
Source: `docs/transformers.mdx` (Reads never generate a transform).

### [HIGH] Declaring conversion presets on a non-image collection

Wrong:

```ts
defineConfig({
  collections: [
    { name: 'videos', acceptsMimeTypes: ['video/mp4'], conversions: [{ name: 'thumb', width: 320 }] },
  ],
})
```

Correct:

```ts
import { defineConfig, transformers } from '@adonis-agora/media'

defineConfig({
  collections: [
    {
      name: 'videos',
      acceptsMimeTypes: ['video/mp4'],
      transformers: [transformers.probe({ eager: true })], // non-image derivations
    },
  ],
})
```

Mechanism: presets decode the original as an image through sharp; requesting one on a video
or PDF fails inside sharp. Transformers are the seam for everything beyond images and
persist into the same `record.conversions` namespace (name collisions throw
`TransformerConflictError` at boot).
Source: `docs/collections-and-conversions.mdx` (warn callout), `docs/transformers.mdx`.

### [HIGH] Trusting the declared mimeType as the real content type

Wrong:

```ts
// client renames payload.png → report.pdf and declares 'application/pdf'
await media.library.attach({
  ownerType: 'Patient', ownerId: '7', collection: 'exams',
  fileName: 'scan.pdf', mimeType: 'application/pdf', contents, // bytes are PNG
})
```

Correct:

```ts
try {
  await media.library.attach({ ownerType: 'Patient', ownerId: '7', collection: 'exams',
    fileName: 'scan.pdf', mimeType: 'application/pdf', contents })
} catch (error) {
  if (error instanceof ContentTypeMismatchError) {
    // error.declaredMimeType vs error.detectedMimeType — reject with a 4xx
  }
  throw error
}
```

Mechanism: with `acceptsMimeTypes` present the library reads the file's magic-byte signature
(first 189 bytes, replayed for streams) and validates the REAL content — a renamed file is a
`ContentTypeMismatchError` even though the declared type is whitelisted. Only the head is
read; the payload stays streaming.
Source: `docs/collections-and-conversions.mdx` (The content is checked too).

See also: `media-attachments-single-file/SKILL.md` — the column-attachment shape for
single-file fields; `media-uploads-resumable/SKILL.md` — landing large uploads as records
via `attachExisting`; `media-stores-delivery/SKILL.md` — serving with delivery modes.
