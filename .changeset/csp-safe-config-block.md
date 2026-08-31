---
"@adonis-agora/media": patch
"@adonis-agora/media-dashboard": patch
---

Dashboard: every API request 404 under a nonce CSP — fixed.

The provider used to hand the SPA its bootstrap (API base, uploads base, tus base, actions) as an
inline `<script>` setting `window.__MEDIA_DASHBOARD__`. A host with `script-src 'self' 'nonce-…'`
(`@adonisjs/shield`'s `@nonce`, the recommended setup) drops that script silently; the SPA then fell
back to `/media/dashboard/api`, and on any other mount path every request from a console that
rendered perfectly well answered 404. The bootstrap now travels as a
`<script type="application/json">` data block, which is never executed and so cannot be refused.
Nothing to change on the host; the global is still honoured as a fallback.
