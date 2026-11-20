---
"@adonis-agora/media": minor
---

Upload sessions have `updatedAt` as well as `createdAt`. The built-in session stores set it on create and move it on every update (`createdAt` never moves). The Lucid store's `media_upload_sessions` table gets a nullable `updated_at` column: new tables have it, and an existing one gets it from `node ace media:publish-migration timestamps` (no backfill; the store keeps working without the column). `agora:doctor --deep` warns while it is missing (`media.timestamps-schema`). The console API's `UploadInfo` has `updatedAt` (ISO string, or `null` when unknown), `media:uploads:show` prints it, and the bundled console shows Created and Updated on record and upload-session details, with the full timestamp on hover in the lists.
