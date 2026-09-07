---
"@adonis-agora/media": patch
---

Security: a client-supplied upload `fileName` could escape its storage prefix via path traversal —
fixed.

`MediaLibrary#layoutPath` (used by `attach`/`attachExisting`) and the default `keyFor` of both
`DirectUploadHandler` and `TusUploadHandler` interpolated the caller's `fileName` straight into a
storage key: `${owner}/${collection}/${id}/${fileName}` or `uploads/${token}/${fileName}`. A file
name of `../../../../etc/passwd` (or an absolute path) walked the resulting key outside its intended
prefix, the same class of bug transformer output paths were already guarded against via
`assertSafeArtifactPath`.

The same problem existed in the separate, older adonis-attachment-style API:
`AttachmentManager#createFromFile` (`attachment.ts`) built its storage key as
`${keyPrefix}/${id}/${fileName}` from the same unsanitized, client-supplied `fileName`. That call
site gets the identical fix below. (`single_file_store.ts`'s `storeSingleFile`/`storeSingleFileWith`
build no storage key of their own — they delegate to `MediaLibrary.attach`, so they were already
covered once `#layoutPath` was fixed.)

Every one of those call sites now runs the file name through a new `sanitizeFileName` helper first:
it must be exactly one path segment — no `/` or `\`, not empty, not `.`/`..`, and free of control
characters — or it throws `UnsafeFileNameError` (`E_MEDIA_UNSAFE_FILE_NAME`). `DirectUploadHandler`
and `TusUploadHandler` map that to a `400` instead of leaking a storage-layer crash;
`AttachmentManager#createFromFile` throws it directly, the same way `MediaLibrary.attach` does, for
the caller to handle. Ordinary file names (including unicode ones) are unaffected; only
path-traversal- and absolute-path-shaped names are rejected.
