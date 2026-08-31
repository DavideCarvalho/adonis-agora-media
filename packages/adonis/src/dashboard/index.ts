// Config idiom — author `config/media_dashboard.ts` against these.

export type {
  AuthMode,
  ConsoleAuthOptions,
  ConsoleSession,
  ConsoleSessionUser,
  LoginHook,
  ResolvedConsoleAuth,
  RevalidateHook,
  SessionHook,
} from './auth.js';
// Built-in session-cookie login.
export { resolveConsoleAuth, signSessionCookie, verifySessionCookie } from './auth.js';
export type { DashboardMiddleware, MediaDashboardConfig } from './define_config.js';
export { defineConfig } from './define_config.js';
export type { ObjectInsightContext, ObjectInsightProvider } from './object_insights.js';
// Host-supplied object annotations.
export { sanitizeInsight } from './object_insights.js';
export type { DashboardServiceOptions, MediaManagerLike } from './service.js';
// Dashboard read/action logic (framework-free — the provider is a thin HTTP shell around this).
export { DashboardError, DashboardService } from './service.js';

// The JSON API contract shared by the SPA client and the provider routes.
export type {
  CollectionFilter,
  CollectionListResponse,
  CollectionSummary,
  CollectionsSummaryResponse,
  ConsoleSessionUserInfo,
  CopyMoveBody,
  DeleteBody,
  DiskCapabilities,
  DiskInfo,
  DiskListResponse,
  LoginBody,
  MediaDetailResponse,
  MediaEntry,
  MediaVariant,
  MeResponse,
  ObjectDetailResponse,
  ObjectEntry,
  ObjectFolder,
  ObjectInsight,
  ObjectInsightFact,
  ObjectInsightLink,
  ObjectInsightsResponse,
  ObjectListResponse,
  Topology,
  UploadDetailResponse,
  UploadInfo,
  UploadListResponse,
  UploadPart,
} from './types.js';
