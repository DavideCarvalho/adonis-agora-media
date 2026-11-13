---
"@adonis-agora/media": minor
---

Every media console action is now a `node ace` command: `media:disks:list`, `media:objects:list`, `media:objects:show`, `media:objects:upload`, `media:objects:copy`, `media:objects:move`, `media:objects:rename`, `media:objects:delete`, `media:folders:create`, `media:collections:list`, `media:records:list`, `media:records:show`, `media:records:delete`, `media:uploads:list`, `media:uploads:show` and `media:uploads:abort`. They use the console's settings from `config/media_dashboard.ts` (its disks, its `actions` switch, its object URLs), print `--json` in the console API's `{ data, meta }` shape, take `--tenant=<id>` with tenancy on, ask before a destructive change unless `--force`, and exit with code `1` on failure. See the new CLI page in the docs.
