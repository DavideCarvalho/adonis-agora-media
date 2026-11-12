import AgoraDoctor from './agora_doctor.js';

/** `node ace media:doctor`: `agora:doctor` for media's checks only (same flags). */
export default class MediaDoctor extends AgoraDoctor {
  static override commandName = 'media:doctor';
  static override description = 'Check the @adonis-agora/media configuration';
  protected override presetLib: string | undefined = 'media';
}
