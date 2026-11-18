---
'@adonis-agora/media': minor
---

Federated console: `proxyObjects` on an `apps` entry serves that app's object bytes from this console (same origin), fetching them from the app with optional `headers` (a service token). Previews, thumbnails and "Open" then work without a session in the other app and under a strict `img-src`. New `authorizeAgoraCaller()` lets another Agora app holding `media:objects:read` read `GET <apiBase>/object/raw`, and `capabilityAllows()` is exported. `object/raw` now serves HTML, SVG, XML and scripts as downloads with a sandboxing CSP and `nosniff`.
