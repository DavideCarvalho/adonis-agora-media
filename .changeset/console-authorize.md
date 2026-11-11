---
"@adonis-agora/media": major
---

The media console is closed in production until you set `authorize`. Without `authorize` in `config/media_dashboard.ts`, the console is open outside production and in production answers `403` to every page and API request. Either way it logs once at boot: ``[@adonis-agora/media] console has no `authorize` configured: it is open outside production and denies every request in production. Set `authorize` in config/media_dashboard.ts.`` The `auth` login routes stay mounted, but a session they mint does not get past the gate. Before, it was open in every environment unless `middleware` or `auth` closed it. `authorize` runs before `middleware` and `auth`, so a console guarded only by those needs `authorize` too, for example `authorize: () => true` to keep your middleware as the gate.

`authorize` now takes the access contract shared by every Agora console, in three forms: an inline function `(ctx) => result`, a `ConsoleAuthorizer` class (built through the container, so `@inject()` works), or a lazy import of one (`() => import('#policies/console_access')`, loaded once). A check may also answer `{ redirectTo: '/login' }`: page navigations are redirected there and API calls get `401`. Every result the hook accepted before keeps working, and a check that throws is still a `403`.

API refusals now answer `{ error: 'forbidden' }` (`403`) and `{ error: 'unauthenticated' }` (`401`, plus `redirectTo` when the check asked for a redirect), the same bodies as every other Agora console. Before they were `{ error: 'Forbidden' }` and `{ error: 'Unauthorized' }`.

New `authorizeByToken({ token })` for machine access: `authorize: authorizeByToken({ token: env.get('CONSOLE_TOKEN') })` allows requests with `Authorization: Bearer <token>` and answers `401` otherwise. An empty or missing token throws when the config loads.

The `DashboardAuthorize`, `AuthorizeResult` and `AuthorizeDecision` types are replaced by `ConsoleAuthorize`, `ConsoleAuthorizeResult` and `ConsoleAuthorizer`, exported from `@adonis-agora/media/dashboard` together with `resolveConsoleAuthorize` and `authorizeByToken`.
