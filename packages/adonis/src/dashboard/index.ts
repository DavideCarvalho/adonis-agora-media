// Config idiom — author `config/media_dashboard.ts` against these.

export type {
  AccessDeniedInfo,
  AccessDeniedPageOptions,
  AccessDeniedReason,
} from './access_denied_page.js';
// The built-in "access denied" page (what a browser sees on a refused page navigation).
export {
  CONSOLE as ACCESS_DENIED_CONSOLE,
  escapeHtml,
  renderAccessDeniedPage,
  resolveAccessDeniedPage,
} from './access_denied_page.js';
// The access contract shared by every Agora console.
export type {
  AuthorizeByTokenOptions,
  ConsoleAuthorize,
  ConsoleAuthorizeDecision,
  ConsoleAuthorizeResult,
  ConsoleAuthorizer,
  ConsoleAuthorizerClass,
} from './console_authorize.js';
export {
  anyAuthorize,
  authorizeByToken,
  normalizeConsoleAuthorizeResult,
  resolveConsoleAuthorize,
} from './console_authorize.js';
export type {
  AgoraConsoleEntry,
  AgoraConsoleIcon,
  AgoraConsoleRegistry,
  AgoraConsoleSearchHit,
} from './console_switcher.js';
// The Agora console switcher: join it from a console the app mounts itself.
export { AGORA_CONSOLES_BINDING, registerAgoraConsole } from './console_switcher.js';
export type {
  AccessDeniedOption,
  AccessDeniedRenderer,
  DashboardMiddleware,
  MediaDashboardConfig,
} from './define_config.js';
export { defineConfig } from './define_config.js';
export type {
  DevTool,
  DevToolCall,
  DevToolInputProperty,
  DevToolInputSchema,
  DevToolsCaller,
  DevToolsDecision,
  DevToolsHub,
  DevToolsLib,
  MediaDevToolsOptions,
} from './dev_tools.js';
// Developer tools for the app's dev MCP endpoint (`@adonis-agora/agent`), when it has one.
export {
  DEV_TOOLS_BINDING,
  MAX_DELETE_KEYS,
  mediaDevTools,
  registerMediaDevTools,
} from './dev_tools.js';
// The list routes' request readers (`filter[...]`, `sort`, `after`/`first`) for your own routes.
export {
  CollectionListFilter,
  ObjectListFilter,
  readCollectionsQuery,
  readObjectsQuery,
  readUploadsQuery,
  UploadListFilter,
} from './list_api.js';
export type { ObjectInsightContext, ObjectInsightProvider } from './object_insights.js';
// Host-supplied object annotations.
export { sanitizeInsight } from './object_insights.js';
export type { ObjectUrlConfig, ObjectUrlStrategy } from './object_urls.js';
// Where the reported object `url` points (store-signed vs. this console's proxy).
export { objectProxyUrl } from './object_urls.js';
export type { DashboardServiceOptions, MediaManagerLike } from './service.js';
// Dashboard read/action logic (framework-free — the provider is a thin HTTP shell around this).
export { DashboardError, DashboardService } from './service.js';

// The JSON API contract shared by the SPA client and the provider routes.
export type {
  CollectionFilter,
  CollectionListResponse,
  CollectionSummary,
  CollectionsSummaryResponse,
  CopyMoveBody,
  CursorPageMeta,
  CursorPageResponse,
  CursorParams,
  DeleteBody,
  DiskCapabilities,
  DiskInfo,
  DiskListResponse,
  FolderBody,
  ListResponse,
  MediaDetailResponse,
  MediaEntry,
  MediaVariant,
  ObjectDetailResponse,
  ObjectEntry,
  ObjectFolder,
  ObjectInsight,
  ObjectInsightFact,
  ObjectInsightLink,
  ObjectInsightsResponse,
  ObjectListItem,
  ObjectListResponse,
  Topology,
  UploadDetailResponse,
  UploadFilter,
  UploadInfo,
  UploadListResponse,
  UploadPart,
} from './types.js';
