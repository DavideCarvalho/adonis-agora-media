---
'@adonis-agora/media-dashboard': minor
'@adonis-agora/media': minor
---

Console shell: the media console is rebuilt on the Agora console kit, the shell every `@adonis-agora` console now shares. Its accent is amber (the access-denied page follows).

- Left sidebar with the brand (the console switcher), nav grouped as LIBRARY (Library, Collections) and TRANSFERS (Uploads, Upload), and a footer with the signed-in user, a theme toggle and sign-out. Below 768px the sidebar becomes a drawer.
- Topbar with the page title, the organization picker, the disk / uploads / actions pills, the live dot and ⌘K search across consoles.
- Each page opens with metric cards (disks and folder contents, record totals, sessions in progress). Library rows keep Preview inline and move copy key / copy / move / rename / delete into a row menu. Lists page with "Load more" on the cursor envelope.
- Light mode. The theme is remembered per console in localStorage.
- Fonts are bundled (Sora, JetBrains Mono); the page no longer loads Google Fonts.
- Every page and region has its own error boundary with a retry button, shaped skeletons and empty states.

Server: the page's data block gains `search`, `viewer` and `signOut`. The new `viewer(ctx)` config option sets the user row; without it the console reads `ctx.auth.user` when the request is already authenticated. The new `signOut` option takes a POST action path, `{ href }` or `false`; without it the console uses the sign-out an account console announces on the `agora.consoles` registry (`account.signOut`). A POST sign-out carries the request's CSRF token.
