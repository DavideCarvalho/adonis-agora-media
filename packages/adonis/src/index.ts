// Config idiom
export { defineConfig, stores, processors, disks, uploadSessions } from './define_config.js';
export type {
  MediaConfig,
  MediaUploadsConfig,
  MediaResumableConfig,
  MediaDeliveryConfig,
  StoreContext,
  StoreFactory,
  LucidStoreConfig,
  ImageProcessorFactory,
  DiskFactory,
  S3DiskConfig,
  S3Credentials,
  UploadMode,
  UploadSessionStoreContext,
  UploadSessionStoreFactory,
  LucidUploadSessionStoreConfig,
} from './define_config.js';

// Manager + layers
export { MediaManager } from './media_manager.js';
export type { MediaManagerOptions } from './media_manager.js';

// Direct-S3 upload modes (proxy + direct multipart)
export { UploadManager } from './upload_manager.js';
export type {
  UploadManagerOptions,
  InitiateDirectUploadInput,
  DirectUploadCreated,
  PresignPartInput,
  CompleteDirectUploadInput,
  AbortDirectUploadInput,
  ProxyUploadInput,
} from './upload_manager.js';
export { resolveUploadMode } from './upload_mode.js';
export type { ResolvedUploadMode, UploadModeLevels } from './upload_mode.js';

// Resumable (TUS) uploads
export { ResumableUploadManager } from './resumable_upload.js';
export type {
  ResumableUploadManagerOptions,
  UploadSession,
  UploadSessionStore,
  UploadSessionListFilter,
  CreateUploadInput,
} from './resumable_upload.js';
export { TusUploadHandler, parseTusMetadata, TUS_VERSION } from './tus.js';
export type { TusRequest, TusResponse, TusUploadHandlerOptions } from './tus.js';
// Configurable delivery (the read-side counterpart to the upload modes)
export {
  MediaDeliveryHandler,
  resolveDeliveryMode,
  DEFAULT_DELIVERY_SIGNED_TTL_SECONDS,
} from './delivery.js';
export type {
  DeliveryMode,
  ResolvedDeliveryMode,
  DeliveryResult,
  DeliveryRequest,
  MediaDeliveryHandlerOptions,
} from './delivery.js';

// Real-content validation (magic-byte signatures behind `acceptsMimeTypes`)
export {
  detectMimeType,
  isDetectableMimeType,
  isClosedSignatureWhitelist,
  verifyContentAgainstWhitelist,
  SIGNATURE_HEAD_BYTES,
} from './content_type.js';
export type { ContentVerdict } from './content_type.js';

// Drive-backed disk resolution (the provider's resolver; exported for wiring media outside AdonisJS)
export { createDriveBackedResolver } from './disks/drive.js';
export type {
  DriveManagerLike,
  DriveServiceModule,
  DriveBackedResolverOptions,
} from './disks/drive.js';

export { isMultipartCapable } from './multipart.js';
export { isExtendedDisk } from './extended_disk.js';
export { MediaLibrary } from './media_library.js';
export type {
  MediaLibraryOptions,
  AttachInput,
  AttachExistingInput,
  OwnerMediaBinding,
  MediaSignedUrlOptions,
  DeliverOptions,
} from './media_library.js';
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
  AttachmentSignedUrlOptions,
} from './attachment.js';
export { StorageManager } from './storage_manager.js';
export type { StorageManagerOptions } from './storage_manager.js';

// Model + SPIs
export type { MediaRecord, MediaConversion } from './media_record.js';
export type { MediaStore, MediaListOptions, MediaListPage, MediaCursor } from './media_store.js';
export {
  DEFAULT_MEDIA_LIST_LIMIT,
  MAX_MEDIA_LIST_LIMIT,
  encodeMediaCursor,
  decodeMediaCursor,
  clampMediaListLimit,
} from './media_store.js';
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
  UploadStartPayload,
  UploadProgressPayload,
  UploadCompletePayload,
  UploadAbortPayload,
} from './diagnostics.js';

// Errors
export {
  MimeNotAllowedError,
  ContentTypeMismatchError,
  ContentSignatureUnrecognizedError,
  DriveNotReadyError,
  MediaNotFoundError,
  MediaObjectMissingError,
  ConversionNotDefinedError,
  ImageProcessorMissingError,
  VariantNotFoundError,
  StoreNotConfiguredError,
  UploadNotSupportedError,
  UploadSessionNotFoundError,
  UploadOffsetConflictError,
  UploadSessionExpiredError,
  UploadSessionStoreNotConfiguredError,
  ResumableUploadsNotConfiguredError,
} from './errors.js';

// `node ace configure` reaches the hook through this entry point, not through the package's
// `./configure` export path.
export { configure } from '../configure.js';
