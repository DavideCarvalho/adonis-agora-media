/**
 * A magic-byte signature: one or more byte runs that must match at fixed offsets for the content to
 * be that type. Multi-part signatures exist because some containers interleave a length field
 * between their markers (WEBP is `RIFF....WEBP`).
 */
interface ContentSignature {
  mimeType: string;
  /** `[offset, hex]` pairs; every pair must match. */
  parts: readonly (readonly [number, string])[];
  /**
   * A byte run that must ALSO appear somewhere in the head, at no fixed offset. Exists for the one
   * family whose discriminator floats: Matroska/WebM's `DocType` is an EBML element inside a
   * variable-length header, so its offset depends on the muxer. The scan only runs after `parts`
   * matched, so it discriminates within an already-identified container rather than fishing for
   * arbitrary bytes in arbitrary files.
   */
  scan?: string;
}

/** ASCII → hex, so signatures whose bytes are readable tags (`ftyp`, brands, `AVI `) stay legible. */
function ascii(text: string): string {
  let hex = '';
  for (let i = 0; i < text.length; i++) {
    hex += text.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * ISO-BMFF `ftyp` signature: bytes 0..3 are the box SIZE (varies with the compatible-brands list,
 * so they are skipped), bytes 4..7 are `ftyp`, bytes 8..11 the major brand — which is what
 * distinguishes plain MP4 from QuickTime.
 */
function ftyp(mimeType: string, brand: string): ContentSignature {
  return {
    mimeType,
    parts: [
      [4, ascii('ftyp')],
      [8, ascii(brand)],
    ],
  };
}

/**
 * The `ftyp` major brands treated as `video/mp4`: the ISO base/conformance brands plus what real
 * encoders write (ffmpeg `isom`/`mp42`, H.264 `avc1`, AV1 `av01`, DASH init segments `dash`). An
 * unknown brand (3GPP's `3gp*`, Apple's `M4V `/`M4A `…) is deliberately NOT claimed as `video/mp4`:
 * it stays *unrecognised*, which under an open whitelist falls back to the declared type instead of
 * manufacturing a false `mismatch` against it.
 */
const MP4_MAJOR_BRANDS = [
  'isom',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
  'avc1',
  'av01',
  'dash',
];

/**
 * The embedded signature table. Deliberately small and dependency-free (no `file-type`): it covers
 * the formats a MIME whitelist realistically gates on the way in — the raster images conversions
 * are generated from, PDF, and the common video containers. Anything outside it is simply
 * *unrecognised*, which is a defined, non-fatal outcome (see {@link detectMimeType}), so the table
 * can grow without changing semantics.
 *
 * Growing it IS observable in one way, though: adding a type here flips any whitelist made up
 * entirely of table types to *closed* (see {@link isClosedSignatureWhitelist}), which starts
 * rejecting unrecognisable content for those collections.
 *
 * Order matters only where signatures could overlap: first full match wins, so the weakest
 * signature (MPEG-TS, two single bytes) goes last.
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
  // ISO-BMFF (`ftyp`) family — one entry per major brand, the GIF87a/GIF89a pattern.
  ...MP4_MAJOR_BRANDS.map((brand) => ftyp('video/mp4', brand)),
  ftyp('video/quicktime', 'qt  '),
  // Matroska family: the EBML magic at 0 identifies the container, the scanned `DocType` element
  // (id 0x4282 + size + ASCII doc type — see {@link ContentSignature.scan} for why it floats)
  // says which member. An EBML file whose DocType is neither — or is encoded with a padded size
  // vint no real muxer emits — stays unrecognised rather than guessed.
  { mimeType: 'video/webm', parts: [[0, '1a45dfa3']], scan: `428284${ascii('webm')}` },
  { mimeType: 'video/x-matroska', parts: [[0, '1a45dfa3']], scan: `428288${ascii('matroska')}` },
  // RIFF container whose form type is AVI; bytes 4..7 are the chunk size, as with WEBP above.
  {
    mimeType: 'video/x-msvideo',
    parts: [
      [0, ascii('RIFF')],
      [8, ascii('AVI ')],
    ],
  },
  // MPEG transport stream: no magic number, only the 0x47 sync byte opening every 188-byte packet.
  // One byte would collide with anything starting with 'G' (GIF is caught above by its full
  // signature, but plain text is not), so the sync byte is required at the start of the first TWO
  // packets — which is also what pins {@link SIGNATURE_HEAD_BYTES} at 189. Kept LAST: it is the
  // weakest signature in the table and must never shadow a stronger one.
  {
    mimeType: 'video/mp2t',
    parts: [
      [0, '47'],
      [188, '47'],
    ],
  },
];

/**
 * How many leading bytes {@link detectMimeType} needs to decide. This — and never the file size —
 * is what the attach paths read: the whole point of `attachExisting` is not buffering the object,
 * so content validation must stay a short head read.
 *
 * 189 = two MPEG-TS sync bytes (offsets 0 and 188), the deepest probe in the table; every other
 * signature resolves within the first few dozen bytes. A file (or a TUS first chunk) shorter than
 * a signature's deepest offset simply cannot match that signature — short heads degrade to
 * "unrecognised", never to a false positive.
 */
export const SIGNATURE_HEAD_BYTES = 189;

/** Does `head` carry `hex` at `offset`? */
function matchesAt(head: Uint8Array, offset: number, hex: string): boolean {
  const length = hex.length / 2;
  if (head.byteLength < offset + length) return false;
  for (let i = 0; i < length; i++) {
    if (head[offset + i] !== Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)) return false;
  }
  return true;
}

/** Does `head` carry `hex` at ANY offset? Naive scan — the head is at most a couple hundred bytes. */
function matchesAnywhere(head: Uint8Array, hex: string): boolean {
  const last = head.byteLength - hex.length / 2;
  for (let offset = 0; offset <= last; offset++) {
    if (matchesAt(head, offset, hex)) return true;
  }
  return false;
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
    if (!signature.parts.every(([offset, hex]) => matchesAt(head, offset, hex))) continue;
    if (signature.scan !== undefined && !matchesAnywhere(head, signature.scan)) continue;
    return signature.mimeType;
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
