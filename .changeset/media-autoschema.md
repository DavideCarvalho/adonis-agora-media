---
'@adonis-agora/media': minor
---

feat(media): auto-create the `media` table on first use (ecosystem convention)

`LucidMediaStore` now auto-creates its table by default (`autoCreateSchema: true`),
matching `@adonis-agora/authz` and `@adonis-agora/durable` — a lib owns its own schema.
Exports `createMediaTables` / `dropMediaTables` from the package root (and the
`@adonis-agora/media/stores/lucid-schema` subpath) so an app that prefers explicit
control can set `autoCreateSchema: false` and run the same DDL from a migration.
