---
'@adonis-agora/media': patch
---

`services/main` no longer throws when imported before `MediaProvider.register()`

The `@adonis-agora/media/services/main` singleton used a provider-captured `getBootedApp()` with a
top-level `await` — importing it before `MediaProvider.register()` ran (e.g. the ace command loader
reading command metadata during `node ace list`) threw `app accessed before MediaProvider registered`.

It now follows the ecosystem-standard pattern used by `@adonisjs/lucid`, `@adonisjs/drive` and
`@adonisjs/queue`: read the app from `@adonisjs/core/services/app` (whose binding is set by
`bin/server`/`bin/console` before any command module is imported) and capture the `MediaManager`
inside `app.booted(...)`. Importing the singleton is now safe at any time; the manager resolves once
the app boots.
