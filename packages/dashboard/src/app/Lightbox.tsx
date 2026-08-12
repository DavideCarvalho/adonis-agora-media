import { useQuery } from '@tanstack/react-query';
import { useRef } from 'react';
import type { ObjectInsight } from '../types';
import { DataTable } from './DataTable';
import { useDashboard } from './context';
import { useObjectInsights } from './queries';
import { Alert, Button, Empty, formatBytes } from './ui';
import {
  DialogBackdrop,
  DialogClose,
  DialogPopup,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from './ui/dialog';

/**
 * A modal preview of a disk object, ported to visual parity with the NestJS sibling console's
 * `Lightbox.tsx`. Renders inline previews by content type (image/video/audio/PDF/text/CSV/TSV);
 * everything else falls back to an "Open original ↗" link. Unlike the NestJS version this build does
 * NOT bundle a spreadsheet (XLSX/ODS) parser — that preview kind falls back to the same "Open
 * original" card rather than pulling in a new dependency for one preview tab.
 */

export interface PreviewItem {
  disk: string;
  key: string;
  name: string;
  size: number;
  contentType?: string;
  url: string;
}

type PreviewKind = 'image' | 'pdf' | 'video' | 'audio' | 'text' | 'other';

const EXTENSION_KIND: ReadonlyArray<[RegExp, PreviewKind]> = [
  [/\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i, 'image'],
  [/\.pdf$/i, 'pdf'],
  [/\.(mp4|webm|mov|m4v|ogv)$/i, 'video'],
  [/\.(mp3|wav|ogg|oga|flac|m4a|aac)$/i, 'audio'],
  [/\.(txt|json|csv|tsv|md|log|xml|ya?ml)$/i, 'text'],
];

function previewKind(item: PreviewItem): PreviewKind {
  const type = item.contentType?.toLowerCase() ?? '';
  if (type.startsWith('image/')) return 'image';
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('text/') || type === 'application/json') return 'text';
  for (const [pattern, kind] of EXTENSION_KIND) {
    if (pattern.test(item.name)) return kind;
  }
  return 'other';
}

function textFlavor(item: PreviewItem): 'csv' | 'tsv' | 'json' | 'plain' {
  const type = item.contentType?.toLowerCase() ?? '';
  if (type.includes('csv') || /\.csv$/i.test(item.name)) return 'csv';
  if (type.includes('tab-separated') || /\.tsv$/i.test(item.name)) return 'tsv';
  if (type.includes('json') || /\.json$/i.test(item.name)) return 'json';
  return 'plain';
}

/** How much of a text/CSV file we pull into the tab — a large file is *sampled* (its head only). */
const SAMPLE_TEXT_BYTES = 8 * 1024 * 1024;

/** The shared fallback surface: a glyph, a message, and a link to the original in a new tab. Used
 *  whenever inline rendering isn't available (unknown type or a read error). */
function FallbackCard({ item, message }: { item: PreviewItem; message: string }) {
  return (
    <div className="grid h-full min-h-[320px] place-items-center gap-4 px-6 text-center">
      <div className="flex flex-col items-center gap-4">
        <div className="grid h-14 w-14 place-items-center rounded-lg border border-border bg-zinc-900 text-2xl text-zinc-600">
          ⬡
        </div>
        <div className="mono max-w-md text-sm text-zinc-400">{message}</div>
        <Button
          tone="accent"
          size="sm"
          // biome-ignore lint/a11y/useAnchorContent: Base UI's `render` prop clones this element with the Button's children; the link is not empty at runtime
          render={<a href={item.url} target="_blank" rel="noopener noreferrer" />}
        >
          Open original ↗
        </Button>
      </div>
    </div>
  );
}

