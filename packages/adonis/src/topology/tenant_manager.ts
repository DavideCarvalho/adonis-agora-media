import type { MediaConfig } from '../define_config.js';
import { MediaTenantUnsupportedError } from '../errors.js';
import { MediaManager } from '../media_manager.js';
import { TenantAccounts } from './tenant_accounts.js';
import { tenantClientOf } from './tenant_client.js';
import { RemoteMediaStore, TenantMediaLibrary } from './tenant_library.js';

/** The disk name a tenant reports: it has none of its own. */
export const TENANT_DISK = 'control-plane';

export { tenantClientOf };

/**
 * The {@link MediaManager} of a tenant: `media.library` runs on the control plane, `media.accounts`
 * reads and writes a person's own files there. This app keeps its collection `access` rules and its
 * delivery settings (route, signing); it has no disk, store or upload session of its own.
 */
export function buildTenantManager(
  config: MediaConfig,
  options: { fetch?: typeof fetch } = {},
): MediaManager {
  const client = tenantClientOf(config, options);
  const urls = config.tenant?.urls;
  return new MediaManager({
    defaultDisk: TENANT_DISK,
    resolve: () => {
      throw new MediaTenantUnsupportedError('A disk');
    },
    store: new RemoteMediaStore(client),
    topology: 'tenant',
    accounts: new TenantAccounts(client),
    library: (libraryOptions) =>
      new TenantMediaLibrary(libraryOptions, { client, ...(urls !== undefined ? { urls } : {}) }),
    ...(config.collections !== undefined ? { collections: config.collections } : {}),
    ...(config.emitDiagnostics !== undefined ? { emitDiagnostics: config.emitDiagnostics } : {}),
    ...(config.delivery?.mode !== undefined ? { deliveryMode: config.delivery.mode } : {}),
    ...(config.delivery?.images !== undefined ? { deliveryImages: config.delivery.images } : {}),
    ...(config.delivery?.signing !== undefined ? { deliverySigning: config.delivery.signing } : {}),
    ...(config.delivery?.path !== undefined ? { deliveryPath: config.delivery.path } : {}),
    ...(config.access?.identity !== undefined ? { accessIdentity: config.access.identity } : {}),
  });
}
