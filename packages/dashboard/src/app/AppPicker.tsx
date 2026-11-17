import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '../agora-kit/ui/popover';
import { selectedApp } from '../client/dashboard-client';
import type { AppPickerResponse } from '../types';
import { useDashboard } from './context';
import { parseHash, toHash } from './hash-route';

/**
 * Put the picked app in the URL (`?app=`, absent = this app). The disk, folder, filters and open
 * detail belong to the app being left, so the page stays but the rest of its hash goes.
 */
export function writeAppToUrl(app: string | undefined): void {
  const url = new URL(window.location.href);
  if (app === undefined) url.searchParams.delete('app');
  else url.searchParams.set('app', app);
  url.hash = toHash({ tab: parseHash(url.hash).tab });
  window.history.pushState(null, '', url.toString());
  // A pushState fires nothing: tell the router and the URL-state adapter the URL moved.
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** The selector's data: this app, then the other apps the console shows. */
export function useAppPicker(): AppPickerResponse | undefined {
  const { client } = useDashboard();
  const { data } = useQuery({
    queryKey: ['apps'],
    queryFn: () => client.apps(),
    staleTime: 5 * 60_000,
    refetchInterval: false,
  });
  return data;
}

const chip =
  'mono flex h-7 items-center gap-1.5 rounded-md border border-line bg-panel-2 px-2 text-[11px] text-fg-2';

/**
 * The topbar's "App" control (the federated console): whose media the console shows. Nothing when
 * the console shows only this app.
 */
export function AppPickerControl() {
  const picker = useAppPicker();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState(selectedApp);

  // An older server has no `/apps`: nothing to pick either.
  if (!picker || !Array.isArray(picker.apps) || picker.apps.length === 0) return null;

  const label =
    current === undefined
      ? picker.local.label
      : (picker.apps.find((a) => a.id === current)?.label ?? current);
  const choose = async (app: string | undefined) => {
    setOpen(false);
    writeAppToUrl(app);
    setCurrent(app);
    await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'apps' });
  };
  const options: Array<{ id: string | undefined; label: string }> = [
    { id: undefined, label: picker.local.label },
    ...picker.apps,
  ];
  const option =
    'flex w-full flex-col rounded px-2 py-1.5 text-left text-xs text-fg hover:bg-hover aria-selected:bg-brand-soft';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={`${chip} max-w-64 hover:border-line-strong`}
        aria-label="App"
        data-app-picker=""
      >
        <span className="hidden text-faint sm:inline">App</span>
        <span className="truncate">{label}</span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 gap-1 p-1">
        <div role="listbox" aria-label="Apps" className="max-h-72 overflow-y-auto">
          {options.map((o) => (
            <button
              key={o.id ?? ''}
              type="button"
              role="option"
              aria-selected={current === o.id}
              onClick={() => void choose(o.id)}
              className={option}
            >
              <span className="truncate">{o.label}</span>
              {o.id !== undefined && o.label !== o.id && (
                <span className="mono truncate text-[10px] text-faint">{o.id}</span>
              )}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
