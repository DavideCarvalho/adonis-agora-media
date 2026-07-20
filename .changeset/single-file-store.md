---
"@adonis-agora/media": minor
---

Add the `@adonis-agora/media/single-file` helper (`storeSingleFile` / `removeSingleFile` / `isSingleFileStoreAvailable`) for storing exactly one file per owner through a `single: true` collection, returning the stable public URL (plus an optional `thumb` conversion URL). Lets other packages delegate single-file uploads such as avatars to media without taking a hard dependency on it.
