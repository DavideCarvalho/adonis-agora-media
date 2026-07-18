import type Configure from '@adonisjs/core/commands/configure';
import { stubsRoot } from './stubs/main.js';

/**
 * `node ace configure @adonis-agora/media` — auto-wires the package:
 *
 * 1. registers the media service provider in `adonisrc.ts`;
 * 2. publishes `config/media.ts`;
 * 3. publishes the Lucid migrations for the optional `lucid` store and the resumable (TUS) session
 *    store (run `node ace migration:run`; delete either if you only use the in-memory equivalents).
 *
 * Requires `@adonisjs/drive` to be installed and configured first (`node ace add @adonisjs/drive`).
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods();

  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider('@adonis-agora/media/media_provider');
  });

  const stubs = stubsRoot();
  await codemods.makeUsingStub(stubs, 'config/media.stub', {});
  await codemods.makeUsingStub(stubs, 'database/migrations/create_media_table.stub', {});
  await codemods.makeUsingStub(
    stubs,
    'database/migrations/create_media_upload_sessions_table.stub',
    {},
  );
}
