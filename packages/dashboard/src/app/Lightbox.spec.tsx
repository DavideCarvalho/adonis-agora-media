// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, waitFor, within } from '@testing-library/react';
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

  describe('Parquet', () => {
    /** 60 rows: id INT64, city STRING (row 2 null), score DOUBLE, active BOOLEAN. */
    function fixture(): ArrayBuffer {
      const file = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'cities.parquet'),
      );
      // Copied into this environment's own ArrayBuffer: jsdom's globals are a different realm from
      // Node's, and hyparquet checks `instanceof ArrayBuffer`.
      const bytes = new ArrayBuffer(file.byteLength);
      new Uint8Array(bytes).set(file);
      return bytes;
    }

    /** The preview is a lazy chunk; its first load can outlast `findBy`'s 1s default on a busy run. */
    const LAZY = { timeout: 5000 };

    function parquetItem(overrides: Partial<PreviewItem> = {}): PreviewItem {
      return {
        disk: 's3',
        key: 'exports/cities.parquet',
        name: 'cities.parquet',
        size: 1204,
        contentType: 'application/vnd.apache.parquet',
        url: 'https://signed.example/cities.parquet',
        ...overrides,
      };
    }

    it('renders the schema, row count and the first 50 rows as a table', async () => {
      const client = {
        objectInsights: vi.fn(async () => ({ insights: [] })),
        objectBytes: vi.fn(async () => fixture()),
      };
      renderView(<Lightbox item={parquetItem()} onClose={vi.fn()} />, client);

      const table = await screen.findByRole('table', { name: 'First 50 of 60 rows' }, LAZY);
      expect(client.objectBytes).toHaveBeenCalledWith(
        's3',
        'exports/cities.parquet',
        25 * 1024 * 1024,
      );

      const schema = screen.getByRole('region', { name: 'Schema' });
      expect(within(schema).getByText('4 columns · 60 rows')).toBeTruthy();
      expect(within(schema).getByText('city').nextSibling?.textContent).toBe('UTF8?');
      expect(within(schema).getByText('id').nextSibling?.textContent).toBe('INT64?');

      const headers = within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent);
      expect(headers).toEqual(['id', 'city', 'score', 'active']);
      const rows = within(table).getAllByRole('row');
      expect(rows).toHaveLength(51);
      const first = within(rows[1] as HTMLElement).getAllByRole('cell');
      expect(first.map((cell) => cell.textContent)).toEqual(['1', 'city-1', '0', 'true']);
      expect(first[1]?.getAttribute('title')).toBe('city-1');
      const nullCell = within(rows[2] as HTMLElement).getAllByRole('cell')[1] as HTMLElement;
      expect(nullCell.textContent).toBe('null');
      expect(nullCell.querySelector('.italic')).toBeTruthy();
    });

    it('detects Parquet by the .parquet extension when the type is generic', async () => {
      const client = {
        objectInsights: vi.fn(async () => ({ insights: [] })),
        objectBytes: vi.fn(async () => fixture()),
      };
      renderView(
        <Lightbox
          item={parquetItem({ contentType: 'application/octet-stream' })}
          onClose={vi.fn()}
        />,
        client,
      );
      expect(await screen.findByRole('table', { name: 'First 50 of 60 rows' }, LAZY)).toBeTruthy();
    });

    it('shows the fallback card when the file cannot be read', async () => {
      const client = {
        objectInsights: vi.fn(async () => ({ insights: [] })),
        objectBytes: vi.fn(async () => new TextEncoder().encode('definitely not parquet').buffer),
      };
      renderView(<Lightbox item={parquetItem()} onClose={vi.fn()} />, client);
      expect(await screen.findByText('Could not read this Parquet file.', {}, LAZY)).toBeTruthy();
      expect(screen.getByText('Open original ↗')).toBeTruthy();
    });

    it('names a compression codec the preview cannot decode', async () => {
      const client = {
        objectInsights: vi.fn(async () => ({ insights: [] })),
        objectBytes: vi.fn(async () => {
          throw new Error('parquet unsupported compression codec: ZSTD');
        }),
      };
      renderView(<Lightbox item={parquetItem()} onClose={vi.fn()} />, client);
      expect(await screen.findByText(/compressed with ZSTD/, {}, LAZY)).toBeTruthy();
    });

    it('does not download a file above the size cap', async () => {
      const client = {
        objectInsights: vi.fn(async () => ({ insights: [] })),
        objectBytes: vi.fn(async () => fixture()),
      };
      renderView(
        <Lightbox item={parquetItem({ size: 30 * 1024 * 1024 })} onClose={vi.fn()} />,
        client,
      );
      expect(
        await screen.findByText(/reads files up to 25 MB; this one is 30 MB/, {}, LAZY),
      ).toBeTruthy();
      expect(client.objectBytes).not.toHaveBeenCalled();
    });
  });
});
