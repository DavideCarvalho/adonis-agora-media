---
"@adonis-agora/media": patch
"@adonis-agora/media-dashboard": patch
---

Console fixes:

- The console now sends shield's CSRF token (`x-xsrf-token`, from the `XSRF-TOKEN` cookie) on every POST, including uploads from the Upload tab, so actions work in apps that use `@adonisjs/shield`. A redirected or non-2xx response now shows as an error instead of a silent success.
- The Uploads tab shows `upload sessions table missing — run the media migration (node ace migration:run)` (HTTP 503) instead of a 500 when the `lucid` upload-session store's tables do not exist.
- `FolderBody` is exported from `@adonis-agora/media/dashboard` and `@adonis-agora/media-dashboard`.
