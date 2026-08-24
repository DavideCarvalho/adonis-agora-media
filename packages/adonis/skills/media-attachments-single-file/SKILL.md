---
name: media-attachments-single-file
description: >-
  Column attachments and the single-file seam in @adonis-agora/media —
  AttachmentManager.createFromFile with always-eager image variants, the Attachment
  value object (toJSON / Attachment.fromJSON), persisting to a Lucid JSON column with
  prepare/consume, media.attachments.url/signedUrl/delete semantics, and
  @adonis-agora/media/single-file (storeSingleFile, removeSingleFile,
  isSingleFileStoreAvailable, storeSingleFileWith) so other packages can delegate
  avatar-style uploads without a hard dependency. Use when a model "has a file"
  (avatar, hero image, logo) or when wiring cross-package single-file uploads.
license: MIT
metadata:
  type: core
  library: "@adonis-agora/media"
  library_version: "0.12.1"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-media:docs/attachments.mdx"
  - "DavideCarvalho/adonis-media:docs/single-file.mdx"
  - "DavideCarvalho/adonis-media:packages/adonis/src/attachment.ts"
  - "DavideCarvalho/adonis-media:packages/adonis/src/single_file_store.ts"
---

# Column attachments & the single-file seam

Two shapes share one storage layer. The `MediaLibrary` is owner+collections; the
`AttachmentManager` is the adonis-attachment style — one file living **directly on a model
column** as a JSON value, no owner row, no extra table. Reach for an attachment when a model
simply *has* a file (an avatar, a hero image); reach for collections when an entity has many
files with policy.

## Setup

```ts title="app/controllers/avatars_controller.ts"
import { createReadStream } from 'node:fs'
import User from '#models/user'
import media from '@adonis-agora/media/services/main'
import type { HttpContext } from '@adonisjs/core/http'

export default class AvatarsController {
  async update({ request, response, auth }: HttpContext) {
    const user = auth.getUserOrFail()

    const avatar = request.file('avatar', { size: '2mb', extnames: ['jpg', 'jpeg', 'png', 'webp'] })
    if (!avatar) return response.badRequest({ error: 'An "avatar" file is required' })

    const att = await media.attachments.createFromFile(
      {
        fileName: avatar.clientName,
        mimeType: avatar.type!,
        contents: createReadStream(avatar.tmpPath!), // Buffer | Readable
      },
      { variants: [{ name: 'thumb', width: 100 }] },
    )

    user.avatarData = att.toJSON() // store on a JSON column
    await user.save()

    return response.ok(user)
  }
}
```

The file lands at `${keyPrefix}/${id}/${fileName}` (`keyPrefix` defaults to your
`attachmentKeyPrefix`, default `attachments`), variants at
`${keyPrefix}/${id}/variants/${name}.${format}`.

Source: `docs/attachments.mdx` (Creating an attachment).

## Core patterns

### Pattern 1 — serialize onto a Lucid JSON column

An `Attachment` is a pure JSON-serializable value object (disk, path, size, mimeType,
variants, meta). Persist `toJSON()`, rebuild with `Attachment.fromJSON()`:

```ts title="app/models/user.ts"
import { BaseModel, column } from '@adonisjs/lucid/orm'
import { Attachment, type AttachmentData } from '@adonis-agora/media'

export default class User extends BaseModel {
  @column({
    prepare: (v) => (v ? JSON.stringify(v) : v),
    consume: (v) => (typeof v === 'string' ? JSON.parse(v) : v),
  })
  declare avatarData: AttachmentData | null

  get avatar(): Attachment | null {
    return Attachment.fromJSON(this.avatarData)
  }
}
```

Source: `docs/attachments.mdx` (A model-column pattern).

### Pattern 2 — resolve URLs and signed URLs through the manager

The value object never touches storage; URL resolution and deletion go through
`media.attachments`:

