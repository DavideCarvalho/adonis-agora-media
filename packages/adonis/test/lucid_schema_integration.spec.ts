import { randomBytes } from 'node:crypto';
import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { backfillMediaTenants } from '../src/commands/tenancy_backfill.js';
import { checkStoreSchema } from '../src/doctor/checks.js';
import type { MediaRecord } from '../src/media_record.js';
import { LucidMediaStore } from '../src/stores/lucid.js';
import { createMediaTables, dropMediaTables, rowsOf } from '../src/stores/lucid-schema.js';
import { LucidUploadSessionStore } from '../src/upload_sessions/lucid.js';
import { runMigrationStub } from './lucid_helpers.js';

/**
 * The `schema` option against real Postgres and MySQL: media's tables live in a schema (a MySQL
 * database) other than the connection's default, and nothing lands in the default one.
 *
 * Runs when `MEDIA_TEST_PG_URL` / `MEDIA_TEST_MYSQL_URL` are set (CI sets both), e.g.
 * `postgres://postgres:postgres@127.0.0.1:5432/postgres` and `mysql://root:root@127.0.0.1:3306/app`.
 */
const targets = [
  { name: 'postgres', client: 'pg', url: process.env.MEDIA_TEST_PG_URL },
  { name: 'mysql', client: 'mysql2', url: process.env.MEDIA_TEST_MYSQL_URL },
] as const;

const TABLES = ['media', 'media_upload_sessions', 'media_upload_parts'];
/** A table reference in captured SQL (not an index name such as `media_created_idx`). */
const TABLE_REF = /(media_upload_sessions|media_upload_parts|media)(?![A-Za-z0-9_])/g;

