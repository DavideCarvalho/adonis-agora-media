---
name: media-uploads-resumable
description: >-
  Large-file uploads in @adonis-agora/media — the uploads config key (mode auto|proxy|
  direct, partSize, presignTtlSeconds, opt-in routes), media.uploads
  (initiateDirectUpload/completeDirectUpload/proxyUpload, resolveUploadMode), resumable
  TUS sessions via media.resumable and TusUploadHandler (UploadSessionStore, in-memory +
  Lucid, byte-offset resume), direct sessions via media.direct (presigned part URLs,
  part-granular resume, confirmPart/status), the DirectUploadPolicy hooks
  (onInitiate/resolveComplete/onComplete/mapError, server-side keys), and adopting
  finished uploads with completeUploadToLibrary / completeDirectUploadToLibrary /
  attachExisting. Use when uploading big files, resuming interrupted uploads, writing an
  upload policy, or fixing UploadNotSupportedError / UploadPartsIncompleteError /
  ResumableUploadsNotConfiguredError.
license: MIT
metadata:
  type: core
  library: "@adonis-agora/media"
  library_version: "1.1.1"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-media:docs/uploads/upload-modes.mdx"
  - "DavideCarvalho/adonis-media:docs/uploads/resumable-tus.mdx"
  - "DavideCarvalho/adonis-media:docs/uploads/direct-sessions.mdx"
  - "DavideCarvalho/adonis-media:docs/uploads/direct-upload-policy.mdx"
  - "DavideCarvalho/adonis-media:packages/adonis/src/upload_mode.ts"
---

# Large-file uploads: proxy, direct-S3, TUS, and policies

Beyond buffer-once `attach`, the library ships upload coordinators with three strategies:
**proxy** (bytes stream through your app — any disk), **direct** (browser PUTs presigned
multipart parts straight to S3 — multipart-capable disk only), and **resumable TUS**
(byte-offset resume over the tus 1.0.0 protocol). `media.direct` adds session-backed direct
uploads whose state survives a reload.

## Setup

```ts title="config/media.ts"
import { middleware } from '#start/kernel'
import { defineConfig, disks, stores, uploadSessions } from '@adonis-agora/media'

export default defineConfig({
  disk: 's3',
  disks: { s3: disks.s3({ bucket: 'my-bucket', region: 'us-east-1' }) },
  store: 'lucid',
  stores: { lucid: stores.lucid() },

  uploads: {
    mode: 'auto',              // auto picks direct on a multipart-capable disk, else proxy
    partSize: 8 * 1024 * 1024, // S3 floor is 5 MiB, cap 10,000 parts
    routes: { enabled: true, prefix: '/media/uploads', middleware: [middleware.auth()] }, // opt-in

    resumable: {               // opt-in — makes media.resumable exist
      store: 'lucid',
      stores: { lucid: uploadSessions.lucid() }, // durable, multi-process sessions
      routes: { enabled: true, prefix: '/media/uploads/tus', maxSize: 5 * 1024 ** 3,
                middleware: [middleware.auth()] },
    },

    direct: {                  // opt-in — makes media.direct exist
      store: 'lucid',
      stores: { lucid: uploadSessions.lucid() }, // same session store SPI as TUS
      partSize: 20 * 1024 * 1024,
      routes: {
        enabled: true,
        prefix: '/media/uploads/direct/sessions',
        collection: 'videos',  // gate the declared type at initiate
        middleware: [middleware.auth()], // the ONLY gate on these routes
      },
    },
  },
})
```

Naming a session `store` with no matching factory throws
`UploadSessionStoreNotConfiguredError` — never a silent in-memory fallback.

Source: `docs/uploads/upload-modes.mdx`, `docs/uploads/resumable-tus.mdx`, `docs/uploads/direct-sessions.mdx`.

## Core patterns

### Pattern 1 — resolve the mode yourself

`proxy` is always allowed; `direct` is a REQUIREMENT that throws
`UploadNotSupportedError` on an incapable disk; `auto` is a PREFERENCE that downgrades:

