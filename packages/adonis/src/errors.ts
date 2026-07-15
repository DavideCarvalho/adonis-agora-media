export class MimeNotAllowedError extends Error {
  readonly code = 'E_MEDIA_MIME_NOT_ALLOWED';
  constructor(collection: string, mimeType: string) {
    super(`MIME type "${mimeType}" is not allowed in collection "${collection}"`);
    this.name = 'MimeNotAllowedError';
  }
}

export class MediaNotFoundError extends Error {
  readonly code = 'E_MEDIA_RECORD_NOT_FOUND';
  constructor(id: string) {
    super(`Media record not found: ${id}`);
    this.name = 'MediaNotFoundError';
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
