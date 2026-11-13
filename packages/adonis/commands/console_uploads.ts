import { args, flags } from '@adonisjs/core/ace';
import { formatBytes, listRequest, MediaConsoleCommand } from '../src/commands/console_command.js';
import { readUploadsQuery } from '../src/dashboard/list_api.js';
import type { DashboardService } from '../src/dashboard/service.js';

/** `node ace media:uploads:list` — resumable uploads in progress. */
export class MediaUploadsList extends MediaConsoleCommand {
  static override commandName = 'media:uploads:list';
  static override description = 'List resumable uploads in progress';

  @flags.string({ description: 'Only uploads to this disk' })
  declare disk?: string;

  @flags.string({ description: 'Only uploads whose key starts with this' })
  declare prefix?: string;

  @flags.string({ description: 'Sort: "-createdAt" (default, newest first) or "createdAt"' })
  declare sort?: string;

  protected override async handle(service: DashboardService): Promise<void> {
    const filter = await readUploadsQuery(
      listRequest({ filter: { disk: this.disk, prefix: this.prefix }, sort: this.sort }),
    );
    const uploads = await service.uploads(filter);
    if (this.json) return this.printJson(uploads);
    this.printTable(
      ['Id', 'Disk', 'Key', 'Received', 'Size', 'Progress', 'Started'],
      uploads.data.map((upload) => [
        upload.id,
        upload.disk,
        upload.key,
        formatBytes(upload.offset),
        formatBytes(upload.size),
        upload.percent === null ? '-' : `${upload.percent}%`,
        upload.createdAt ?? '-',
      ]),
      'No uploads in progress.',
    );
  }
}

/** `node ace media:uploads:show <id>` — one upload in progress, with its recorded parts. */
export class MediaUploadsShow extends MediaConsoleCommand {
  static override commandName = 'media:uploads:show';
  static override description = 'Show one upload in progress and its parts';

  @args.string({ description: 'Upload session id' })
  declare id: string;

  protected override async handle(service: DashboardService): Promise<void> {
    const detail = await service.uploadDetail(this.id);
    if (this.json) return this.printJson(detail);
    const { upload } = detail;
    this.printFields([
      ['Id', upload.id],
      ['Disk', upload.disk],
      ['Key', upload.key],
      ['Received', formatBytes(upload.offset)],
      ['Size', formatBytes(upload.size)],
      ['Progress', upload.percent === null ? '-' : `${upload.percent}%`],
      ['Multipart', upload.multipart ? 'yes' : 'no'],
      ['Organization', upload.tenantId],
      ['Started', upload.createdAt ?? '-'],
    ]);
    this.printTable(
      ['Part', 'ETag'],
      detail.parts.map((part) => [String(part.partNumber), part.etag]),
      'No parts recorded.',
    );
  }
}

/** `node ace media:uploads:abort <id>` — cancel an upload in progress. */
export class MediaUploadsAbort extends MediaConsoleCommand {
  static override commandName = 'media:uploads:abort';
  static override description = 'Cancel an upload in progress (its parts are discarded)';

  @args.string({ description: 'Upload session id' })
  declare id: string;

  @flags.boolean({ description: 'Do not ask for confirmation' })
  declare force: boolean;

  protected override async handle(service: DashboardService): Promise<void> {
    this.assertActions(service);
    const { upload } = await service.uploadDetail(this.id);
    const what = `upload ${upload.id} (${upload.disk}:${upload.key})`;
    if (!(await this.confirmed(this.force, `Abort ${what}?`))) return;
    await service.abortUpload(this.id);
    await this.audit(`aborted ${what}`);
    if (this.json) return this.printJson({ ok: true, id: upload.id });
    this.logger.success(`Aborted ${what}`);
  }
}
