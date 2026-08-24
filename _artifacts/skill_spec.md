# Skill spec — adonis-media (TanStack Intent agent skills)

Autonomous compressed discovery. **No maintainer interview was run** (fully-autonomous
constraint); everything below is grounded in README.md, REVIEW.md, docs/** (all narrative
files read: getting-started, configuration, collections-and-conversions, attachments,
single-file, stores-and-processors, delivery, transformers, errors, testing, roadmap, index,
storage/s3-disk, integrations/telescope, uploads/*, react/*, dashboard/*), and the source of
packages/{adonis,react,dashboard}.

## Scope decision

The monorepo publishes three packages. `@adonis-agora/media` is the flagship and owns almost
the whole consumer surface; the console ships embedded inside it (`./dashboard_provider`), with
`@adonis-agora/media-dashboard` as its standalone/delegate install. Skills therefore target all
three packages, with the dashboard skill owned by the dashboard package since that is where a
standalone host looks.

| Package | Version | Skills | Why |
|---|---|---|---|
| `@adonis-agora/media` | 0.12.1 | 5 | Setup/config, library+collections+conversions, attachments+single-file, storage/delivery SPIs + S3 disk, large-file uploads/policies. |
| `@adonis-agora/media-react` | 0.5.0 | 1 | The browser half: hook, component, framework-free client, console launcher. |
| `@adonis-agora/media-dashboard` | 8.0.0 | 1 | Console config, session auth modes, DashboardService programmatic API. |

Total: 7 SKILL.md files. Flat structure (`packages/<pkg>/skills/<skill-name>/SKILL.md`),
all `type: core`, no router skill, every entry carries its owning `package`.

## Skill set (flat; all type `core`)

Core package — `packages/adonis/skills/`:
1. `media-setup` — `node ace configure`, both providers, the two stub configs, the two
   migrations, `defineConfig` keys, disk precedence (per-call > collection > top-level >
   Drive default), lazy peer thunks, `StoreNotConfiguredError` vs zero-config in-memory,
   `DriveNotReadyError`.
2. `media-library-collections` — `media.library.attach/attachExisting/for()`,
   MIME whitelist + magic-byte content verification (closed vs open whitelists),
   `single: true` atomic replace, append-only ordering, deterministic `id` retries,
   eager/lazy `ConversionPreset`s, `ensureConversion`, transformers vs conversions
   (`TransformNotReadyError`), `MediaRecord.conversions` shape.
3. `media-attachments-single-file` — `AttachmentManager.createFromFile` with always-eager
   variants, `Attachment.toJSON()/fromJSON()`, the Lucid JSON-column pattern, URL/signing/
   delete semantics, and the `@adonis-agora/media/single-file` seam
   (`storeSingleFile`, `isSingleFileStoreAvailable`).
4. `media-stores-delivery` — `MediaStore` SPI (incl. cross-owner keyset `list()`),
   Lucid store + migration schema, custom store factories, `ImageProcessor`/sharp +
   custom processors, the structural `Disk` contract, `createDriveBackedResolver`
   (namespace-not-default trap), `disks.s3()` extended operations + declarative visibility,
   `presignS3Url`, `delivery.mode auto/public/signed/proxy`, `MediaDeliveryHandler` +
   `HlsDeliveryHandler` mounting rules, testing doubles.
5. `media-uploads-resumable` — `uploads` config, `resolveUploadMode`, proxy/direct/TUS
   strategies, `TusUploadHandler`, `media.resumable`, `media.direct` sessions,
   `DirectUploadPolicy` hooks (server-side keys, `onComplete` body, `mapError`),
   `completeUploadToLibrary` / `completeDirectUploadToLibrary` adoption, CORS ETag
   requirement, route gating.

React package — `packages/react/skills/`:
6. `media-react-uploads` — `useMediaUpload` (modes, pause/resume semantics, `storageKey`
   cross-reload resume), `MediaUploader` render-prop headless mode,
   `createMediaUploadClient` + session primitives + `xhrPartUploader`, `MediaHttpError`
   status discipline, header/SigV4 rules, `OpenMediaDashboardButton`.

Dashboard package — `packages/dashboard/skills/`:
7. `media-dashboard-console` — embedded-vs-standalone provider choice, `actions` gate,
   `middleware` + built-in `auth` composition (Mode A/B), cookie signing helpers,
   `DashboardService`/`DashboardError`, object insights.

## Highest-value AI-agent guidance (what to get right)

- **No silent fallbacks**: naming an unknown `store` throws at boot; `direct` on a
  non-multipart disk throws instead of downgrading; `auto` delivery resolves to `signed`
  when visibility is unknown and never picks `proxy`.
- **Authorization is always yours**: upload routes, delivery/HLS handlers, and the console
  perform NO authorization — `routes.middleware`, route guards, and policy hooks are the gates.
- **Policy layer lives in the collection**: without `single: true`, attach appends; MIME
  whitelist is exact-match plus magic-byte verification of the real bytes.
- **Transformers never generate on read** (`TransformNotReadyError`) while image presets do;
  attachment variants are the opposite — always eager.
- **Adopt finished uploads in place** (`attachExisting` / `complete*ToLibrary`) — re-reading
  bytes through `attach()` defeats the point of resumable uploads.
- **Client/server contract pairs**: client paths must match server prefixes; presigned PUTs
  take no auth headers; bucket CORS must expose `ETag`.

## Frontmatter contract (mirrors nestjs-filter/nestjs-telescope references)

- Top-level only: `name`, `description`, `metadata`. `name` = kebab leaf == parent dir.
- `metadata`: `{ type: core, library, library_version, framework }` (`framework: adonisjs`
  for core skills, `react` for the React package).
- `sources`: `DavideCarvalho/adonis-media:<path>` entries.
- Body: Setup → 2–4 Core patterns → ≥3 Common Mistakes (Wrong/Correct real code +
  Mechanism + Source).

## Remaining Gaps (what a maintainer interview would have answered)

- Failure-mode priorities are inferred from doc callouts/error tables, not from issue reports
  or telemetry (no interview, no GitHub mining this pass).
- Transformers/HLS have no dedicated skill (covered across media-library-collections and
  media-stores-delivery); a dedicated one is the natural next addition if video usage grows.
- Telescope integration intentionally uncovered (optional peer; see docs/integrations/telescope.mdx).
- Dashboard SPA internals are covered only at config/service level by design — the SPA ships prebuilt.
