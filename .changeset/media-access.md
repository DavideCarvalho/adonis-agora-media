---
'@adonis-agora/media': minor
---

Authorization that plugs into the app's auth: `media.access`.

- **Collection rules:** `collections[].access: { read?, write? }`. A rule built with `authorizers` (`owner`, `authenticated`, `roles`, `public`, `any`, `all`) or your own function. An absent rule denies.
- **The current user:** `access.identity` resolves it. The default reads `ctx.auth.user`. `authkitIdentity()` from the new `@adonis-agora/media/authkit` subpath covers both sides of authkit: on the server it takes the acting account plus the real human under impersonation; on the client, the token's sub, global roles and active organization.
- **authz rules:** `authz.can(permission | fn)` and `authz.roles([...])` from the new `@adonis-agora/media/authz` subpath. They check the real human (never an impersonated account), or the app's user object when the identity has one.
- **The delivery route:** `media.access.deliveryRoute(options?)` is a ready handler that every app used to write by hand. It authorizes the read (a valid signed URL counts as authorization), passes `?w`/`?q`/`?conversion`/`Accept`/`?exp`/`?sig` through, redirects or streams with the right headers (private `Cache-Control` by default, `Vary: Accept`, an RFC 6266 `inline` disposition), and answers the library's errors as 400/401/403/404 JSON.
- **In your own code:** `media.access.can()`, `authorize()` (throws the new `MediaAccessDeniedError`, with `status` 401 or 403), `subject()` and `image(ctx, id)`. The last one is `media.library.image()` after a read check.

authkit and authz are optional peers, imported only when used.
