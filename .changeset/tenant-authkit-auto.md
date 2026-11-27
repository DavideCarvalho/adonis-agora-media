---
'@adonis-agora/media': minor
---

`topology: 'tenant'` needs no `tenant` block when `@adonis-agora/authkit-client` is booted with its `service` configured: its `authkit.client.tenantOf('urn:agora:media')` supplies `tenant.url`, `tenant.token` and `tenant.partition`. Detected by shape (no dependency on authkit-client; a version without `tenantOf` counts as absent). Each field set in `tenant` wins, one by one, and `tenant: { auto: false }` turns it off. With neither, a web boot fails naming both fixes. `agora:doctor`'s `media.topology` shows where each field came from (`authkit-client (auto)` or `explicit`), and `media.control-plane` checks the filled-in client.
