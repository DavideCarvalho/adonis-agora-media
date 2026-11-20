import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { UploadSession } from '../src/resumable_upload.js';
import { LucidUploadSessionStore } from '../src/upload_sessions/lucid.js';
import { runUploadSessionsMigration } from './lucid_helpers.js';

/**
 * The `updated_at` probe runs inside whatever transaction the app is in (Lucid's global test
 * transaction, or a request wrapped in one). On Postgres a failing statement aborts the
 * transaction, so the probe must never fail: the next query would get 25P02.
 * Runs when `MEDIA_TEST_PG_URL` / `MEDIA_TEST_MYSQL_URL` are set (CI sets both).
 */
const TARGETS = [
  { name: 'postgres', client: 'pg', url: process.env.MEDIA_TEST_PG_URL },
  { name: 'mysql', client: 'mysql2', url: process.env.MEDIA_TEST_MYSQL_URL },
] as const;

function session(id: string): UploadSession {
  return {
    id,
    disk: 'fs',
    key: `${id}.bin`,
    contentType: undefined,
    size: undefined,
    offset: 0,
    parts: 0,
    createdAt: new Date('2026-11-20T00:00:00.000Z'),
  };
}

for (const target of TARGETS) {
  describe.skipIf(!target.url)(`upload-session probe inside a transaction (${target.name})`, () => {
    let db: Database;

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
      await db.connection().schema.dropTableIfExists('media_upload_parts');
      await db.connection().schema.dropTableIfExists('media_upload_sessions');
    });

    it('a table without updated_at: the probe leaves the transaction usable', async () => {
      await runUploadSessionsMigration(db);
      await db.connection().schema.alterTable('media_upload_sessions', (table) => {
        table.dropColumn('updated_at');
      });
      await db.beginGlobalTransaction();
      try {
        const store = new LucidUploadSessionStore(db);
        expect(await store.hasUpdatedAtColumn()).toBe(false);
        await store.create(session('in-trx'));
        expect((await store.get('in-trx'))?.id).toBe('in-trx');
      } finally {
        await db.rollbackGlobalTransaction();
      }
    });

    it('a table with updated_at is found from the catalog', async () => {
      await runUploadSessionsMigration(db);
      const store = new LucidUploadSessionStore(db);
      expect(await store.hasUpdatedAtColumn()).toBe(true);
    });
  });
}
