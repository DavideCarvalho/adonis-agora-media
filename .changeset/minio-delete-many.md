---
"@adonis-agora/media": patch
---

`S3Disk.deleteMany` now works on MinIO versions that reject `DeleteObjects` with `MissingContentMD5`: it falls back to single deletes and remembers.
