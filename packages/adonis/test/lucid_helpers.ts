import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';

/** A fresh standalone Lucid `Database` over an isolated `:memory:` sqlite db. */
export function makeMemoryDatabase(): Database {
  // app/emitter generics are app-specific; tests don't need them.
  const app = new AppFactory().create(new URL('./', import.meta.url), () => {}) as any;
  const logger = new LoggerFactory().create();
  const emitter = new Emitter(app);

  return new Database(
    {
      connection: 'primary',
      connections: {
        primary: {
          client: 'better-sqlite3',
          connection: { filename: ':memory:' },
          useNullAsDefault: true,
        },
      },
    },
    logger,
    emitter,
  );
}

/**
 * Run the package's *actual* `create_media_table` migration against `db`. The migration ships as a
 * Tempura stub (handlebars header that picks the output path), so we read the stub, strip that header
 * and load the remaining — a stock `BaseSchema` class — to drive its `up()` through Lucid's schema
 * runner on the real sqlite connection. This is what exercises the `order` reserved-word column
 * end-to-end (knex must quote it in the `CREATE TABLE` DDL, or sqlite would reject the migration).
 */
export async function runMediaMigration(db: Database): Promise<void> {
  return runMigrationStub(db, 'create_media_table.stub');
}

/** Run the resumable (TUS) `media_upload_sessions` + `media_upload_parts` migration against `db`. */
export async function runUploadSessionsMigration(db: Database): Promise<void> {
  return runMigrationStub(db, 'create_media_upload_sessions_table.stub');
}

/** Load a package migration stub (stripping its Tempura header) and drive its `up()` on `db`. */
async function runMigrationStub(db: Database, stubName: string): Promise<void> {
  const stubPath = fileURLToPath(
    new URL(`../stubs/database/migrations/${stubName}`, import.meta.url),
  );
  const raw = readFileSync(stubPath, 'utf8');
  // Drop the leading `{{{ ... }}}` Tempura header; the rest is a valid ESM migration module.
  const source = raw.slice(raw.indexOf('}}}') + 3).trimStart();

  // Keep the temp module inside the project tree so its `@adonisjs/lucid` import resolves against the
  // package's node_modules and Vitest's transform pipeline (swc) picks it up.
  const baseDir = fileURLToPath(new URL('./.migrations-tmp/', import.meta.url));
  mkdirSync(baseDir, { recursive: true });
  const dir = mkdtempSync(join(baseDir, 'run-'));
  const file = join(dir, 'create_media_table.ts');
  writeFileSync(file, source);
  try {
    const mod = await import(/* @vite-ignore */ pathToFileURL(file).href);
    const Migration = mod.default as new (
      client: unknown,
      file: string,
      dryRun?: boolean,
    ) => { execUp(): Promise<unknown> };
    const migration = new Migration(db.connection(), file, false);
    await migration.execUp();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
