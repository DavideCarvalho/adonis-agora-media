// Config idiom

// `node ace configure` reaches the hook through this entry point, not through the package's
// `./configure` export path.
export { configure } from '../configure.js';
export type {
  AttachmentData,
  AttachmentManagerOptions,
  AttachmentSignedUrlOptions,
  AttachmentVariant,
  CreateAttachmentInput,
  CreateAttachmentOptions,
} from './attachment.js';
export {
  Attachment,
  AttachmentManager,
} from './attachment.js';
export type { ContentVerdict } from './content_type.js';
// Real-content validation (magic-byte signatures behind `acceptsMimeTypes`)
export {
  detectMimeType,
  isClosedSignatureWhitelist,
  isDetectableMimeType,
  SIGNATURE_HEAD_BYTES,
  verifyContentAgainstWhitelist,
} from './content_type.js';
export type {
  DiskFactory,
  ImageProcessorFactory,
  InferConversions,
  InferTransformers,
  LucidStoreConfig,
  LucidUploadSessionStoreConfig,
  MediaConfig,
  MediaDeliveryConfig,
  MediaDirectUploadConfig,
  MediaResumableConfig,
  MediaUploadsConfig,
  S3Credentials,
  S3DiskConfig,
  StoreContext,
  StoreFactory,
  UploadMode,
  UploadSessionStoreContext,
  UploadSessionStoreFactory,
} from './define_config.js';
export {
  defineConfig,
  disks,
  processors,
  stores,
  transformers,
  uploadSessions,
} from './define_config.js';
export type {
  DeliveryMode,
  DeliveryRequest,
  DeliveryResult,
  MediaDeliveryHandlerOptions,
  ResolvedDeliveryMode,
} from './delivery.js';
// Configurable delivery (the read-side counterpart to the upload modes)
export {
  DEFAULT_DELIVERY_SIGNED_TTL_SECONDS,
  MediaDeliveryHandler,
  resolveDeliveryMode,
} from './delivery.js';
// Diagnostics (event types only — `publishMedia` is the internal emit helper and is not exported)
export type {
  AttachmentCreatePayload,
  AttachmentDeletePayload,
  AttachPayload,
  ConversionPayload,
  DeletePayload,
  MediaDiagnosticEvent,
  MediaDiagnosticPayloads,
  UploadAbortPayload,
  UploadCompletePayload,
  UploadProgressPayload,
  UploadStartPayload,
} from './diagnostics.js';
export type {
  DirectUploadCreatedSession,
  DirectUploadInitiateInput,
  DirectUploadManagerOptions,
  DirectUploadPartUrl,
  DirectUploadStatus,
} from './direct_upload.js';
// Session-backed direct uploads (browser→S3 multipart with a persisted, resumable session)
export {
  DEFAULT_DIRECT_PART_SIZE,
  DirectUploadManager,
  MAX_DIRECT_PARTS,
  MIN_DIRECT_PART_SIZE,
} from './direct_upload.js';
export type {
  DirectUploadHandlerOptions,
  DirectUploadRequest,
  DirectUploadResponse,
} from './direct_upload_handler.js';
export { DirectUploadHandler } from './direct_upload_handler.js';
export type {
  DriveBackedResolverOptions,
  DriveManagerLike,
  DriveServiceModule,
} from './disks/drive.js';
// Drive-backed disk resolution (the provider's resolver; exported for wiring media outside AdonisJS)
export { createDriveBackedResolver } from './disks/drive.js';
export type { PresignS3UrlInput, SigV4Credentials } from './disks/sigv4.js';
// Hand-rolled SigV4 query presigner (what the S3 disk signs part/GET URLs with; exported for
// wiring presigned URLs outside the bundled disk)
export { presignS3Url } from './disks/sigv4.js';
// Errors
export {
  ContentSignatureUnrecognizedError,
  ContentTypeMismatchError,
  ConversionArtifactMissingError,
  ConversionNotDefinedError,
  DirectUploadsNotConfiguredError,
  DriveNotReadyError,
  HlsSourceUnsupportedError,
  ImageProcessorMissingError,
  MediaNotFoundError,
  MediaObjectMissingError,
  MimeNotAllowedError,
  ResumableUploadsNotConfiguredError,
  StoreNotConfiguredError,
  TransformerConflictError,
  TransformerNotDefinedError,
  TransformerOutputError,
  TransformerRuntimeMissingError,
  TransformNotReadyError,
  UploadNotSupportedError,
  UploadOffsetConflictError,
  UploadPartOutOfRangeError,
  UploadPartSizeError,
  UploadPartsIncompleteError,
  UploadSessionExpiredError,
  UploadSessionNotFoundError,
  UploadSessionStoreNotConfiguredError,
  VariantNotFoundError,
} from './errors.js';
export { isExtendedDisk } from './extended_disk.js';
export type {
  HlsDeliveryHandlerOptions,
  HlsDeliveryRequest,
  HlsDeliveryResult,
  HlsFileRef,
  HlsUrlBuilder,
} from './hls/delivery.js';
export { HlsDeliveryHandler } from './hls/delivery.js';
export type { HlsUriRef, HlsUriRewriter } from './hls/playlist.js';
// HLS delivery (playlist rewriting + the framework-agnostic package handler)
export {
  classifyUri,
  HLS_PLAYLIST_CONTENT_TYPE,
  HLS_SEGMENT_CONTENT_TYPE,
  hlsArtifactContentType,
  isRelativeUri,
  resolvePackagePath,
  rewriteHlsPlaylist,
} from './hls/playlist.js';
export type { ConversionPreset, ConversionResult, ImageProcessor } from './image_processor.js';
export type { MediaCollectionConfig } from './media_collection.js';
export { MediaCollectionRegistry } from './media_collection.js';
export type {
  AttachExistingInput,
  AttachInput,
  DeliverOptions,
  MediaLibraryOptions,
  MediaSignedUrlOptions,
  OwnerMediaBinding,
} from './media_library.js';
export { MediaLibrary } from './media_library.js';
export type { MediaManagerOptions } from './media_manager.js';
// Manager + layers
export { MediaManager } from './media_manager.js';
// Model + SPIs
export type { MediaConversion, MediaRecord } from './media_record.js';
export type { MediaCursor, MediaListOptions, MediaListPage, MediaStore } from './media_store.js';
export {
  clampMediaListLimit,
  DEFAULT_MEDIA_LIST_LIMIT,
  decodeMediaCursor,
  encodeMediaCursor,
  MAX_MEDIA_LIST_LIMIT,
} from './media_store.js';
export { isMultipartCapable } from './multipart.js';
export type {
  CreateUploadInput,
  ResumableUploadManagerOptions,
  UploadSession,
  UploadSessionListFilter,
  UploadSessionStore,
} from './resumable_upload.js';
// Resumable (TUS) uploads
export { ResumableUploadManager } from './resumable_upload.js';
export type { StorageManagerOptions } from './storage_manager.js';
export { StorageManager } from './storage_manager.js';
export type { MediaTableNames } from './stores/lucid-schema.js';
// Schema helpers (ecosystem convention — lib owns its own schema; see `stores/lucid-schema.ts`)
export { createMediaTables, dropMediaTables } from './stores/lucid-schema.js';
// Transformers (pluggable content transformations persisted as conversions)
export type {
  Transformer,
  TransformerContext,
  TransformerWriteOptions,
  TransformResult,
} from './transformer.js';
export type {
  HlsRemuxEngine,
  HlsRemuxRequest,
  HlsRemuxSummary,
  HlsTransformerOptions,
  WebCodecsProvider,
  WebCodecsSupport,
} from './transformers/hls.js';
export { HLS_ENTRY_PLAYLIST, HlsTransformer, resolveWebCodecsSupport } from './transformers/hls.js';
export type {
  MediaProbeEngine,
  MediaProbeSummary,
  MetadataProbeTransformerOptions,
} from './transformers/probe.js';
export { MetadataProbeTransformer } from './transformers/probe.js';
export type { TusRequest, TusResponse, TusUploadHandlerOptions } from './tus.js';
export { parseTusMetadata, TUS_VERSION, TusUploadHandler } from './tus.js';
export type {
  CompleteResolution,
  CopyOptions,
  DirectUploadPolicy,
  Disk,
  DiskCapabilities,
  DiskMetaData,
  DiskResolver,
  DiskStat,
  DiskWriteOptions,
  ExtendedDisk,
  InitiateDecision,
  ListEntry,
  ListOptions,
  ListResult,
  MultipartPart,
  MultipartUploadDisk,
  PolicyErrorInfo,
  SignedUrlOptions,
} from './types.js';
export type {
  AbortDirectUploadInput,
  CompleteDirectUploadInput,
  DirectUploadCreated,
  InitiateDirectUploadInput,
  PresignPartInput,
  ProxyUploadInput,
  UploadManagerOptions,
} from './upload_manager.js';
// Direct-S3 upload modes (proxy + direct multipart)
export { UploadManager } from './upload_manager.js';
export type { ResolvedUploadMode, UploadModeLevels } from './upload_mode.js';
export { resolveUploadMode } from './upload_mode.js';
