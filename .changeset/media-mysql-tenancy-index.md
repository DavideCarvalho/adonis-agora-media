---
'@adonis-agora/media': patch
---

Tenancy on MySQL: the `media_tenant_owner_idx` index (tenant, owner type, owner id, collection) was over InnoDB's 3072-byte key limit under utf8mb4, so the tenancy migration and the auto-added tenant column failed there. On MySQL the index now covers the first 191 characters of each column; Postgres and SQLite are unchanged. Re-running the tenancy migration after a failed MySQL attempt (column added, index missing) now completes it.
