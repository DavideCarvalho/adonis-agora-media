export class MimeNotAllowedError extends Error {
  readonly code = 'E_MEDIA_MIME_NOT_ALLOWED';
  constructor(collection: string, mimeType: string) {
    super(`MIME type "${mimeType}" is not allowed in collection "${collection}"`);
    this.name = 'MimeNotAllowedError';
  }
}

/**
 * The bytes are not what the caller said they were. Raised when a collection declares
 * `acceptsMimeTypes` and the file's magic-byte signature identifies a type that either the
 * collection does not accept or that contradicts the declared `mimeType` — the case
 * {@link MimeNotAllowedError} cannot catch, because the declared type is written by the app (often
 * hardcoded) rather than proven by the content.
 */
export class ContentTypeMismatchError extends Error {
  readonly code = 'E_MEDIA_CONTENT_TYPE_MISMATCH';
  constructor(
    readonly collection: string,
    readonly declaredMimeType: string,
    readonly detectedMimeType: string,
    accepted: readonly string[],
  ) {
    super(
      `File contents are actually "${detectedMimeType}" (detected from the file signature), not the declared "${declaredMimeType}". Collection "${collection}" accepts [${accepted.join(', ')}].`,
    );
    this.name = 'ContentTypeMismatchError';
  }
}

/**
 * The content carries no recognisable signature, under a collection whose `acceptsMimeTypes` are
 * ALL signature-detectable. Distinct from {@link ContentTypeMismatchError}, which reports bytes that
 * were positively identified as some other type: here nothing was identified at all, and that is
 * itself the proof — if every accepted type is one the signature table can recognise, content it
 * cannot recognise is none of them.
 *
 * A collection that accepts even one signature-less type (`image/svg+xml`, `text/csv`,
 * `text/plain`, office formats…) is NOT closed, and unrecognised content there stays accepted.
 */
export class ContentSignatureUnrecognizedError extends Error {
  readonly code = 'E_MEDIA_CONTENT_SIGNATURE_UNRECOGNIZED';
  constructor(
    readonly collection: string,
    readonly declaredMimeType: string | undefined,
    readonly accepted: readonly string[],
  ) {
    super(
      `File contents carry no recognisable signature${
        declaredMimeType ? ` for the declared "${declaredMimeType}"` : ''
      }. Collection "${collection}" accepts only signature-detectable types [${accepted.join(', ')}], so content that matches none of their signatures cannot be any of them.`,
    );
    this.name = 'ContentSignatureUnrecognizedError';
  }
}

/**
 * A media disk was resolved before `@adonisjs/drive` finished booting, so its disk manager does not
 * exist yet. Drive's service module assigns the manager inside `app.booted(...)`; reading it any
 * earlier yields `undefined`. The media provider resolves it lazily, at first real disk use, so in
 * practice this only fires when media is called from outside a booted application.
 */
export class DriveNotReadyError extends Error {
  readonly code = 'E_MEDIA_DRIVE_NOT_READY';
  constructor(disk: string) {
    super(
      `Cannot resolve disk "${disk}": the \`@adonisjs/drive\` disk manager is not available yet because the application has not finished booting. Resolve media disks after boot (e.g. inside a request or a \`booted\` hook), or declare the disk in \`disks\` in config/media.ts so it does not go through Drive at all.`,
    );
    this.name = 'DriveNotReadyError';
  }
}

export class MediaNotFoundError extends Error {
  readonly code = 'E_MEDIA_RECORD_NOT_FOUND';
  constructor(id: string) {
    super(`Media record not found: ${id}`);
    this.name = 'MediaNotFoundError';
  }
}

export class MediaObjectMissingError extends Error {
  readonly code = 'E_MEDIA_OBJECT_MISSING';
  constructor(disk: string, key: string) {
    super(
      `No object at key "${key}" on disk "${disk}". \`attachExisting\` registers an object that is already stored — upload it first (e.g. finish the resumable session), or use \`attach\` to write the bytes.`,
    );
    this.name = 'MediaObjectMissingError';
  }
}

export class ConversionNotDefinedError extends Error {
  readonly code = 'E_MEDIA_CONVERSION_NOT_DEFINED';
  constructor(collection: string, conversion: string) {
    super(`Conversion "${conversion}" is not defined for collection "${collection}"`);
    this.name = 'ConversionNotDefinedError';
  }
}

/**
 * A conversion was requested by a name that names neither an image preset nor a transformer of the
 * record's collection — the transformer counterpart of {@link ConversionNotDefinedError}, raised by
 * `MediaLibrary.transform`.
 */
export class TransformerNotDefinedError extends Error {
  readonly code = 'E_MEDIA_TRANSFORMER_NOT_DEFINED';
  constructor(collection: string, transformer: string) {
    super(`Transformer "${transformer}" is not defined for collection "${collection}"`);
    this.name = 'TransformerNotDefinedError';
  }
}

/**
 * A transformer-produced conversion was read (`url` / `deliver` / HLS delivery) before it was
 * generated. Deliberately NOT generated lazily on read like image conversions: a transform is
 * assumed heavy (a video remux takes minutes), and a read path is the wrong place to pay that.
 * Generate it explicitly — `media.library.transform(id, name)` from a job — then read again.
 */
