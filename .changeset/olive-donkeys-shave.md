---
'@adonis-agora/media': minor
---

Configurable delivery, and `acceptsMimeTypes` now validates the real file content

**Configurable delivery (`delivery`).** The library had a configurable strategy for writes (`uploads.mode`) but nothing for reads, so every consuming app re-derived the same decision by hand — and on a private bucket whose storage isn't internet-reachable, hand-rolled its own streaming route. New `delivery: { mode, signedTtlSeconds }` config (`'auto' | 'public' | 'signed' | 'proxy'`, default `auto`) plus `MediaLibrary.deliver(id, options?)`, returning a discriminated union: `{ kind: 'redirect', url }` for `public`/`signed`, `{ kind: 'stream', stream, mimeType, size, fileName }` for `proxy`.

`MediaDeliveryHandler` is the framework-agnostic route half, mirroring `TusUploadHandler`: your app mounts one route with its own middleware and delegates. Like `TusUploadHandler`, **it performs no authorization** — guard the route before calling `handle`, which is also why the provider mounts no delivery route of its own.

`auto` resolves by asking the disk for the object's visibility (`Disk.getVisibility`, optional and implemented by every Drive disk): public ⇒ `public`, otherwise ⇒ `signed`. A disk that can't answer falls back to `signed`. The bundled `disks.s3()` gained a declarative `visibility` option (default `private`) to answer it without an ACL round-trip.

**Real content validation.** A collection's `acceptsMimeTypes` used to check the caller-declared `mimeType` — which the app itself writes, routinely hardcoded — so it validated nothing about the bytes. It now also detects the type from the file's magic-byte signature and rejects content that contradicts the declaration, with a new `ContentTypeMismatchError` (`E_MEDIA_CONTENT_TYPE_MISMATCH`). Content with no recognisable signature (SVG, CSV, text, office formats) falls back to the declared type rather than being rejected.

Only the first 16 bytes are read, never the whole file: `attach` peeks the head and replays it in front of the rest, so a `Readable` payload stays streaming, and `attachExisting` does a short disk read that is torn down immediately — adopting a large object in place still never downloads it. The signature table (PNG, JPEG, GIF, WEBP, PDF) is embedded; no new dependency.
