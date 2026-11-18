---
'@adonis-agora/media': patch
'@adonis-agora/media-dashboard': patch
---

An app without `@adonisjs/drive` (no `drive.manager` binding) no longer fails every media call with "Cannot resolve binding drive.manager": Drive's service is only loaded when the app registers it, so the store and the console work; a disk outside `disks` then fails with `DriveNotConfiguredError`, which names the cause. The console of an app with no storage of its own (no `config/drive.ts`, no `disk`/`disks` in `config/media.ts`, e.g. one that only hosts the federated console) now says so, with a button for each of the other apps, instead of showing failing pages. `topology` gains `storage`.
