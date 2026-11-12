---
"@adonis-agora/media": minor
---

`node ace agora:doctor` (and `media:doctor`): one health check for every installed `@adonis-agora` lib, the same command every lib ships (canonical revision 1.1). Media adds `media.disks` (every disk it writes to exists), `media.console-gate` (console `authorize`, an error in production), `media.account-console` (listed collections exist and have rules) and `media.tenancy-schema` (deep: the `tenant_id` column with tenancy on). New subpath `./doctor`; the commands are in the `@adonis-agora/media/commands` barrel `configure` registers.
