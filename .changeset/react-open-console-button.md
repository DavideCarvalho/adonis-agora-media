---
'@adonis-agora/media-react': minor
---

`OpenMediaDashboardButton` — a drop-in launcher for the `@adonis-agora/media-dashboard` console, ported from the NestJS sibling console's `open-console-button.tsx` so both ecosystems ship the same building block.

Three tiers, same behaviour underneath:

- `openMediaDashboard` / `mintMediaDashboardSession` / `mediaDashboardUrl` / `mediaDashboardSessionUrl` — no React at all: mint a console session from your own app's auth and get back the URL to navigate to.
- `useOpenMediaDashboard` (+ `openMediaDashboardMutationOptions`) — a hook exposing `open`/`isPending`/`error`, for a host that wants its own markup.
- `OpenMediaDashboardButton` — a deliberately unstyled `<button>` that forwards `className`/`style`/every other button prop (so it inherits the host's design system) and renders a mint refusal by default rather than swallowing it.

A refused session mint throws `ConsoleSessionError`. Purely additive — new exports only.
