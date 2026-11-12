---
'@adonis-agora/media': patch
---

`stores.lucid({ connection })`: auto-creating the `media` table (and the tenant column) now runs on the configured connection. It used to run on the default connection, so the table was created in the wrong database and the store's first query failed.
