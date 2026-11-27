---
name: media-setup
description: >-
  Install and configure @adonis-agora/media in an AdonisJS app. Covers node ace
  configure (media_provider + dashboard_provider registration), config/media.ts via
  defineConfig with stores/processors/disks/uploadSessions factory maps, the
  media singleton from @adonis-agora/media/services/main, disk resolution precedence
  (per-call > collection > top-level disk > Drive default), lazy optional peers
  (@adonisjs/lucid, sharp, @aws-sdk/client-s3, mediabunny), StoreNotConfiguredError,
  DriveNotReadyError, the embedded console provider, topology: 'tenant' (zero-config
  via authkit-client) and consoleCommands for a federated console. Use when setting up
  media, choosing a MediaStore, wiring disks, running as a tenant, or fixing boot errors.
license: MIT
metadata:
  type: core
  library: "@adonis-agora/media"
  library_version: "0.12.1"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-media:README.md"
  - "DavideCarvalho/adonis-media:docs/getting-started.mdx"
  - "DavideCarvalho/adonis-media:docs/configuration.mdx"
  - "DavideCarvalho/adonis-media:packages/adonis/src/define_config.ts"
  - "DavideCarvalho/adonis-media:packages/adonis/src/media_manager.ts"
---

# Setting up @adonis-agora/media

`@adonis-agora/media` is a media library for AdonisJS on top of `@adonisjs/drive`: owner
collections with policy, column attachments, image conversions, content transformers,
large-file uploads, configurable delivery, and an embedded management console. Storage is
delegated entirely to Drive — this package never reimplements disk drivers.

## Setup

Install the package (plus Drive only for Drive-backed disks), then run the configure codemod:

```bash
node ace add @adonisjs/drive   # optional — only for Drive-backed disks; config.disks, the store and the console work without it
npm i @adonis-agora/media
node ace configure @adonis-agora/media
```

`configure` registers **both** providers in `adonisrc.ts`, publishes `config/media.ts`
and `config/media_dashboard.ts`, and publishes three Lucid migrations (one for the optional
`lucid` media store, one for the upload-session store, one adding the nullable `tenant_id`
column tenancy needs — unused while tenancy is off). Delete the migrations you don't
need; the in-memory stores need none.

```ts title="config/media.ts"
import { defineConfig, stores, processors } from '@adonis-agora/media'

export default defineConfig({
  // disk: 's3',              // omit to use Drive's default disk
  store: 'memory',
  stores: {
    memory: stores.memory(),
    lucid: stores.lucid({ connection: 'pg' }),
  },
  imageProcessor: processors.sharp(),
  collections: [
    { name: 'avatar', single: true, acceptsMimeTypes: ['image/png', 'image/jpeg'] },
    {
      name: 'gallery',
      conversions: [
        { name: 'thumb', width: 200, height: 200 },
        { name: 'og', width: 1200, eager: true },
      ],
    },
  ],
})
```

Reach the singleton manager anywhere:

```ts
import media from '@adonis-agora/media/services/main'

const url = await media.library.url(recordId)
```

Source: `docs/getting-started.mdx`, `docs/configuration.mdx`.

### Operate from the terminal

Every console action is also a command (`configure` registers `@adonis-agora/media/commands`):
`media:disks:list`, `media:objects:list|show|upload|copy|move|rename|delete`,
`media:folders:create`, `media:collections:list`, `media:records:list|show|delete`,
`media:uploads:list|show|abort`. They use `config/media_dashboard.ts` (its disks, its `actions`
switch — changes are refused while `actions` is off — and its object URLs), `--json` prints the console API's response shape (`{ data, meta }` for the paged `objects:list` and `records:list`; `{ data }` for `disks:list`, `collections:list` and `uploads:list`), take
`--tenant=<id>` with tenancy on, and ask before a destructive change unless `--force`.

```bash
node ace media:records:list --collection=avatars --json
node ace media:objects:delete tmp/old.bin --force
```

Source: `docs/cli.mdx`.

## Core patterns

### Pattern 1 — select drivers by name from lazy factory maps

The Agora idiom: drivers live in the core package (`stores`, `processors`, `disks`,
`uploadSessions`, `transformers`), you select them **by name**, and each heavy optional peer
(`@adonisjs/lucid`, `sharp`, `@aws-sdk/client-s3`, `mediabunny`) is imported only when its
driver is selected at boot.

