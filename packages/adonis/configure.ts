import type Configure from '@adonisjs/core/commands/configure';
import { stubsRoot } from './stubs/main.js';

/**
 * `node ace configure @adonis-agora/media` — auto-wires the package:
 *
 * 1. registers the media service provider in `adonisrc.ts`;
 * 2. publishes `config/media.ts`;
 * 3. publishes the Lucid migration for the optional `lucid` store (run
 *    `node ace migration:run`; delete it if you only use the in-memory store).
 *
 * Requires `@adonisjs/drive` to be installed and configured first (`node ace add @adonisjs/drive`).
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods();

  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider('@adonis-agora/media/media_provider');
  });

  await codemods.makeUsingStub(stubsRoot, 'config/media.stub', {});
  await codemods.makeUsingStub(stubsRoot, 'database/migrations/create_media_table.stub', {});
}
