import { type ReactNode, createElement, useEffect } from 'react';
import type { MediaUploadResult, UploadMeta } from './client.js';
import { ensureMediaUploaderStyles } from './styles.js';
import {
  type MediaUploadMode,
  type UseMediaUpload,
  type UseMediaUploadOptions,
  useMediaUpload,
} from './use-media-upload.js';

export interface MediaUploaderProps extends UseMediaUploadOptions {
  /** Upload strategy (mirrors {@link UseMediaUploadOptions.mode}). Default `tus`. */
  mode?: MediaUploadMode;
  /** `accept` attribute for the file input. */
  accept?: string;
  /** Extra metadata (e.g. `key`/`disk` for direct/proxy) merged into every upload. */
  meta?: Partial<UploadMeta>;
  /** Skip injecting the default Agora-themed stylesheet (bring your own). Default false. */
  unstyled?: boolean;
  /** Class applied to the wrapper element. */
  className?: string;
  /** Called with the result after a successful upload. */
  onUploaded?: (result: MediaUploadResult) => void;
  onError?: (error: Error) => void;
  /**
   * Headless override: receive the full hook state + a `selectFile(file)` handler and render your
   * own UI. When provided, the default input/progress markup is skipped entirely.
   */
  render?: (api: UseMediaUpload & { selectFile: (file: Blob) => void }) => ReactNode;
}

/**
 * A minimal, headless-friendly file uploader wired to {@link useMediaUpload}. The default markup is
 * a file input + a progress bar, styled through Agora design tokens (see {@link ensureMediaUploaderStyles}).
 * Pass `render` to take full control of the UI, `unstyled` to drop the default CSS, or override any
 * `--agora-media-*` custom property to retheme.
 *
 * Authored with `createElement` (no JSX) so the package builds and tests without a JSX toolchain;
 * consumers can style or replace it freely.
 */
export function MediaUploader(props: MediaUploaderProps) {
  const { accept, meta, unstyled, className, onUploaded, onError, render, ...hookOptions } = props;

  const api = useMediaUpload(hookOptions);

  useEffect(() => {
    if (!unstyled) ensureMediaUploaderStyles();
  }, [unstyled]);

  const selectFile = async (file: Blob) => {
    const filename = file instanceof File ? file.name : (meta?.filename ?? 'upload');
    const contentType = file instanceof File ? file.type : meta?.contentType;
    try {
      const result = await api.upload(file, {
        filename,
        ...(contentType ? { contentType } : {}),
        ...(meta ?? {}),
      } as UploadMeta);
      onUploaded?.(result);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      onError?.(err as Error);
    }
  };

  if (render) return render({ ...api, selectFile });

  const onChange = (event: { target: { files: FileList | null } }) => {
    const file = event.target.files?.[0];
    if (file) void selectFile(file);
  };

  return createElement(
    'div',
    {
      'data-media-uploader': '',
      'data-status': api.status,
      ...(className ? { className } : {}),
    },
    createElement('input', {
      type: 'file',
      'aria-label': 'Upload file',
      ...(accept ? { accept } : {}),
      onChange,
    }),
    createElement('progress', { value: api.progress, max: 1 }),
    createElement(
      'span',
      { 'data-media-status': '' },
      api.status === 'error' && api.error ? api.error.message : api.status,
    ),
  );
}
