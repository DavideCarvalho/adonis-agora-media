import type { QueryClientContract } from '@adonisjs/lucid/types/database';
import {
  assertSafeIdentifier,
  assertSchema,
  detectDialect,
  type LucidDatabase,
  qualifiedTable,
} from '../stores/lucid-schema.js';

/** What {@link backfillMediaTenants} changes. */
export interface BackfillOptions {
  /** Records whose owner is the tenant itself (`Organization`): `tenant_id = owner_id`. */
  ownerType: string;
  /** The `media` table (default `media`). */
  table?: string;
  /** The database schema the table lives in (default: the connection's current one). */
  schema?: string;
  /** Count only, change nothing. */
  dryRun?: boolean;
}

/**
 * Stamp `tenant_id` on records that have none and whose owner IS the tenant (an `Organization`
 * owning its files): `tenant_id = owner_id`. Rows that already have a tenant are left alone.
 * Returns how many rows matched (and were updated, unless `dryRun`).
 */
export async function backfillMediaTenants(
  client: QueryClientContract,
  options: BackfillOptions,
): Promise<number> {
  const schema = assertSchema(
    options.schema,
    detectDialect(client as unknown as LucidDatabase),
    'media:tenancy:backfill',
  );
  const table = qualifiedTable(assertSafeIdentifier(options.table ?? 'media'), schema);
  const matching = () =>
    client.from(table).whereNull('tenant_id').where('owner_type', options.ownerType);
  const [row] = (await matching().count('* as total')) as Array<{ total?: unknown }>;
  const total = Number(row?.total ?? 0);
  if (options.dryRun || total === 0) return total;
  // `owner_id` is copied column to column: one UPDATE, no row through the app.
  await matching().update({ tenant_id: client.knexRawQuery('??', ['owner_id']) });
  return total;
}
