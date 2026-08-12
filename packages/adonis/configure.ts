import type Configure from '@adonisjs/core/commands/configure';
import { stubsRoot } from './stubs/main.js';

/**
 * `node ace configure @adonis-agora/media` — auto-wires the package:
 *
 * 1. registers the media service provider in `adonisrc.ts`;
 * 2. registers the dashboard provider — the management console SPA ships embedded in this package
 *    (its built assets are copied in at `pnpm build` time), so this alone is enough to get it; no
 *    separate `@adonis-agora/media-dashboard` install is required (though that package still exists,
 *    standalone, for hosts that prefer registering it directly);
 * 3. publishes `config/media.ts` and `config/media_dashboard.ts`;
 * 4. publishes the Lucid migrations for the optional `lucid` store and the resumable (TUS) session
 *    store (run `node ace migration:run`; delete either if you only use the in-memory equivalents).
 *
 * Requires `@adonisjs/drive` to be installed and configured first (`node ace add @adonisjs/drive`).
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods();

  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider('@adonis-agora/media/media_provider');
    rcFile.addProvider('@adonis-agora/media/dashboard_provider');
  });

  const stubs = stubsRoot();
  await codemods.makeUsingStub(stubs, 'config/media.stub', {});
  await codemods.makeUsingStub(stubs, 'config/media_dashboard.stub', {});
  await codemods.makeUsingStub(stubs, 'database/migrations/create_media_table.stub', {});
  await codemods.makeUsingStub(
    stubs,
    'database/migrations/create_media_upload_sessions_table.stub',
    {},
  );
}