```ts
const att = Attachment.fromJSON(user.avatarData)!

await media.attachments.url(att)            // original
await media.attachments.url(att, 'thumb')   // named variant

await media.attachments.signedUrl(att, '30m')                        // expiring (s3/gcs)
await media.attachments.signedUrl(att, '1h', { variant: 'thumb' })   // signed variant

// force a named download — headers are baked into the URL by the presigner
await media.attachments.signedUrl(att, '1h', {
  contentDisposition: `attachment; filename="${att.name}"`,
})
```

Source: `docs/attachments.mdx` (Resolving URLs).

### Pattern 3 — the single-file store for other packages

`@adonis-agora/media/single-file` is the narrow seam for "replace this owner's one file and
give me a URL", importable unconditionally with feature detection:

```ts
import { isSingleFileStoreAvailable, removeSingleFile, storeSingleFile } from '@adonis-agora/media/single-file'

if (await isSingleFileStoreAvailable()) {
  const { url, thumbUrl } = await storeSingleFile({
    ownerType: 'User',
    ownerId: String(user.id),
    collection: 'avatar',
    fileName: upload.clientName,
    mimeType: upload.type!,
    contents: upload.bytes, // a Buffer
  })
  // thumbUrl is null — not an error — when the 'thumb' conversion isn't configured
}

// tests or multi-manager apps pass the manager explicitly:
import { storeSingleFileWith } from '@adonis-agora/media/single-file'
await storeSingleFileWith(testManager, { ownerType: 'User', ownerId: '1', collection: 'avatar',
  fileName: 'me.png', mimeType: 'image/png', contents: pngBytes })
```

`removeSingleFile({ ownerType, ownerId, collection })` empties the owner's collection,
deleting each record's disk object and conversions.

Source: `docs/single-file.mdx`.

## Common mistakes

### [HIGH] Requesting attachment variants that were not declared up front

Wrong:

```ts
const att = await media.attachments.createFromFile(input) // no variants option
await media.attachments.url(att, 'thumb') // throws
```

Correct:

```ts
const att = await media.attachments.createFromFile(input, {
  variants: [{ name: 'thumb', width: 100 }],
})
await media.attachments.url(att, 'thumb')
```

Mechanism: unlike the library's lazy conversions, attachment **variants are always eager** —
generated inside `createFromFile`, because there is no per-attachment record to cache a
lazily-generated variant onto. An undeclared variant throws `VariantNotFoundError`
(`E_MEDIA_VARIANT_NOT_FOUND`). Requesting any variant with no `imageProcessor` configured
throws.
Source: `docs/attachments.mdx` (Variants are eager callout, Resolving URLs).

### [HIGH] Leaving the model column populated after attachments.delete()

Wrong:

```ts
await media.attachments.delete(att)
// column still holds the JSON → every url()/signedUrl() resolves deleted objects
```

Correct:

```ts
await media.attachments.delete(att)
user.avatarData = null
await user.save()
```

Mechanism: `delete()` removes the original AND every variant from storage but deliberately
does not touch your model column — clearing it is yours, since only you know the field.
Stale columns keep producing dead URLs until saved as null.
Source: `docs/attachments.mdx` (Deleting).

### [CRITICAL] Calling storeSingleFile against a collection that is not single:true

Wrong:

```ts
// config declares NO 'avatar' collection (or declares it without single: true)
await storeSingleFile({ ownerType: 'User', ownerId: '1', collection: 'avatar', ... }) // upload #1
await storeSingleFile({ ownerType: 'User', ownerId: '1', collection: 'avatar', ... }) // upload #2
```

Correct:

```ts
// config/media.ts
defineConfig({
  collections: [{ name: 'avatar', single: true, acceptsMimeTypes: ['image/png', 'image/jpeg'] }],
})
```

Mechanism: nothing about these functions enforces replacement — replacement is a property of
the COLLECTION. Without `single: true` each call appends another record, and "the avatar"
quietly becomes a growing list of files.
Source: `docs/single-file.mdx` (warn callout: `single: true` lives in the config).

See also: `media-library-collections/SKILL.md` — choosing between the two shapes and the
collection policy both paths run under.
