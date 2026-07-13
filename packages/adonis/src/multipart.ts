import type { Disk, MultipartUploadDisk } from './types.js';

/**
 * Structural guard: does this disk implement the optional {@link MultipartUploadDisk} surface?
 * The base {@link Disk} contract deliberately omits multipart, so the upload layer detects it here
 * at runtime (the bundled `disks.s3()` disk provides it; the in-memory/Drive disks do not) rather
 * than depending on it statically. A disk is treated as multipart-capable when it exposes the whole
 * create/upload/presign/complete/abort surface.
 */
export function isMultipartCapable(disk: Disk): disk is Disk & MultipartUploadDisk {
  const d = disk as Partial<MultipartUploadDisk>;
  return (
    typeof d.createMultipartUpload === 'function' &&
    typeof d.presignUploadPart === 'function' &&
    typeof d.completeMultipartUpload === 'function' &&
    typeof d.abortMultipartUpload === 'function' &&
    typeof d.uploadPart === 'function'
  );
}