```ts
import { resolveUploadMode, isMultipartCapable } from '@adonis-agora/media'
import type { ResolvedUploadMode, UploadModeLevels } from '@adonis-agora/media'
import media from '@adonis-agora/media/services/main'
import type { HttpContext } from '@adonisjs/core/http'

declare const request: HttpContext['request']

const mode: ResolvedUploadMode = resolveUploadMode(
  { global: 'auto', perCall: request.input('mode') } satisfies UploadModeLevels,
  isMultipartCapable(media.disk('s3')),
  's3',
)
```

Source: `docs/uploads/upload-modes.mdx` (Resolving the mode yourself).

### Pattern 2 — resumable TUS sessions

The engine is framework-agnostic (`TusUploadHandler`); the provider mounts thin routes.
Programmatically:

```ts
import media from '@adonis-agora/media/services/main'
import type { MultipartFile } from '@adonisjs/core/bodyparser'

declare const file: MultipartFile
declare const chunk1: Buffer, chunk2: Buffer // the request bodies of the PATCHes

const session = await media.resumable.createUpload({
  disk: 's3', key: `users/1/video.mp4`, size: file.size, contentType: 'video/mp4',
})

let { offset } = await media.resumable.writeChunk(session.id, 0, chunk1)
;({ offset } = await media.resumable.writeChunk(session.id, offset, chunk2))
await media.resumable.status(session.id) // { offset, size, contentType, expiresAt }

const { key, disk, size } = await media.resumable.complete(session.id)
```

`media.hasResumable` guards access; `media.resumable` throws
`ResumableUploadsNotConfiguredError` without config. A standard tus client (or
`@adonis-agora/media-react`) points at `routes.prefix` and works unchanged.

Source: `docs/uploads/resumable-tus.mdx` (media.resumable).

### Pattern 3 — adopt finished uploads into the library (zero-copy)

Do NOT read the bytes back through `attach()` — that buffers and rewrites the object.
Register the object where it already is:

```ts
import type Lesson from '#models/lesson'
import type Patient from '#models/patient'
import type { DirectUploadCreatedSession, MultipartPart, UploadSession } from '@adonis-agora/media'
import media from '@adonis-agora/media/services/main'

declare const session: UploadSession, patient: Patient
declare const created: DirectUploadCreatedSession, lesson: Lesson
declare const partsFromClient: MultipartPart[] // { partNumber, etag }[] the browser reports

// TUS finalize:
const record = await media.completeUploadToLibrary(session.id, {
  ownerType: 'Patient', ownerId: patient.id, collection: 'exams',
  fileName: 'exam.pdf', mimeType: 'application/pdf',
})

// direct sessions:
const record2 = await media.completeDirectUploadToLibrary(created.id, {
  ownerType: 'Lesson', ownerId: lesson.id, collection: 'videos',
  fileName: 'original.mp4', mimeType: 'video/mp4',
}, partsFromClient)
```

Both chain `library.attachExisting({ ..., key, disk, size })` — the collection's whitelist
is re-validated against the real bytes (a short head read), `single: true` replace and
ordering still apply, and nothing streams through the app.

Source: `docs/uploads/resumable-tus.mdx` (Turning a finished upload into a media record).

### Pattern 4 — a DirectUploadPolicy owns every app decision

The handler owns mechanics; the policy owns decisions. With a policy, `keyFor` is never
called — the key is computed server-side from authenticated context. `ctx.bouncer` is typed by
the middleware `node ace add @adonisjs/bouncer` writes:

```ts title="app/middleware/initialize_bouncer_middleware.ts (excerpt)"
import * as abilities from '#abilities/main'
import { policies } from '#generated/policies'
import type { Bouncer } from '@adonisjs/bouncer'
import type { HttpContext } from '@adonisjs/core/http'

declare module '@adonisjs/core/http' {
  export interface HttpContext {
    bouncer: Bouncer<Exclude<HttpContext['auth']['user'], undefined>, typeof abilities, typeof policies>
  }
}
```

