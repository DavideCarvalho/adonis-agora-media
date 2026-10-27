---
'@adonis-agora/media': minor
---

Dashboard: the `authorize` hook now follows the dashboard-gate contract shared by every `@adonis-agora` console. It may return `boolean | AuthorizeDecision` (`{ allowed, reason?: 'unauthenticated' | 'forbidden' }`); both types are exported from `@adonis-agora/media/dashboard`. `{ allowed: false }` denies (previously a decision object was truthy and would have been let through), `reason: 'unauthenticated'` answers `401` (`{ error: 'Unauthorized' }` JSON on the API, the "Sign in required" access-denied page on a navigation), and a bare `false`, a missing reason, `'forbidden'` or a throw keep answering `403`. A redirect — or a body — the hook wrote still wins, now on the API as well as on the page.
