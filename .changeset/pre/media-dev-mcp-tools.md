---
"@adonis-agora/media": minor
---

The media console now serves its data to coding agents on the app's dev MCP endpoint (`/mcp/agora`) when the app registers `@adonis-agora/agent/mcp_provider`. Ten `media_*` tools, gated by the console's own `authorize`: reads (`media_list_disks`, `media_list_objects`, `media_get_object`, `media_list_uploads`, `media_get_upload`, `media_list_collections`, `media_get_collections_summary`, `media_get_media`) are listed by default and never return a URL; the actions (`media_abort_upload`, `media_delete_objects`) only when the app opts in on the dev endpoint and the console has `actions: true`. No configuration in this package.

New `anyAuthorize(...authorizers)` in `@adonis-agora/media/dashboard`: allows a request when any of the given `authorize` forms does, e.g. a console token for MCP clients or a signed-in admin.
