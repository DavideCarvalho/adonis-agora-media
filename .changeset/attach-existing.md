---
'@adonis-agora/media': minor
---

Bridge already-stored objects into the media library without copying their bytes.

- `MediaLibrary.attachExisting({ ownerType, ownerId, collection, key, disk?, fileName, mimeType, size?, ... })` registers an object that already exists on a disk as a `MediaRecord` — zero-copy: the bytes are never downloaded or rewritten, and `size` is resolved from the object's metadata when omitted. Everything after storage matches `attach()` (collection resolution, `acceptsMimeTypes`, `single: true` atomic replace, ordering, eager conversions, `attach` diagnostics), which both paths now share. A missing key throws the new `MediaObjectMissingError`. Opt into `moveIntoLayout: true` to relocate the object into the library's key layout via the disk's native server-side move (`ExtendedDisk`, e.g. `disks.s3()`); it never streams bytes through the app to emulate one.
- `MediaManager.completeUploadToLibrary(sessionId, input)` finishes a resumable (TUS) session and attaches the assembled object in one step. `resumable.complete()` is unchanged and remains the raw primitive.
- `MediaLibrary.for(...)` bindings expose `attachExisting` alongside `attach`.
