export { type MediaDashboardOptions, mediaDashboard } from './dashboard.js';
export { mediaTelescopeExtension } from './extension.js';
export {
  mediaActiveUploadsProvider,
  mediaAttachmentActivityProvider,
  mediaConversionsOverTimeProvider,
  mediaRecentConversionsProvider,
  mediaRecentUploadsProvider,
  mediaStorageOpsOverTimeProvider,
  mediaUploadSuccessRateProvider,
  mediaUploadThroughputProvider,
  mediaUploadsOverTimeProvider,
} from './data-providers.js';
export type {
  ContainerLike,
  DataProvider,
  DashboardSpec,
  ExtensionContext,
  LinkSpec,
  TelescopeExtension,
  TelescopeStoreLike,
  TelescopeEntryLike,
} from './telescope-sdk.js';
