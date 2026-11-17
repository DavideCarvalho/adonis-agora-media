import { randomBytes } from 'node:crypto';
import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DashboardService } from '../../src/dashboard/service.js';
import {
  buildFederatedMediaApp,
  FederatedConsoleService,
  mediaConsoleCommandHandler,
} from '../../src/federation/console.js';
import { RedisConsoleChannel } from '../../src/federation/redis_channel.js';
import type { MediaRecord } from '../../src/media_record.js';
import { stores } from '../../src/stores/factory.js';
import { LucidMediaStore } from '../../src/stores/lucid.js';
import { createMediaTables, rowsOf } from '../../src/stores/lucid-schema.js';
import { uploadSessions } from '../../src/upload_sessions/factory.js';
import { LucidUploadSessionStore } from '../../src/upload_sessions/lucid.js';
import { runMigrationStub } from '../lucid_helpers.js';
import { RedisBus } from '../support/redis_bus.js';

/**
 * The federated console against real Postgres: the owning app's media tables live in its own
 * schema, the console's app has its own, and the console reads the owning app's through a role
 * that has only `USAGE` + `SELECT` there. Runs when `MEDIA_TEST_PG_URL` is set.
 */
const url = process.env.MEDIA_TEST_PG_URL;

function record(over: Partial<MediaRecord>): MediaRecord {
  return {
    id: 'id',
    ownerType: 'User',
    ownerId: '1',
    collection: 'avatar',
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

function database(connection: string): Database {
  const app = new AppFactory().create(new URL('./', import.meta.url), () => {}) as never;
  return new Database(
    { connection: 'main', connections: { main: { client: 'pg', connection } as never } },
    new LoggerFactory().create(),
    new Emitter(app),
  );
}

describe.skipIf(!url)('federated media console on Postgres (two schemas, read-only role)', () => {
  const suffix = randomBytes(4).toString('hex');
  const owning = `et_${suffix}`;
  const local = `hub_${suffix}`;
  const role = `media_ro_${suffix}`;
  let admin: Database;
  let readOnly: Database;
  const statements: string[] = [];

  const raw = async (sql: string, bindings: unknown[] = []) =>
    rowsOf(await admin.connection().rawQuery(sql, bindings as never));

  beforeAll(async () => {
    admin = database(url as string);
    for (const schema of [owning, local]) {
      await createMediaTables(admin.connection(), { schema });
      await runMigrationStub(admin, 'create_media_upload_sessions_table.stub', { schema });
    }
    await raw(`CREATE ROLE ${role} LOGIN PASSWORD 'pw'`);
    await raw(`GRANT USAGE ON SCHEMA "${owning}" TO ${role}`);
    await raw(
      `GRANT SELECT ON "${owning}"."media", "${owning}"."media_upload_sessions", "${owning}"."media_upload_parts" TO ${role}`,
    );
    const limited = new URL(url as string);
    limited.username = role;
    limited.password = 'pw';
    readOnly = database(limited.href);
    const knex = readOnly.connection().getWriteClient() as unknown as {
      on(event: 'query', listener: (query: { sql: string }) => void): void;
    };
    knex.on('query', (query) => statements.push(query.sql));
  });

  afterAll(async () => {
    await readOnly?.manager.closeAll();
    if (admin) {
      await raw(`DROP SCHEMA IF EXISTS "${owning}" CASCADE`);
      await raw(`DROP SCHEMA IF EXISTS "${local}" CASCADE`);
      await raw(`DROP OWNED BY ${role}`).catch(() => undefined);
      await raw(`DROP ROLE IF EXISTS ${role}`);
      await admin.manager.closeAll();
    }
  });

  it('lists the other app records and uploads through SELECT only, and acts through the app', async () => {
    // The owning app writes its own tables, with its own (full) connection.
    const ownStore = new LucidMediaStore(admin, { schema: owning, autoCreateSchema: false });
    await ownStore.save(record({ id: 'et-1', collection: 'documents', size: 5 }));
    await ownStore.save(record({ id: 'et-2', collection: 'avatar', size: 7 }));
    const ownSessions = new LucidUploadSessionStore(admin, { schema: owning });
    await ownSessions.create({
      id: 'up-1',
      disk: 'fs',
      key: 'docs/big.pdf',
      offset: 10,
      size: 100,
      parts: 1,
      metadata: {},
      createdAt: new Date(2_000),
    } as never);
    // The console's app has media of its own, in its own schema: never mixed in.
    await new LucidMediaStore(admin, { schema: local, autoCreateSchema: false }).save(
      record({ id: 'hub-1' }),
    );

    const bus = new RedisBus();
    const handler = mediaConsoleCommandHandler({
      actions: true,
      service: async () =>
        new DashboardService(
          {
            storage: { defaultDisk: 'fs', disk: () => ({}) as never },
            hasResumable: false,
            resumable: { list: async () => [], abort: async () => {}, listParts: async () => [] },
            store: ownStore,
          },
          { diskNames: ['fs'], actions: true },
        ),
    });
    await new RedisConsoleChannel({ client: bus.connection(), prefix: 'et' }).answer(handler);

    // The console builds the app from its config, as `apps` in config/media_dashboard.ts does.
    const container = {
      make: async (binding: string) => (binding === 'lucid.db' ? readOnly : null),
    };
    const app = await buildFederatedMediaApp(
      'entre-textos',
      {
        label: 'Entre Textos',
        // No `autoCreateSchema: false` here: a federated store never creates anything anyway.
        store: stores.lucid({ schema: owning }),
        uploadSessions: uploadSessions.lucid({ schema: owning }),
        controlPlane: new RedisConsoleChannel({ client: bus.connection(), prefix: 'et' }),
      },
      { container },
    );
    const console = new FederatedConsoleService(app, { actions: true, actor: 'ana@hub' });

    expect((await console.collections()).data.map((e) => e.id).sort()).toEqual(['et-1', 'et-2']);
    expect((await console.collections({ collection: 'documents' })).data.map((e) => e.id)).toEqual([
      'et-1',
    ]);
    expect((await console.collectionsSummary()).data).toEqual(
      expect.arrayContaining([
        { key: 'documents', count: 1, sumSize: 5 },
        { key: 'avatar', count: 1, sumSize: 7 },
      ]),
    );
    expect((await console.uploads()).data).toMatchObject([
      { id: 'up-1', key: 'docs/big.pdf', percent: 10 },
    ]);
    expect((await console.uploadDetail('up-1')).upload.id).toBe('up-1');

    // The role cannot write there, and the console never tried any DDL.
    await expect(
      readOnly.connection().from(`${owning}.media`).where('id', 'et-1').delete(),
    ).rejects.toThrow(/permission denied/);
    expect(statements.filter((sql) => /^\s*(create|alter|drop)\b/i.test(sql))).toEqual([]);

    // The delete runs in the owning app, which still owns its tables.
    await console.deleteMediaRecord('et-1');
    expect(await ownStore.find('et-1')).toBeNull();
    expect((await console.collections()).data.map((e) => e.id)).toEqual(['et-2']);
  });
});
