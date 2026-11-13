import { useMediaUpload } from '@adonis-agora/media-react';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { PageHeader } from '../../agora-kit/blocks/page-header';
import { Panel } from '../../agora-kit/blocks/panel';
import { QueryBoundary } from '../../agora-kit/blocks/query-boundary';
import { PageBody } from '../../agora-kit/shell/app-shell';
import { Badge } from '../../agora-kit/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../agora-kit/ui/select';
import { Skeleton } from '../../agora-kit/ui/skeleton';
import { csrfHeader } from '../../client/dashboard-client';
import type { DiskInfo } from '../../types';
import { useDashboard } from '../context';
import { UploadIcon } from '../icons';
import { useDisks } from '../queries';
import { Bar, Empty, Field, useToasts } from '../ui';

interface QueueItem {
  name: string;
  status: 'done' | 'error';
}

/** The destination picker, presentational. */
function DiskSelect({
  disks,
  value,
  onChange,
}: {
  disks: DiskInfo[];
  value: string;
  onChange: (disk: string) => void;
}) {
  return (
    <Field id="upload-disk" label="Destination disk">
      <Select value={value} onValueChange={(next) => onChange(String(next ?? ''))}>
        <SelectTrigger id="upload-disk" size="sm" className="mono w-full max-w-xs text-[13px]">
          <SelectValue placeholder="(no disks)" />
        </SelectTrigger>
        <SelectContent>
          {disks.map((d) => (
            <SelectItem key={d.name} value={d.name} className="mono text-[13px]">
              {d.name}
              {d.default ? ' (default)' : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/** The drop zone, presentational: click or drop files to hand them to `onFiles`. */
function DropZone({ onFiles }: { onFiles: (files: File[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <button
      type="button"
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
        if (files.length) onFiles(files);
      }}
      className={`flex w-full flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-10 text-center transition-colors ${
        over
          ? 'border-brand-border bg-brand-soft text-brand'
          : 'border-line-strong text-dim hover:border-brand-border hover:text-fg'
      }`}
    >
      <span className="grid size-10 place-items-center rounded-md border border-border bg-panel-2 text-brand [&_svg]:size-4.5">
        <UploadIcon />
      </span>
      <span className="text-[13px] font-medium">Drop files here, or click to choose</span>
      <span className="text-[11px] text-faint">Uploaded one by one, resumable (TUS).</span>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) onFiles(files);
          e.target.value = '';
        }}
      />
    </button>
  );
}

/**
 * Upload (TRANSFERS) — `@adonis-agora/media-react`'s `useMediaUpload` (resumable TUS) against the
 * core upload routes. Files dropped or picked upload one after the other into the chosen disk; on
 * completion the library and uploads queries are invalidated so the new objects appear.
 * Container: owns the disk query, the uploader and the session's queue.
 */
export function UploadPanel() {
  const { bootstrap } = useDashboard();
  const disks = useDisks();
  const qc = useQueryClient();
  const { push } = useToasts();
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [active, setActive] = useState<string | null>(null);

  const browsable = useMemo(() => disks.data?.data ?? [], [disks.data]);
  const [disk, setDisk] = useState<string>('');
  const targetDisk = disk || browsable.find((d) => d.default)?.name || browsable[0]?.name || '';

  const uploader = useMediaUpload({
    mode: 'tus',
    baseUrl: '',
    tusPath: bootstrap.tusBase,
    uploadsPath: bootstrap.uploadsBase,
    // shield guards the core upload routes too; resolved per request so a rotated token is picked up.
    getHeaders: csrfHeader,
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

  const percent = Math.round(uploader.progress * 100);

  return (
    <PageBody className="max-w-3xl">
      <PageHeader
        title="Upload"
        description="Send files straight to a disk through the resumable upload routes."
      />
      <Panel title="New upload" description={targetDisk ? `into ${targetDisk}` : undefined}>
        <div className="flex flex-col gap-4">
          <QueryBoundary query={disks} label="Disks" skeleton={<Skeleton className="h-8 w-60" />}>
            {() => <DiskSelect disks={browsable} value={targetDisk} onChange={setDisk} />}
          </QueryBoundary>
          <DropZone onFiles={(files) => void handleFiles(files)} />
          {active && (
            <div className="flex items-center gap-3 text-xs">
              <span className="mono min-w-0 flex-1 truncate text-fg-2">{active}</span>
              <Bar percent={percent} />
              <span className="mono tnum shrink-0 text-[10.5px] text-faint">{percent}%</span>
            </div>
          )}
        </div>
      </Panel>
      <Panel
        title="This session"
        description={queue.length > 0 ? `${queue.length} files` : undefined}
      >
        {queue.length === 0 && !active ? (
          <Empty className="py-2">No uploads yet.</Empty>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {queue.map((item, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: queue rows are `{ name, status }` with no id and the same file can be re-uploaded; the index is the only stable disambiguator
                key={`${item.name}-${i}`}
                className="flex items-center justify-between gap-2 py-2 text-xs"
              >
                <span className="mono min-w-0 flex-1 truncate text-fg-2">{item.name}</span>
                <Badge variant={item.status === 'done' ? 'good' : 'destructive'}>
                  {item.status === 'done' ? 'Uploaded' : 'Failed'}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </PageBody>
  );
}