function record(over: Partial<MediaRecord>): MediaRecord {
  return {
    id: 'id',
    ownerType: 'Post',
    ownerId: '1',
    collection: 'gallery',
    name: 'a',
    fileName: 'a.png',
    mimeType: 'image/png',
    size: 10,
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

for (const target of targets) {
  describe.skipIf(!target.url)(`media lucid stores with schema (${target.name})`, () => {
    const mysql = target.client === 'mysql2';
    const quote = mysql ? '`' : '"';
    let db: Database;
    let schema: string | undefined;
    let statements: string[] = [];

    const raw = async (sql: string, bindings: unknown[] = []) =>
      rowsOf(await db.connection().rawQuery(sql, bindings as never));

    const tablesIn = async (where: string): Promise<string[]> =>
      (
        await raw(
          `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ? AND table_name IN (${TABLES.map(() => '?').join(', ')}) ORDER BY table_name`,
          [where, ...TABLES],
        )
      ).map((row) => String(row.name));

    const defaultSchema = async (): Promise<string> =>
      String(
        (await raw(mysql ? 'SELECT DATABASE() AS name' : 'SELECT current_schema() AS name'))[0]
          ?.name,
      );

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
      const knex = db.connection().getWriteClient() as unknown as {
        on(event: 'query', listener: (query: { sql: string }) => void): void;
      };
      knex.on('query', (query) => statements.push(query.sql));
    });

    afterAll(async () => {
      await db?.manager.closeAll();
    });

    afterEach(async () => {
      if (schema === undefined) return;
      await raw(
        mysql
          ? `DROP DATABASE IF EXISTS \`${schema}\``
          : `DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
      );
      schema = undefined;
    });

    const freshSchema = (): string => {
      schema = `mschema_${randomBytes(4).toString('hex')}`;
      statements = [];
      return schema;
    };

    /** Every media table reference in the captured SQL is `<schema>.<table>`. */
    const expectAllQualified = () => {
      const unqualified: string[] = [];
      for (const sql of statements) {
        for (const match of sql.matchAll(TABLE_REF)) {
          const before = sql.slice(0, match.index);
          // Skip the name inside a string literal / binding placeholder and index names.
          if (before.endsWith("'") || before.endsWith('_')) continue;
          if (!before.endsWith(`${quote}${schema}${quote}.${quote}`)) unqualified.push(sql);
        }
      }
      expect(unqualified).toEqual([]);
      expect(statements.length).toBeGreaterThan(0);
    };

    it('auto-creates the schema and the media table there, and reads/writes only there', async () => {
      const name = freshSchema();
      const store = new LucidMediaStore(db, { schema: name });

      await store.save(record({ id: 'a', createdAt: new Date(1_000), size: 10 }));
      await store.save(record({ id: 'b', createdAt: new Date(2_000), size: 5, order: 1 }));
      await store.save(record({ id: 'c', collection: 'docs', createdAt: new Date(3_000) }));
      await store.save(record({ id: 'a', name: 'renamed', createdAt: new Date(1_000), size: 10 }));

      expect(await tablesIn(name)).toEqual(['media']);
      expect(await tablesIn(await defaultSchema())).toEqual([]);

      expect((await store.find('a'))?.name).toBe('renamed');
      expect((await store.listByOwner('Post', '1', 'gallery')).map((m) => m.id)).toEqual([
        'a',
        'b',
      ]);
      const first = await store.list({ limit: 2 });
      expect(first.items.map((m) => m.id)).toEqual(['c', 'b']);
      const second = await store.list({ limit: 2, cursor: first.nextCursor ?? undefined });
      expect(second.items.map((m) => m.id)).toEqual(['a']);
      expect(await store.nextOrder('Post', '1', 'gallery')).toBe(2);
      expect(
        (await store.collectionTotals()).map((t) => [t.collection, t.count, t.sumSize]),
      ).toEqual(
        expect.arrayContaining([
          ['gallery', 2, 15],
          ['docs', 1, 10],
        ]),
      );
      await store.delete('c');
      expect(await store.find('c')).toBeNull();

      // A second store (another process) finds the schema and table in place.
      const again = new LucidMediaStore(db, { schema: name });
      expect((await again.find('a'))?.id).toBe('a');

      expectAllQualified();
    });

    it('runs the published migrations into the schema and back out', async () => {
      const name = freshSchema();
      await runMigrationStub(db, 'create_media_table.stub', { schema: name });
      await runMigrationStub(db, 'create_media_upload_sessions_table.stub', { schema: name });
      expect(await tablesIn(name)).toEqual([...TABLES].sort());
      expect(await tablesIn(await defaultSchema())).toEqual([]);

      const store = new LucidMediaStore(db, { schema: name, autoCreateSchema: false });
      await store.save(record({ id: 'm' }));
      expect((await store.find('m'))?.id).toBe('m');

      await runMigrationStub(db, 'create_media_upload_sessions_table.stub', {
        schema: name,
        direction: 'down',
      });
      await runMigrationStub(db, 'create_media_table.stub', { schema: name, direction: 'down' });
      expect(await tablesIn(name)).toEqual([]);
    });

    it('keeps upload sessions and their parts in the schema', async () => {
      const name = freshSchema();
      await runMigrationStub(db, 'create_media_upload_sessions_table.stub', { schema: name });
      statements = [];
      const sessions = new LucidUploadSessionStore(db, { schema: name });

      await sessions.create({ id: 's1', disk: 'fs', key: 'uploads/a', offset: 0, parts: 0 });
      await sessions.update({ id: 's1', disk: 'fs', key: 'uploads/a', offset: 5, parts: 1 });
      await sessions.addPart('s1', { partNumber: 1, etag: 'e1' });
      await sessions.addPart('s1', { partNumber: 1, etag: 'e2' });

      expect((await sessions.get('s1'))?.offset).toBe(5);
      expect(await sessions.listParts('s1')).toEqual([{ partNumber: 1, etag: 'e2' }]);
      expect((await sessions.list({ keyPrefix: 'uploads/' })).map((s) => s.id)).toEqual(['s1']);
      await sessions.delete('s1');
      expect(await sessions.get('s1')).toBeNull();
      expect(await sessions.listParts('s1')).toEqual([]);

      expectAllQualified();
    });

    it("backfills tenants inside the app's own transaction", async () => {
      const name = freshSchema();
      const store = new LucidMediaStore(db, { schema: name });
      await store.save(record({ id: 'o1', ownerType: 'Organization', ownerId: 'org-1' }));
      await raw(
        `ALTER TABLE ${quote}${name}${quote}.${quote}media${quote} ADD COLUMN ${quote}tenant_id${quote} VARCHAR(255) NULL`,
      );

      const trx = await db.connection().transaction();
      const count = await backfillMediaTenants(trx, { ownerType: 'Organization', schema: name });
      await trx.commit();

      expect(count).toBe(1);
      const rows = await raw(
        `SELECT ${quote}tenant_id${quote} AS tenant FROM ${quote}${name}${quote}.${quote}media${quote}`,
      );
      expect(rows.map((row) => row.tenant)).toEqual(['org-1']);
      expectAllQualified();
    });

    it('adds the tenant column in the schema', async () => {
      const name = freshSchema();
      const store = new LucidMediaStore(db, { schema: name, tenantColumn: true });
      await store.save(record({ id: 't', tenantId: 'tenant-1' }));
      expect(await store.hasTenantColumn()).toBe(true);
      expect(await store.listTenants()).toEqual(['tenant-1']);
      expect(await store.list({ tenantIds: ['tenant-1'] })).toMatchObject({
        items: [{ id: 't' }],
      });

      await runMigrationStub(db, 'create_media_upload_sessions_table.stub', { schema: name });
      const sessions = new LucidUploadSessionStore(db, { schema: name, tenantColumn: true });
      await raw(
        `ALTER TABLE ${quote}${name}${quote}.${quote}media_upload_sessions${quote} ADD COLUMN ${quote}tenant_id${quote} VARCHAR(255) NULL`,
      );
      await sessions.create({ id: 's', disk: 'fs', key: 'k', offset: 0, parts: 0, tenantId: 'x' });
      expect((await sessions.list({ tenantIds: ['x'] })).map((s) => s.id)).toEqual(['s']);
      expectAllQualified();
    });

    it('runs the tenancy migration into the schema and back out', async () => {
      const name = freshSchema();
      await runMigrationStub(db, 'create_media_table.stub', { schema: name });
      await runMigrationStub(db, 'create_media_upload_sessions_table.stub', { schema: name });
      await runMigrationStub(db, 'add_media_tenant_id.stub', { schema: name });

      const tenantColumns = async (where: string) =>
        (
          await raw(
            "SELECT table_name AS name FROM information_schema.columns WHERE table_schema = ? AND column_name = 'tenant_id' ORDER BY table_name",
            [where],
          )
        ).map((row) => String(row.name));
      const tenantIndex = async () =>
        (
          await raw(
            mysql
              ? 'SELECT sub_part AS part FROM information_schema.statistics WHERE table_schema = ? AND table_name = ? AND index_name = ? ORDER BY seq_in_index'
              : 'SELECT indexname AS part FROM pg_indexes WHERE schemaname = ? AND tablename = ? AND indexname = ?',
            [name, 'media', 'media_tenant_owner_idx'],
          )
        ).map((row) => String(row.part));

      expect(await tenantColumns(name)).toEqual(['media', 'media_upload_sessions']);
      expect(await tenantColumns(await defaultSchema())).toEqual([]);
      // MySQL indexes a 191-character prefix of each of the four columns (InnoDB's key limit).
      expect(await tenantIndex()).toEqual(
        mysql ? ['191', '191', '191', '191'] : ['media_tenant_owner_idx'],
      );

      await runMigrationStub(db, 'add_media_tenant_id.stub', { schema: name, direction: 'down' });
      expect(await tenantColumns(name)).toEqual([]);
      expect(await tenantIndex()).toEqual([]);
    });

    it.skipIf(mysql)('reports a table the role cannot write to', async () => {
      const name = freshSchema();
      await runMigrationStub(db, 'create_media_upload_sessions_table.stub', { schema: name });
      const role = `${name}_ro`;
      await raw(`DROP ROLE IF EXISTS ${role}`);
      await raw(`CREATE ROLE ${role} LOGIN PASSWORD 'pw'`);
      await raw(`GRANT USAGE ON SCHEMA "${name}" TO ${role}`);
      await raw(`GRANT ALL ON "${name}"."media_upload_sessions" TO ${role}`);
      await raw(`GRANT SELECT ON "${name}"."media_upload_parts" TO ${role}`);
      const url = new URL(target.url as string);
      url.username = role;
      url.password = 'pw';
      const app = new AppFactory().create(new URL('./', import.meta.url), () => {}) as any;
      const limited = new Database(
        { connection: 'ro', connections: { ro: { client: 'pg', connection: url.href } as never } },
        new LoggerFactory().create(),
        new Emitter(app),
      );
      try {
        const results = await checkStoreSchema(
          'sessions',
          new LucidUploadSessionStore(limited, { schema: name }),
        );
        expect(results.map((r) => r.status)).toEqual(['error']);
        expect(results[0]?.message).toContain('media_upload_parts');
      } finally {
        await limited.manager.closeAll();
        await raw(`DROP OWNED BY ${role}`);
        await raw(`DROP ROLE ${role}`);
      }
    });

    it('reports the schema to agora:doctor', async () => {
      const name = freshSchema();
      const store = new LucidMediaStore(db, { schema: name });
      const before = await checkStoreSchema('media store', store);
      expect(before[0]?.status).toBe('error');
      expect(before[0]?.message).toContain('does not exist');

      await createMediaTables(db.connection(), { schema: name });
      expect((await checkStoreSchema('media store', store)).map((r) => r.status)).toEqual(['ok']);

      const sessions = new LucidUploadSessionStore(db, { schema: name });
      const missing = await checkStoreSchema('sessions', sessions);
      expect(missing[0]?.status).toBe('error');
      expect(missing[0]?.message).toContain('media_upload_sessions, media_upload_parts');

      await dropMediaTables(db.connection(), { schema: name });
      expect(await tablesIn(name)).toEqual([]);

      // Without a schema: no result at all.
      expect(await checkStoreSchema('media store', new LucidMediaStore(db))).toEqual([]);
    });
  });
}
