---
name: media-react-uploads
description: >-
  Browser uploads with @adonis-agora/media-react — the useMediaUpload hook (modes tus/
  direct/proxy, status/progress state, pause/resume/abort/reset, storageKey cross-reload
  resume), the MediaUploader component with headless render prop, the framework-free
  createMediaUploadClient from @adonis-agora/media-react/client (uploadTus/uploadDirect/
  uploadProxy, session primitives, xhrPartUploader part transport, MediaHttpError,
  chunkSize/concurrency/retries options), UploadMeta rules (key is proxy-only), typed
  TComplete results, and the console launcher (OpenMediaDashboardButton,
  useOpenMediaDashboard, ConsoleSessionError redirect trap). Use when building upload UIs
  against @adonis-agora/media server routes or opening the media console from an app.
license: MIT
metadata:
  type: core
  library: "@adonis-agora/media-react"
  library_version: "0.5.0"
  framework: react
sources:
  - "DavideCarvalho/adonis-media:docs/react/index.mdx"
  - "DavideCarvalho/adonis-media:docs/react/client.mdx"
  - "DavideCarvalho/adonis-media:docs/react/console-launcher.mdx"
  - "DavideCarvalho/adonis-media:packages/react/src/use-media-upload.ts"
  - "DavideCarvalho/adonis-media:packages/react/src/client.ts"
---

# React & browser uploads

`@adonis-agora/media-react` is the first-party browser companion to the AdonisJS provider's
upload routes. It speaks three strategies: **TUS resumable** (default, byte-offset resume),
**direct-S3 multipart** (presigned part PUTs, part-granular resume via sessions), and
**proxy** (single PUT through your app). `react` is an optional peer — the `./client`
entry point needs no React.

## Setup

```sh
npm i @adonis-agora/media-react
```

```tsx title="app/components/uploader.tsx"
import { useMediaUpload } from '@adonis-agora/media-react'

export function Uploader() {
  const { upload, pause, resume, abort, status, progress } = useMediaUpload({ mode: 'tus' })

  return (
    <div>
      <input
        type="file"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) upload(file, { filename: file.name, contentType: file.type })
        }}
      />
      <progress value={progress} max={1} />
      <span>{status}</span>
      <button type="button" onClick={pause}>Pause</button>
      <button type="button" onClick={resume}>Resume</button>
      <button type="button" onClick={abort}>Abort</button>
    </div>
  )
}
```

A stock server needs no path options — every client default matches its server prefix
(`tusPath` `/media/uploads/tus`, `directPath` `/media/uploads/direct/sessions`,
`uploadsPath` `/media/uploads`).

Source: `docs/react/index.mdx`.

## Core patterns

### Pattern 1 — cross-reload resume for direct uploads

Pass `storageKey` to persist session coordinates in `localStorage`; the hook probes on
mount and offers a resume button when pending parts remain:

```tsx
const { upload, resume, resumable, status, progress } = useMediaUpload({
  mode: 'direct',
  storageKey: `upload:lesson:${lessonId}`,
})

return resumable ? (
  <button type="button" onClick={() => resume()}>Resume "{resumable.fileName}"</button>
) : (
  <input type="file" onChange={(e) => {
    const file = e.target.files?.[0]
    if (file) upload(file, { filename: file.name })
  }} />
)
```

A persisted session is reused only when fileName AND byte size match; the server is the
authority (`directSessionStatus` re-reads coordinates and returns FRESH presigned URLs).
Definitive "gone" (404/410) drops the entry; transient failures keep it resumable.

Source: `docs/react/index.mdx` (Resuming a direct upload across a reload).

### Pattern 2 — headless component and framework-free client

```tsx
import { MediaUploader } from '@adonis-agora/media-react'

<MediaUploader
  mode="direct"
  accept="video/*"
  render={({ status, progress, selectFile }) => (
    <button type="button" onClick={() => selectFile()}>{status} {progress}</button>
  )}
/>
```

```ts
import { createMediaUploadClient } from '@adonis-agora/media-react/client'

const client = createMediaUploadClient({
  baseUrl: 'https://api.example.com',
  headers: { Authorization: `Bearer ${token}` },            // app requests only
  getHeaders: async () => ({ Authorization: `Bearer ${await fresh()}` }),
})

const result = await client.uploadDirect(file, { filename: 'a.mp4', contentType: 'video/mp4' })
```

The client also exposes session primitives — `createTusSession`, `tusOffset`, `abortTus`,
`directSessionStatus`, `abortDirectSession` — plus an injectable `partUploader`.

Source: `docs/react/index.mdx`, `docs/react/client.mdx`.

### Pattern 3 — type the completion body a policy returns

