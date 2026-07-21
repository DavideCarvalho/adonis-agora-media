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
