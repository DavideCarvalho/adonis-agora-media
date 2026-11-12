import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { backfillMediaTenants } from '../src/commands/tenancy_backfill.js';

/**
 * `node ace media:tenancy:backfill --owner-type=Organization` — stamp `tenant_id` on stored files
 * that have none and whose owner is the tenant itself (`tenant_id = owner_id`). Lucid store only.
 */
export default class MediaTenancyBackfill extends BaseCommand {
  static override commandName = 'media:tenancy:backfill';
  static override description =
    'Stamp tenant_id on media whose owner is the tenant (e.g. --owner-type=Organization)';
  static override options: CommandOptions = { startApp: true };

  @flags.string({ description: 'Owner type that is the tenant itself (e.g. Organization)' })
  declare ownerType: string;

  @flags.string({ description: 'The media table (default: media)' })
  declare table: string;

  @flags.string({ description: 'The database schema of the table (default: the current one)' })
  declare schema: string;

  @flags.string({ description: 'The Lucid connection (default: the default connection)' })
  declare connection: string;

  @flags.boolean({ description: 'Only count the files that would be stamped' })
  declare dryRun: boolean;

  override async run(): Promise<void> {
    if (!this.ownerType) {
      this.logger.error(
        'Pass --owner-type, the owner type that is the tenant (e.g. Organization).',
      );
      this.exitCode = 1;
      return;
    }
    const db = (await this.app.container.make('lucid.db')) as {
      connection(name?: string): Parameters<typeof backfillMediaTenants>[0];
    };
    const count = await backfillMediaTenants(db.connection(this.connection), {
      ownerType: this.ownerType,
      ...(this.table !== undefined ? { table: this.table } : {}),
      ...(this.schema !== undefined ? { schema: this.schema } : {}),
      ...(this.dryRun ? { dryRun: true } : {}),
    });
    this.logger.success(
      this.dryRun
        ? `${count} file(s) owned by ${this.ownerType} have no tenant and would be stamped.`
        : `Stamped ${count} file(s) owned by ${this.ownerType} with their owner as tenant.`,
    );
  }
}
