/**
 * `@adonis-agora/media-dashboard`'s public surface, shrunk as of `7.0.0`: `defineConfig`,
 * `DashboardService`/`DashboardError`, the session-auth helpers and `ObjectInsightProvider` all moved
 * to `@adonis-agora/media`'s own `./dashboard` subpath — the console is now embedded there, and this
 * package's provider (still exported below) is a thin delegate to it. Author `config/media_dashboard.ts`
 * against `@adonis-agora/media/dashboard`'s `defineConfig` regardless of which provider you register;
 * both read the SAME `media_dashboard` config key.
 *
 * What's left here: the standalone provider entry point, and the wire-format API types (kept as this
 * package's own copy — the SPA needs them and importing `@adonis-agora/media`'s copy would reintroduce
 * the workspace cycle the provider's delegation deliberately avoids; see that file's doc comment).
 */
export { default as MediaDashboardProvider } from './provider/media_dashboard_provider.js';
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
