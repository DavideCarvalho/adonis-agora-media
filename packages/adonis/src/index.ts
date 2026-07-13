// Config idiom
export { defineConfig, stores, processors, disks } from './define_config.js';
export type {
  MediaConfig,
  StoreContext,
  StoreFactory,
  LucidStoreConfig,
  ImageProcessorFactory,
  DiskFactory,
  S3DiskConfig,
  S3Credentials,
} from './define_config.js';

// Manager + layers
export { MediaManager } from './media_manager.js';
export type { MediaManagerOptions } from './media_manager.js';

export { isExtendedDisk } from './extended_disk.js';
export { MediaLibrary } from './media_library.js';
export type { MediaLibraryOptions, AttachInput, OwnerMediaBinding } from './media_library.js';
export {
  Attachment,
  AttachmentManager,
} from './attachment.js';
export type {
  AttachmentData,
  AttachmentVariant,
  AttachmentManagerOptions,
  CreateAttachmentInput,
  CreateAttachmentOptions,
} from './attachment.js';
export { StorageManager } from './storage_manager.js';
export type { StorageManagerOptions } from './storage_manager.js';

// Model + SPIs
export type { MediaRecord, MediaConversion } from './media_record.js';
export type { MediaStore } from './media_store.js';
export { MediaCollectionRegistry } from './media_collection.js';
export type { MediaCollectionConfig } from './media_collection.js';
export type { ConversionPreset, ConversionResult, ImageProcessor } from './image_processor.js';
export type {
  Disk,
  DiskResolver,
  DiskWriteOptions,
  DiskMetaData,
  SignedUrlOptions,
  MultipartPart,
  MultipartUploadDisk,
  ExtendedDisk,
  DiskCapabilities,
  DiskStat,
  CopyOptions,
  ListOptions,
  ListEntry,
  ListResult,
} from './types.js';

// Diagnostics (event types only — `publishMedia` is the internal emit helper and is not exported)
export type {
  MediaDiagnosticEvent,
  MediaDiagnosticPayloads,
  AttachPayload,
  DeletePayload,
  ConversionPayload,
  AttachmentCreatePayload,
  AttachmentDeletePayload,
} from './diagnostics.js';

// Errors
export {
  MimeNotAllowedError,
  MediaNotFoundError,
  ConversionNotDefinedError,
  ImageProcessorMissingError,
  VariantNotFoundError,
  StoreNotConfiguredError,
} from './errors.js';
