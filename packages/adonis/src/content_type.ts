/**
 * A magic-byte signature: one or more byte runs that must match at fixed offsets for the content to
 * be that type. Multi-part signatures exist because some containers interleave a length field
 * between their markers (WEBP is `RIFF....WEBP`).
 */
interface ContentSignature {
  mimeType: string;
  /** `[offset, hex]` pairs; every pair must match. */
  parts: readonly (readonly [number, string])[];
}

/**
 * The embedded signature table. Deliberately small and dependency-free (no `file-type`): it covers
 * the formats a MIME whitelist realistically gates on the way in — the raster images conversions are
 * generated from, plus PDF. Anything outside it is simply *unrecognised*, which is a defined,
 * non-fatal outcome (see {@link detectMimeType}), so the table can grow without changing semantics.
 */
const SIGNATURES: readonly ContentSignature[] = [
  { mimeType: 'image/png', parts: [[0, '89504e470d0a1a0a']] },
  // SOI + the first byte of the next marker. Covers JFIF/Exif/raw JPEG alike.
  { mimeType: 'image/jpeg', parts: [[0, 'ffd8ff']] },
  { mimeType: 'image/gif', parts: [[0, '474946383761']] }, // GIF87a
  { mimeType: 'image/gif', parts: [[0, '474946383961']] }, // GIF89a
  // RIFF container whose form type is WEBP; bytes 4..7 are the chunk size, so they are skipped.
  {
    mimeType: 'image/webp',
    parts: [
      [0, '52494646'],
      [8, '57454250'],
    ],
  },
  { mimeType: 'application/pdf', parts: [[0, '25504446']] }, // %PDF
];

/**
 * How many leading bytes {@link detectMimeType} needs to decide. This — and never the file size —
 * is what the attach paths read: the whole point of `attachExisting` is not buffering the object,
 * so content validation must stay a short head read.
 */
export const SIGNATURE_HEAD_BYTES = 16;

/** Does `head` carry `hex` at `offset`? */
function matchesAt(head: Uint8Array, offset: number, hex: string): boolean {
  const length = hex.length / 2;
  if (head.byteLength < offset + length) return false;
  for (let i = 0; i < length; i++) {
    if (head[offset + i] !== Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)) return false;
  }
  return true;
}

/**
 * Identify the real content type from the leading bytes of a file, or `undefined` when no signature
 * in the embedded table matches.
 *
 * `undefined` means "unknown", NOT "invalid": plenty of legitimate types (SVG, CSV, plain text,
 * office formats) have no fixed signature, so callers treat it as "no evidence either way" and fall
 * back to the declared MIME type rather than rejecting.
 */
export function detectMimeType(head: Uint8Array): string | undefined {
  for (const signature of SIGNATURES) {
    if (signature.parts.every(([offset, hex]) => matchesAt(head, offset, hex))) {
      return signature.mimeType;
    }
  }
  return undefined;
}

/** Every MIME type {@link detectMimeType} can PROVE from a signature. */
const DETECTABLE_MIME_TYPES: ReadonlySet<string> = new Set(SIGNATURES.map((s) => s.mimeType));

/** Can {@link detectMimeType} ever return this type — i.e. is it in the embedded table? */
export function isDetectableMimeType(mimeType: string): boolean {
  return DETECTABLE_MIME_TYPES.has(mimeType);
}

/**
 * Is every type in this whitelist signature-detectable — a *closed* whitelist?
 *
 * The distinction is what makes "unrecognised signature" actionable. Under a closed whitelist
 * (`['application/pdf']`, `['image/png', 'image/jpeg']`) unrecognised content cannot be any accepted
 * type, so it is provably wrong. Under an open one (anything containing `image/svg+xml`, `text/csv`,
 * `text/plain`, an office format…) unrecognised is the NORMAL case for a legitimate file, so there
 * is no evidence either way. An empty list is not closed: it whitelists nothing to reason from.
 */
export function isClosedSignatureWhitelist(accepted: readonly string[]): boolean {
  return accepted.length > 0 && accepted.every((type) => isDetectableMimeType(type));
}

/**
 * The outcome of checking real bytes against a collection's `acceptsMimeTypes`. Returned rather
 * than thrown so every caller (the two attach paths, the TUS handler) maps it onto its own failure
 * mode — an exception in the library, an HTTP status in the handler — off one shared decision.
 */
export type ContentVerdict =
  | { outcome: 'accepted' }
  /** A signature matched, and it contradicts the type the caller declared. */
  | { outcome: 'mismatch'; detected: string }
  /** A signature matched, and the collection does not accept that type. */
  | { outcome: 'not-accepted'; detected: string }
  /** No signature matched, under a closed whitelist ⇒ the content is none of the accepted types. */
  | { outcome: 'unrecognized' };

/**
 * Decide whether the leading bytes of a file are acceptable for a collection, given its
 * `acceptsMimeTypes` and (optionally) the type the caller declared.
 *
 * - a signature matches and agrees with the declared type (or none was declared and the type is
 *   whitelisted) ⇒ `accepted`.
 * - a signature matches and contradicts the declared type ⇒ `mismatch`, whether or not the detected
 *   type is itself whitelisted: a record whose `mimeType` misdescribes its bytes poisons every
 *   downstream consumer (conversions, `Content-Type` on delivery).
 * - a signature matches, nothing was declared, and the type is not whitelisted ⇒ `not-accepted`.
 * - no signature matches ⇒ `unrecognized` under a closed whitelist (see
 *   {@link isClosedSignatureWhitelist}), otherwise `accepted` — "unknown" is not "invalid" when a
 *   legitimate accepted type could have no signature at all.
 */
export function verifyContentAgainstWhitelist(
  head: Uint8Array,
  accepted: readonly string[],
  declared?: string,
): ContentVerdict {
  const detected = detectMimeType(head);
  if (detected === undefined) {
    return isClosedSignatureWhitelist(accepted)
      ? { outcome: 'unrecognized' }
      : { outcome: 'accepted' };
  }
  if (declared !== undefined && detected !== declared) return { outcome: 'mismatch', detected };
  if (!accepted.includes(detected)) return { outcome: 'not-accepted', detected };
  return { outcome: 'accepted' };
}