```ts title="app/media/lesson_video_policy.ts"
import { randomUUID } from 'node:crypto'
import Lesson from '#models/lesson'
import LessonUpload from '#models/lesson_upload'
import type User from '#models/user'
import { errors } from '@adonisjs/bouncer'
import type { HttpContext } from '@adonisjs/core/http'
import type { DirectUploadPolicy, InitiateDecision, CompleteResolution } from '@adonis-agora/media'

export default class LessonVideoPolicy implements DirectUploadPolicy<HttpContext, { uploadRowId: string }> {
  async onInitiate(ctx: HttpContext, input): Promise<InitiateDecision<{ uploadRowId: string }>> {
    const user: User = ctx.auth.getUserOrFail()
    const lesson = await Lesson.findOrFail(ctx.params.lessonId)
    await ctx.bouncer.authorize('uploadLessonVideo', lesson) // ← authorization lives HERE

    const key = `tenants/${user.tenantId}/lessons/${lesson.id}/${randomUUID()}.mp4`
    const row = await LessonUpload.create({ lessonId: lesson.id, key, status: 'pending' })

    return {
      key,
      collection: 'videos',
      context: { uploadRowId: row.id },
      rollback: () => row.delete(), // runs if anything AFTER this decision throws
    }
  }

  async resolveComplete(ctx, input): Promise<CompleteResolution<{ uploadRowId: string }>> {
    const row = await LessonUpload.findByOrFail('uploadSessionId', input.id)
    return {
      sessionId: input.id,
      target: { ownerType: 'Lesson', ownerId: row.lessonId, collection: 'videos',
                fileName: row.fileName, mimeType: 'video/mp4' },
      context: { uploadRowId: row.id },
    }
  }

  async onComplete(_ctx, { record, resolution }) {
    await LessonUpload.query().where('id', resolution.context!.uploadRowId)
      .update({ status: 'stored', mediaId: record.id })
    return { mediaId: record.id, status: 'processing' } // ← IS the response body
  }

  mapError(_ctx, error) {
    if (error instanceof errors.E_AUTHORIZATION_FAILURE) return { status: 403, body: { error: 'forbidden' } }
    return undefined // fall through to the handler's mapping
  }
}
```

Register it as a lazy thunk: `routes: { policy: () => import('#media/lesson_video_policy') }`.
The module's default export is used — a class is instantiated with no arguments.

Source: `docs/uploads/direct-upload-policy.mdx`.

## Common mistakes

### [CRITICAL] Shipping upload routes without middleware or a policy

Wrong:

```ts no-check
uploads: { direct: { routes: { enabled: true } } } // middleware defaults to []
```

Correct:

```ts no-check
uploads: {
  direct: {
    routes: { enabled: true, middleware: [middleware.auth()],
              policy: () => import('#media/lesson_video_policy') },
  },
}
```

Mechanism: `routes.middleware` defaults to `[]` and the handlers perform no authorization
whatsoever. Without middleware (and without `allowUnguarded: true`) a route group does not
mount in production — the boot throws naming the option to set — and outside production it
mounts open, with a warning. Use middleware for "are you logged in" and policy hooks for "may
you upload to THIS resource".
Source: `docs/uploads/direct-sessions.mdx` (routes.middleware), `docs/uploads/direct-upload-policy.mdx` (warn callout).

### [CRITICAL] Re-reading finished upload bytes through library.attach()

Wrong:

```ts no-check
const { key, disk } = await media.resumable.complete(session.id)
const bytes = await media.disk(disk).getBytes(key) // buffers the whole file…
await media.library.attach({ ..., contents: bytes }) // …and rewrites it to a new key
```

Correct:

```ts
import type Patient from '#models/patient'
import type { UploadSession } from '@adonis-agora/media'
import media from '@adonis-agora/media/services/main'

declare const session: UploadSession, patient: Patient

const record = await media.completeUploadToLibrary(session.id, {
  ownerType: 'Patient', ownerId: patient.id, collection: 'exams',
  fileName: 'exam.pdf', mimeType: 'application/pdf',
})
```

Mechanism: `attach` buffers the payload once and writes a NEW object — exactly what a
resumable upload exists to avoid. `completeUploadToLibrary` /
`completeDirectUploadToLibrary` chain `attachExisting`, which registers the existing key
zero-copy.
Source: `docs/uploads/resumable-tus.mdx` (Turning a finished upload into a media record).

