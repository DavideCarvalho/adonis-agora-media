---
'@adonis-agora/media': minor
---

Add an `authorize` option to the media dashboard config — an access-decision hook
gating the whole console (SPA + JSON API), same shape as the other `@adonis-agora`
dashboards (telescope, durable, agent):

```ts
// config/media_dashboard.ts
import { defineConfig } from '@adonis-agora/media/dashboard'
import { authorizeByRoles } from '@adonis-agora/authz'

export default defineConfig({
  authorize: authorizeByRoles({ roles: ['ADMIN'] }),
})
```

- Receives the real `HttpContext`; return `true` to allow, `false` to deny.
- Runs **before** `middleware` and composes with the built-in `auth` session guard
  (all must pass).
- A denied request answers `401`/`403` — or honors a redirect the hook wrote (a
  `location` header), so a hook can send visitors to the app's login page.
- A throwing hook fails closed (denied), never leaks the console.
- When omitted, behavior is unchanged (console open unless you gate with
  `middleware`/`auth`).

New exported type: `DashboardAuthorize`.
