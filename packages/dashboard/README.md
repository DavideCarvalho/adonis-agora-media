# @adonis-agora/media-dashboard

A media-management console for [`@adonis-agora/media`](../adonis): browse your buckets, watch
resumable uploads in progress, upload new objects, and copy/move/delete objects across buckets. It is
a small React SPA served by a thin AdonisJS provider, themed to Agora design tokens (light + dark).

The console consumes the **real** media surface — disk `list`/`stat`/`copy`/`move`/`deleteMany` and
the resumable `UploadSessionStore.list()` — through provider-registered routes. Nothing about storage
is reimplemented; the upload UI reuses [`@adonis-agora/media-react`](../react).

## Install

```sh
pnpm add @adonis-agora/media-dashboard
```

Register the provider **after** the media provider in `adonisrc.ts`:

```ts
providers: [
  () => import('@adonis-agora/media/media_provider'),
  () => import('@adonis-agora/media-dashboard/media_dashboard_provider'),
]
```

## Configure — `config/media_dashboard.ts`

```ts
import { defineConfig } from '@adonis-agora/media-dashboard'
import { middleware } from '#start/kernel'

export default defineConfig({
  basePath: '/media/dashboard',   // where the SPA mounts (default)
  actions: true,                  // enable copy/move/delete (default: false, read-only)
  disks: ['s3', 'backups'],       // browsable disks (default: derived from media config)
  middleware: middleware.auth(),  // gate the whole console — SPA + API
})
```

Mount the SPA under any path without rebuilding — the provider rewrites Vite's asset base and injects
the runtime bootstrap (`window.__MEDIA_DASHBOARD__`) into `index.html` at serve time.

## Routes

Registered under `apiBasePath` (default `<basePath>/api`), behind your `middleware`:

| Method | Path | Backed by |
| --- | --- | --- |
| `GET` | `/topology` | capability probe |
| `GET` | `/disks` | `StorageManager` + `DiskCapabilities` |
| `GET` | `/objects?disk&prefix&cursor&limit` | disk `list` |
| `GET` | `/object?disk&key` | disk `stat` + signed URL |
| `GET` | `/uploads?disk&prefix` | `ResumableUploadManager.list()` |
| `POST` | `/copy` · `/move` | disk `copy`/`move` (streamed for cross-disk) |
| `POST` | `/delete` | disk `deleteMany` |

Uploads use the core `@adonis-agora/media` TUS/direct routes via `@adonis-agora/media-react`.

## Views

- **Library** — pick a disk, walk folders via cursor-paginated `list`, copy/move across buckets, delete.
- **Uploads** — live resumable sessions, polled every 2s from the session store.
- **Upload** — drag-drop / picker, resumable TUS uploads into the chosen disk.
