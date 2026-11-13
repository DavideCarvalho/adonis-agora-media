import type { MediaDashboardConfig } from './define_config.js';
import type { ObjectUrlStrategy } from './object_urls.js';
import { DashboardService, type MediaManagerLike } from './service.js';
import { normalizePath } from './spa.js';
import { consoleKeyPrefixes, scopedManager } from './tenant_scope.js';

/** The slice of the app's config the console's service is built from. */
export interface ConsoleServiceConfig {
  /** `config/media_dashboard.ts`. */
  console: MediaDashboardConfig;
  /** `config/media.ts` (only `disk`, `disks` and `delivery.mode` are read). */
  media: { disk?: string; disks?: Record<string, unknown>; delivery?: { mode?: string } };
  /** `config/drive.ts` (only `default` is read). */
  drive: { default?: string };
}

/** Read {@link ConsoleServiceConfig} from an app's config. */
export function readConsoleServiceConfig(config: {
  get<T>(key: string, defaultValue?: unknown): T;
}): ConsoleServiceConfig {
  return {
    console: config.get<MediaDashboardConfig>('media_dashboard', {}),
    media: config.get<ConsoleServiceConfig['media']>('media', {}),
    drive: config.get<ConsoleServiceConfig['drive']>('drive', {}),
  };
}

/** The disks the console browses: the configured list, else the media default plus `disks` keys. */
export function consoleDiskNames(config: ConsoleServiceConfig): string[] {
  const listed = config.console.disks;
  if (listed && listed.length > 0) return listed;
  const defaultName = config.media.disk ?? config.drive.default ?? 'default';
  const configured = config.media.disks ? Object.keys(config.media.disks) : [];
  return Array.from(new Set([defaultName, ...configured]));
}

/**
 * Which `url` the console reports for an object's bytes. An explicit `objectUrls` always wins;
 * when unset, the console follows the core media config: a host already streaming every read
 * through the app (`delivery.mode: 'proxy'`) has declared its store unreachable from a browser,
 * so a signed URL minted for the internal endpoint would be a link the console cannot open.
 * Anything else keeps the historical `'auto'`.
 */
export function consoleObjectUrlStrategy(config: ConsoleServiceConfig): ObjectUrlStrategy {
  if (config.console.objectUrls) return config.console.objectUrls;
  return config.media.delivery?.mode === 'proxy' ? 'proxy' : 'auto';
}

/** Where the console's JSON API is mounted. */
export function consoleApiBase(config: MediaDashboardConfig): string {
  const basePath = normalizePath(config.basePath ?? '/media/dashboard');
  return normalizePath(config.apiBasePath ?? `${basePath}/api`);
}

/**
 * The console's {@link DashboardService} over `manager`: its disks, its `actions` switch, its
 * object-URL strategy and its insight providers. With tenancy on it is confined to `ids` (`undefined`:
 * every tenant). The console's JSON API, its developer tools and the `media:*` commands all use it.
 */
export function buildConsoleService(
  manager: MediaManagerLike & { readonly tenancy?: { readonly enabled: boolean } | undefined },
  config: ConsoleServiceConfig,
  ids?: Array<string | null> | undefined,
): DashboardService {
  const objectUrls = {
    strategy: consoleObjectUrlStrategy(config),
    apiBasePath: consoleApiBase(config.console),
  };
  const options = {
    diskNames: consoleDiskNames(config),
    actions: config.console.actions ?? false,
    objectUrls,
  };
  const insights = config.console.objectInsights ?? [];
  if (!manager.tenancy?.enabled) return new DashboardService(manager, options, insights);
  const keyPrefixes = consoleKeyPrefixes(ids);
  return new DashboardService(
    scopedManager(manager, ids),
    { ...options, ...(keyPrefixes !== undefined ? { keyPrefixes } : {}) },
    insights,
  );
}
