import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { args, flags } from '@adonisjs/core/ace';
import {
  CommandRefusal,
  formatBytes,
  listRequest,
  MediaConsoleCommand,
} from '../src/commands/console_command.js';
import { readObjectsQuery } from '../src/dashboard/list_api.js';
import type { DashboardService } from '../src/dashboard/service.js';
import { mimeTypeFromName } from '../src/mime_type.js';

/** Strip leading and trailing slashes: a folder prefix as a bare path. */
function bareFolder(prefix: string): string {
  return prefix.replace(/^\/+/, '').replace(/\/+$/, '');
}

/** `node ace media:objects:list` — one page of a disk under a prefix, folders first. */
export class MediaObjectsList extends MediaConsoleCommand {
  static override commandName = 'media:objects:list';
  static override description = 'Browse a disk: folders and files under a prefix (one page)';

  @flags.string({ description: 'Disk to browse (default: the console default disk)' })
  declare disk?: string;

  @flags.string({ description: 'Key prefix, e.g. "User/42/" (default: the root)' })
  declare prefix?: string;

  @flags.string({ description: "Cursor of the next page (the previous page's nextCursor)" })
  declare after?: string;

  @flags.number({ description: 'Page size (default and max 1000)' })
  declare first?: number;

  @flags.string({ description: 'Sort: "key" (the only order a disk lists in)' })
  declare sort?: string;

  protected override async handle(service: DashboardService): Promise<void> {
    const { disk, params } = await readObjectsQuery(
      listRequest({
        filter: { disk: this.disk ?? this.defaultDisk(service), prefix: this.prefix },
        sort: this.sort,
        after: this.after,
        first: this.first,
      }),
    );
    const page = await service.objects(disk, params);
    if (this.json) return this.printJson(page);
    this.printTable(
      ['Type', 'Key', 'Size', 'Last modified'],
      page.data.map((item) =>
        item.type === 'folder'
          ? ['folder', item.prefix, '', '']
          : ['file', item.key, formatBytes(item.sizeBytes), item.lastModified ?? '-'],
      ),
      'Nothing under this prefix.',
    );
    if (page.meta.nextCursor !== null) {
      this.logger.info(`More: --after ${JSON.stringify(page.meta.nextCursor)}`);
    }
  }
}

/** `node ace media:objects:show <key>` — one object's metadata and what the app knows about it. */
export class MediaObjectsShow extends MediaConsoleCommand {
  static override commandName = 'media:objects:show';
  static override description = "Show one object's size, content type and insights";

  @args.string({ description: 'Full object key' })
  declare key: string;

  @flags.string({ description: 'Disk (default: the console default disk)' })
  declare disk?: string;

  @flags.boolean({ description: 'Also print a URL to the bytes (signed, or the console proxy)' })
  declare url: boolean;

  protected override async handle(service: DashboardService): Promise<void> {
    const disk = this.disk ?? this.defaultDisk(service);
    const object = this.url
      ? await service.object(disk, this.key)
      : await service.objectMeta(disk, this.key);
    const { insights } = await service.objectInsights(disk, this.key);
    if (this.json) return this.printJson({ object, insights });
    this.printFields([
      ['Disk', disk],
      ['Key', object.key],
      ['Size', formatBytes(object.size)],
      ['Content type', object.contentType ?? '-'],
      ['Last modified', object.lastModified ?? '-'],
      ['URL', 'url' in object ? object.url : undefined],
    ]);
    for (const insight of insights) {
      this.logger.log(`\n${insight.title}`);
      this.printFields([
        ...(insight.facts ?? []).map((fact): [string, unknown] => [`  ${fact.label}`, fact.value]),
        ...(insight.links ?? []).map((link): [string, unknown] => [`  ${link.label}`, link.href]),
        ['  Note', insight.note],
      ]);
    }
  }
}

/** `node ace media:objects:upload <file>` — the console's upload: one file onto a disk. */
export class MediaObjectsUpload extends MediaConsoleCommand {
  static override commandName = 'media:objects:upload';
  static override description = 'Upload a local file onto a disk (the console upload, 100 MB max)';

  @args.string({ description: 'Local file to upload' })
  declare file: string;

  @flags.string({ description: 'Disk (default: the console default disk)' })
  declare disk?: string;

  @flags.string({ description: 'Full destination key (default: <prefix><file name>)' })
  declare key?: string;

