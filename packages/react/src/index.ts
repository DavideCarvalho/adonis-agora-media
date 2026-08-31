export {
  createMediaUploadClient,
  type DirectUploadOptions,
  type DirectUploadPartUrl,
  type DirectUploadSessionStatus,
  MediaHttpError,
  type MediaUploadClient,
  type MediaUploadClientOptions,
  type MediaUploadResult,
  mediaUrl,
  type PartUploader,
  type PerUploadOptions,
  type TusUploadOptions,
  type UploadedPart,
  type UploadMeta,
  xhrPartUploader,
} from './client.js';
// The embeddable "open dashboard" widget — mint a console session from your own app's auth and
// navigate to `@adonis-agora/media-dashboard`. Ported from the NestJS sibling console's
// `src/react/*` so both ecosystems ship the same building block.
export {
  ConsoleSessionError,
  mediaDashboardSessionUrl,
  mediaDashboardUrl,
  mintMediaDashboardSession,
  type OpenConsoleOptions,
  openMediaDashboard,
} from './console-session.js';
export * from './media-uploader.js';
export {
  OpenMediaDashboardButton,
  type OpenMediaDashboardButtonProps,
} from './open-console-button.js';
export {
  ensureMediaUploaderStyles,
  MEDIA_UPLOADER_STYLE_ID,
  mediaUploaderCss,
} from './styles.js';
export * from './use-media-upload.js';
export {
  openMediaDashboardMutationOptions,
  type UseOpenConsoleResult,
  useOpenMediaDashboard,
} from './use-open-console.js';
