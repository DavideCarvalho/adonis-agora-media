---
'@adonis-agora/media': patch
---

Fix: streaming a file to an S3 disk always failed

The streaming fast-path (a `Readable` with a known size and no conversions, added in 0.2.0)
never worked against real S3 — every write threw:

```
Invalid value "undefined" for header "x-amz-decoded-content-length"
```

S3 cannot size a stream, so it needs `ContentLength` up front, and `S3Disk.putStream` never
sent it. `MediaLibrary.attach` and `AttachmentManager.createFromFile` made it worse: both
*gate* the fast-path on `input.size` being known and then dropped that size instead of
passing it to the disk. So the one path that had the size threw it away, and the buffered
path (which doesn't need it) is the only one that worked.

`DiskWriteOptions` gains `contentLength`; both call sites forward the size that made them
eligible; `S3Disk.putStream` sends it as `ContentLength` and throws a named error up front
when it is missing, instead of failing deep inside the AWS SDK's header layer.

If you implement a custom `Disk`, `putStream` now receives `contentLength` in its options.
Ignoring it stays valid for disks that can size their own payload.

Why the tests missed it: `s3_disk.spec.ts` asserted with `aws-sdk-client-mock`, which
intercepts the command *before* the SDK's header middleware runs, so the mocked call
happily accepted a payload the real SDK rejects. The library/attachment tests use the
in-memory disk, which holds the bytes and never needs the declaration. Both now assert the
size reaches the disk, and the in-memory disk records the `contentLength` it was handed —
but the bug was only ever visible against a live S3/MinIO.
