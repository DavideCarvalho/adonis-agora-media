import { UploadNotSupportedError } from './errors.js';

/** Requested upload strategy. `auto` picks `direct` when the disk is multipart-capable, else `proxy`. */
export type UploadMode = 'auto' | 'proxy' | 'direct';

/** The concrete strategy after resolution — `auto` has been collapsed to one of these. */
export type ResolvedUploadMode = 'proxy' | 'direct';

/**
 * The upload mode configured at each level. The most specific wins:
 * per-call → per-disk → global → `auto`.
 */
export interface UploadModeLevels {
  /** Global default from `config/media.ts` (`uploads.mode`). */
  global?: UploadMode | undefined;
  /** A per-disk override (unused by the bundled disks; reserved for future per-disk config). */
  perDisk?: UploadMode | undefined;
  /** A per-call override passed to the upload method. */
  perCall?: UploadMode | undefined;
}

/**
 * Decide whether an upload flows through the backend (`proxy` — the app streams bytes to the disk)
 * or straight to the disk (`direct` — the app issues presigned multipart part URLs and the client
 * uploads to S3 itself).
 *
 * - `proxy`: always allowed (every disk can accept bytes through `put`/`putStream`).
 * - `direct`: requires a multipart-capable disk; otherwise throws {@link UploadNotSupportedError}.
 * - `auto`: `direct` when the disk is multipart-capable, else `proxy`.
 */
export function resolveUploadMode(
  levels: UploadModeLevels,
  directCapable: boolean,
  diskName = 'disk',
): ResolvedUploadMode {
  const mode: UploadMode = levels.perCall ?? levels.perDisk ?? levels.global ?? 'auto';

  if (mode === 'proxy') return 'proxy';
  if (mode === 'direct') {
    if (!directCapable) throw new UploadNotSupportedError(diskName);
    return 'direct';
  }
  return directCapable ? 'direct' : 'proxy';
}
