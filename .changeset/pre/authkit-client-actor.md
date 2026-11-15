---
'@adonis-agora/media': patch
---

`authkitIdentity()` on the authkit-client side sets `realId` from the identity's actor (the token's `act` claim), falling back to `sub`. Under impersonation through a remote authkit, permission checks are made for the impersonating human, as they already were on the authkit-server side.
