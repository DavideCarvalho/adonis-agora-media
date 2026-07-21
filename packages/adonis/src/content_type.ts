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
