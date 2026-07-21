---
'@adonis-agora/media': patch
---

Resolve the Lucid `Database` by its string alias `'lucid.db'` instead of importing
`@adonisjs/lucid/services/db`, making the library immune to the dual-package hazard.

The service module resolves the `Database` **class** and uses it as the container token, while
Lucid's provider registers `container.singleton(Database, ...)` keyed on that same class object. A
class token only matches when the consumer and the booting provider loaded the *same physical copy*
of `@adonisjs/lucid`. When a host app's tree contains two copies — different version pins, or even
the same version resolved under different peer sets, which pnpm materializes as separate directories
— the tokens differ, no binding is found, and the container tries to *construct* `Database`, which
has no `@inject()`:

```
RuntimeException: Cannot construct "[class Database]" class.
Container is not able to resolve its dependencies. Did you forget to use @inject() decorator?
```

This took down every TUS upload in a production app while its local test suite passed, because the
duplication existed only in the `pnpm deploy` artifact and not in the workspace.

`'lucid.db'` is a string, so it cannot be duplicated: whichever copy boots registers the alias, and
any copy resolves it. The library no longer depends on the host app's dependency tree being
perfectly deduplicated. Both `stores.lucid()` and `uploadSessions.lucid()` are fixed, and a
regression test asserts on the resolved *token* rather than the returned store — asserting on the
store would pass with either implementation and let the hazard back in silently.

No API change: both factories already received the application in their context.
