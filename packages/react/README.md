# @adonis-agora/media-react

React hook + headless uploader component and a framework-free browser upload client for
[`@adonis-agora/media`](../adonis). It speaks the AdonisJS provider's **actual** upload contract
across all three server strategies:

- **TUS resumable** — `POST`/`HEAD`/`PATCH`/`DELETE` against `uploads.resumable.routes.prefix`
  (default `/media/uploads/tus`), `Content-Type: application/offset+octet-stream`, resumes from the
  server's `Upload-Offset`. The default strategy.
- **Direct-S3 multipart** — `POST /direct/initiate` returns presigned part URLs; parts are `PUT`
  straight to S3 (ETags collected) and assembled via `POST /direct/:uploadId/complete`
  (`uploads.routes.prefix`, default `/media/uploads`).
- **Proxy** — a single `PUT /proxy` streams the whole body through the app.

## Install

```bash
npm i @adonis-agora/media-react react
```

`react` is an (optional) peer dependency — the `./client` entry point is framework-free and needs no
React.

## `useMediaUpload`

```tsx
import { useMediaUpload } from '@adonis-agora/media-react'

function Uploader() {
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
    </div>
  )
}
```

- `mode`: `'tus'` (resumable, default) · `'direct'` (presigned S3 multipart) · `'proxy'`.
- `pause()` / `resume()` — for `tus`, resume continues from the server offset; `direct`/`proxy`
  restart.
- `abort()` — cancels and terminates the TUS session server-side.
- `direct`/`proxy` require a `key` in the upload `meta` (resolve it server-side in real apps).

## `MediaUploader` (headless-friendly component)

```tsx
import { MediaUploader } from '@adonis-agora/media-react'

<MediaUploader mode="tus" accept="image/*" onUploaded={(r) => console.log(r)} />

// Fully headless:
<MediaUploader render={({ status, progress, selectFile }) => (/* your UI */)} />
```

The default markup is a file input + progress bar, themed through **Agora design tokens**
(`--agora-primary`, `--agora-primary-soft`, `--agora-ink`) via overridable `--agora-media-*` CSS
custom properties. Pass `unstyled` to drop the default stylesheet, or override any variable to
retheme. No vendor branding.

## `createMediaUploadClient` (framework-free)

```ts
import { createMediaUploadClient } from '@adonis-agora/media-react/client'

const client = createMediaUploadClient({ baseUrl: 'https://api.example.com' })
await client.uploadTus(file, { filename: 'a.png', contentType: 'image/png' })
await client.uploadDirect(file, { filename: 'a.png', key: 'u/1/a.png' })
await client.uploadProxy(file, { filename: 'a.png', key: 'u/1/a.png' })
```

Static `headers` and a fresh-per-request `getHeaders()` (for short-lived tokens) are merged into
every **app** request; presigned S3 `PUT`s deliberately receive neither, so the SigV4 signature
stays intact.
