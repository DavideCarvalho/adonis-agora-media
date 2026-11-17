---
"@adonis-agora/media-dashboard": minor
---

The Collections view's filters now live in the URL, so a filtered view can be shared, bookmarked and reloaded, and back/forward step through it: collection, owner type, owner id and path prefix sit in the hash's query (`#/collections?collection=gallery&ownerType=Post&ownerId=42`, the prefix as `keyPrefix`). The `collection` param is the one search hits already link with, so existing links open as before.
