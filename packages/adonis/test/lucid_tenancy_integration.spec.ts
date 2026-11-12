import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { MediaRecord } from '../src/media_record.js';
import { LucidMediaStore } from '../src/stores/lucid.js';
import { ensureMediaTenantColumn } from '../src/stores/lucid-schema.js';
import { runMediaMigration, runMigrationStub, runTenancyMigration } from './lucid_helpers.js';

/**
 * Tenancy's `tenant_id` column and `media_tenant_owner_idx` on real Postgres and MySQL. On MySQL
 * the four VARCHAR(255) columns exceed InnoDB's 3072-byte key limit under utf8mb4, so the index
 * covers a prefix of each there; Postgres indexes the whole columns.
 *
 * Runs when `MEDIA_TEST_PG_URL` / `MEDIA_TEST_MYSQL_URL` are set (CI sets both), e.g.
 * `postgres://postgres:postgres@127.0.0.1:5432/postgres` and `mysql://root:root@127.0.0.1:3306/app`.
 */
const targets = [
  { name: 'postgres', client: 'pg', url: process.env.MEDIA_TEST_PG_URL },
  { name: 'mysql', client: 'mysql2', url: process.env.MEDIA_TEST_MYSQL_URL },
] as const;

const INDEX = 'media_tenant_owner_idx';

function record(over: Partial<MediaRecord>): MediaRecord {
  return {
    id: 'id',
    ownerType: 'Post',
    ownerId: '1',
    collection: 'gallery',
    name: 'a',
    fileName: 'a.png',
    mimeType: 'image/png',
    size: 1,
    disk: 'fs',
    path: 'p',
    order: 0,
    customProperties: {},
    conversions: {},
    createdAt: new Date(1_000),
    updatedAt: new Date(1_000),
    ...over,
  };
}

/** The rows of a Lucid `rawQuery` result, whatever the driver returned. */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return (Array.isArray(result[0]) ? result[0] : result) as never;
  return ((result as { rows?: unknown[] }).rows ?? []) as never;
}

for (const target of targets) {
  describe.skipIf(!target.url)(`media tenancy schema (${target.name})`, () => {
    const mysql = target.client === 'mysql2';
    let db: Database;

    const raw = async (sql: string, bindings: unknown[] = []) =>
      rowsOf(await db.connection().rawQuery(sql, bindings as never));

    /** The columns of `media_tenant_owner_idx`, in order, with MySQL's prefix length. */
    const indexColumns = async (): Promise<string[]> => {
      if (mysql) {
        const rows = await raw(
          'SELECT column_name AS col, sub_part AS part FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? ORDER BY seq_in_index',
          ['media', INDEX],
        );
        return rows.map((row) => `${row.col}(${row.part ?? 'full'})`);
      }
      const rows = await raw(
        `SELECT a.attname AS col FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
          WHERE c.relname = ? AND n.nspname = current_schema()
          ORDER BY k.ord`,
        [INDEX],
      );
      return rows.map((row) => `${row.col}(full)`);
    };

    const expected = mysql
      ? ['tenant_id(191)', 'owner_type(191)', 'owner_id(191)', 'collection(191)']
      : ['tenant_id(full)', 'owner_type(full)', 'owner_id(full)', 'collection(full)'];

    beforeAll(() => {
      const app = new AppFactory().create(new URL('./', import.meta.url), () => {}) as any;
      db = new Database(
        {
          connection: 'main',
          connections: { main: { client: target.client, connection: target.url } as never },
        },
        new LoggerFactory().create(),
        new Emitter(app),
      );
    });

    afterAll(async () => {
      await db?.manager.closeAll();
    });

    afterEach(async () => {
      for (const table of ['media_upload_parts', 'media_upload_sessions', 'media']) {
        await raw(`DROP TABLE IF EXISTS ${table}`);
      }
    });

    it('the tenancy migration adds the column and the index, and the store uses them', async () => {
      await runMediaMigration(db);
      await runMigrationStub(db, 'create_media_upload_sessions_table.stub');
      await runTenancyMigration(db);
      expect(await indexColumns()).toEqual(expected);

      const store = new LucidMediaStore(db, { autoCreateSchema: false, tenantColumn: true });
      expect(await store.hasTenantColumn()).toBe(true);
      await store.save(record({ id: 'a', tenantId: 't1' }));
      await store.save(record({ id: 'b', tenantId: 't2' }));
      expect(await store.listTenants()).toEqual(['t1', 't2']);
      expect((await store.list({ tenantIds: ['t1'] })).items.map((m) => m.id)).toEqual(['a']);

      await runMigrationStub(db, 'add_media_tenant_id.stub', { direction: 'down' });
      expect(await indexColumns()).toEqual([]);
      expect(await store.hasTenantColumn()).toBe(false);
    });

    it('re-running the migration after it added the column but not the index completes it', async () => {
      await runMediaMigration(db);
      // What a failed earlier attempt leaves on MySQL, where DDL is not transactional.
      await raw('ALTER TABLE media ADD COLUMN tenant_id VARCHAR(255) NULL');
      if (mysql) {
        await runTenancyMigration(db);
        expect(await indexColumns()).toEqual(expected);
      } else {
        // Postgres rolled the whole migration back, so the column never stays behind there.
        await expect(runTenancyMigration(db)).rejects.toThrow(/tenant_id/);
      }
    });

    it('ensureMediaTenantColumn adds the column and index, idempotently', async () => {
      await runMediaMigration(db);
      await ensureMediaTenantColumn(db.connection());
      await ensureMediaTenantColumn(db.connection());
      expect(await indexColumns()).toEqual(expected);

      // The store's self-repair path (tenancy on, auto-create on) on a migrated table.
      await raw(`DROP INDEX ${INDEX}${mysql ? ' ON media' : ''}`);
      const store = new LucidMediaStore(db, { autoCreateSchema: false, tenantColumn: true });
      await ensureMediaTenantColumn(db.connection());
      await store.save(record({ id: 'x', tenantId: 't' }));
      expect(await indexColumns()).toEqual(expected);
    });
  });
}
