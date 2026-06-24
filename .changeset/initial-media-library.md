---
"@adonis-agora/media": minor
---

Initial release of `@adonis-agora/media` — a media-library for AdonisJS built on `@adonisjs/drive`.

- **MediaLibrary**: owner collections with MIME whitelist, single-file replace, and ordering; `attach`/`list`/`find`/`delete`; public and signed `url` resolution.
- **Conversions**: width/height/fit/format/quality presets, generated eagerly on attach or lazily on first `url()` and cached.
- **AttachmentManager**: adonis-attachment-style column attachments with eager image variants.
- **Storage via `@adonisjs/drive`**: disks are resolved from the Drive manager — no disk drivers are reimplemented.
- **Pluggable SPIs**: `MediaStore` (in-memory + Lucid drivers) and `ImageProcessor` (sharp). Heavy peers (`@adonisjs/lucid`, `sharp`) load lazily, only when selected.
- **Config idiom**: `defineConfig` + `stores`/`processors` factories + `media_provider` + `configure` (publishes `config/media.ts` and the `media` table migration).
- **Diagnostics**: lifecycle events emitted structurally on the `@agora/diagnostics:emit` global slot (no hard dependency).
- **Testing kit** (`@adonis-agora/media/testing`): `InMemoryMediaStore`, `InMemoryDisk` + `inMemoryDiskResolver`, and `FakeImageProcessor`.