export class TransformNotReadyError extends Error {
  readonly code = 'E_MEDIA_TRANSFORM_NOT_READY';
  constructor(
    readonly mediaId: string,
    readonly transformer: string,
  ) {
    super(
      `Conversion "${transformer}" of media "${mediaId}" has not been generated yet. Transformer conversions are never generated inside a read path — run \`media.library.transform('${mediaId}', '${transformer}')\` (idempotent; call it from a job) and retry.`,
    );
    this.name = 'TransformNotReadyError';
  }
}

/**
 * Two derivatives of one collection claim the same name. Presets and transformers persist into the
 * same `record.conversions` map, so the namespace is shared; raised at registry construction (boot),
 * not on first attach.
 */
export class TransformerConflictError extends Error {
  readonly code = 'E_MEDIA_TRANSFORMER_CONFLICT';
  constructor(collection: string, name: string) {
    super(
      `Collection "${collection}" defines more than one conversion or transformer named "${name}". Preset and transformer names share the \`record.conversions\` namespace, so each name may appear once per collection.`,
    );
    this.name = 'TransformerConflictError';
  }
}

/**
 * A transformer needs a runtime capability the host doesn't provide — an optional peer that isn't
 * installed (`mediabunny`), or an API the runtime lacks (WebCodecs in Node). Thrown by the built-in
 * transformers and available for custom ones, so "this environment can't do that" always surfaces
 * as one clear, typed error instead of a deep import/undefined crash.
 */
export class TransformerRuntimeMissingError extends Error {
  readonly code = 'E_MEDIA_TRANSFORMER_RUNTIME_MISSING';
  constructor(
    readonly transformer: string,
    readonly requirement: string,
    hint?: string,
  ) {
    super(
      `Transformer "${transformer}" requires ${requirement}, which is not available in this runtime.${hint ? ` ${hint}` : ''}`,
    );
    this.name = 'TransformerRuntimeMissingError';
  }
}

/**
 * A transformer violated the output contract: wrote outside its prefix (`..`/absolute path),
 * declared an `entry` it never wrote, or wrote artifacts without declaring an entry. These are
 * programming errors in the transformer, surfaced with the transformer's name so the broken one is
 * obvious.
 */
export class TransformerOutputError extends Error {
  readonly code = 'E_MEDIA_TRANSFORMER_OUTPUT_INVALID';
  constructor(transformer: string, reason: string) {
    super(`Transformer "${transformer}" produced an invalid output: ${reason}`);
    this.name = 'TransformerOutputError';
  }
}

/**
 * A metadata-only conversion (a probe, a blurhash) was asked for its file — `url`, `signedUrl` or
 * `deliver` — but it has no artifact; only `record.conversions[name].meta` exists. Read the record
 * instead of a URL.
 */
export class ConversionArtifactMissingError extends Error {
  readonly code = 'E_MEDIA_CONVERSION_ARTIFACT_MISSING';
  constructor(mediaId: string, conversion: string) {
    super(
      `Conversion "${conversion}" of media "${mediaId}" is metadata-only — it has no artifact to deliver. Its result lives on \`record.conversions['${conversion}'].meta\`.`,
    );
    this.name = 'ConversionArtifactMissingError';
  }
}

/**
 * The HLS transformer could not stream-copy the source: a track's codec cannot be carried by the
 * segment format (MPEG-TS wants h264/aac), and no re-encode path exists in this runtime. Definitive
 * for the file — retrying cannot fix it; re-encode the source, or provide a WebCodecs
 * implementation (see `transformers.hls({ webcodecs })`).
 */
export class HlsSourceUnsupportedError extends Error {
  readonly code = 'E_MEDIA_HLS_SOURCE_UNSUPPORTED';
  constructor(details: string) {
    super(
      `HLS remux is impossible for this source: ${details}. Without an encoder (WebCodecs) the tracks can only be stream-copied, so an incompatible codec is definitive — re-encode the source to h264/aac, or configure \`transformers.hls({ webcodecs })\` with a WebCodecs implementation to enable the re-encode fallback.`,
    );
    this.name = 'HlsSourceUnsupportedError';
  }
}

export class ImageProcessorMissingError extends Error {
  readonly code = 'E_MEDIA_IMAGE_PROCESSOR_MISSING';
  constructor() {
    super('No ImageProcessor was configured; conversions are unavailable');
    this.name = 'ImageProcessorMissingError';
  }
}

export class VariantNotFoundError extends Error {
  readonly code = 'E_MEDIA_VARIANT_NOT_FOUND';
  constructor(variant: string) {
    super(`Attachment has no variant "${variant}"`);
    this.name = 'VariantNotFoundError';
  }
}

export class UploadNotSupportedError extends Error {
  readonly code = 'E_MEDIA_UPLOAD_NOT_SUPPORTED';
  constructor(disk: string, operation = 'direct multipart upload') {
    super(
      `Disk "${disk}" does not support ${operation}. Use a multipart-capable disk (e.g. \`disks.s3()\`) or the \`proxy\` upload mode.`,
    );
    this.name = 'UploadNotSupportedError';
  }
}

