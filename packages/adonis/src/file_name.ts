import { UnsafeFileNameError } from './errors.js';

/**
 * Validate a client-supplied upload file name before it is interpolated into a storage key.
 *
 * Unlike a transformer's own output path — validated by `assertSafeArtifactPath` in
 * `media_library.ts`, which only has to keep the transformer's OWN bookkeeping honest — a
 * `fileName` comes straight off the wire (a multipart field, a TUS `Upload-Metadata` header) and
 * must be treated as hostile.
 *
 * A file name is, by definition, a single path segment: it names a file, not a location. So
 * anything that would add or change segments — a `/` or `\`, an empty string, a bare `.` or `..`,
 * a control character — is rejected outright with {@link UnsafeFileNameError}, never silently
 * stripped down to a "safe" basename. That mirrors `assertSafeArtifactPath`'s stance: a
 * traversal-shaped input is never something to normalize into place.
 *
 * Every call site that builds a storage key from a client-supplied file name must route it through
 * here first: `MediaLibrary#layoutPath`, and the default `keyFor` of `DirectUploadHandler` and
 * `TusUploadHandler`.
 */
export function sanitizeFileName(fileName: string): string {
  const normalized = fileName.replace(/\\/g, '/');
  const hasControlCharacters = Array.from(normalized).some((char) => char.charCodeAt(0) < 0x20);
  if (
    normalized === '' ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.includes('/') ||
    hasControlCharacters
  ) {
    throw new UnsafeFileNameError(fileName);
  }
  return normalized;
}