  @flags.string({ description: 'Folder to upload into when --key is not given (default: root)' })
  declare prefix?: string;

  @flags.string({ description: 'Content type to store (default: from the file extension)' })
  declare type?: string;

  protected override async handle(service: DashboardService): Promise<void> {
    this.assertActions(service);
    const info = await stat(this.file).catch(() => null);
    if (!info?.isFile()) throw new CommandRefusal(`not a file: ${this.file}`);
    const disk = this.disk ?? this.defaultDisk(service);
    const folder = this.prefix !== undefined ? bareFolder(this.prefix) : '';
    const key = this.key ?? `${folder === '' ? '' : `${folder}/`}${basename(this.file)}`;
    const type = this.type ?? mimeTypeFromName(this.file);
    await service.putObject(disk, key, createReadStream(this.file), type);
    await this.audit(`uploaded ${disk}:${key} (${info.size} bytes)`);
    if (this.json) return this.printJson({ disk, key, size: info.size });
    this.logger.success(`Uploaded ${disk}:${key} (${formatBytes(info.size)})`);
  }
}

/** Shared flags and body of copy / move. */
abstract class TransferCommand extends MediaConsoleCommand {
  protected abstract readonly op: 'copy' | 'move';

  @args.string({ description: 'Source key (a folder prefix with --folder)' })
  declare from: string;

  @args.string({ description: 'Destination key (a folder prefix with --folder)' })
  declare to: string;

  @flags.string({ description: 'Source disk (default: the console default disk)' })
  declare disk?: string;

  @flags.string({ description: 'Destination disk (default: the source disk)' })
  declare toDisk?: string;

  @flags.boolean({ description: 'Copy/move a whole folder (every object under it)' })
  declare folder: boolean;

  protected override async handle(service: DashboardService): Promise<void> {
    this.assertActions(service);
    const disk = this.disk ?? this.defaultDisk(service);
    const body = {
      disk,
      from: this.from,
      to: this.to,
      ...(this.toDisk !== undefined ? { toDisk: this.toDisk } : {}),
    };
    if (this.folder) {
      await (this.op === 'copy' ? service.copyFolder(body) : service.moveFolder(body));
    } else {
      await (this.op === 'copy' ? service.copy(body) : service.move(body));
    }
    const target = `${this.toDisk ?? disk}:${this.to}`;
    const what = `${this.folder ? 'folder ' : ''}${disk}:${this.from} → ${target}`;
    await this.audit(`${this.op === 'copy' ? 'copied' : 'moved'} ${what}`);
    if (this.json) return this.printJson({ ok: true, ...body, folder: this.folder === true });
    this.logger.success(`${this.op === 'copy' ? 'Copied' : 'Moved'} ${what}`);
  }
}

/** `node ace media:objects:copy <from> <to>` — copy an object (or a folder), same or cross disk. */
export class MediaObjectsCopy extends TransferCommand {
  static override commandName = 'media:objects:copy';
  static override description = 'Copy an object (or --folder) to another key or disk';
  protected readonly op = 'copy' as const;
}

/** `node ace media:objects:move <from> <to>` — move an object (or a folder), same or cross disk. */
export class MediaObjectsMove extends TransferCommand {
  static override commandName = 'media:objects:move';
  static override description = 'Move an object (or --folder) to another key or disk';
  protected readonly op = 'move' as const;
}

/** `node ace media:objects:rename <key> <name>` — rename in place (a same-disk move). */
export class MediaObjectsRename extends MediaConsoleCommand {
  static override commandName = 'media:objects:rename';
  static override description = 'Rename an object (or --folder) in place';

  @args.string({ description: 'Full key of the object (the folder prefix with --folder)' })
  declare key: string;

  @args.string({ description: 'The new name (last path segment only)' })
  declare name: string;

  @flags.string({ description: 'Disk (default: the console default disk)' })
  declare disk?: string;

  @flags.boolean({ description: 'Rename a folder (moves every object under it)' })
  declare folder: boolean;

