import {
  parquetMetadata,
  parquetReadObjects,
  parquetSchema,
  type SchemaElement,
  type SchemaTree,
} from 'hyparquet';

/**
 * Reads the head of a Parquet file for the Lightbox preview. Part of the lazy Parquet chunk (only
 * `ParquetPreview.tsx` imports it, through `React.lazy`), so `hyparquet` never weighs on the
 * console's main bundle.
 */

export interface ParquetColumn {
  name: string;
  /** The most specific type the schema declares: logical type, else converted type, else physical. */
  type: string;
  nullable: boolean;
}

export interface ParquetPreviewData {
  columns: ParquetColumn[];
  /** Total rows in the file, from the footer metadata. */
  rowCount: bigint;
  /** The first rows, already formatted for display; `null` is a null cell. */
  rows: Array<Array<string | null>>;
}

function columnType(node: SchemaTree): string {
  const element: SchemaElement = node.element;
  const logical = element.logical_type;
  if (logical) {
    if (logical.type === 'DECIMAL') return `DECIMAL(${logical.precision},${logical.scale})`;
    if (logical.type === 'TIMESTAMP' || logical.type === 'TIME') {
      return `${logical.type}(${logical.unit})`;
    }
    if (logical.type === 'INTEGER') {
      return `${logical.isSigned ? 'INT' : 'UINT'}${logical.bitWidth}`;
    }
    return logical.type;
  }
  if (element.converted_type) return element.converted_type;
  if (node.children.length > 0) return 'STRUCT';
  return element.type ?? 'UNKNOWN';
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** Binary values longer than this show only their head (plus the total length). */
const MAX_HEX_BYTES = 64;

function formatBytesValue(bytes: Uint8Array): string {
  const head = toHex(bytes.subarray(0, MAX_HEX_BYTES));
  return bytes.length > MAX_HEX_BYTES ? `0x${head}… (${bytes.length} bytes)` : `0x${head}`;
}

/** JSON replacer for nested values: BigInt, binary and dates have no JSON form of their own. */
function jsonSafe(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return formatBytesValue(value);
  return value;
}

/**
 * Render one decoded Parquet value as display text. `null` (and `undefined`) stay `null` so the
 * table can show them distinctly from an empty string. Never throws.
 */
export function formatParquetValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }
  if (value instanceof Uint8Array) return formatBytesValue(value);
  try {
    return JSON.stringify(value, jsonSafe) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Turn hyparquet's "unsupported compression codec: X" into the codec name, when that's the error. */
export function unsupportedCodec(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  return /unsupported compression codec:\s*(\S+)/i.exec(message)?.[1] ?? null;
}

/**
 * Parse a Parquet file's schema, row count and first `rowLimit` rows. Snappy and uncompressed pages
 * decode; any other codec throws (see {@link unsupportedCodec}).
 */
export async function readParquetPreview(
  bytes: ArrayBuffer,
  rowLimit: number,
): Promise<ParquetPreviewData> {
  const metadata = parquetMetadata(bytes);
  const tree = parquetSchema(metadata);
  const columns: ParquetColumn[] = tree.children.map((node) => ({
    name: node.element.name,
    type: columnType(node),
    nullable: node.element.repetition_type !== 'REQUIRED',
  }));
  const end = Math.min(rowLimit, Number(metadata.num_rows));
  const objects =
    end > 0 ? await parquetReadObjects({ file: bytes, metadata, rowStart: 0, rowEnd: end }) : [];
  return {
    columns,
    rowCount: metadata.num_rows,
    rows: objects
      .slice(0, end)
      .map((row) => columns.map((column) => formatParquetValue(row[column.name]))),
  };
}
