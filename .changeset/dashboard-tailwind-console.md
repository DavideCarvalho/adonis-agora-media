---
'@adonis-agora/media-dashboard': minor
---

Dashboard rebuilt on Tailwind + `@base-ui-components/react` + CVA, with a substantial feature port: auth (session login/logout), object insights/raw preview proxy, and record/upload detail drill-ins.

The hand-rolled CSS SPA is replaced with Tailwind utility classes, headless `@base-ui-components/react` primitives and `class-variance-authority` variants — matching the design system already used by the sibling NestJS console, so both ecosystems share the same visual language. `FolderTree`, `DataTable` and `Lightbox` are extracted as standalone, independently-tested components; `LibraryBrowseView` absorbs the disk/collection browsing UX previously spread across ad hoc markup.

New server-side surface backing the above:

- `auth.ts` / `cookie.ts` — session login, session check, logout, cookie handling for the console's own auth screen (`AuthScreen.tsx`).
- `object_insights.ts` + `DashboardService#objectInsights` — host apps register `ObjectInsightProvider`s (via `config/media_dashboard.ts`'s `objectInsights`) that annotate an object with app-specific metadata; a provider that throws is skipped rather than blocking the view.
- `DashboardService#objectStream` — same-origin raw byte proxy so text/PDF preview inline and a CORS-locked bucket is still previewable.
- `DashboardService#mediaRecord` / `deleteMediaRecord` — full `MediaRecord` detail (with signed conversion-variant URLs) and actions-gated delete, backing the new record-detail drill-in.
- `DashboardService#collectionsSummary` — per-collection record-count/byte rollup for the collection chips, bounded scan so a very large library degrades to a partial summary instead of an unbounded walk.
- `DashboardService#uploadDetail` / `abortUpload` — full resumable-session detail (+ recorded parts) and actions-gated cancel, backing the new upload-detail drill-in.
- `DashboardService#putObject` — bounded convenience upload (buffered, capped at 100MB) distinct from the resumable TUS path.

All additive — existing `DashboardService` consumers and the previous SPA routes are unaffected.
