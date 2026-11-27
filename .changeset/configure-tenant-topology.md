---
"@adonis-agora/media": patch
---

`node ace configure @adonis-agora/media --topology=tenant` publishes `config/media.ts` in the one-line tenant form (`defineConfig({ topology: 'tenant' })`), with a note that url, token and partition come from `@adonis-agora/authkit-client` and the explicit `tenant` fields commented out, and skips the store, upload-session and tenancy migrations a tenant never uses. Without the flag, configure is unchanged.
