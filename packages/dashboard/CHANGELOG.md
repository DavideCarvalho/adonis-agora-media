# @adonis-agora/media-dashboard

## 8.1.0

### Minor Changes

- [#80](https://github.com/DavideCarvalho/adonis-agora-media/pull/80) [`e83f7d2`](https://github.com/DavideCarvalho/adonis-agora-media/commit/e83f7d2ca0d57ca2af770d7b9385b18fb96c60c2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **Breaking (0.x minor):** the dashboard's paginated listings now use the ecosystem's shared **cursor** pagination interface, the same one `@adonis-agora/filter` defines — `{ after, first }` in, `{ …items, nextCursor, prevCursor, hasNext, hasPrev }` out. Every `@adonis-agora/*` library is converging on that interface so a caller learns it once.
  
  Filter defines two mechanisms — offset and cursor. This package adopts the **cursor** one (not offset), because its listings are backed by S3's `ListObjectsV2` continuation token and, for `/collections`, a `createdAt`/`id` keyset. Those are opaque, forward-only handles to *what comes next*: there is no way to compute an offset or seek to page 7, so cursor is the honest match rather than a workaround.
  
  **Forward-only, deliberately.** Filter's `CursorParams` also carries `before` / `last`; this package does **not** accept them — better a compile error than a silently ignored parameter — and pins `prevCursor: null` / `hasPrev: false` in every response. Those two fields stay present so the page *is* the ecosystem's `CursorPage` shape rather than a near-miss of it. Walk forward and keep the pages you've seen (which is what the console SPA does).
  
  What changed:
  
  - `DashboardService.objects(disk, { prefix?, cursor?, limit? })` → `objects(disk, { prefix?, after?, first? })`. Its result `{ folders, files, cursor? }` → `{ folders, files, nextCursor, prevCursor, hasNext, hasPrev }`. `objects` keeps **two** payload arrays instead of a single `items`: a delimiter listing returns folders (common prefixes) *and* files in the same page, and merging them would lose that distinction — its type is `CursorPageInfo & { folders, files }`, i.e. filter's page envelope with a two-part payload.
  - `DashboardService.collections({ …filters, cursor?, limit? })` → `collections({ …filters, after?, first? })`, returning `CursorPage<MediaEntry>` verbatim (`items` + the envelope) instead of `{ items, nextCursor }`.
  - Routes: `GET /objects` and `GET /collections` now read `?after=&first=` instead of `?cursor=&limit=`.
  - New exported types on both `@adonis-agora/media/dashboard` and `@adonis-agora/media-dashboard/types`: `CursorParams`, `CursorPage<T>`, `CursorPageInfo`.
  - Page sizes are unchanged — the SPA still asks for 50 per page, only the parameter name moved.
  
  Not changed: `MediaStore.list` and the `ExtendedDisk.list` driver keep their `{ cursor, limit }` → `{ items, nextCursor }` / `{ folders, files, cursor }` vocabulary. Those are persistence/driver SPIs that custom stores and disks implement, not listing APIs a client calls; the dashboard maps `after` → `cursor` and `first` → `limit` at its boundary.
  
  Migration — a hand-rolled route over `DashboardService`:
  
  ```ts
  // before
  const page = await dashboard.objects('s3', {
    prefix: request.input('prefix'),
    cursor: request.input('cursor'),
    limit: 100,
  })
  render(page.folders, page.files)
  const more = page.cursor
  
  // after
  const page = await dashboard.objects('s3', {
    prefix: request.input('prefix'),
    after: request.input('after'),
    first: 100,
  })
  render(page.folders, page.files)
  const more = page.hasNext ? page.nextCursor : null // prevCursor is always null: forward-only
  ```
  
  And a browser client call:
  
  ```ts
  // before
  await client.collections({ ownerType: 'Post', cursor: page.nextCursor ?? undefined, limit: 50 })
  // after
  await client.collections({ ownerType: 'Post', after: page.nextCursor ?? undefined, first: 50 })
  ```

### Patch Changes

- [#81](https://github.com/DavideCarvalho/adonis-agora-media/pull/81) [`cbcd113`](https://github.com/DavideCarvalho/adonis-agora-media/commit/cbcd113708e2005830951683a3d4d5b6ee45d1a2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Dashboard SPA rebuilt against `@base-ui/react` 1.8 and PostCSS 8.5.28. No source changes and no API change — the shipped `dist/spa` bundle just picks up the newer upstream components.

## 8.0.3

### Patch Changes

- [#63](https://github.com/DavideCarvalho/adonis-agora-media/pull/63) [`a90e230`](https://github.com/DavideCarvalho/adonis-agora-media/commit/a90e230d3fea035345238922052d0988bd3c4c2a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Dashboard: every API request 404 under a nonce CSP — fixed.
  
  The provider used to hand the SPA its bootstrap (API base, uploads base, tus base, actions) as an
  inline `<script>` setting `window.__MEDIA_DASHBOARD__`. A host with `script-src 'self' 'nonce-…'`
  (`@adonisjs/shield`'s `@nonce`, the recommended setup) drops that script silently; the SPA then fell
  back to `/media/dashboard/api`, and on any other mount path every request from a console that
  rendered perfectly well answered 404. The bootstrap now travels as a
  `<script type="application/json">` data block, which is never executed and so cannot be refused.
  Nothing to change on the host; the global is still honoured as a fallback.

## 8.0.2

### Patch Changes

- [#61](https://github.com/DavideCarvalho/adonis-agora-media/pull/61) [`85979d7`](https://github.com/DavideCarvalho/adonis-agora-media/commit/85979d7014f5d95b01142aac91fe3268bbfa54ef) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Dashboard rebuilt on Tailwind 4, React 19 and Vite 8 — same tokens and layout; opacity
  modifiers now resolve through `color-mix` instead of the old colour-function trick.

## 8.0.1

### Patch Changes

- [#57](https://github.com/DavideCarvalho/adonis-agora-media/pull/57) [`331f53f`](https://github.com/DavideCarvalho/adonis-agora-media/commit/331f53f6294f3b7e4261bdbf65fb8090063aa673) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Ship TanStack Intent agent skills with every package. Each package now publishes a
  `skills/` directory (`media-*` SKILL.md files) that lands in `node_modules` on install, so
  AI coding agents can discover them via `npx @tanstack/intent list`; adds `@tanstack/intent`
  as a devDependency for `intent validate` in CI.

## 8.0.0

### Patch Changes

- Updated dependencies [[`e2baf99`](https://github.com/DavideCarvalho/adonis-agora-media/commit/e2baf993dae1a7d3574128085abe1cf48087a023)]:
  - @adonis-agora/media@0.12.0

## 7.0.0

### Major Changes

- [`ad61387`](https://github.com/DavideCarvalho/adonis-agora-media/commit/ad61387aba714ba85ce6a6cf810b97259db46a93) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **Breaking:** the console's server-side logic (`defineConfig`/`MediaDashboardConfig`, `DashboardService`/`DashboardError`, the session-auth helpers, `ObjectInsightProvider`/`sanitizeInsight`) has moved to `@adonis-agora/media`'s new `@adonis-agora/media/dashboard` subpath, now that the console ships embedded there (see `@adonis-agora/media`'s changeset). Update any import of these from `@adonis-agora/media-dashboard` (or this package's root `.`) to `@adonis-agora/media/dashboard`.

  `@adonis-agora/media-dashboard/media_dashboard_provider` is unaffected in behavior and still works exactly as before — it is now a thin delegate to `@adonis-agora/media`'s embedded `dashboard_provider` (dynamically imported at boot, to avoid a monorepo build-time cycle between the two packages) rather than owning the routing/auth/service logic itself, so a fix to the console applies to both entry points identically. `config/media_dashboard.ts` is read from the same `media_dashboard` config key either way; author it against `@adonis-agora/media/dashboard`'s `defineConfig` regardless of which provider you register.

  This package's own remaining public surface (`.`) is now just the provider re-export plus the dashboard's wire-format API types (`DiskInfo`, `ObjectListResponse`, `MediaEntry`, ... — kept as this package's own copy so the SPA needs no dependency on `@adonis-agora/media`'s types).

  If you don't import from this package directly (most hosts only register its provider in `adonisrc.ts`), nothing changes for you — consider switching to `@adonis-agora/media/dashboard_provider` directly, since this package is no longer required.

### Patch Changes

- Updated dependencies [[`ad61387`](https://github.com/DavideCarvalho/adonis-agora-media/commit/ad61387aba714ba85ce6a6cf810b97259db46a93)]:
  - @adonis-agora/media@0.11.0

## 6.1.0

### Minor Changes

- [`a06b2df`](https://github.com/DavideCarvalho/adonis-media/commit/a06b2df5194259be83fa08e8af15e7f9b07c48b3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Dashboard rebuilt on Tailwind + `@base-ui-components/react` + CVA, with a substantial feature port: auth (session login/logout), object insights/raw preview proxy, and record/upload detail drill-ins.

  The hand-rolled CSS SPA is replaced with Tailwind utility classes, headless `@base-ui-components/react` primitives and `class-variance-authority` variants — matching the design system already used by the sibling NestJS console, so both ecosystems share the same visual language. `FolderTree`, `DataTable` and `Lightbox` are extracted as standalone, independently-tested components; `LibraryBrowseView` absorbs the disk/collection browsing UX previously spread across ad hoc markup.

  New server-side surface backing the above:

  - `auth.ts` / `cookie.ts` — session login, session check, logout, cookie handling for the console's own auth screen (`AuthScreen.tsx`).
  - `object_insights.ts` + `DashboardService#objectInsights` — host apps register `ObjectInsightProvider`s (via `config/media_dashboard.ts`'s `objectInsights`) that annotate an object with app-specific metadata; a provider that throws is skipped rather than blocking the view.
  - `DashboardService#objectStream` — same-origin raw byte proxy so text/PDF preview inline and a CORS-locked bucket is still previewable.
  - `DashboardService#mediaRecord` / `deleteMediaRecord` — full `MediaRecord` detail (with signed conversion-variant URLs) and actions-gated delete, backing the new record-detail drill-in.
  - `DashboardService#collectionsSummary` — per-collection record-count/byte rollup for the collection chips, bounded scan so a very large library degrades to a partial summary instead of an unbounded walk.
  - `DashboardService#uploadDetail` / `abortUpload` — full resumable-session detail (+ recorded parts) and actions-gated cancel, backing the new upload-detail drill-in.
  - `DashboardService#putObject` — bounded convenience upload (buffered, capped at 100MB) distinct from the resumable TUS path.

  All additive — existing `DashboardService` consumers and the previous SPA routes are unaffected.

## 6.0.0

### Patch Changes

- Updated dependencies [[`77337c8`](https://github.com/DavideCarvalho/adonis-media/commit/77337c8ecde9589f9a006600420327eae5b6a0f2)]:
  - @adonis-agora/media@0.10.0

## 5.0.0

### Patch Changes

- Updated dependencies [[`a44014e`](https://github.com/DavideCarvalho/adonis-media/commit/a44014eb05c1aea460c163b1dd68c98bee01c284), [`75649a9`](https://github.com/DavideCarvalho/adonis-media/commit/75649a9c6793f9f8fc83da07ee2418ab9ff8432b), [`f81478e`](https://github.com/DavideCarvalho/adonis-media/commit/f81478e7a683347fa4ba56c9fb8d5614c2e95477)]:
  - @adonis-agora/media@0.9.0

## 4.0.0

### Patch Changes

- Updated dependencies [[`92006a0`](https://github.com/DavideCarvalho/adonis-media/commit/92006a032290c6d7e61d4b34184553127992ea5c)]:
  - @adonis-agora/media@0.8.0

## 3.0.0

### Patch Changes

- Updated dependencies [[`afdc1f4`](https://github.com/DavideCarvalho/adonis-media/commit/afdc1f4ec0b46d5b8ed29e3e586e443dd28d940d)]:
  - @adonis-agora/media@0.7.0

## 2.0.0

### Patch Changes

- Updated dependencies [[`5ffebf8`](https://github.com/DavideCarvalho/adonis-media/commit/5ffebf8173a5aa69a83eb13675927da2107fa323)]:
  - @adonis-agora/media@0.6.0

## 1.0.0

### Patch Changes

- Updated dependencies [[`256a11e`](https://github.com/DavideCarvalho/adonis-media/commit/256a11e034118435b2c29a1b7ac7c0c6c05ac5b6)]:
  - @adonis-agora/media@0.5.0

## 0.2.0

### Minor Changes

- Server-side folder operations (create, truly-recursive delete, copy/move) + fix the empty-name "/" folder that froze the disk browser. Widen the `@adonis-agora/media` peer range to accept `0.4`.

## 0.1.0

Primeira versão. Console de gerenciamento de mídia (SPA React + API JSON) sobre o
`MediaManager` do `@adonis-agora/media`.

Peer em `@adonis-agora/media@^0.2.0`.
