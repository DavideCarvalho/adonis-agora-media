---
'@adonis-agora/media': minor
---

`signedUrl` agora aceita as opções de resposta do disk (`contentDisposition`, `contentType`).

**Breaking:** o 3º parâmetro posicional virou um objeto de opções.

- `library.signedUrl(id, '1h', 'thumbnail')` → `library.signedUrl(id, '1h', { conversion: 'thumbnail' })`
- `attachments.signedUrl(att, '1h', 'thumb')` → `attachments.signedUrl(att, '1h', { variant: 'thumb' })`

Forçar download com um nome de arquivo (`attachment; filename="..."`) é o caso canônico de URL
assinada e não tinha como ser expresso pela library — só pelo disk, o que obrigava o chamador a
conhecer disk e path.
