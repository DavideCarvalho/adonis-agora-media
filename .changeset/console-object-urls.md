---
"@adonis-agora/media": minor
---

Console: new `objectUrls` option — report object URLs through the console's own proxy, for a store
the browser cannot reach.

Every object the console shows carries a `url`: what "Open ↗" links to, and the `src` of the image
/ video / audio previews. It was always a short-lived signed URL straight to the object store, which
silently assumes the browser has a route to that store. On a deployment where it does not — a
private bucket on an internal network, a MinIO addressed by an in-cluster hostname, a policy against
client-to-bucket traffic — that URL is signed for the INTERNAL endpoint and resolves nowhere in a
browser (`ERR_NAME_NOT_RESOLVED`). The console had the bytes available same-origin the whole time
(`GET /object/raw`, which the PDF and text previews already use) and linked past them anyway.

`objectUrls: 'proxy'` in `config/media_dashboard.ts` makes `GET /object` (and the per-conversion
variant URLs of `GET /media-record`) report `<apiBasePath>/object/raw?disk&key` instead — same
origin, same auth as the rest of the console. `'auto'`, the default, is the previous behaviour
unchanged, so nothing moves for a store the browser can reach.

Same option name and same two values as the NestJS sibling console, so the two answer "the bucket
is not reachable from the browser" identically.
