import { ListLoader } from '@adonisjs/core/ace';
import AgoraDoctor from './agora_doctor.js';
import MediaDoctor from './media_doctor.js';
import MediaPublishMigration from './publish_migration.js';
import MediaTenancyBackfill from './tenancy_backfill.js';

/**
 * The commands barrel for `@adonis-agora/media` (`agora:doctor`, `media:doctor`,
 * `media:publish-migration`, `media:tenancy:backfill`). Registered in an app's `adonisrc` via
 * `rcFile.addCommand('@adonis-agora/media/commands')`, which this package's `configure` does.
 */
const loader = new ListLoader([
  AgoraDoctor,
  MediaDoctor,
  MediaPublishMigration,
  MediaTenancyBackfill,
]);

export const getMetaData = loader.getMetaData.bind(loader);
export const getCommand = loader.getCommand.bind(loader);
