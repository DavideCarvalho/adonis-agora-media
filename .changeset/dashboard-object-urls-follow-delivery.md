---
"@adonis-agora/media": minor
---

Console: `objectUrls` follows the core `delivery.mode` when unset.

A host already streaming every read through the app (`delivery.mode: 'proxy'` in
`config/media.ts`) has declared its store unreachable from a browser — minting the console a
signed URL for the internal endpoint anyway handed it a link that resolves nowhere. With no
explicit `objectUrls` in `config/media_dashboard.ts`, the console now implies `'proxy'` from a
proxy delivery mode and keeps `'auto'` otherwise. An explicit `objectUrls` always wins, so
nothing moves for hosts that set it.
