---
name: media-dashboard-console
description: >-
  The media management console for @adonis-agora/media — config/media_dashboard.ts via
  @adonis-agora/media/dashboard defineConfig (basePath, apiBasePath, authorize gate, actions gate, disks,
  middleware, enabled), the embedded dashboard_provider, sign-in through the app via
  authorize ({ redirectTo }), authorizeByToken, DashboardService + DashboardError +
  MediaManagerLike programmatic API, and objectInsights providers.
  Use when mounting or gating the console, sending signed-out operators to the app's login,
  building custom admin routes over storage, or adding object insights.
license: MIT
metadata:
  type: core
  library: "@adonis-agora/media-dashboard"
  library_version: "8.0.0"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-media:docs/dashboard/index.mdx"
  - "DavideCarvalho/adonis-media:docs/dashboard/authentication.mdx"
  - "DavideCarvalho/adonis-media:docs/dashboard/programmatic.mdx"
  - "DavideCarvalho/adonis-media:packages/dashboard/src/index.ts"
---

# The management console

The console is a React SPA plus JSON API for browsing buckets, watching resumable uploads,
and copy/move/delete across buckets. It ships **embedded** in `@adonis-agora/media`
(`./dashboard_provider`); `@adonis-agora/media-dashboard` is its build source and exports the
console's API types.

## Setup

```ts title="adonisrc.ts"
providers: [
  () => import('@adonis-agora/media/media_provider'),
  () => import('@adonis-agora/media/dashboard_provider'),
]
```

```ts title="config/media_dashboard.ts"
import { defineConfig } from '@adonis-agora/media/dashboard'
import { middleware } from '#start/kernel'

export default defineConfig({
  basePath: '/media/dashboard',
  actions: true,                 // copy/move/delete — read-only when false (the default)
  disks: ['s3', 'backups'],
  authorize: (ctx) => ctx.auth.user?.isAdmin === true, // who may open it — SPA + API
  middleware: middleware.auth(), // runs after authorize
})
```

`node ace configure @adonis-agora/media` registers both providers automatically. The
`actions`-only routes are always mounted; the gate lives one layer down in
`DashboardService`, which throws `403` when `actions` is false.

Source: `docs/dashboard/index.mdx`.

## Core patterns

### Pattern 1 — sign-in through your app

The console has no login of its own. `authorize` decides, and a signed-out visitor is sent to
your app's login with `{ redirectTo }`:

```ts title="config/media_dashboard.ts"
import { defineConfig } from '@adonis-agora/media/dashboard'

export default defineConfig({
  authorize: async (ctx) => {
    if (!(await ctx.auth.check())) return { redirectTo: '/login' }
    return ctx.auth.user!.isAdmin === true
  },
})
```

A page navigation gets a `302` there; an API call gets
`401 { error: 'unauthenticated', redirectTo }`, and the SPA follows that `redirectTo` (or
reloads the page when the `401` carries none). There are no `/me`, `/login`, `/session` or
`/logout` routes and no `auth` option.

Source: `docs/dashboard/authentication.mdx`.

### Pattern 2 — reuse the console's engine under your own routes

`DashboardService` is framework-free (typed over the structural `MediaManagerLike`), so your
own admin screens get the same paging and transfer engine:

```ts title="start/routes.ts"
import { MediaManager } from '@adonis-agora/media'
import { DashboardService, DashboardError, readObjectsQuery } from '@adonis-agora/media/dashboard'

const media = await app.container.make(MediaManager)
const dashboard = new DashboardService(media, { diskNames: ['s3'], actions: true })

// Same wire format as the console: `filter[disk]`, `filter[prefix]`, `after`, `first` in,
// `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev } }` out. Forward only: `before`/`last`
// are a 400 and `prevCursor`/`hasPrev` are always `null`/`false`.
router.get('/admin/storage/objects', async (ctx) => {
  try {
    const { disk, params } = await readObjectsQuery(ctx)
    return await dashboard.objects(disk, params)
  } catch (error) {
    if (error instanceof DashboardError) {
      return ctx.response.status(error.status).json({ error: error.message })
    }
    throw error
  }
}).use([middleware.auth(), middleware.admin()])
```

