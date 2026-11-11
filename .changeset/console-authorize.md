---
"@adonis-agora/media": major
---

The media console is closed in production until you set `authorize`. Without `authorize` in `config/media_dashboard.ts`, the console is open outside production and refuses every request (`403`) in production, with a warning at boot. Before, it was open in every environment unless `middleware` or `auth` closed it. `authorize` runs before `middleware` and `auth`, so a console guarded only by those needs `authorize` too, for example `authorize: () => true` to keep your middleware as the gate.

`authorize` now takes the access contract shared by every Agora console, in three forms: an inline function `(ctx) => result`, a `ConsoleAuthorizer` class (built through the container, so `@inject()` works), or a lazy import of one (`() => import('#policies/console_access')`, loaded once). A check may also answer `{ redirectTo: '/login' }`: page navigations are redirected there and API calls get `401`. Every result the hook accepted before keeps working, and a check that throws is still a `403`.

The `DashboardAuthorize`, `AuthorizeResult` and `AuthorizeDecision` types are replaced by `ConsoleAuthorize`, `ConsoleAuthorizeResult` and `ConsoleAuthorizer`, exported from `@adonis-agora/media/dashboard` together with `resolveConsoleAuthorize`.
