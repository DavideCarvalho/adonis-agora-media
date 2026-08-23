---
name: media-setup
description: >-
  Install and configure @adonis-agora/media in an AdonisJS app. Covers node ace
  configure (media_provider + dashboard_provider registration), config/media.ts via
  defineConfig with stores/processors/disks/uploadSessions factory maps, the
  media singleton from @adonis-agora/media/services/main, disk resolution precedence
  (per-call > collection > top-level disk > Drive default), lazy optional peers
  (@adonisjs/lucid, sharp, @aws-sdk/client-s3, mediabunny), StoreNotConfiguredError,
  DriveNotReadyError, and the embedded console provider. Use when setting up media,
  choosing a MediaStore, wiring disks, or fixing boot errors.
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

Install Drive (the storage backend) plus the package, then run the configure codemod:

```bash
node ace add @adonisjs/drive   # required — media owns no disk drivers
npm i @adonis-agora/media
node ace configure @adonis-agora/media
```

`configure` registers **both** providers in `adonisrc.ts`, publishes `config/media.ts`
and `config/media_dashboard.ts`, and publishes two Lucid migrations (one for the optional
`lucid` media store, one for the upload-session store). Delete the migrations you don't
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