```ts
import { defineConfig, stores, processors, disks } from '@adonis-agora/media'

export default defineConfig({
  store: 'lucid',
  stores: { lucid: stores.lucid({ connection: 'pg' }) },
  imageProcessor: processors.sharp(),
  disks: { s3: disks.s3({ bucket: 'my-bucket', region: 'us-east-1' }) },
  disk: 's3',
})
```

Listing a driver you never select costs nothing — the thunk imports nothing until built.
An empty `defineConfig({})` gives the in-memory store on Drive's default disk, no
conversions, no upload routes, `auto` delivery, diagnostics on.

Source: `docs/configuration.mdx`.

### Pattern 2 — disk precedence

Which disk a write targets resolves per-call first, then collection, then top-level, then
Drive's default:

```ts
defineConfig({
  disk: 'public-s3',                                        // 3rd choice
  collections: [
    { name: 'invoices', disk: 'private-s3' },               // 2nd choice
  ],
})

// per-call wins over everything:
await media.library.attach({ ..., disk: 'temp-fs' })       // 1st choice
```

Where the NAME resolves from has separate precedence: the config's own `disks` map first,
then `config/drive.ts`. A record stores which disk it lives on, so moving a collection to a
new disk never strands existing files.

Source: `docs/configuration.mdx` (`disk` — where files live).

### Pattern 3 — DI instead of the service import

The provider binds one singleton `MediaManager`. Prefer it through the container when you
want testability:

```ts
import { MediaManager } from '@adonis-agora/media'

export default class PostImagesController {
  constructor(protected media: MediaManager) {}
}
// or: const media = await app.container.make(MediaManager)
```

Accessors: `media.library` (collections), `media.attachments` (column attachments),
`media.disk(name?)` (raw Drive disk escape hatch), `media.store` (cross-owner reads),
and the opt-in coordinators `media.uploads` / `media.resumable` / `media.direct`.

Source: `docs/getting-started.mdx` (Step 2), `packages/adonis/src/media_manager.ts`.

### Pattern 4 — keep the media on a control plane (`topology: 'tenant'`)

With `@adonis-agora/authkit-client` >= 1.1.0 configured with its `service` (`name`, `clientId`,
`clientSecret`, optional `partition`, in `config/authkit_client.ts`), the topology is all you
write: media fills `tenant.url`, `tenant.token` and `tenant.partition` from
`authkit.client.tenantOf('urn:agora:media')` (partition: `service.partition`, else `service.name`).

```ts title="config/media.ts (a tenant app)"
export default defineConfig({
  topology: 'tenant',
  delivery: { path: '/media/:id' },
  collections: [{ name: 'covers', access: { read: 'public' } }],
})
```

Bring your own (another client, another IdP, a shared secret): each field you set wins over
authkit-client's, one by one, and `tenant: { auto: false }` turns the detection off.

```ts
import { authkitTenantToken, controlPlaneUrl } from '@adonis-agora/authkit-client'

defineConfig({
  topology: 'tenant',
  tenant: {
    url: controlPlaneUrl({ issuer, resource: 'urn:agora:media' }), // or 'https://hub.example.com/_media'
    partition: 'entre-textos',
    token: authkitTenantToken({ issuer, clientId, clientSecret, resource: 'urn:agora:media' }),
    // or a shared secret string, or { get() } / an async function of your own
  },
})
```

Without authkit-client (or without its `service`) and without the explicit fields, the app fails
to boot naming the missing `tenant.*` fields and both fixes; `node ace agora:doctor`
(`media.topology`) shows where each came from (`authkit-client (auto)` or `explicit`). A tenant
keeps no media itself: `defineConfig` refuses `disk`, `disks`, `store`, `stores`,
`imageProcessor`, `uploads`, `tenancy`, `consoleCommands` and `accountConsole` there.
`media.library` keeps its API and runs on the control plane (`topology: 'control-plane'`, which
needs `verifyTenant`).

Source: `docs/topology.mdx` (A tenant app), `packages/adonis/src/topology/authkit_tenant.ts`.

### Pattern 5 — answer another app's federated console (`consoleCommands`)

An app shown in another app's media console (its `config/media_dashboard.ts` → `apps`) answers it
over Redis (`@adonisjs/redis`) from `config/media.ts`:

