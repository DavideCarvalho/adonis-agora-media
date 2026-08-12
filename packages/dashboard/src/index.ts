export { defineConfig } from './define_config.js';
export type { MediaDashboardConfig, DashboardMiddleware } from './define_config.js';
export { default as MediaDashboardProvider } from './provider/media_dashboard_provider.js';
export { DashboardService, DashboardError } from './server/service.js';
export type { MediaManagerLike, DashboardServiceOptions } from './server/service.js';
export {
  resolveConsoleAuth,
  signSessionCookie,
  verifySessionCookie,
} from './server/auth.js';
export type {
  ConsoleAuthOptions,
  ConsoleSession,
  ConsoleSessionUser,
  ResolvedConsoleAuth,
  AuthMode,
  SessionHook,
  LoginHook,
  RevalidateHook,
} from './server/auth.js';
export { sanitizeInsight } from './server/object_insights.js';
export type { ObjectInsightProvider, ObjectInsightContext } from './server/object_insights.js';
export type {
  DiskInfo,
  DiskListResponse,
  DiskCapabilities,
  ObjectFolder,
  ObjectEntry,
  ObjectListResponse,
  ObjectDetailResponse,
  MediaEntry,
  MediaVariant,
  MediaDetailResponse,
  CollectionListResponse,
  CollectionFilter,
  CollectionSummary,
  CollectionsSummaryResponse,
  UploadInfo,
  UploadPart,
  UploadListResponse,
  UploadDetailResponse,
  Topology,
  CopyMoveBody,
  DeleteBody,
  ObjectInsight,
  ObjectInsightFact,
  ObjectInsightLink,
  ObjectInsightsResponse,
  ConsoleSessionUserInfo,
  MeResponse,
  LoginBody,
} from './types.js';
