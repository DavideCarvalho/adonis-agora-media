import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
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

/** `?app=` as the URL has it now, following the picker and back/forward (`popstate`). */
export function useUrlApp(): string | undefined {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener('popstate', onChange);
      return () => window.removeEventListener('popstate', onChange);
    },
    selectedApp,
    () => undefined,
  );
}

/**
 * The selector's data: this app, then the other apps the console shows, and the app the server
 * actually serves for this URL (`selected`). Asked again whenever `?app=` changes.
 */
export function useAppPicker(): { picker: AppPickerResponse | undefined; fresh: boolean } {
  const { client } = useDashboard();
  const urlApp = useUrlApp();
  const { data, isPlaceholderData } = useQuery({
    queryKey: ['apps', urlApp ?? null],
    queryFn: () => client.apps(),
    staleTime: 5 * 60_000,
    refetchInterval: false,
    placeholderData: keepPreviousData,
  });
  return { picker: data, fresh: data !== undefined && !isPlaceholderData };
}

const chip =
  'mono flex h-7 items-center gap-1.5 rounded-md border border-line bg-panel-2 px-2 text-[11px] text-fg-2';

/**
 * The topbar's "App" control (the federated console): whose media the console shows. Nothing when
 * the console shows only this app.
 */
export function AppPickerControl() {
  const { picker, fresh } = useAppPicker();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const urlApp = useUrlApp();

  // The URL's app moved (a pick, or back/forward): every view's data belongs to the app left.
  const seen = useRef(urlApp);
  useEffect(() => {
    if (seen.current === urlApp) return;
    seen.current = urlApp;
    void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'apps' });
  }, [urlApp, queryClient]);

  // An older server has no `/apps`: nothing to pick either.
  if (!picker || !Array.isArray(picker.apps) || picker.apps.length === 0) return null;

  // The app the server serves for this URL (an unknown or ungranted `?app=` is none of the
  // listed ones), the URL's own value only until the server has answered for it.
  const current = fresh ? (picker.selected ?? undefined) : urlApp;
  const label =
    current === undefined
      ? picker.local.label
      : (picker.apps.find((a) => a.id === current)?.label ?? current);
  const choose = (app: string | undefined) => {
    setOpen(false);
    writeAppToUrl(app);
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
              onClick={() => choose(o.id)}
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
