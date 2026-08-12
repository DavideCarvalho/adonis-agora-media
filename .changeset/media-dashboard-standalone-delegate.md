---
'@adonis-agora/media-dashboard': major
---

**Breaking:** the console's server-side logic (`defineConfig`/`MediaDashboardConfig`, `DashboardService`/`DashboardError`, the session-auth helpers, `ObjectInsightProvider`/`sanitizeInsight`) has moved to `@adonis-agora/media`'s new `@adonis-agora/media/dashboard` subpath, now that the console ships embedded there (see `@adonis-agora/media`'s changeset). Update any import of these from `@adonis-agora/media-dashboard` (or this package's root `.`) to `@adonis-agora/media/dashboard`.

`@adonis-agora/media-dashboard/media_dashboard_provider` is unaffected in behavior and still works exactly as before — it is now a thin delegate to `@adonis-agora/media`'s embedded `dashboard_provider` (dynamically imported at boot, to avoid a monorepo build-time cycle between the two packages) rather than owning the routing/auth/service logic itself, so a fix to the console applies to both entry points identically. `config/media_dashboard.ts` is read from the same `media_dashboard` config key either way; author it against `@adonis-agora/media/dashboard`'s `defineConfig` regardless of which provider you register.

This package's own remaining public surface (`.`) is now just the provider re-export plus the dashboard's wire-format API types (`DiskInfo`, `ObjectListResponse`, `MediaEntry`, ... — kept as this package's own copy so the SPA needs no dependency on `@adonis-agora/media`'s types).

If you don't import from this package directly (most hosts only register its provider in `adonisrc.ts`), nothing changes for you — consider switching to `@adonis-agora/media/dashboard_provider` directly, since this package is no longer required.