Mutating methods throw `DashboardError(403)` when built with `actions: false`; statuses map
verbatim onto HTTP (400 invalid argument, 404 unknown disk/record/session, 413 oversized).

Source: `docs/dashboard/programmatic.mdx`.

### Pattern 3 — object insights annotate previews with YOUR data

Providers run on every object preview and render structured data in the lightbox:

```ts title="config/media_dashboard.ts"
export default defineConfig({
  objectInsights: [
    {
      id: 'documents',
      async resolve({ disk, key }) {
        const doc = await Document.findBy('storageKey', key)
        if (!doc) return null
        return {
          title: 'Document',
          facts: [{ label: 'Owner', value: doc.ownerEmail }],
          links: [{ label: 'Open in app', href: `/documents/${doc.id}` }],
        }
      },
    },
  ],
})
```

Providers return data, not components (the SPA is prebuilt); throwing providers are skipped
and logged; links pass through `sanitizeInsight` (`javascript:`/`data:` hrefs dropped).

Source: `docs/dashboard/index.mdx` (Object insights).

## Common mistakes

### [CRITICAL] Enabling actions without an auth gate

Wrong:

```ts
export default defineConfig({ actions: true }) // no authorize, no middleware
```

Correct:

```ts
export default defineConfig({
  actions: true,
  authorize: (ctx) => ctx.auth.user?.isAdmin === true,
  middleware: middleware.auth(),
})
```

Mechanism: `actions: true` enables copy/move/delete, recursive folder sweeps, record
deletion, upload aborts and uploads — recursive delete/move are destructive and
irreversible. Without `authorize` the console is open outside production and refuses every page
and API request (`403`) in production, with a warning at boot; `authorize` runs before
`middleware`, so a console guarded only by `middleware` needs `authorize` too (for example
`authorize: () => true` to keep it as the gate). API refusals answer `{ error: 'forbidden' }`
(`403`) or `{ error: 'unauthenticated' }` (`401`) JSON. For scripts, use
`authorize: authorizeByToken({ token: env.get('CONSOLE_TOKEN') })` (Bearer header only; an
empty token throws at config time).
Source: `docs/dashboard/index.mdx` (warn callout, Folder operations warn),
`docs/dashboard/authentication.mdx`.

### [HIGH] Assuming deleteMediaRecord removes the underlying object

Wrong:

```ts
await dashboard.deleteMediaRecord(id) // expecting the bucket to lose the file
```

Correct:

```ts
await dashboard.deleteMediaRecord(id)         // removes the MediaStore row only
await dashboard.remove({ disk: 's3', keys: [record.path] }) // remove objects explicitly
// or delete through the library, which removes original AND conversions:
await media.library.delete(record.id)
```

Mechanism: `DashboardService.deleteMediaRecord` deletes the metadata row and nothing else —
the disk object stays where it is, unlike `media.library.delete` which also removes every
conversion file.
Source: `docs/dashboard/programmatic.mdx` (Actions table).

### [MEDIUM] Running expensive lookups in an objectInsights resolver

Wrong:

```ts
async resolve({ key }) {
  const related = await Related.query().where('key', key).preload('everything') // fan-out
  return { facts: related.map(...) }
}
```

Correct:

```ts
async resolve({ key }) {
  const doc = await Document.findBy('storageKey', key) // single indexed lookup
  return doc ? { facts: [{ label: 'Owner', value: doc.ownerEmail }] } : null
}
```

Mechanism: `resolve` runs on EVERY preview of EVERY object (providers concurrently,
failures skipped and logged) — annotation must never slow opening a file, so keep it to one
indexed lookup.
Source: `docs/dashboard/index.mdx` (Object insights).

See also: `media-stores-delivery/SKILL.md` — the ExtendedDisk operations and
`MediaStore.list` the console consumes; `media-react-uploads/SKILL.md` — the upload client
it embeds.