```ts title="config/media.ts"
export default defineConfig({
  consoleCommands: { connection: 'main', prefix: 'entretextos' }, // browse only
  // consoleCommands: { connection: 'main', prefix: 'entretextos', actions: true }, // allow changes
})
```

Every command is authenticated, reads included. Nothing to set when `@adonis-agora/crypto` runs in
the app (commands sealed with its key `console-media`) or when authkit-client's `service` is
configured (the console sends an authkit app-call token; grant the console app
`media:console:*`, or `media:console:read` to browse only, on this app in authkit). Otherwise set
`secret` (16+ chars, shared with the console's `controlPlane.secret`), or bring your own with
`verifyTenant` (any IdP) / an explicit `crypto: { cipher }`. `crypto: false` and
`verifyTenant: false` turn the automatic modes off. `actions` defaults to **off**: mutations are
refused (`403`) until you opt in. Commands without the viewer's `capabilities` are refused
(`capabilities-required`). With no way to authenticate, a web process fails to boot naming the
options; `node ace agora:doctor` reports it (`media.console-commands`).

Source: `docs/dashboard/federated-console.mdx` (The other app, Authenticating the console),
`packages/adonis/src/define_config.ts` (`MediaConsoleCommandsConfig`).

## Common mistakes

### [CRITICAL] Calling the media singleton at module scope before Drive boots

Wrong:

```ts
// module scope — runs before the app (and Drive) has booted
import media from '@adonis-agora/media/services/main'
export const DEFAULT_URL = await media.library.url('seed-image')
```

Correct:

```ts
import media from '@adonis-agora/media/services/main'

export default class LogoController {
  async show() {
    const url = await media.library.url('seed-image') // inside request lifecycle
  }
}
```

Mechanism: a disk resolution reaching `@adonisjs/drive` before its manager has booted throws
`DriveNotReadyError` (`E_MEDIA_DRIVE_NOT_READY`) — almost always a media call at module scope
instead of inside a request or `app.booted`.
Source: `docs/errors.mdx` (Storage and configuration).

### [HIGH] Naming a `store` that has no matching factory entry

Wrong:

```ts
defineConfig({
  store: 'luicd', // typo
  stores: { lucid: stores.lucid() },
})
```

Correct:

```ts
defineConfig({
  store: 'lucid',
  stores: { lucid: stores.lucid() },
})
```

Mechanism: the provider throws `StoreNotConfiguredError` at boot — deliberately NOT a silent
fallback to in-memory, because a typo quietly swapping durable persistence for a process-local
Map is discovered only after data loss. Only the zero-config path (no `store` named at all)
resolves to in-memory. Same rule for upload-session stores.
Source: `docs/configuration.mdx` (How the provider builds it), `docs/errors.mdx`.

### [HIGH] Selecting lucid/sharp without installing the peer or running the migration

Wrong:

```sh
npm i @adonis-agora/media   # no @adonisjs/lucid, no sharp, no migration:run
# config selects store: 'lucid' + conversions → fails at boot / first attach
```

Correct:

```sh
node ace add @adonisjs/lucid        # or ensure it exists
npm i sharp
node ace migration:run              # published by configure for the lucid stores
```

Mechanism: the factory thunks import their peers lazily at boot-time selection; selecting
`lucid` without the published `media` table fails on the first store write, not at
`configure` time.
Source: `docs/getting-started.mdx` (Prerequisites, Callout on migrations).

### [MEDIUM] Importing the dashboard's defineConfig into config/media.ts

Wrong:

```ts
// config/media.ts
import { defineConfig } from '@adonis-agora/media/dashboard' // wrong file's helper
export default defineConfig({ collections: [{ name: 'gallery' }] })
```

Correct:

```ts
// config/media.ts
import { defineConfig } from '@adonis-agora/media'
// config/media_dashboard.ts uses:
// import { defineConfig } from '@adonis-agora/media/dashboard'
```

Mechanism: both packages export a `defineConfig`; the wrong one types the wrong file and
silently drops unknown keys instead of failing.
Source: README.md (subpath exports table), `docs/dashboard/index.mdx`.

See also: `media-library-collections/SKILL.md` — attaching to collections after setup;
`media-stores-delivery/SKILL.md` — writing custom stores/processors/disks.