/** Split delimited text into rows of fields, honoring double-quoted fields (with "" escapes). */
function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function DelimitedTable({ text, delimiter }: { text: string; delimiter: string }) {
  const rows = parseDelimited(text.trimEnd(), delimiter);
  const header = rows[0];
  if (!header) return <Empty>Empty file.</Empty>;
  return <DataTable header={header} body={rows.slice(1)} />;
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function TextPreview({ item }: { item: PreviewItem }) {
  const { client } = useDashboard();
  const query = useQuery({
    queryKey: ['object-text-head', item.disk, item.key],
    queryFn: () => client.objectTextHead(item.disk, item.key, SAMPLE_TEXT_BYTES),
    retry: false,
    staleTime: 60_000,
  });

  if (query.isLoading) return <Empty>Loading…</Empty>;
  if (query.isError || !query.data)
    return <FallbackCard item={item} message="Could not read this file." />;

  const { text, bytesRead } = query.data;
  const truncated = bytesRead < item.size;
  const source = truncated ? text.slice(0, Math.max(0, text.lastIndexOf('\n'))) : text;
  const flavor = textFlavor(item);
  const content =
    flavor === 'csv' ? (
      <DelimitedTable text={source} delimiter="," />
    ) : flavor === 'tsv' ? (
      <DelimitedTable text={source} delimiter={'\t'} />
    ) : (
      <pre className="mono min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-black/30 p-3 text-xs text-zinc-300">
        {flavor === 'json' ? prettyJson(source) : source}
      </pre>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {truncated && (
        <Alert variant="warn" className="shrink-0">
          Sample — the first {formatBytes(bytesRead)} of {formatBytes(item.size)}. Filters and sort
          apply to this sample; open the original ↗ for the whole file.
        </Alert>
      )}
      {content}
    </div>
  );
}

function PreviewBody({ item, kind }: { item: PreviewItem; kind: PreviewKind }) {
  const { client } = useDashboard();
  switch (kind) {
    case 'image':
      return (
        <div className="grid min-h-0 flex-1 place-items-center">
          <img
            src={item.url}
            alt={item.name}
            className="max-h-full max-w-full rounded-md object-contain"
          />
        </div>
      );
    case 'video':
      return (
        <div className="grid min-h-0 flex-1 place-items-center">
          {/* biome-ignore lint/a11y/useMediaCaption: preview of an arbitrary stored object; no track available */}
          <video src={item.url} controls className="max-h-full max-w-full rounded-md" />
        </div>
      );
    case 'audio':
      return (
        <div className="grid min-h-0 flex-1 place-items-center">
          {/* biome-ignore lint/a11y/useMediaCaption: preview of an arbitrary stored object */}
          <audio src={item.url} controls className="w-full max-w-md" />
        </div>
      );
    case 'pdf':
      // Streamed inline through the same-origin proxy so the browser renders it instead of a signed
      // URL that may carry Content-Disposition: attachment (which would download).
      return (
        <iframe
          src={client.objectRawUrl(item.disk, item.key)}
          title={item.name}
          className="min-h-0 w-full flex-1 rounded-md border border-border bg-white"
        />
      );
    case 'text':
      return <TextPreview item={item} />;
    default:
      return (
        <FallbackCard
          item={item}
          message={`No inline preview for ${item.contentType ?? 'this type'}`}
        />
      );
  }
}

/**
 * What the HOST knows about this object, when it registered any `objectInsights` providers. Silent
 * about its own absence — no providers, nothing to say, or a failed lookup all render nothing.
 */
function ObjectInsights({ disk, objectKey }: { disk: string; objectKey: string }) {
  const { data } = useObjectInsights(disk, objectKey);
  const insights = data?.insights ?? [];
  if (insights.length === 0) return null;
  return (
    <div className="mb-3 flex flex-wrap gap-2">
      {insights.map((insight: ObjectInsight) => (
        <div
          key={insight.title}
          className="min-w-56 flex-1 rounded-md border border-border bg-panel px-3 py-2"
        >
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">{insight.title}</div>
          {insight.facts?.map((fact) => (
            <div key={fact.label} className="mt-1 flex items-baseline gap-2 text-xs">
              <span className="text-zinc-500">{fact.label}</span>
              <span className="mono tnum truncate text-zinc-200">{fact.value}</span>
            </div>
          ))}
          {insight.note && <p className="mt-1.5 text-[11px] text-zinc-500">{insight.note}</p>}
          {insight.links && insight.links.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {insight.links.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-sky-400 underline underline-offset-2 hover:text-sky-300"
                >
                  {link.label}
                </a>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** A modal preview of a disk object: the object's name + metadata over an inline renderer chosen by
 *  content type. Same Dialog primitive as every other modal in the console (see `./ui/dialog.tsx`),
 *  so Escape, outside-press, the focus trap and focus restore all behave identically — a preview
 *  opened from a row hands focus back to that row on close. */
export function Lightbox({ item, onClose }: { item: PreviewItem | null; onClose: () => void }) {
  const popupRef = useRef<HTMLDivElement>(null);
  if (!item) return null;
  const kind = previewKind(item);

  return (
    <DialogRoot
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup
          ref={popupRef}
          // Focus the panel itself, not the first tabbable thing in it — that is the "Open ↗" link,
          // and opening a preview should not leave Enter armed to launch a new tab.
          initialFocus={popupRef}
          className="h-[86vh] max-h-[calc(100vh-3rem)] max-w-5xl"
        >
          <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate normal-case tracking-normal text-sm text-zinc-200">
                {item.name}
              </DialogTitle>
              <div className="mono tnum mt-0.5 flex items-center gap-2 text-[10px] text-zinc-600">
                <span>{formatBytes(item.size)}</span>
                {item.contentType && (
                  <span className="rounded border border-border px-1 text-zinc-500">
                    {item.contentType}
                  </span>
                )}
              </div>
            </div>
            <Button
              tone="ghost"
              className="shrink-0"
              // biome-ignore lint/a11y/useAnchorContent: Base UI's `render` prop clones this element with the Button's children; the link is not empty at runtime
              render={<a href={item.url} target="_blank" rel="noopener noreferrer" />}
            >
              Open ↗
            </Button>
            <Button
              render={<DialogClose />}
              tone="ghost"
              aria-label="Close preview"
              className="shrink-0"
            >
              ✕
            </Button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4">
            <ObjectInsights disk={item.disk} objectKey={item.key} />
            <PreviewBody item={item} kind={kind} />
          </div>
        </DialogPopup>
      </DialogPortal>
    </DialogRoot>
  );
}
