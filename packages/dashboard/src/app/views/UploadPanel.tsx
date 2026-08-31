import { useMediaUpload } from '@adonis-agora/media-react';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { useDashboard } from '../context';
import { useDisks } from '../queries';
import { Bar, Empty, Panel, useToasts } from '../ui';

interface QueueItem {
  name: string;
  status: 'done' | 'error';
}

/**
 * Upload panel — reuses `@adonis-agora/media-react`'s `useMediaUpload` (resumable TUS) against the
 * core upload routes. Files dropped or picked are uploaded sequentially into the chosen disk; on
 * completion the library/uploads queries are invalidated so the new objects appear. Styled to match
 * the console's other dialogs' dropzone (see `UploadDialog` in `LibraryBrowseView.tsx`).
 */
export function UploadPanel() {
  const { bootstrap } = useDashboard();
  const disks = useDisks();
  const qc = useQueryClient();
  const { push } = useToasts();
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [active, setActive] = useState<string | null>(null);

  const browsable = useMemo(() => disks.data?.disks ?? [], [disks.data]);
  const [disk, setDisk] = useState<string>('');
  const targetDisk = disk || browsable.find((d) => d.default)?.name || browsable[0]?.name || '';

  const uploader = useMediaUpload({
    mode: 'tus',
    baseUrl: '',
    tusPath: bootstrap.tusBase,
    uploadsPath: bootstrap.uploadsBase,
  });

  const handleFiles = async (files: File[]) => {
    for (const file of files) {
      setActive(file.name);
      try {
        await uploader.upload(file, {
          filename: file.name,
          ...(file.type ? { contentType: file.type } : {}),
          key: file.name,
          ...(targetDisk ? { disk: targetDisk } : {}),
        });
        setQueue((prev) => [{ name: file.name, status: 'done' }, ...prev]);
      } catch (err) {
        setQueue((prev) => [{ name: file.name, status: 'error' }, ...prev]);
        push(`${file.name}: ${(err as Error).message}`, 'error');
      }
    }
    setActive(null);
    uploader.reset();
    qc.invalidateQueries({ queryKey: ['objects'] });
    qc.invalidateQueries({ queryKey: ['uploads'] });
  };

  return (
    <section className="rise mx-auto max-w-xl">
      <Panel className="p-4">
        <h3 className="mono mb-3 text-[10px] uppercase tracking-wider text-zinc-600">Upload</h3>
        <div className="flex flex-col gap-3">
          <label
            htmlFor="upload-disk"
            className="mono flex flex-col gap-1 text-[10px] uppercase tracking-wider text-zinc-600"
          >
            Destination disk
            <select
              id="upload-disk"
              value={targetDisk}
              onChange={(e) => setDisk(e.target.value)}
              className="mono max-w-xs rounded-md border border-border bg-black/30 px-3 py-2 text-sm normal-case tracking-normal text-zinc-100 focus:border-accent/40 focus:outline-hidden"
            >
              {browsable.length === 0 && <option value="">(no disks)</option>}
              {browsable.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name}
                  {d.default ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </label>

          {/* biome-ignore lint/a11y/useKeyWithClickEvents: click opens the native file picker; keyboard users reach it via the hidden input's label semantics */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone; ARIA has no role for drag-and-drop targets and the hidden input is the accessible control */}
          <div
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              const files = Array.from(e.dataTransfer.files);
              if (files.length) void handleFiles(files);
            }}
            className={`mono cursor-pointer rounded-md border border-dashed px-3 py-8 text-center text-xs transition-colors ${
              over
                ? 'border-accent/50 bg-accent/5 text-accent'
                : 'border-border text-zinc-500 hover:text-zinc-300'
            }`}
          >
            Drop files here, or click to choose
            <input
              ref={inputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length) void handleFiles(files);
                e.target.value = '';
              }}
            />
          </div>

          {active && (
            <div className="flex items-center gap-2 text-xs">
              <span className="mono min-w-0 flex-1 truncate text-zinc-300">{active}</span>
              <Bar percent={Math.round(uploader.progress * 100)} />
              <span className="mono tnum shrink-0 text-[10px] text-zinc-500">
                {Math.round(uploader.progress * 100)}%
              </span>
            </div>
          )}

          {queue.length === 0 && !active ? (
            <Empty>No uploads yet.</Empty>
          ) : (
            <ul className="flex flex-col gap-1">
              {queue.map((item, i) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: queue rows are `{ name, status }` with no id and the same file can be re-uploaded; the index is the only stable disambiguator
                  key={`${item.name}-${i}`}
                  className="mono flex items-center justify-between gap-2 rounded-sm border border-border px-2 py-1 text-[11px]"
                >
                  <span className="min-w-0 flex-1 truncate text-zinc-300">{item.name}</span>
                  <span className={item.status === 'done' ? 's-ok' : 's-error'}>
                    {item.status === 'done' ? 'Uploaded' : 'Failed'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Panel>
    </section>
  );
}
