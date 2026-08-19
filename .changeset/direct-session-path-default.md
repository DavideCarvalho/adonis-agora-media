---
'@adonis-agora/media-react': minor
---

**`mode: 'direct'` now works with no configuration at all.** Read this if you set `uploadsPath`.

A stock `createMediaUploadClient()` talking to a stock `@adonis-agora/media` server could not upload: the client sent its direct-upload requests to `uploadsPath` (default `/media/uploads`), but the provider mounts the direct-session routes at `uploads.direct.routes.prefix`, whose default is `/media/uploads/direct/sessions`. Every direct upload 404'd on the initiate. The two packages were each internally consistent and disagreed with each other, so no unit test on either side could see it.

The client now has a separate `directPath` option for the direct-session routes, defaulting to `/media/uploads/direct/sessions` — the server's own default — while `uploadsPath` keeps addressing the core upload routes, where the proxy endpoint (`<uploadsPath>/proxy`) actually lives. They were never the same server prefix; only the client conflated them.

**Am I affected?**

- **You never set `uploadsPath`** → direct uploads were broken and now work. Nothing to do.
- **You set `uploadsPath` (the common case, and the only way direct uploads worked)** → `directPath` falls back to it, so every URL your client produces is byte-for-byte what it produced before. Nothing to do. You may now split the two if you want the proxy endpoint as well:

  ```ts
  createMediaUploadClient({
    uploadsPath: '/media/uploads',        // proxy lives here
    directPath: '/api/v1/upload-video',   // direct sessions live here
  })
  ```

- **You left `uploadsPath` at its default AND moved the server** to `uploads.direct.routes.prefix: '/media/uploads'` to meet it → this is the one configuration that changes. Either drop that server override (the defaults now line up on their own), or pin the old client behaviour explicitly:

  ```ts
  createMediaUploadClient({ directPath: '/media/uploads' })
  ```

`useMediaUpload` and `<MediaUploader>` accept `directPath` too, and forward it unchanged.

Minor rather than major: the package is pre-1.0, where minor is this repo's breaking-change channel, and the only behaviour that changes is a path that previously produced a `404` — with the single narrow exception above, which is a one-line pin. A major would force a version bump on every consumer for a fix that leaves working configurations untouched.
