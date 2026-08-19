---
'@adonis-agora/media': patch
---

**Fixes a hard `npm install` failure.** Two peer ranges used a caret over a 0.x dependency, which under semver does not cross a minor — `^0.4.0` means `>=0.4.0 <0.5.0`. Every later minor of those peers fell out of range.

pnpm downgrades an unsatisfied peer to a warning, so this was invisible inside the monorepo. **npm treats it as `ERESOLVE` and refuses to install**, even though both peers are declared optional:

```
While resolving: @adonis-agora/media@0.12.0
Found: @adonis-agora/telescope@0.8.1
Conflicting peer dependency: @adonis-agora/telescope@0.4.0
```

- `@adonis-agora/telescope`: `^0.4.0` → `>=0.4.0 <1.0.0`. Telescope is at 0.8.1, so any consumer on a current telescope could not install this package under npm. The floor stays at 0.4.0: bisecting the published tarballs shows the extension contract `mediaTelescopeExtension()` implements has been type-compatible since 0.1.0, so 0.4.0 was never too high — only the ceiling was wrong.
- `sharp`: `^0.33.0` → `>=0.33.0 <1.0.0`. Same defect, same `ERESOLVE`; sharp is at 0.35.3. The processor only uses `resize`/`toFormat`/`quality`/`toBuffer`, verified end to end against sharp 0.35.3 outside the monorepo.

No runtime behaviour changes, and no dependency is bumped — this only widens what a consumer is *allowed* to have installed.
