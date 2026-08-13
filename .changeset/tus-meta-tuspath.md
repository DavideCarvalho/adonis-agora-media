---
"@adonis-agora/media-react": minor
---

`useMediaUpload`/`createMediaUploadClient` — uploads TUS agora aceitam um path de create por-upload e metadata custom.

- `UploadMeta.metadata`: pares `Upload-Metadata` extras (ex.: `{ title, examdate }`), decodificados no servidor pelo `parseTusMetadata` — deixa a rota TUS do app carregar campos de domínio no create.
- `UploadMeta.tusPath`: override do path do create TUS por-upload, para rotas que embutem um resource id no path (ex.: `/api/exames/tus/:uploadId`) em vez de um prefixo fixo.

Puramente aditivo — a API existente (`tusPath` global, `filename`/`filetype`) não muda.
