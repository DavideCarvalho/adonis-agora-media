import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import type { MediaConfig } from '../src/define_config.js';
import { appKeyOf, consoleCommandKeys } from '../src/federation/redis_channel.js';

/**
 * `node ace media:console-key` — print this app's console-command public key: what another app's
 * federated console sets as `controlPlane.publicKey` to send commands in token mode (authkit). It is
 * derived from `APP_KEY` and `consoleCommands.prefix`, so it changes when either does. Not secret.
 */
export default class MediaConsoleKey extends BaseCommand {
  static override commandName = 'media:console-key';
  static override description =
    "Print this app's console-command public key (the federated console's controlPlane.publicKey)";
  static override options: CommandOptions = { startApp: false };

  @flags.string({ description: 'The channel prefix (default: consoleCommands.prefix)' })
  declare prefix?: string;

  override async run(): Promise<void> {
    const options = this.app.config.get<MediaConfig>('media', {}).consoleCommands;
    const prefix = this.prefix ?? options?.prefix;
    if (!prefix) {
      this.logger.error(
        'No prefix: set consoleCommands.prefix in config/media.ts, or pass --prefix',
      );
      this.exitCode = 1;
      return;
    }
    const appKey = await appKeyOf(this.app);
    if (!appKey) {
      this.logger.error('No APP_KEY: the console-command key is derived from it');
      this.exitCode = 1;
      return;
    }
    this.logger.log(consoleCommandKeys(appKey, prefix).publicKey);
  }
}
