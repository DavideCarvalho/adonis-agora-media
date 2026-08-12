# @adonis-agora/media-dashboard

A media-management console for [`@adonis-agora/media`](../adonis): browse your buckets, watch
resumable uploads in progress, upload new objects, and copy/move/delete objects across buckets. It is
a small React SPA served by a thin AdonisJS provider, themed to Agora design tokens (light + dark).

The console consumes the **real** media surface — disk `list`/`stat`/`copy`/`move`/`deleteMany` and
the resumable `UploadSessionStore.list()` — through provider-registered routes. Nothing about storage
is reimplemented; the upload UI reuses [`@adonis-agora/media-react`](../react).

## The console ships embedded in `@adonis-agora/media` — install that instead

As of `7.0.0`, this package's install/provider story is **secondary**. The console (this same React
SPA, and all of its server-side auth/service logic) is bundled straight into
[`@adonis-agora/media`](../adonis) at build time; `node ace configure @adonis-agora/media` registers
its `dashboard_provider` for you, with no separate package to add:

```sh
npm i @adonis-agora/media
node ace configure @adonis-agora/media
```

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
```

See [`@adonis-agora/media`'s Dashboard section](../adonis#dashboard) for the full config reference —
`defineConfig`, `DashboardService`, the session-auth helpers and `ObjectInsightProvider` all live under
`@adonis-agora/media/dashboard` now.

## This package, standalone (advanced / legacy)

This package — and its own `media_dashboard_provider` entry point — is still published and still
works, for hosts that already register it directly, or that prefer keeping the dashboard as an
explicit, separately-versioned install. Its provider is a thin delegate to the embedded one above (no
logic of its own), so both entry points stay identical in behavior. **Register only one of the two.**

```sh
pnpm add @adonis-agora/media-dashboard
```

```ts
providers: [
  () => import('@adonis-agora/media/media_provider'),
  () => import('@adonis-agora/media-dashboard/media_dashboard_provider'),
]
```

`config/media_dashboard.ts` is read from the SAME config key (`media_dashboard`) regardless of which
provider you register, authored against `@adonis-agora/media/dashboard`'s `defineConfig` either way:

```ts
import { defineConfig } from '@adonis-agora/media/dashboard'
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
