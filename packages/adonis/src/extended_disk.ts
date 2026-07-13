import type { Disk, ExtendedDisk } from './types.js';

/**
 * Structural guard: does this disk implement the optional {@link ExtendedDisk} surface (copy/move,
 * batched delete, list, size/stat, plus a capabilities descriptor)? The base {@link Disk} contract
 * deliberately omits these, so callers detect the richer operations here at runtime (the bundled
 * `disks.s3()` disk provides them; the in-memory/Drive disks do not) rather than depending on them
 * statically. A disk qualifies when it exposes the whole surface.
 */
export function isExtendedDisk(disk: Disk): disk is Disk & ExtendedDisk {
  const d = disk as Partial<ExtendedDisk>;
  return (
    typeof d.copy === 'function' &&
    typeof d.move === 'function' &&
    typeof d.deleteMany === 'function' &&
    typeof d.list === 'function' &&
    typeof d.size === 'function' &&
    typeof d.stat === 'function' &&
    typeof d.capabilities === 'object' &&
    d.capabilities !== null
  );
}
