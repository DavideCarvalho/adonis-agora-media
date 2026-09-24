---
'@adonis-agora/media-react': patch
---

**`Upload-Metadata` values are now Base64 of their UTF-8 bytes**, which is what the server side (`parseTusMetadata`) decodes.

The client used `btoa(value)` directly. `btoa` takes a one-byte-per-char string, so an accented title reached the server garbled (`Hemograma março` became `Hemograma mar�o`), and anything past U+00FF — an em dash, curly quotes, an emoji — threw `InvalidCharacterError` and failed the upload outright. Filenames and titles are exactly where those characters show up. Found in an end-to-end test of an app uploading lab reports in Portuguese.
