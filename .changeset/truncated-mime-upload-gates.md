---
'@adonis-agora/media': patch
---

Normalize truncated MIME declarations at the TUS and direct-upload gates too

`attach` / `attachExisting` already resolve a bare top-level type (`"text"` for `report.csv`) from the file extension, but the earlier, byte-free gates did not: TUS `POST` answered `415` and `DirectUploadManager.initiate` threw `MimeNotAllowedError` for the very same upload that `attach` would accept. Both gates now share the same resolver (against the TUS `filename` / the direct-upload key), and record the normalized type — TUS sniffs the first chunk against it, direct uploads stamp it as the object's `Content-Type`. The whitelist stays authoritative: an unresolvable or non-whitelisted result is still rejected with the allowed list.
