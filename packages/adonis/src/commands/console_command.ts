import { userInfo } from 'node:os';
import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { allTenants } from '../agora/tenancy.js';
import { buildConsoleService, readConsoleServiceConfig } from '../dashboard/console_service.js';
import type { DashboardService } from '../dashboard/service.js';
import { resolveConsoleTenantScope } from '../dashboard/tenant_scope.js';
import { MediaManager } from '../media_manager.js';

/** Who the `media:*` commands act as, in log lines: `cli:<os user>`, or `cli`. */
export function cliActor(): string {
  try {
    const name = userInfo().username;
    return name ? `cli:${name}` : 'cli';
  } catch {
    return 'cli';
  }
}

/** A refusal the command reports as is (exit code 1), without a stack. */
export class CommandRefusal extends Error {}

/**
 * Base of the `media:*` console commands. Each one runs the SAME `DashboardService` the media
 * console's JSON API and its developer tools run (same disks, same `actions` switch, same tenant
 * confinement), built from `config/media_dashboard.ts`. Nothing about storage is reimplemented here.
 *
 * - `--json` prints one JSON document (the console API's response shape) instead of a table.
 * - `--tenant <id>` confines a command to one organization when tenancy is on; without it the
 *   command sees every organization (the operator running `node ace` is trusted like a console
 *   viewer granted `tenants: '*'`).
 * - A failure prints the reason and exits with code 1.
 */
export abstract class MediaConsoleCommand extends BaseCommand {
  static override options: CommandOptions = { startApp: true };

  @flags.boolean({ description: 'Print JSON instead of a table' })
  declare json: boolean;

  @flags.string({
    description: 'Organization (tenant) id to act on when tenancy is on (default: every one)',
  })
  declare tenant?: string;

  /** The command's work, given the console's service. */
  protected abstract handle(service: DashboardService): Promise<void>;

  override async run(): Promise<void> {
    try {
      const manager = (await this.app.container.make(MediaManager)) as MediaManager;
      const config = readConsoleServiceConfig(this.app.config);
      if (!manager.tenancy?.enabled) {
        if (this.tenant !== undefined) {
          throw new CommandRefusal('--tenant needs tenancy on (`tenancy` in config/media.ts)');
        }
        await this.handle(buildConsoleService(manager, config));
        return;
      }
      const scope = resolveConsoleTenantScope({
        granted: '*',
        own: undefined,
        selected: this.tenant,
      });
      // The command has no request tenant: run across every tenant, confined by the scope above.
      await allTenants(() => this.handle(buildConsoleService(manager, config, scope.ids)));
    } catch (error) {
      this.fail(error);
    }
  }

  /** Report `error` and exit with code 1. */
  protected fail(error: unknown): void {
    this.logger.error(error instanceof Error ? error.message : String(error));
    this.exitCode = 1;
  }

  /** Print `value` as one JSON document. */
  protected printJson(value: unknown): void {
    this.logger.log(JSON.stringify(value, null, 2));
  }

  /** Print rows as a table, or `empty` when there are none. */
  protected printTable(head: string[], rows: string[][], empty = 'Nothing to show.'): void {
    if (rows.length === 0) {
      this.logger.info(empty);
      return;
    }
    const table = this.ui.table();
    table.head(head);
    for (const row of rows) table.row(row);
    table.render();
  }

  /** Print `key: value` lines, skipping undefined values. */
  protected printFields(fields: Array<[string, unknown]>): void {
    for (const [label, value] of fields) {
      if (value === undefined) continue;
      this.logger.log(`${label}: ${value === null ? '-' : String(value)}`);
    }
  }

  /** The default disk of the console (the manager default when browsable, else the first). */
  protected defaultDisk(service: DashboardService): string {
    const disks = service.disks().data;
    const disk = disks.find((candidate) => candidate.default) ?? disks[0];
    if (!disk) throw new CommandRefusal('the console has no disks');
    return disk.name;
  }

  /**
   * Refuse a change up front when the console's `actions` switch is off (the service refuses it
   * too; this only saves asking a question whose answer cannot be acted on).
   */
  protected assertActions(service: DashboardService): void {
    if (!service.topology().actions) {
      throw new CommandRefusal(
        'actions are disabled on this console: set `actions: true` in config/media_dashboard.ts',
      );
    }
  }

  /**
   * Ask before a destructive change unless `force`. Returns whether to go ahead; a "no" exits with
   * code 1.
   */
  protected async confirmed(force: boolean, question: string): Promise<boolean> {
    if (force) return true;
    const ok = await this.prompt.confirm(question, { default: false });
    if (!ok) {
      this.logger.info('Cancelled: nothing was changed.');
      this.exitCode = 1;
    }
    return ok;
  }

  /** Log an action through the app logger, with the actor (`cli:<os user>`). */
  protected async audit(action: string): Promise<void> {
    const line = `[@adonis-agora/media] ${cliActor()}${this.tenant !== undefined ? ` (organization ${this.tenant})` : ''}: ${action}`;
    try {
      const logger = (await this.app.container.make('logger')) as { info?: unknown };
      if (typeof logger?.info === 'function') logger.info(line);
    } catch {
      // No app logger bound: the command's own output already says what happened.
    }
  }
}

/** A size in bytes for humans (`1.2 MB`), or `-` when unknown. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '-';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** A query-string-shaped request for the console's list readers (`list_api.ts`). */
export function listRequest(query: Record<string, unknown>): {
  request: { qs: () => Record<string, unknown> };
} {
  const qs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (value !== null && typeof value === 'object') {
      const nested = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined),
      );
      if (Object.keys(nested).length > 0) qs[key] = nested;
      continue;
    }
    qs[key] = value;
  }
  return { request: { qs: () => qs } };
}
