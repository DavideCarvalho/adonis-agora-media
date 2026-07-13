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

export class StoreNotConfiguredError extends Error {
  readonly code = 'E_MEDIA_STORE_NOT_CONFIGURED';
  constructor(name: string) {
    super(
      `Media config selects store "${name}" but no matching factory exists in \`stores\`. Add \`stores.${name}\` to config/media.ts (e.g. \`stores: { ${name}: stores.lucid() }\`), or omit \`store\` to use the in-memory store.`,
    );
    this.name = 'StoreNotConfiguredError';
  }
}
