---
"@adonis-agora/media-dashboard": minor
---

Require @adonis-agora/media 0.18

The peer range moves from `>=0.11.0 <1.0.0` to `>=0.18.0 <1.0.0`, and the exact copy
pinned for types moves with it — the two are asserted equal by
`src/provider/peer_resolution.spec.ts`, because a pin above the floor would leave the
oldest supported version untested against the `./dashboard_provider` subpath this package
delegates to.

Projects on @adonis-agora/media 0.11 through 0.17 need to upgrade it alongside this
release. Nothing in this package's own API changes.
