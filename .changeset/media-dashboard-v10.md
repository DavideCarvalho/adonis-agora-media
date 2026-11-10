---
"@adonis-agora/media-dashboard": major
---

Remove the standalone console provider. The console ships in `@adonis-agora/media`; register its provider instead.

- **Removed:** the `@adonis-agora/media-dashboard/media_dashboard_provider` subpath and the `MediaDashboardProvider` export from `@adonis-agora/media-dashboard`. Replace `() => import('@adonis-agora/media-dashboard/media_dashboard_provider')` with `() => import('@adonis-agora/media/dashboard_provider')` in `adonisrc.ts`. `config/media_dashboard.ts` is unchanged.
- The package now only exports the console's API types (`.` and `./types`).
- The `@adonis-agora/media` peer now accepts 1.x, including the 1.0 release candidates: `>=0.18.0 <2.0.0 || >=1.0.0-rc.0 <2.0.0`.