export class UploadSessionNotFoundError extends Error {
  readonly code = 'E_MEDIA_UPLOAD_SESSION_NOT_FOUND';
  constructor(id: string) {
    super(`Upload session not found: ${id}`);
    this.name = 'UploadSessionNotFoundError';
  }
}

export class UploadOffsetConflictError extends Error {
  readonly code = 'E_MEDIA_UPLOAD_OFFSET_CONFLICT';
  constructor(
    readonly expected: number,
    readonly received: number,
  ) {
    super(`Upload offset conflict: expected ${expected}, received ${received}`);
    this.name = 'UploadOffsetConflictError';
  }
}

export class UploadSessionExpiredError extends Error {
  readonly code = 'E_MEDIA_UPLOAD_SESSION_EXPIRED';
  constructor(id: string) {
    super(`Upload session has expired: ${id}`);
    this.name = 'UploadSessionExpiredError';
  }
}

/**
 * A part size the S3 multipart API cannot honour: below the 5 MiB minimum (every part but the last
 * must reach it, or `CompleteMultipartUpload` fails with `EntityTooSmall` AFTER the client uploaded
 * everything), or small enough that the file would need more than the 10,000 parts S3 allows.
 * Raised at `initiate`, where it costs nothing — the alternative is discovering it at complete,
 * when the whole file has already crossed the wire.
 */
export class UploadPartSizeError extends Error {
  readonly code = 'E_MEDIA_UPLOAD_PART_SIZE';
  constructor(detail: string) {
    super(`Invalid multipart part size: ${detail}`);
    this.name = 'UploadPartSizeError';
  }
}

/** A confirmed part number outside `1..totalParts` for the session — a client slicing with the wrong part size. */
export class UploadPartOutOfRangeError extends Error {
  readonly code = 'E_MEDIA_UPLOAD_PART_OUT_OF_RANGE';
  constructor(
    readonly partNumber: number,
    readonly totalParts: number,
  ) {
    super(
      `Part number ${partNumber} is outside this upload's range (1..${totalParts}). The client must slice the file with the partSize the session was created with.`,
    );
    this.name = 'UploadPartOutOfRangeError';
  }
}

/**
 * `complete()` was asked to assemble an upload whose parts are not all accounted for (neither
 * confirmed to the session nor supplied in the call). Failing fast here names the EXACT missing
 * part numbers; letting S3 discover it returns an opaque `InvalidPart` after a round-trip.
 */
export class UploadPartsIncompleteError extends Error {
  readonly code = 'E_MEDIA_UPLOAD_PARTS_INCOMPLETE';
  constructor(
    readonly sessionId: string,
    readonly missingParts: readonly number[],
  ) {
    super(
      `Cannot complete upload session ${sessionId}: no ETag for part(s) ${missingParts.join(', ')}. Upload and confirm them (or pass them to complete()) first — status() lists what is pending.`,
    );
    this.name = 'UploadPartsIncompleteError';
  }
}

export class DirectUploadsNotConfiguredError extends Error {
  readonly code = 'E_MEDIA_DIRECT_NOT_CONFIGURED';
  constructor() {
    super(
      "Session-backed direct uploads are not configured. Set `uploads.direct` in config/media.ts (e.g. `direct: { store: 'lucid', stores: { lucid: uploadSessions.lucid() } }`) to enable the direct upload session store.",
    );
    this.name = 'DirectUploadsNotConfiguredError';
  }
}

export class ResumableUploadsNotConfiguredError extends Error {
  readonly code = 'E_MEDIA_RESUMABLE_NOT_CONFIGURED';
  constructor() {
    super(
      "Resumable (TUS) uploads are not configured. Set `uploads.resumable` in config/media.ts (e.g. `resumable: { store: 'lucid', stores: { lucid: uploadSessions.lucid() } }`) to enable the resumable upload session store.",
    );
    this.name = 'ResumableUploadsNotConfiguredError';
  }
}

export class StoreNotConfiguredError extends Error {
  readonly code = 'E_MEDIA_STORE_NOT_CONFIGURED';
  constructor(name: string) {
    super(
      `Media config selects store "${name}" but no matching factory exists in \`stores\`. Add \`stores.${name}\` to config/media.ts (e.g. \`stores: { ${name}: stores.lucid() }\`), or omit \`store\` to use the in-memory store.`,
    );
    this.name = 'StoreNotConfiguredError';
  }
}

export class UploadSessionStoreNotConfiguredError extends Error {
  readonly code = 'E_MEDIA_UPLOAD_SESSION_STORE_NOT_CONFIGURED';
  constructor(name: string) {
    super(
      `Media config selects resumable session store "${name}" but no matching factory exists in \`uploads.resumable.stores\`. Add \`uploads.resumable.stores.${name}\` to config/media.ts (e.g. \`stores: { ${name}: uploadSessions.lucid() }\`), or omit \`store\` to use the in-memory session store.`,
    );
    this.name = 'UploadSessionStoreNotConfiguredError';
  }
}
