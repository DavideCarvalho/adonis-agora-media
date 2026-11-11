---
"@adonis-agora/media": major
"@adonis-agora/media-react": major
---

Release 1.0. Every export, option, subpath and ace command of `@adonis-agora/media` and `@adonis-agora/media-react` from 0.x works unchanged (see "Migrating to 1.0" in the docs). One behaviour is gone: the embedded console no longer reads a `window.__MEDIA_DASHBOARD__` global, only the JSON data block the provider injects.

- Node.js 24 or later is required (`engines.node: ">=24"`, unchanged).
- `@adonis-agora/media` accepts `@adonis-agora/authz`, `@adonis-agora/authkit-client`, `@adonis-agora/authkit-server` and `@adonis-agora/telescope` 1.x, including the 1.0 release candidates (`<lower> <2.0.0 || >=1.0.0-rc.0 <2.0.0`, lower bounds unchanged).
