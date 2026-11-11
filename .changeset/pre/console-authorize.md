---
"@adonis-agora/media": major
"@adonis-agora/media-dashboard": major
"@adonis-agora/media-react": major
---

The media console is closed in production until you set `authorize`. Without `authorize` in `config/media_dashboard.ts`, the console is open outside production and in production answers `403` to every page and API request. Either way it logs once at boot: ``[@adonis-agora/media] console has no `authorize` configured: it is open outside production and denies every request in production. Set `authorize` in config/media_dashboard.ts.`` Before, it was open in every environment unless `middleware` or `auth` closed it. `authorize` runs before `middleware`, so a console guarded only by `middleware` needs `authorize` too, for example `authorize: () => true` to keep your middleware as the gate.

`authorize` now takes the access contract shared by every Agora console, in three forms: an inline function `(ctx) => result`, a `ConsoleAuthorizer` class (built through the container, so `@inject()` works), or a lazy import of one (`() => import('#policies/console_access')`, loaded once). A check may also answer `{ redirectTo: '/login' }`: page navigations are redirected there and API calls get `401`. Every result the hook accepted before keeps working, and a check that throws is still a `403`.

API refusals now answer `{ error: 'forbidden' }` (`403`) and `{ error: 'unauthenticated' }` (`401`, plus `redirectTo` when the check asked for a redirect), the same bodies as every other Agora console. Before they were `{ error: 'Forbidden' }` and `{ error: 'Unauthorized' }`.

New `authorizeByToken({ token })` for machine access: `authorize: authorizeByToken({ token: env.get('CONSOLE_TOKEN') })` allows requests with `Authorization: Bearer <token>` and answers `401` otherwise. An empty or missing token throws when the config loads.

The `DashboardAuthorize`, `AuthorizeResult` and `AuthorizeDecision` types are replaced by `ConsoleAuthorize`, `ConsoleAuthorizeResult` and `ConsoleAuthorizer`, exported from `@adonis-agora/media/dashboard` together with `resolveConsoleAuthorize` and `authorizeByToken`.

The console no longer has a login of its own: the `auth` option of `config/media_dashboard.ts` is removed, with no alias. Gone with it: the console's login screen and sign out button, the `GET /me`, `POST /login`, `POST /session` and `POST /logout` API routes, the `media_dashboard_session` cookie and its `secret`/`ttl`/`session`/`login`/`revalidate` hooks, and the exports `resolveConsoleAuth`, `signSessionCookie`, `verifySessionCookie` and the types `ConsoleAuthOptions`, `ResolvedConsoleAuth`, `ConsoleSession`, `ConsoleSessionUser`, `ConsoleSessionUserInfo`, `AuthMode`, `SessionHook`, `LoginHook`, `RevalidateHook`, `MeResponse` and `LoginBody` (from `@adonis-agora/media/dashboard` and `@adonis-agora/media-dashboard`). Sign-in is your app's own: gate the console in `authorize` and return `{ redirectTo: '/login' }` for a signed-out visitor. When one of the console's API calls answers `401`, the console follows that `redirectTo`, or reloads the page when there is none. `@adonis-agora/media-dashboard`'s client drops `me()`, `login()`, `logout()` and `ConsoleAuthState`, and takes an `onUnauthenticated` option (default `followUnauthenticated`).

`@adonis-agora/media-react` drops the console launcher, which only minted the removed console session: `OpenMediaDashboardButton`, `useOpenMediaDashboard`, `openMediaDashboardMutationOptions`, `openMediaDashboard`, `mintMediaDashboardSession`, `mediaDashboardSessionUrl`, `mediaDashboardUrl`, `ConsoleSessionError` and their types. Link to the console's `basePath` instead.
