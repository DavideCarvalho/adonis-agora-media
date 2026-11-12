import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MediaRecord } from '../src/media_record.js';
import { LucidMediaStore } from '../src/stores/lucid.js';

/** Two sqlite files behind two connections: `primary` (the default) and `media`. */
function makeTwoConnectionDatabase(dir: string): Database {
  const app = new AppFactory().create(new URL('./', import.meta.url), () => {}) as any;
  const sqlite = (file: string) => ({
    client: 'better-sqlite3' as const,
    connection: { filename: join(dir, file) },
    useNullAsDefault: true,
  });
  return new Database(
    {
      connection: 'primary',
      connections: { primary: sqlite('primary.sqlite'), media: sqlite('media.sqlite') },
    },
    new LoggerFactory().create(),
    new Emitter(app),
  );
}

async function tables(db: Database, connection: string): Promise<string[]> {
  const rows = (await db
    .connection(connection)
    .rawQuery(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)) as Array<{
    name: string;
  }>;
  return rows.map((row) => row.name);
}

const record: MediaRecord = {
  id: 'a',
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
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

describe('LucidMediaStore on a named connection', () => {
  let dir: string;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'media-connection-'));
    db = makeTwoConnectionDatabase(dir);
  });

  afterEach(async () => {
    await db.manager.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });

  it('auto-creates the table on that connection, not the default one', async () => {
    const store = new LucidMediaStore(db, { connectionName: 'media' });
    await store.save(record);

    expect(await store.find('a')).not.toBeNull();
    expect(await tables(db, 'media')).toContain('media');
    expect(await tables(db, 'primary')).not.toContain('media');
  });

  it('adds the tenant column on that connection too', async () => {
    const store = new LucidMediaStore(db, { connectionName: 'media', tenantColumn: true });
    await store.save({ ...record, tenantId: 't1' });

    expect((await store.find('a'))?.tenantId).toBe('t1');
    expect(await store.hasTenantColumn()).toBe(true);
    expect(await tables(db, 'primary')).not.toContain('media');
  });
});
