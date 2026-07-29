---
'@adonis-agora/media': minor
---

**Behaviour change — omitting `disk` now really uses Drive's default disk.** Read this if your `config/media.ts` does not set `disk`.

The documented fallback ("omit `disk` and the provider uses the `default` of your `config/drive.ts`") had never worked in any environment. `MediaProvider` read it as `app.config.get('drive').default`, but `app.config.get('drive')` returns the value your config file exported — Drive's `defineConfig()` returns an **unresolved `ConfigProvider`** (`{ type: 'provider', resolver }`), so `.default` was always `undefined` and the fallback always returned the literal string `'default'`. (Reading `.config.default` instead does not help either: `{ config: { default, fakes, services } }` is the shape the provider's resolver *returns*, never the shape of the provider itself.) The provider now resolves the config provider — the same thing `@adonisjs/drive`'s own provider does before it builds its manager — and reads the default disk name off the resolved config. Drive's `DriveManager` cannot be asked instead: it keeps that config in a `#private` field and exposes no accessor.

**Am I affected?** Look at the `default` key of your `config/drive.ts`:

- `default: 'default'` (or you set `disk` in `config/media.ts`, or you have no Drive config at all) → nothing changes.
- `default` is anything else *and* your `services` map has **no** disk named `default` → media was hard-broken for you (every disk operation threw inside flydrive, because it was asked for a service named `'default'` that does not exist). This release fixes it; there is nothing to migrate.
- `default` is anything else *and* your `services` map **does** have a disk named `default` → **this moves where your files are written and read.** New objects now go to your real Drive default (e.g. `s3`) instead of the disk named `default`.

**Migration.** Objects already written under the `'default'` disk will not be found on the new disk — nothing copies them. Media records persist their own `disk`, so rows attached before this upgrade keep resolving to `'default'` and stay readable as long as that disk still exists in `config/drive.ts`; anything that recomputes a location from the *current* default (or any object you wrote outside the media record store) will look on the new disk and miss. To keep the old behaviour exactly, pin it explicitly:

```ts
// config/media.ts
export default defineConfig({
  disk: 'default', // was implicit before this release
})
```

Otherwise, move the existing objects to your real default disk (or point that Drive service at the same bucket/location) before upgrading.

This is a minor, not a major: the package is pre-1.0, where minor is the breaking-change channel, and a `1.0.0` would signal an API stability this package has not declared. The affected surface is narrow (a host that both omits `disk` and keeps a Drive disk literally named `default` alongside a different Drive `default`), the alternative for most affected hosts was a crash, and pinning the old behaviour is a one-line config change.
