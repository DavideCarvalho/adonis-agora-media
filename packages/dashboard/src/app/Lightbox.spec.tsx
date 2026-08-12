// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Lightbox, type PreviewItem } from './Lightbox';
import { renderView } from './testkit';

describe('Lightbox', () => {
  it('renders nothing when there is no item', () => {
    const { container } = render(<Lightbox item={null} onClose={vi.fn()} />);
    expect(container.textContent).toBe('');
  });

  it('renders an inline image preview for an image content type', () => {
    const item: PreviewItem = {
      disk: 's3',
      key: 'photo.jpg',
      name: 'photo.jpg',
      size: 2048,
      contentType: 'image/jpeg',
      url: 'https://signed.example/photo.jpg',
    };
    const client = { objectInsights: vi.fn(async () => ({ insights: [] })) };
    renderView(<Lightbox item={item} onClose={vi.fn()} />, client);
    const img = screen.getByAltText('photo.jpg') as HTMLImageElement;
    expect(img.src).toBe('https://signed.example/photo.jpg');
  });

  it('renders host-registered object insights above the preview', async () => {
    const item: PreviewItem = {
      disk: 's3',
      key: 'doc.pdf',
      name: 'doc.pdf',
      size: 100,
      contentType: 'application/pdf',
      url: 'https://signed.example/doc.pdf',
    };
    const client = {
      objectInsights: vi.fn(async () => ({
        insights: [{ title: 'Knowledge base', facts: [{ label: 'Indexed', value: 'yes' }] }],
      })),
      objectRawUrl: vi.fn(() => 'https://signed.example/doc.pdf/raw'),
    };
    renderView(<Lightbox item={item} onClose={vi.fn()} />, client);
    await waitFor(() => expect(screen.getByText('Knowledge base')).toBeTruthy());
    expect(screen.getByText('yes')).toBeTruthy();
  });

  it('falls back to an "Open original" link for an unknown content type', () => {
    const item: PreviewItem = {
      disk: 's3',
      key: 'archive.zip',
      name: 'archive.zip',
      size: 100,
      contentType: 'application/zip',
      url: 'https://signed.example/archive.zip',
    };
    const client = { objectInsights: vi.fn(async () => ({ insights: [] })) };
    renderView(<Lightbox item={item} onClose={vi.fn()} />, client);
    expect(screen.getByText('Open original ↗')).toBeTruthy();
  });
});
