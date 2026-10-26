---
'@adonis-agora/media-react': patch
---

Direct-S3 uploads `PUT` their parts in parallel, four at a time by default. The `concurrency` client option (and the per-upload one) now sets that bound; it was accepted but ignored. A failed part stops new parts from starting and rejects once the running ones settle.
