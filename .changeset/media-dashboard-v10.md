---
"@adonis-agora/media-dashboard": major
---

Remove the standalone console provider. The console ships in `@adonis-agora/media`; register its provider instead.

- **Removed:** the `@adonis-agora/media-dashboard/media_dashboard_provider` subpath and the `MediaDashboardProvider` export from `@adonis-agora/media-dashboard`. Replace `() => import('@adonis-agora/media-dashboard/media_dashboard_provider')` with `() => import('@adonis-agora/media/dashboard_provider')` in `adonisrc.ts`. `config/media_dashboard.ts` is unchanged.
- The package now only exports the console's API types (`.` and `./types`).
- The console reads its runtime config only from the JSON data block the provider injects; a `window.__MEDIA_DASHBOARD__` global is no longer read.
- The `@adonis-agora/media` and `@adonisjs/core` peers are removed: the package no longer imports either, so installing it requires neither.