  protected override async handle(service: DashboardService): Promise<void> {
    this.assertActions(service);
    const name = this.name.trim();
    if (name === '' || name.includes('/')) {
      throw new CommandRefusal('the new name must be one path segment (no "/")');
    }
    const disk = this.disk ?? this.defaultDisk(service);
    const from = this.folder ? bareFolder(this.key) : this.key;
    const slash = from.lastIndexOf('/');
    const to = `${slash === -1 ? '' : from.slice(0, slash + 1)}${name}`;
    if (this.folder) await service.moveFolder({ disk, from, to });
    else await service.move({ disk, from, to });
    await this.audit(`renamed ${this.folder ? 'folder ' : ''}${disk}:${from} → ${to}`);
    if (this.json)
      return this.printJson({ ok: true, disk, from, to, folder: this.folder === true });
    this.logger.success(`Renamed ${disk}:${from} → ${to}`);
  }
}

/** `node ace media:objects:delete <keys...>` — delete objects (or a folder) from a disk. */
export class MediaObjectsDelete extends MediaConsoleCommand {
  static override commandName = 'media:objects:delete';
  static override description = 'Delete objects (or --folder, recursively) from a disk';

  @args.spread({ description: 'Full keys (one folder prefix with --folder)' })
  declare keys: string[];

  @flags.string({ description: 'Disk (default: the console default disk)' })
  declare disk?: string;

  @flags.boolean({ description: 'Delete a folder and every object under it' })
  declare folder: boolean;

  @flags.boolean({ description: 'Do not ask for confirmation' })
  declare force: boolean;

  @flags.boolean({ description: 'Show what would be deleted, delete nothing' })
  declare dryRun: boolean;

  protected override async handle(service: DashboardService): Promise<void> {
    const keys = (this.keys ?? []).filter((key) => key !== '');
    if (keys.length === 0) throw new CommandRefusal('pass at least one key');
    if (this.folder && keys.length !== 1) throw new CommandRefusal('--folder takes one prefix');
    const disk = this.disk ?? this.defaultDisk(service);

    if (this.dryRun) {
      if (this.folder) {
        const prefix = `${bareFolder(keys[0] as string)}/`;
        const page = await service.objects(disk, { prefix, first: 1 });
        const result = { dryRun: true, disk, folder: prefix, empty: page.data.length === 0 };
        if (this.json) return this.printJson(result);
        this.logger.info(
          `Would delete folder ${disk}:${prefix} and every object under it${result.empty ? ' (it is empty)' : ''}.`,
        );
        return;
      }
      // Every key is read first: a missing (or out-of-scope) key fails the dry run like the delete.
      const objects = await Promise.all(keys.map((key) => service.objectMeta(disk, key)));
      if (this.json) return this.printJson({ dryRun: true, disk, objects });
      this.printTable(
        ['Key', 'Size'],
        objects.map((object) => [object.key, formatBytes(object.size)]),
      );
      this.logger.info(`Would delete ${objects.length} object(s) from ${disk}.`);
      return;
    }

    this.assertActions(service);
    const what = this.folder
      ? `folder ${disk}:${bareFolder(keys[0] as string)}/ and everything under it`
      : `${keys.length} object(s) from ${disk}`;
    if (!(await this.confirmed(this.force, `Delete ${what}?`))) return;
    if (this.folder) await service.deleteFolder({ disk, prefix: keys[0] as string });
    else await service.remove({ disk, keys });
    await this.audit(`deleted ${what}${this.folder ? '' : `: ${keys.join(', ')}`}`);
    if (this.json) {
      return this.printJson(
        this.folder
          ? { ok: true, disk, folder: keys[0] }
          : { ok: true, disk, deleted: keys.length },
      );
    }
    this.logger.success(`Deleted ${what}`);
  }
}

/** `node ace media:folders:create <prefix>` — create a folder (a zero-byte marker object). */
export class MediaFoldersCreate extends MediaConsoleCommand {
  static override commandName = 'media:folders:create';
  static override description = 'Create a folder on a disk';

  @args.string({ description: 'Folder path, e.g. "uploads/2026"' })
  declare prefix: string;

  @flags.string({ description: 'Disk (default: the console default disk)' })
  declare disk?: string;

  protected override async handle(service: DashboardService): Promise<void> {
    this.assertActions(service);
    const disk = this.disk ?? this.defaultDisk(service);
    await service.createFolder({ disk, prefix: this.prefix });
    const folder = `${bareFolder(this.prefix)}/`;
    await this.audit(`created folder ${disk}:${folder}`);
    if (this.json) return this.printJson({ ok: true, disk, folder });
    this.logger.success(`Created folder ${disk}:${folder}`);
  }
}
