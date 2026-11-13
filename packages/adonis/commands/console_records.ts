import { args, flags } from '@adonisjs/core/ace';
import { formatBytes, listRequest, MediaConsoleCommand } from '../src/commands/console_command.js';
import { readCollectionsQuery } from '../src/dashboard/list_api.js';
import type { DashboardService } from '../src/dashboard/service.js';

/** `node ace media:collections:list` — record count and total size per collection. */
export class MediaCollectionsList extends MediaConsoleCommand {
  static override commandName = 'media:collections:list';
  static override description = 'List collections with their record count and total size';

  protected override async handle(service: DashboardService): Promise<void> {
    const summary = await service.collectionsSummary();
    if (this.json) return this.printJson(summary);
    this.printTable(
      ['Collection', 'Records', 'Size'],
      summary.data.map((row) => [row.key, String(row.count), formatBytes(row.sumSize)]),
      'No media records.',
    );
  }
}

/** `node ace media:records:list` — stored media records, newest first (one page). */
export class MediaRecordsList extends MediaConsoleCommand {
  static override commandName = 'media:records:list';
  static override description = 'List stored media records, newest first (one page)';

  @flags.string({ description: 'Only this collection' })
  declare collection?: string;

  @flags.string({ description: 'Only this owner type, e.g. User' })
  declare ownerType?: string;

  @flags.string({ description: 'Only this owner id (usually with --owner-type)' })
  declare ownerId?: string;

  @flags.string({ description: 'Only records whose stored path starts with this' })
  declare prefix?: string;

  @flags.string({ description: "Cursor of the next page (the previous page's nextCursor)" })
  declare after?: string;

  @flags.number({ description: 'Page size (default 50)' })
  declare first?: number;

  @flags.string({ description: 'Sort: "-createdAt" (the only order records list in)' })
  declare sort?: string;

  protected override async handle(service: DashboardService): Promise<void> {
    const params = await readCollectionsQuery(
      listRequest({
        filter: {
          collection: this.collection,
          ownerType: this.ownerType,
          ownerId: this.ownerId,
          prefix: this.prefix,
        },
        sort: this.sort,
        after: this.after,
        first: this.first,
      }),
    );
    const page = await service.collections(params);
    if (this.json) return this.printJson(page);
    this.printTable(
      ['Id', 'Collection', 'Owner', 'File', 'Type', 'Size', 'Created'],
      page.data.map((record) => [
        record.id,
        record.collection,
        `${record.ownerType}#${record.ownerId}`,
        record.fileName,
        record.mimeType,
        formatBytes(record.sizeBytes),
        record.createdAt,
      ]),
      'No media records.',
    );
    if (page.meta.nextCursor !== null) {
      this.logger.info(`More: --after ${JSON.stringify(page.meta.nextCursor)}`);
    }
  }
}

/** `node ace media:records:show <id>` — one media record, with a URL per generated conversion. */
export class MediaRecordsShow extends MediaConsoleCommand {
  static override commandName = 'media:records:show';
  static override description = 'Show one media record and its conversions';

  @args.string({ description: 'Media record id' })
  declare id: string;

  protected override async handle(service: DashboardService): Promise<void> {
    const detail = await service.mediaRecord(this.id);
    if (this.json) return this.printJson(detail);
    const { record } = detail;
    this.printFields([
      ['Id', record.id],
      ['Collection', record.collection],
      ['Owner', `${record.ownerType}#${record.ownerId}`],
      ['Name', record.name],
      ['File name', record.fileName],
      ['Type', record.mimeType],
      ['Size', formatBytes(record.sizeBytes)],
      ['Disk', record.disk],
      ['Path', record.path],
      ['Organization', record.tenantId],
      ['Created', record.createdAt],
      ['Updated', record.updatedAt],
      ['Conversions', record.conversions.length > 0 ? record.conversions.join(', ') : '-'],
    ]);
    for (const variant of detail.variants) this.logger.log(`  ${variant.name}: ${variant.url}`);
  }
}

/** `node ace media:records:delete <id>` — delete a media record (its files are left on the disk). */
export class MediaRecordsDelete extends MediaConsoleCommand {
  static override commandName = 'media:records:delete';
  static override description = 'Delete a media record (the stored files stay on the disk)';

  @args.string({ description: 'Media record id' })
  declare id: string;

  @flags.boolean({ description: 'Do not ask for confirmation' })
  declare force: boolean;

  protected override async handle(service: DashboardService): Promise<void> {
    this.assertActions(service);
    // Read first: an unknown (or out-of-scope) id fails before the question is asked.
    const record = await service.mediaEntry(this.id);
    const what = `media record ${record.id} (${record.collection}, ${record.fileName})`;
    if (!(await this.confirmed(this.force, `Delete ${what}?`))) return;
    await service.deleteMediaRecord(this.id);
    await this.audit(`deleted ${what}`);
    if (this.json) return this.printJson({ ok: true, id: record.id });
    this.logger.success(`Deleted ${what}`);
  }
}