With a `DirectUploadPolicy`, the complete response body is whatever `onComplete` returned.
Type it and narrow the discriminated union:

```tsx
type Completion = { mediaId: string; status: 'processing' }

const { upload } = useMediaUpload<Completion>({ mode: 'direct' })

const result = await upload(file, { filename: file.name, contentType: file.type })
if (result.mode === 'direct') {
  router.visit(`/videos/${result.body.mediaId}`) // typed
}
```

Result variants: `{ mode: 'tus', location }`, `{ mode: 'direct', uploadId, key, disk, body }`,
`{ mode: 'proxy', key, disk }`.

Source: `docs/react/index.mdx` (The typed completion body).

## Common mistakes

### [CRITICAL] Adding Authorization headers to presigned S3 part PUTs

Wrong:

```ts
// custom PartUploader that forwards app headers everywhere
const client = createMediaUploadClient({
  headers: { Authorization: `Bearer ${token}` },
  partUploader: (url, body) =>
    fetch(url, { method: 'PUT', body, headers: { Authorization: `Bearer ${token}` } }),
})
```

Correct:

```ts
const client = createMediaUploadClient({
  headers: { Authorization: `Bearer ${token}` }, // app requests only
})
// presigned PUTs receive NO headers — that's the default xhrPartUploader's job:
const client2 = createMediaUploadClient({
  partUploader: async (url, body) => {
    const res = await fetch(url, { method: 'PUT', body }) // no auth header
    return res.headers.get('ETag')!
  },
})
```

Mechanism: presigned URLs are signed with SigV4 over host/path/query — an added
`Authorization` header breaks the signature and S3 rejects the PUT. `headers` /
`getHeaders` are deliberately merged into requests against YOUR app only.
Source: `docs/react/index.mdx` (warn callout), `docs/react/client.mdx` (The part transport warn).

### [HIGH] Passing meta.key to TUS or direct uploads expecting it honored

Wrong:

```ts
await upload(file, { filename: 'clip.mp4', key: 'users/1/clip.mp4' }) // mode: 'tus'
```

Correct:

```ts
// proxy takes a key; TUS/direct derive keys SERVER-side (optionally via a DirectUploadPolicy)
await uploadProxy(file, { filename: 'clip.mp4', key: 'users/1/clip.mp4' })
await uploadTus(file, { filename: 'clip.mp4' })
```

Mechanism: `key` (and `disk`) in `UploadMeta` apply to PROXY only — TUS and direct derive
the object key server-side, and `meta.key` is silently ignored there. A client-chosen key
would be a hole you'd have to close anyway.
Source: `docs/react/index.mdx` (UploadMeta table).

### [HIGH] Treating the TComplete generic as validation

Wrong:

```tsx
const { upload } = useMediaUpload<{ mediaId: string }>({ mode: 'direct' })
const result = await upload(file, meta)
router.visit(`/videos/${result.body.mediaId}`) // trusts unchecked JSON
```

Correct:

```tsx
import { z } from 'zod'

const Completion = z.object({ mediaId: z.string(), status: z.enum(['processing']) })
const parsed = Completion.parse(result.body)
router.visit(`/videos/${parsed.mediaId}`)
```

Mechanism: `TComplete` is a compile-time assertion over raw server JSON — nothing at this
boundary checks the shape. Parse with a schema before trusting it.
Source: `docs/react/index.mdx` (warn callout under The typed completion body).

### [MEDIUM] Sharing one storageKey between multiple uploaders

Wrong:

```tsx
<LessonVideo storageKey="upload" />
<LessonCover storageKey="upload" /> // both write the same localStorage entry
```

Correct:

```tsx
<LessonVideo storageKey="upload:lesson-video" />
<LessonCover storageKey="upload:cover" />
```

Mechanism: `storageKey` should be unique per upload slot — two uploaders sharing a key fight
over the same entry, and reuse additionally requires matching fileName AND byte size, so a
revised same-named file never splices bytes into an old session. Ignored by `tus` and
`proxy`.
Source: `docs/react/index.mdx` (Resuming a direct upload across a reload).

### [MEDIUM] Setting concurrency expecting parallel direct-S3 parts

Wrong:

```ts
createMediaUploadClient({ concurrency: 4 }) // expecting 4 parallel part PUTs
```

Correct:

```ts
createMediaUploadClient({ retries: 3 }) // parts are sequential today
```

Mechanism: `concurrency` is **reserved** — direct-S3 uploads run sequentially today; the
option exists only for forward compatibility, so tuning it changes nothing.
Source: `docs/react/index.mdx` (client options table).

See also: `media-uploads-resumable/SKILL.md` — the server routes this client speaks;
`media-dashboard-console/SKILL.md` — the console embedding this same client.
