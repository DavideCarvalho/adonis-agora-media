import { MediaConsoleCommand } from '../src/commands/console_command.js';
import type { DashboardService } from '../src/dashboard/service.js';

/** `node ace media:disks:list` — the disks the media console browses, and what each supports. */
export class MediaDisksList extends MediaConsoleCommand {
  static override commandName = 'media:disks:list';
  static override description = 'List the disks the media console browses';

  protected override async handle(service: DashboardService): Promise<void> {
    const disks = service.disks();
    if (this.json) return this.printJson(disks);
    this.printTable(
      ['Disk', 'Default', 'List', 'Presign', 'Multipart', 'Public URLs'],
      disks.data.map((disk) => [
        disk.name,
        disk.default ? 'yes' : '',
        yesNo(disk.capabilities.list),
        yesNo(disk.capabilities.presign),
        yesNo(disk.capabilities.multipart),
        yesNo(disk.capabilities.publicUrls),
      ]),
      'No disks.',
    );
  }
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}
