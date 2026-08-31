---
"@adonis-agora/media": minor
---

Console: a refused page navigation now gets a real page instead of `{"error":"Unauthorized"}`,
and an `authorize` refusal is a `403` everywhere.

When `authorize` refuses, opening the console used to answer the browser with the same JSON the
API gets. It now serves a built-in access-denied page in the console's own visual language — the
status, a sentence explaining the refusal and a "Back to app" link. An `authorize` hook that
redirects still wins.

The status of that refusal changes from `401 { error: 'Unauthorized' }` to
`403 { error: 'Forbidden' }` on the API too — the hook knew who was asking and said no, which is
what every other Agora console already answers. The SPA is unaffected: it decides whether to show
its login screen from `GET /me` (ungated) and the session guard's `401 { auth: { modes } }`, which
are unchanged. Only a client scripted against the old `401` for an `authorize` denial notices.

The page carries no inline `<script>`, so a nonce'd `script-src` CSP cannot break it; its inline
`<style>` takes `@adonisjs/shield`'s request nonce when one exists.

New `accessDenied` option on `config/media_dashboard.ts` to customise it — an object (`brand`,
`title`, `message`, `homeHref`, `accent`, labels) to tweak the built-in page, or a function
`(info, ctx) => html | void` to render it yourself or redirect.

Also fixed: when `authorize` wrote a redirect on an API request, the guard still ran the route
handler on top of the `302`; it now stands down like the SPA routes do.
