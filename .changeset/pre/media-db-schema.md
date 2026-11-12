---
'@adonis-agora/media': minor
---

`stores.lucid({ schema })` and `uploadSessions.lucid({ schema })` put media's tables in a database schema other than the connection's (a Postgres schema, a MySQL database). Every statement names the schema, so it works on any connection without `searchPath`. Auto-create makes the schema when missing, the published migrations take the same `schema`, `createMediaTables` / `dropMediaTables` and `media:tenancy:backfill --schema` accept it, SQLite fails at boot when it is set, and `agora:doctor --deep` checks it (`media.db-schema`, registered only when a schema is set). The auto-created table now also works on MySQL (identifiers are quoted per dialect). Without `schema` nothing changes.
