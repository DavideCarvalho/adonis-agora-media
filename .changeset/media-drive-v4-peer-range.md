---
'@adonis-agora/media': patch
---

Widen the `@adonisjs/drive` peer dependency from `^3.0.0` to `^3.0.0 || ^4.0.0`.

Verified compatible by running the real test suite against `@adonisjs/drive@4` (the package's dev dependency is bumped accordingly). No source changes were needed — this is a non-breaking relaxation of the accepted peer range, so consumers can adopt Drive v4 without waiting on a major bump here.
