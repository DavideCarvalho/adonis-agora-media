---
'@adonis-agora/media': patch
---

perf: fewer round-trips on the delivery hot paths.

- Proxied delivery (`deliver()` / `media.access.serve()` in `proxy` mode, `streamFile()` segments, the HLS
  delivery route's streamed segments) issues the disk's `getMetaData` and `getStream` together instead
  of one after the other — one storage round-trip less before the first byte. A metadata failure still
  wins (and the opened stream is destroyed).
- `deliver()` with `?w=` reuses the record the resize already holds instead of fetching it again; the size
  is still validated before the lookup.
- `media.access.serve()` (by id), `media.access.image()` and `media.access.stream()` hand the record they
  just fetched and authorized to the library instead of letting it look the same id up again.
- Buffered writes (`toBytes`, proxy upload to a disk without `putStream`, console upload) no longer copy
  every chunk and then the whole payload once more; HLS/DASH manifests are decoded without a copy.
