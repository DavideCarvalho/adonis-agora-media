---
'@adonis-agora/media': minor
'@adonis-agora/media-dashboard': minor
---

Federated console: `proxyActions` on an `apps` entry sends this console's actions on that app's media (delete, copy, move, folders, delete record, cancel upload) to the app's own console API over HTTP (`POST` on its `origin` + `apiPath`, headers only to that origin, `redirect: 'manual'`), and the app runs them with its own store and disks. A new per-app `actions` overrides the console's own switch for that app. `/apps` now says, per app, `mode: 'federated'` and who runs its actions (`actions: 'app' | 'none'`).

App side: `authorizeAppCaller({ identify, permit })` lets another app's console read object bytes (`media:objects:read`) and run the action routes (`media:objects:write`, listed in `MEDIA_ACTION_ROUTES`), with presets `identifyAgoraCaller()` / `identifySharedSecret()` and `permitTokenCapabilities()` / `permitAll()`. `authorizeAgoraCaller()` takes `actions: true` to open the action routes. `mediaCallerCsrfExceptions()` lets those calls through shield's CSRF check.

Console UI: federated apps carry a "federated" badge in the App picker, a notice at the top of the page says where their data comes from and who runs actions, and the actions of a read-only federated app show disabled with the reason.
