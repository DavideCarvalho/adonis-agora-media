---
'@adonis-agora/media': minor
---

Faster and lighter hot paths, plus an exact console summary:

- Resumable `complete()` on a disk without native multipart streams the parts in order into `putStream` instead of concatenating the whole upload in memory (three copies of it before), so a multi-gigabyte upload no longer runs the process out of memory.
- Attaching to a collection with eager conversions reads the original once for every preset (zero times when the bytes are in hand) and records all of them in one save. `stripMetadata` strips the uploaded bytes before the single write instead of writing, reading back and rewriting them.
- `image()` builds every `srcSet` URL from the record it already fetched: one store read per image instead of one per candidate.
- Concurrent requests for the same missing lazy conversion (or on-demand size) share one generation, and conversion entries generated at once for the same media in the same process no longer overwrite each other.
- The HLS playlist route checks references against a set, the SigV4 presigner reuses the derived signing key per (secret, day, region, service), and `S3Disk` parses its endpoints once: a 1,200-segment playlist renders about 3x faster.
- `transformers.video()` uploads the package six files at a time; when one fails, the rest finish before the partial output is swept.
- The `media` table gains `(created_at, id)` and `(collection, created_at, id)` indexes for the newest-first `list()`. The auto-created schema adds them on boot; the published migration includes them. It no longer creates `media_owner_idx`, whose columns are the leftmost prefix of `media_owner_collection_idx`.
- `MediaStore` gains an optional `collectionTotals()`, implemented by both bundled stores (a `GROUP BY` in Lucid). The console's collection summary uses it and is now exact at any size, where it previously stopped counting at 5,000 records.
