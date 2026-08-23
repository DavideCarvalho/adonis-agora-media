---
'@adonis-agora/media': patch
'@adonis-agora/media-react': patch
'@adonis-agora/media-dashboard': patch
---

Ship TanStack Intent agent skills with every package. Each package now publishes a
`skills/` directory (`media-*` SKILL.md files) that lands in `node_modules` on install, so
AI coding agents can discover them via `npx @tanstack/intent list`; adds `@tanstack/intent`
as a devDependency for `intent validate` in CI.
