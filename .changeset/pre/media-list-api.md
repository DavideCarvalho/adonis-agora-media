---
"@adonis-agora/media": major
"@adonis-agora/media-dashboard": major
---

The console's list routes use the `@adonis-agora/filter` list format.

- `GET /objects`: `?disk=&prefix=` → `?filter[disk]=&filter[prefix]=` (`filter[disk]` required). Paging stays `after` / `first` (default and max 1000). The response is `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev } }`; `data` holds folders, then files, each tagged `type: 'folder' | 'file'` (was `{ folders, files, nextCursor, prevCursor, hasNext, hasPrev }`). `sort` accepts only `key`.
- `GET /collections`: `?collection=&ownerType=&ownerId=&prefix=` → `?filter[collection]=&filter[ownerType]=&filter[ownerId]=&filter[prefix]=`. Paging stays `after` / `first` (default 50, max 200). The response is `{ data, meta }` (was `{ items, nextCursor, prevCursor, hasNext, hasPrev }`). `sort` accepts only `-createdAt`.
- `GET /uploads`: `?disk=&prefix=` → `?filter[disk]=&filter[prefix]=`; `sort=createdAt|-createdAt` (default newest first). Response `{ data }` (was `{ uploads }`).
- `GET /disks` answers `{ data }` (was `{ disks }`); `GET /collections/summary` answers `{ data }` (was `{ collections }`).
- An unknown filter field, an operator other than equality, a sort outside the route's list, or `before` / `last` is a `400`.
- `DashboardService`: `objects()` and `collections()` return `CursorPageResponse<T>` (`{ data, meta }`); `disks()`, `uploads()` and `collectionsSummary()` return `{ data }`; `uploads()` takes `order: 'asc' | 'desc'`.
- Types: `CursorPage` and `CursorPageInfo` are removed; new `CursorPageResponse<T>`, `CursorPageMeta`, `ListResponse<T>`, `ObjectListItem`, `UploadFilter`. `ObjectListResponse`, `CollectionListResponse`, `DiskListResponse`, `UploadListResponse` and `CollectionsSummaryResponse` change shape as above.
- New `readObjectsQuery`, `readCollectionsQuery` and `readUploadsQuery` in `@adonis-agora/media/dashboard` read these routes' query strings for your own routes.
- `@adonis-agora/media` now depends on `@adonis-agora/filter`.
