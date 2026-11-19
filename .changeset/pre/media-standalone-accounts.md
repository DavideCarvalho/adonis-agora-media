---
'@adonis-agora/media': minor
---

`media.accounts` in an app that keeps its own media: `accounts: { url, partition, token }` in `config/media.ts` (same fields as `tenant`, without `urls`) points a standalone app at the control plane that keeps people's account files (an avatar), while `media.library` stays on the app's own disks and store. Refused on a tenant (which uses `tenant`) and on a control plane.
