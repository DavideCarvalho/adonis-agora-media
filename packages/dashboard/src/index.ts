/**
 * `@adonis-agora/media-dashboard`'s public surface: the console's wire-format API types. The console
 * itself (provider, `defineConfig`, `DashboardService`, `authorize`) ships in `@adonis-agora/media`
 * under `./dashboard_provider` and `./dashboard`; this package is the SPA's build-time source.
 */
export type {
  CollectionFilter,
  CollectionListResponse,
  CollectionSummary,
  CollectionsSummaryResponse,
  CopyMoveBody,
  CursorPage,
  CursorPageInfo,
  CursorParams,
  DeleteBody,
  DiskCapabilities,
  DiskInfo,
  DiskListResponse,
  FolderBody,
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
  ObjectListResponse,
  Topology,
  UploadDetailResponse,
  UploadInfo,
  UploadListResponse,
  UploadPart,
} from './types.js';
