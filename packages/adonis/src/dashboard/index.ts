// Config idiom — author `config/media_dashboard.ts` against these.
export { defineConfig } from './define_config.js';
export type { MediaDashboardConfig, DashboardMiddleware } from './define_config.js';

// Dashboard read/action logic (framework-free — the provider is a thin HTTP shell around this).
export { DashboardService, DashboardError } from './service.js';
export type { MediaManagerLike, DashboardServiceOptions } from './service.js';

// Built-in session-cookie login.
export { resolveConsoleAuth, signSessionCookie, verifySessionCookie } from './auth.js';
export type {
  ConsoleAuthOptions,
  ConsoleSession,
  ConsoleSessionUser,
  ResolvedConsoleAuth,
  AuthMode,
  SessionHook,
  LoginHook,
  RevalidateHook,
} from './auth.js';

// Host-supplied object annotations.
export { sanitizeInsight } from './object_insights.js';
export type { ObjectInsightProvider, ObjectInsightContext } from './object_insights.js';

// The JSON API contract shared by the SPA client and the provider routes.
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
