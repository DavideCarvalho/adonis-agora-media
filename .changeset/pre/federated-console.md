---
'@adonis-agora/media': minor
'@adonis-agora/media-dashboard': minor
---

Federated console: the media console can also show other apps' media, with an **App** selector (`?app=` in the URL). Each app keeps its own tables, disks and credentials. `config/media_dashboard.ts` gains `apps` (`label`, `store`, `uploadSessions`, `controlPlane: { connection, prefix }`, `origin`, `timeoutMs`) and `appLabel`; records, collections and upload sessions are read from the other app's tables (read-only, never created or altered), and disks, object URLs and the actions are asked of that app over Redis, which answers with `consoleCommands: { connection, prefix, actions }` in its `config/media.ts` (one instance runs each command, claimed with `SET NX`). New `GET <api>/apps`; `authorize` may grant `apps`. An unknown app answers 404, an app that does not answer 503, an app error 502, a command it does not run 501. Uploading from the console stays the console app's own.
