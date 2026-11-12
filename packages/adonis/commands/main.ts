import { ListLoader } from '@adonisjs/core/ace';
import MediaPublishMigration from './publish_migration.js';
import MediaTenancyBackfill from './tenancy_backfill.js';

/**
 * The commands barrel for `@adonis-agora/media` (`media:publish-migration`,
 * `media:tenancy:backfill`). Registered in an app's `adonisrc` via
 * `rcFile.addCommand('@adonis-agora/media/commands')`, which this package's `configure` does.
 */
const loader = new ListLoader([MediaPublishMigration, MediaTenancyBackfill]);

export const getMetaData = loader.getMetaData.bind(loader);
export const getCommand = loader.getCommand.bind(loader);
