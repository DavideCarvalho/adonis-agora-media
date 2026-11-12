---
"@adonis-agora/media": minor
"@adonis-agora/media-dashboard": minor
---

The media console joins the Agora console switcher. It registers itself in the app's `'agora.consoles'` registry (created by whichever console boots first), and its brand becomes a menu to the other Agora consoles the viewer may open, each checked with that console's own `authorize` (300 ms each, in parallel; `ctx.agoraProbe` is `true` while they run). Ctrl/Cmd-K searches every console the viewer may open; media answers record ids, collection names and disk names. New routes: `GET <apiBase>/consoles` and `GET <apiBase>/consoles/search?q=`, behind the console's `authorize`. `registerAgoraConsole` is exported from `@adonis-agora/media/dashboard` for consoles an app mounts itself. The Collections view opens filtered from `#/collections?collection=<name>`. Nothing changes for an app with a single console.
