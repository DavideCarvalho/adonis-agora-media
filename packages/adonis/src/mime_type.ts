/**
 * Small built-in extension → MIME map. Used ONLY as a fallback when the caller's declared MIME type
 * is ambiguous — a bare top-level type like `"text"` from a truncated multipart header — or not on
 * the collection's whitelist. The whitelist stays authoritative: a type resolved from here is used
 * only if it is itself whitelisted, so nothing is loosened.
 */
const EXTENSION_MIME_TYPES: Readonly<Record<string, string>> = {
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  txt: 'text/plain',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
};

/**
 * Resolve the MIME type an upload path records. Shared by every declared-type gate — `attach` /
 * `attachExisting`, the TUS `POST` and direct-upload `initiate` — so a declaration one path
 * normalizes is never rejected up front by another. The declared type stands whenever the collection
 * accepts it (or declares no whitelist at all). Otherwise — a bare top-level type with no `/`, or a
 * concrete type the whitelist rejects — fall back to the file extension: if the extension pins a
 * concrete MIME the collection DOES accept, that value is used (and stored on the record). Returns
 * `undefined` when nothing resolvable is whitelisted, which the caller reports as a rejection
 * listing the allowed types. `fileName` may be a full object key — only its last segment counts.
 */
export function resolveDeclaredMimeType(
  declared: string,
  fileName: string,
  accepted: readonly string[] | undefined,
): string | undefined {
  if (accepted === undefined || accepted.includes(declared)) return declared;

  const baseName = fileName.slice(fileName.lastIndexOf('/') + 1);
  const dot = baseName.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const extension = baseName.slice(dot + 1).toLowerCase();
  const resolved = EXTENSION_MIME_TYPES[extension];
  if (resolved === undefined || !accepted.includes(resolved)) return undefined;
  return resolved;
}
