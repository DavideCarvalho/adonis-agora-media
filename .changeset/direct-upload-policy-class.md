---
'@adonis-agora/media': patch
---

Fix the direct-upload `policy` default export being usable as a class.

`uploads.direct.routes.policy` is a lazy `() => import(...)`, and the idiomatic AdonisJS policy is a `default export class`. Until now the provider handed the module's default export straight to the handler **without instantiating it**, so a class policy crashed at runtime — the handler called `policy.onInitiate(...)` on the constructor, not on an instance. The provider now instantiates a class default export (no arguments) and passes a ready object through unchanged, so both forms work.

The config seam is typed accordingly: the new `DirectUploadPolicyModule` accepts either a policy class or a ready policy object. It is typed `<any, any>` on purpose — `DirectUploadPolicy` is invariant in its context and record generics, so `<unknown, unknown>` would reject every concretely-typed policy; the `any` is contained at this config boundary and the handler still sees a fully-typed policy.
