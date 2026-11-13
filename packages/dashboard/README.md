# @adonis-agora/media-dashboard

A media-management console for [`@adonis-agora/media`](../adonis): browse your buckets, watch
resumable uploads in progress, upload new objects, and copy/move/delete objects across buckets. It is
a small React SPA served by a thin AdonisJS provider, themed to Agora design tokens (light + dark).

The console consumes the **real** media surface — disk `list`/`stat`/`copy`/`move`/`deleteMany` and
the resumable `UploadSessionStore.list()` — through provider-registered routes. Nothing about storage
is reimplemented; the upload UI reuses [`@adonis-agora/media-react`](../react).

## The console ships embedded in `@adonis-agora/media` — install that instead

The console (this React SPA, and all of its server-side auth/service logic) is bundled into
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
`defineConfig`, `DashboardService`, the `authorize` contract and `ObjectInsightProvider` all live under
`@adonis-agora/media/dashboard` now.

## Configuration

`config/media_dashboard.ts`, authored against `@adonis-agora/media/dashboard`'s `defineConfig`:

```ts
import { defineConfig } from '@adonis-agora/media/dashboard'
import { middleware } from '#start/kernel'

export default defineConfig({
  basePath: '/media/dashboard',   // where the SPA mounts (default)
  actions: true,                  // enable copy/move/delete (default: false, read-only)
  disks: ['s3', 'backups'],       // browsable disks (default: derived from media config)
  authorize: (ctx) => ctx.auth.user?.isAdmin === true, // who may open it — SPA + API
  middleware: middleware.auth(), // runs after authorize
})
```

Mount the SPA under any path without rebuilding — the provider rewrites Vite's asset base and injects
the runtime config into `index.html` at serve time, as a JSON data block
(`<script type="application/json" id="media-dashboard-config">`) that a strict CSP does not block.

## Routes

Registered under `apiBasePath` (default `<basePath>/api`), behind `authorize` and your `middleware`:

| Method | Path | Backed by |
| --- | --- | --- |
| `GET` | `/topology` | capability probe |
| `GET` | `/disks` | `StorageManager` + `DiskCapabilities` |
| `GET` | `/objects?filter[disk]&filter[prefix]&after&first` | disk `list` |
| `GET` | `/object?disk&key` | disk `stat` + signed URL |
| `GET` | `/uploads?filter[disk]&filter[prefix]&sort` | `ResumableUploadManager.list()` |
| `GET` | `/collections?filter[collection]&filter[ownerType]&filter[ownerId]&filter[prefix]&after&first` | `MediaStore.list` |
| `POST` | `/copy` · `/move` | disk `copy`/`move` (streamed for cross-disk) |
| `POST` | `/delete` | disk `deleteMany` |

List routes speak the `@adonis-agora/filter` list format: filters as `filter[field]=value`, `sort` against a per-route allow-list, an unknown field or sort answered with `400`. `/objects` and `/collections` page with `?after=<meta.nextCursor>&first=<size>` and answer `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev } }`; the other lists answer `{ data }`. Paging is forward only: `before` / `last` are a `400`, and `prevCursor` / `hasPrev` are always `null` / `false`.

Uploads use the core `@adonis-agora/media` TUS/direct routes via `@adonis-agora/media-react`.

## Views

- **Library** — pick a disk, walk folders via cursor-paginated `list`, copy/move across buckets, delete.
- **Uploads** — live resumable sessions, polled every 2s from the session store.
- **Upload** — drag-drop / picker, resumable TUS uploads into the chosen disk.
