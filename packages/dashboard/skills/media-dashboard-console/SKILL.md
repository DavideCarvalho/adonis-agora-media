---
name: media-dashboard-console
description: >-
  The media management console for @adonis-agora/media — config/media_dashboard.ts via
  @adonis-agora/media/dashboard defineConfig (basePath, apiBasePath, actions gate, disks,
  middleware, enabled), the embedded dashboard_provider vs the standalone
  @adonis-agora/media-dashboard delegate provider, built-in session auth (Mode A
  auth.session minting from app auth, Mode B auth.login credentials screen, revalidate,
  secret/ttl, signSessionCookie/verifySessionCookie/resolveConsoleAuth), DashboardService
  + DashboardError + MediaManagerLike programmatic API, and objectInsights providers.
  Use when mounting or gating the console, wiring console login, building custom admin
  routes over storage, or adding object insights.
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
(`./dashboard_provider`); `@adonis-agora/media-dashboard` is its standalone build source +
a thin delegate provider for hosts that prefer an explicit install.

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
  middleware: middleware.auth(), // gate the whole console — SPA + API
})
```

`node ace configure @adonis-agora/media` registers both providers automatically. The
`actions`-only routes are always mounted; the gate lives one layer down in
`DashboardService`, which throws `403` when `actions` is false.

Source: `docs/dashboard/index.mdx`.

## Core patterns

### Pattern 1 — built-in session auth (Mode A / Mode B)

`auth` gives the console its own signed cookie so a plain browser navigation works even
when your app's auth is not cookie-shaped:

```ts title="config/media_dashboard.ts"
import { defineConfig } from '@adonis-agora/media/dashboard'

export default defineConfig({
  auth: {
    secret: env.get('MEDIA_CONSOLE_SECRET'), // required — missing/empty is a boot error
    ttl: '8h',
    // Mode A: mint from your app's own auth on the raw request
    async session(request) {
      const token = request.headers.authorization?.replace('Bearer ', '')
      if (!token) return null
      const user = await verifyAccessToken(token)
      return user?.roles.includes('admin') ? { id: String(user.id), roles: user.roles } : null
    },
    // Mode B: validate credentials from the built-in login screen (optional)
    // async login(username, password) { ... },
    async revalidate(user) { // checked at sliding renewal; false ⇒ cookie cleared, 401
      const admin = await Admin.find(Number(user.id))
      return admin !== null && !admin.suspended
    },
  },
}
```

Configure both modes and the login screen offers both (learned from the `401` body of
`GET /me`). The auth routes (`/me`, `/login`, `/session`, `/logout`) are deliberately mounted
OUTSIDE both gates — they create the session the guard checks for.

Source: `docs/dashboard/authentication.mdx`.

### Pattern 2 — reuse the console's engine under your own routes

`DashboardService` is framework-free (typed over the structural `MediaManagerLike`), so your
own admin screens get the same paging and transfer engine:

```ts title="start/routes.ts"
import { MediaManager } from '@adonis-agora/media'
import { DashboardService, DashboardError } from '@adonis-agora/media/dashboard'

const media = await app.container.make(MediaManager)
const dashboard = new DashboardService(media, { diskNames: ['s3'], actions: true })

router.get('/admin/storage/objects', async ({ request, response }) => {
  try {
    return await dashboard.objects(request.input('disk'), {
      prefix: request.input('prefix', ''),
      cursor: request.input('cursor'),
      limit: 100,
    })
  } catch (error) {
    if (error instanceof DashboardError) {
      return response.status(error.status).json({ error: error.message })
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
export default defineConfig({ actions: true }) // no middleware, no auth
```

Correct:

```ts
export default defineConfig({
  actions: true,
  middleware: middleware.auth(),
  auth: { secret: env.get('MEDIA_CONSOLE_SECRET'), login: checkAdminPassword },
})
```

Mechanism: `actions: true` enables copy/move/delete, recursive folder sweeps, record
deletion, upload aborts and uploads — recursive delete/move are destructive and
irreversible. The routes are mounted regardless of `enabled`; only `middleware`/`auth`
keep them from being open to the internet.
Source: `docs/dashboard/index.mdx` (warn callout, Folder operations warn).

### [HIGH] Configuring dashboard auth with neither a session nor a login hook

Wrong:

```ts
auth: { secret: env.get('MEDIA_CONSOLE_SECRET') } // no way to mint a session
```

Correct:

```ts
auth: { secret: env.get('MEDIA_CONSOLE_SECRET'), session: mySessionHook }
```

Mechanism: at least one of `session`/`login` must be present — configuring `auth` with
neither is a boot error by design (a gate nothing can mint a session for would lock the
console permanently). A hook that THROWS is treated as denial, never a 500.
Source: `docs/dashboard/authentication.mdx` (The two modes table).

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

### [MEDIUM] Registering both the embedded and standalone console providers

Wrong:

```ts
providers: [
  () => import('@adonis-agora/media/dashboard_provider'),
  () => import('@adonis-agora/media-dashboard/media_dashboard_provider'), // duplicate
]
```

Correct:

```ts
providers: [
  () => import('@adonis-agora/media/media_provider'),
  () => import('@adonis-agora/media/dashboard_provider'),
]
```

Mechanism: the standalone provider is a thin delegate to the embedded one — registering both
mounts the console twice. Register exactly one of the two; both read the same
`media_dashboard` config key.
Source: `docs/dashboard/index.mdx` (Standalone install legacy).

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
and console launcher it embeds.
