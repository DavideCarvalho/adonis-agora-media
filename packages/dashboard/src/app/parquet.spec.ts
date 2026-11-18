// @vitest-environment node
import { parquetWriteBuffer } from 'hyparquet-writer';
import { describe, expect, it } from 'vitest';
import { isParquet } from './parquet';
import { formatParquetValue, readParquetPreview, unsupportedCodec } from './parquet-reader';

describe('isParquet', () => {
  it('detects Parquet by content type', () => {
    for (const contentType of [
      'application/vnd.apache.parquet',
      'application/x-parquet',
      'Application/X-Parquet; charset=binary',
    ]) {
      expect(isParquet({ key: 'data', name: 'data', contentType })).toBe(true);
    }
  });

  it('detects Parquet by a .parquet key or name', () => {
    expect(isParquet({ key: 'exports/2026/part-0.parquet', name: 'part-0.parquet' })).toBe(true);
    expect(
      isParquet({
        key: 'part-0.PARQUET',
        name: 'part-0.PARQUET',
        contentType: 'binary/octet-stream',
      }),
    ).toBe(true);
  });

  it('leaves everything else alone', () => {
    expect(isParquet({ key: 'a.csv', name: 'a.csv', contentType: 'text/csv' })).toBe(false);
    expect(isParquet({ key: 'parquet.txt', name: 'parquet.txt' })).toBe(false);
  });
});

describe('formatParquetValue', () => {
  it('keeps nulls distinct from empty strings', () => {
    expect(formatParquetValue(null)).toBeNull();
    expect(formatParquetValue(undefined)).toBeNull();
    expect(formatParquetValue('')).toBe('');
  });

  it('renders scalars, BigInt, dates and bytes', () => {
    expect(formatParquetValue(42)).toBe('42');
    expect(formatParquetValue(true)).toBe('true');
    expect(formatParquetValue(9007199254740993n)).toBe('9007199254740993');
    expect(formatParquetValue(new Date('2026-11-17T12:00:00.000Z'))).toBe(
      '2026-11-17T12:00:00.000Z',
    );
    expect(formatParquetValue(new Date(Number.NaN))).toBe('Invalid Date');
    expect(formatParquetValue(new Uint8Array([0, 15, 255]))).toBe('0x000fff');
    expect(formatParquetValue(new Uint8Array(100))).toMatch(/… \(100 bytes\)$/);
  });

  it('stringifies nested values with BigInt support', () => {
    expect(formatParquetValue({ id: 1n, tags: ['a', null], at: new Date(0) })).toBe(
      '{"id":"1","tags":["a",null],"at":"1970-01-01T00:00:00.000Z"}',
    );
  });

  it('never throws on values JSON cannot serialize', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(formatParquetValue(cyclic)).toBe('[object Object]');
  });
});

describe('unsupportedCodec', () => {
  it('extracts the codec from hyparquet errors', () => {
    expect(unsupportedCodec(new Error('parquet unsupported compression codec: ZSTD'))).toBe('ZSTD');
    expect(unsupportedCodec(new Error('parquet file invalid'))).toBeNull();
  });
});

describe('readParquetPreview', () => {
  it('reads the schema, row count and only the leading rows', async () => {
    const bytes = parquetWriteBuffer({
      columnData: [
        { name: 'id', data: Array.from({ length: 120 }, (_, i) => BigInt(i)), type: 'INT64' },
        {
          name: 'label',
          data: Array.from({ length: 120 }, (_, i) => (i % 2 ? `row ${i}` : null)),
          type: 'STRING',
        },
      ],
    });
    const preview = await readParquetPreview(bytes, 50);
    expect(preview.rowCount).toBe(120n);
    expect(preview.columns.map((column) => [column.name, column.type])).toEqual([
      ['id', 'INT64'],
      ['label', 'UTF8'],
    ]);
    expect(preview.rows).toHaveLength(50);
    expect(preview.rows[0]).toEqual(['0', null]);
    expect(preview.rows[1]).toEqual(['1', 'row 1']);
  });

  it('rejects bytes that are not Parquet', async () => {
    await expect(
      readParquetPreview(new TextEncoder().encode('not a parquet file').buffer, 50),
    ).rejects.toThrow();
  });
});
