import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasConfiguredSchema } from '../src/doctor/checks.js';
import { stores } from '../src/stores/factory.js';
import { LucidMediaStore } from '../src/stores/lucid.js';
import { createMediaTables } from '../src/stores/lucid-schema.js';
import { uploadSessions } from '../src/upload_sessions/factory.js';
import { LucidUploadSessionStore } from '../src/upload_sessions/lucid.js';
import { makeMemoryDatabase } from './lucid_helpers.js';

/** A Lucid-shaped `Database` whose connections report `dialect` and never run a query. */
function fakeDatabase(dialect: string): Database {
  const client = { dialect: { name: dialect }, rawQuery: async () => [] };
  return { connection: () => client } as unknown as Database;
}

describe('the media lucid `schema` option', () => {
  let db: Database;

  beforeEach(() => {
    db = makeMemoryDatabase();
  });

  afterEach(async () => {
    await db.manager.closeAll();
  });

  it('fails at construction on SQLite, naming the schema', () => {
    expect(() => new LucidMediaStore(db, { schema: 'media' })).toThrow(
      /stores\.lucid\(\) sets `schema: "media"`, but the connection is better-sqlite3, which has no schemas/,
    );
    expect(() => new LucidUploadSessionStore(db, { schema: 'media' })).toThrow(/has no schemas/);
  });

  it('fails in the schema helpers on SQLite', async () => {
    await expect(createMediaTables(db, { schema: 'media' })).rejects.toThrow(/has no schemas/);
  });

  it.each(['', '1abc', 'a.b', 'a-b', 'a"b', 'x'.repeat(64)])(
    'rejects the schema name %j',
    (name) => {
      expect(() => new LucidMediaStore(fakeDatabase('postgres'), { schema: name })).toThrow(
        /must be a plain identifier/,
      );
    },
  );

  it('accepts a 63-character name with digits, _ and $', () => {
    const name = `a_1$${'x'.repeat(59)}`;
    expect(new LucidMediaStore(fakeDatabase('postgres'), { schema: name }).schema).toBe(name);
    expect(new LucidUploadSessionStore(fakeDatabase('mysql'), { schema: name }).schema).toBe(name);
  });

  it('changes nothing without a schema', async () => {
    const store = new LucidMediaStore(db);
    expect(store.schema).toBeUndefined();
    expect(await store.inspectSchema()).toBeNull();
  });

  it('tells agora:doctor which stores set a schema', () => {
    expect(hasConfiguredSchema(undefined)).toBe(false);
    expect(hasConfiguredSchema({ store: 'lucid', stores: { lucid: stores.lucid() } })).toBe(false);
    expect(
      hasConfiguredSchema({ store: 'lucid', stores: { lucid: stores.lucid({ schema: 'media' }) } }),
    ).toBe(true);
    expect(
      hasConfiguredSchema({
        uploads: {
          resumable: {
            store: 'lucid',
            stores: { lucid: uploadSessions.lucid({ schema: 'media' }) },
          },
        },
      } as never),
    ).toBe(true);
  });
});
