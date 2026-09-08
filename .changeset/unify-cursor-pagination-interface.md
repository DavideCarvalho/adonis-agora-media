---
'@adonis-agora/media': minor
'@adonis-agora/media-dashboard': minor
---

**Breaking (0.x minor):** the dashboard's paginated listings now use the ecosystem's shared **cursor** pagination interface, the same one `@adonis-agora/filter` defines — `{ after, first }` in, `{ …items, nextCursor, prevCursor, hasNext, hasPrev }` out. Every `@adonis-agora/*` library is converging on that interface so a caller learns it once.

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
