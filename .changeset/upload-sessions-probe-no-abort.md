---
"@adonis-agora/media": patch
---

Fix: on a table without the new `updated_at` column, starting an upload inside a transaction failed on Postgres ("current transaction is aborted"). The column check ran a query that fails when the column is missing, which aborts the surrounding transaction (Lucid's global test transaction, or a request wrapped in one). It now reads `information_schema` (`PRAGMA table_info` on SQLite) and never fails.
