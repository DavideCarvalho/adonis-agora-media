---
'@adonis-agora/media': patch
---

Normalize generic/truncated MIME declarations from the file extension, and list the accepted types in the rejection

**Better error message.** `MimeNotAllowedError` (code `E_MEDIA_MIME_NOT_ALLOWED`) now includes the collection's `acceptsMimeTypes`, so a rejected upload is instantly diagnosable: `MIME type "text" is not allowed in collection "dataset". Allowed: text/csv, text/plain.` The error also carries the list on a new `accepted` field.

**MIME normalization.** Adonis multipart sometimes reports a bare top-level type (`"text"` instead of `"text/csv"`), which used to be rejected outright. Now `attach` / `attachExisting` treat a generic or non-whitelisted declaration as ambiguous and try to pin a concrete MIME from the file extension via a small built-in map (`.csv` → `text/csv`, `.tsv`, `.txt`, `.xlsx`/`.xls`, `.json`, raster images, `.svg`, `.pdf`, common video containers). When the extension resolves to a type the collection **does** whitelist, that normalized value is what the record stores (and what the disk's `Content-Type` and the content-signature check use). The whitelist stays authoritative — the resolved type must be on it, and the magic-byte check still runs — so nothing is loosened; an unresolvable or non-whitelisted result still throws `MimeNotAllowedError` with the allowed list.
