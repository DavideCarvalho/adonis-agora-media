---
"@adonis-agora/media": minor
"@adonis-agora/media-react": minor
---

Harden the built-in upload routes and the headers media responses send.

- `uploads.routes` no longer accepts an object key from the client. The client sends a `fileName`; the key is derived on the server (`uploads.routes.keyFor(fileName, token, ctx)`, default `uploads/<uuid>/<fileName>`). A request that still sends `key` gets a `400`.
- The disk is `uploads.routes.disk` (default: the media default disk), or one of the disks listed in `uploads.routes.disks`. Any other disk gets a `400`. A client-supplied `visibility` is ignored, and `contentType` must be a bare `type/subtype`.
- `POST /direct/initiate` now answers an `uploadToken`. The later multipart calls (presign part, complete, abort) must send `key`, `disk` and that `uploadToken`. Tokens are signed with `APP_KEY`, or with `uploads.secret` (16+ characters) when set. In production, an app that mounts `uploads.routes` without either fails to boot.
- Upload, TUS (`uploads.resumable.routes`) and direct-session (`uploads.direct.routes`) routes now take a `middleware` option, e.g. `middleware: [middleware.auth()]`. In production a group without `middleware` is not mounted and the boot fails naming the option to set; use `allowUnguarded: true` only when something else (a global middleware) guards them. Outside production they mount with a warning.
- `Content-Type` and `Vary` values that come from stored records or disks are checked before they are sent; an invalid value falls back to `application/octet-stream` instead of crashing the process.
- `@adonis-agora/media-react`: the proxy upload sends `fileName` and returns the key the server chose. `meta.key` is ignored.
