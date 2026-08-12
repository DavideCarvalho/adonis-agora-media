export {
  type DirectUploadOptions,
  type DirectUploadPartUrl,
  type DirectUploadSessionStatus,
  type MediaUploadClient,
  type MediaUploadClientOptions,
  type MediaUploadResult,
  type PartUploader,
  type PerUploadOptions,
  type TusUploadOptions,
  type UploadedPart,
  type UploadMeta,
  MediaHttpError,
  createMediaUploadClient,
  mediaUrl,
  xhrPartUploader,
} from './client.js';
export {
  MEDIA_UPLOADER_STYLE_ID,
  ensureMediaUploaderStyles,
  mediaUploaderCss,
} from './styles.js';
export * from './use-media-upload.js';
export * from './media-uploader.js';

// The embeddable "open dashboard" widget — mint a console session from your own app's auth and
// navigate to `@adonis-agora/media-dashboard`. Ported from the NestJS sibling console's
// `src/react/*` so both ecosystems ship the same building block.
export {
  ConsoleSessionError,
  type OpenConsoleOptions,
  mediaDashboardSessionUrl,
  mediaDashboardUrl,
  mintMediaDashboardSession,
  openMediaDashboard,
} from './console-session.js';
export {
  type UseOpenConsoleResult,
  openMediaDashboardMutationOptions,
  useOpenMediaDashboard,
} from './use-open-console.js';
export {
  OpenMediaDashboardButton,
  type OpenMediaDashboardButtonProps,
} from './open-console-button.js';
