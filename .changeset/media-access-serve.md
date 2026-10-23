---
'@adonis-agora/media': minor
---

`media.access.serve(ctx, record | id, options)` is the core of the delivery route, for a controller that finds the record its own way, such as a stable `/profiles/:id/photo` URL or a record looked up by its owner. It authorizes the read (a valid signature counts), honours the query and `Accept`, answers with the right headers, and maps the library's errors to HTTP. A missing record is a 404. `deliveryRoute()` is now built on it.

Fix: in `proxy` delivery, an object whose storage type is generic (`application/octet-stream`, which S3 reports for multipart/TUS-assembled objects) is now served as the record's MIME type, for the original. A PDF uploaded through TUS was reaching browsers and phones as an opaque binary that no viewer would open.
