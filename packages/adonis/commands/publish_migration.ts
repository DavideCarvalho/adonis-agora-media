import { args, BaseCommand } from '@adonisjs/core/ace';
import { stubsRoot } from '../stubs/main.js';

/** The migrations this package can publish, by name. */
export const MEDIA_MIGRATIONS: Record<string, string> = {
  media: 'database/migrations/create_media_table.stub',
  'upload-sessions': 'database/migrations/create_media_upload_sessions_table.stub',
  tenancy: 'database/migrations/add_media_tenant_id.stub',
  timestamps: 'database/migrations/add_media_upload_sessions_updated_at.stub',
};

/**
 * `node ace media:publish-migration <name>` — publish one of the package's migrations into the
 * app's `database/migrations`: `media` (the `lucid` store's table), `upload-sessions` (the resumable
 * session store's tables), `tenancy` (the `tenant_id` column organizations-as-tenants needs) or
 * `timestamps` (the `updated_at` column of upload sessions tables created before it existed).
 */
export default class MediaPublishMigration extends BaseCommand {
  static override commandName = 'media:publish-migration';
  static override description =
    'Publish an @adonis-agora/media migration (media, upload-sessions, tenancy, timestamps)';

  @args.string({ description: 'Which migration: media, upload-sessions, tenancy or timestamps' })
  declare name: string;

  override async run(): Promise<void> {
    const stub = MEDIA_MIGRATIONS[this.name];
    if (!stub) {
      this.logger.error(
        `Unknown migration "${this.name}". Use one of: ${Object.keys(MEDIA_MIGRATIONS).join(', ')}.`,
      );
      this.exitCode = 1;
      return;
    }
    const codemods = await this.createCodemods();
    await codemods.makeUsingStub(stubsRoot(), stub, {});
  }
}