### [CRITICAL] Expecting direct uploads to work without bucket CORS exposing ETag

Wrong:

```json
// bucket CORS: allowed origins/methods only
{ "AllowedOrigins": ["https://app.example.com"], "AllowedMethods": ["PUT"] }
```

Correct:

```json
{ "AllowedOrigins": ["https://app.example.com"], "AllowedMethods": ["PUT"],
  "ExposeHeaders": ["ETag"] }
```

Mechanism: the browser must read the `ETag` response header of each part PUT to confirm it;
without `ExposeHeaders: ["ETag"]` no part can ever be confirmed — the single most common
direct-upload misconfiguration (the client fails with an explicit "S3 did not expose an
ETag" message).
Source: `docs/uploads/direct-sessions.mdx` (warn callout: Bucket CORS must expose ETag), `docs/react/client.mdx`.

### [MEDIUM] Forcing mode:direct on a disk without native multipart

Wrong:

```ts
uploads: { mode: 'direct' } // disk is the local FS driver
```

Correct:

```ts
uploads: { mode: 'auto' } // downgrades to proxy on incapable disks
```

Mechanism: `direct` is a requirement, `auto` is a preference — forcing `direct` on a disk
without native multipart throws `UploadNotSupportedError` (`E_MEDIA_UPLOAD_NOT_SUPPORTED`,
mapped to 400 by the routes) rather than silently downgrading.
Source: `docs/uploads/upload-modes.mdx` (Resolving the mode yourself).

### [HIGH] Expecting a media record from policy-less direct completion

Wrong:

```ts
import media from '@adonis-agora/media/services/main'

declare const id: string // the direct upload session id

await media.direct.complete(id) // returns { key, disk, size } — no MediaRecord created
await media.library.url('???') // nothing to look up
```

Correct:

```ts
import type Lesson from '#models/lesson'
import media from '@adonis-agora/media/services/main'

declare const id: string, lesson: Lesson

const record = await media.completeDirectUploadToLibrary(id, {
  ownerType: 'Lesson', ownerId: lesson.id, collection: 'videos',
  fileName: 'original.mp4', mimeType: 'video/mp4',
})
```

Mechanism: without a `DirectUploadPolicy`, `complete` returns the raw assembled object and
creates NO media record — adopting it into the library is the caller's job. With a policy,
`resolveComplete` → `attachExisting` → `onComplete` runs automatically.
Source: `docs/uploads/direct-upload-policy.mdx` (Without a policy).

### [HIGH] Trusting client-supplied keys or TUS metadata as key segments

Wrong:

```ts
import media from '@adonis-agora/media/services/main'
import type { HttpContext } from '@adonisjs/core/http'

declare const request: HttpContext['request'], contents: Buffer

// routes take `key` from the request body and use it verbatim
const key = request.input('key')
await media.proxyUpload({ key, contents })
```

Correct:

```ts
import { randomUUID } from 'node:crypto'
import type User from '#models/user'
import { parseTusMetadata } from '@adonis-agora/media'
import media from '@adonis-agora/media/services/main'
import type { HttpContext } from '@adonisjs/core/http'

declare const auth: HttpContext['auth'], request: HttpContext['request'], contents: Buffer

// resolve the key server-side from authenticated context (or use a policy)
const user: User = auth.getUserOrFail()
await media.proxyUpload({ key: `users/${user.id}/${randomUUID()}.mp4`, contents })
// TUS metadata: parse + validate before use
const meta = parseTusMetadata(request.header('upload-metadata'))
```

Mechanism: the object key is yours to resolve server-side — a client-supplied key lets one
tenant overwrite another's objects. TUS `Upload-Metadata` is browser input: validate it and
never use it as a key segment unsanitized.
Source: `docs/uploads/upload-modes.mdx` (media.uploads), `docs/react/client.mdx` (Custom TUS metadata warn).

See also: `media-react-uploads/SKILL.md` — the browser half that speaks these routes;
`media-library-collections/SKILL.md` — the collection policy that re-validates adopted
uploads.
