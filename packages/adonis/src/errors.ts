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
