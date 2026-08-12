---
'@adonis-agora/media': minor
---

The management console now ships **embedded** — `@adonis-agora/media/dashboard_provider` mounts the same React SPA + JSON API `@adonis-agora/media-dashboard` always has, straight from this package. `node ace configure @adonis-agora/media` registers it automatically (alongside publishing `config/media_dashboard.ts`); no separate `@adonis-agora/media-dashboard` install is required to get the console.

New subpath exports:

- `@adonis-agora/media/dashboard_provider` — the provider (routes: SPA + assets, JSON API, session auth). Reads the same `media_dashboard` config key `@adonis-agora/media-dashboard`'s provider always did, so an existing `config/media_dashboard.ts` keeps working unchanged if you switch to this provider.
- `@adonis-agora/media/dashboard` — `defineConfig`/`MediaDashboardConfig` for authoring `config/media_dashboard.ts`, `DashboardService`/`DashboardError`, the built-in session-auth helpers (`resolveConsoleAuth`, `signSessionCookie`, `verifySessionCookie`), `ObjectInsightProvider`/`sanitizeInsight`, and the dashboard's JSON API types.

`MediaDashboardConfig` also gains `enabled` (default `true`) — set `false` to register the provider without mounting any route.

At build time, `pnpm build` copies `@adonis-agora/media-dashboard`'s built SPA (`dist/spa`) into this package's own `dist/assets/spa`, mirroring `@adonis-agora/durable`'s embedded-dashboard pattern. `@adonis-agora/media-dashboard` remains published, standalone-installable, and its own provider (`@adonis-agora/media-dashboard/media_dashboard_provider`) still works — see that package's own changeset for what changed there. Register only one of the two dashboard providers in a given app.
