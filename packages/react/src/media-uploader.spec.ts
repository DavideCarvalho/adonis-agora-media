// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { MediaUploadClient } from './client';
import { MediaUploader } from './media-uploader';

function fakeClient(): MediaUploadClient {
  return {
    createTusSession: vi.fn(async () => ({ location: '/media/uploads/tus/s1' })),
    tusOffset: vi.fn(async () => 0),
    abortTus: vi.fn(async () => {}),
    uploadTus: vi.fn(async (_d, _m, opts) => {
      opts?.onProgress?.(10, 10);
      return { mode: 'tus', location: '/media/uploads/tus/s1' } as const;
    }),
    uploadDirect: vi.fn(
      async () => ({ mode: 'direct', key: 'k', disk: 's3', uploadId: 'up' }) as const,
    ),
    uploadProxy: vi.fn(async () => ({ mode: 'proxy', key: 'k', disk: 'local' }) as const),
    mediaUrl: (id: string) => `/media/${id}`,
  };
}

describe('MediaUploader', () => {
  it('renders a file input and progress bar in the idle state', () => {
    render(createElement(MediaUploader, { client: fakeClient() }));
    expect(screen.getByLabelText('Upload file')).toBeDefined();
    const wrapper = document.querySelector('[data-media-uploader]');
    expect(wrapper?.getAttribute('data-status')).toBe('idle');
  });

  it('injects the Agora-themed stylesheet by default (tokens, no vendor branding)', () => {
    render(createElement(MediaUploader, { client: fakeClient() }));
    const style = document.getElementById('agora-media-uploader-styles');
    expect(style).not.toBeNull();
    expect(style?.textContent).toContain('--agora-primary');
    expect(style?.textContent?.toLowerCase()).not.toContain('nest');
  });

  it('does not inject styles when unstyled', () => {
    document.getElementById('agora-media-uploader-styles')?.remove();
    render(createElement(MediaUploader, { client: fakeClient(), unstyled: true }));
    expect(document.getElementById('agora-media-uploader-styles')).toBeNull();
  });

  it('uploads the selected file and fires onUploaded with the result', async () => {
    const onUploaded = vi.fn();
    render(createElement(MediaUploader, { client: fakeClient(), onUploaded }));

    const input = screen.getByLabelText('Upload file') as HTMLInputElement;
    const file = new File(['hello world'], 'a.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() =>
      expect(onUploaded).toHaveBeenCalledWith({ mode: 'tus', location: '/media/uploads/tus/s1' }),
    );
  });

  it('supports a headless render override', () => {
    const client = fakeClient();
    render(
      createElement(MediaUploader, {
        client,
        render: (api) => createElement('div', { 'data-testid': 'custom' }, `status:${api.status}`),
      }),
    );
    expect(screen.getByTestId('custom').textContent).toBe('status:idle');
    // The default markup is skipped entirely.
    expect(screen.queryByLabelText('Upload file')).toBeNull();
  });

  it('fires onError when the upload fails', async () => {
    const failing = fakeClient();
    (failing.createTusSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('nope'));
    const onError = vi.fn();
    render(createElement(MediaUploader, { client: failing, onError }));

    const input = screen.getByLabelText('Upload file') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'x.txt', { type: 'text/plain' })] },
    });

    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(Error)));
  });
});
