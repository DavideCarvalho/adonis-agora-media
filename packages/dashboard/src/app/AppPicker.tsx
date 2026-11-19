import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import {
  AppModeBadge,
  actionsUnavailableReason,
  FederatedNotice,
} from '../agora-kit/blocks/app-mode';
import { ScopeMenu } from '../agora-kit/blocks/scope-menu';
import { subscribeHashUrl } from '../agora-kit/url-state/hash-url';
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

/**
 * The page's query string (`?app=` / `?tenant=`), kept current: a pick writes it with
 * `pushState` plus a `popstate`. The shell reads it so its cross-console links carry the new
 * scope right after a pick.
 */
export function usePageSearch(): string {
  return useSyncExternalStore(
    subscribeHashUrl,
    () => window.location.search,
    () => '',
  );
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

/** One of the other apps, as `/apps` lists it. */
export type PickerApp = AppPickerResponse['apps'][number];

/**
 * The other app the console shows now (`?app=`), as `/apps` lists it, or `undefined` for this app
 * (or before the server has answered for this URL).
 */
export function useSelectedApp(): PickerApp | undefined {
  const { picker, fresh } = useAppPicker();
  if (!fresh || !picker || !Array.isArray(picker.apps) || picker.selected == null) return undefined;
  return picker.apps.find((a) => a.id === picker.selected);
}

/**
 * Why the console's actions are off for the app shown now (a federated app that is read-only
 * here), or `undefined`. Action buttons show disabled with it instead of failing.
 */
export function useActionsUnavailable(): string | undefined {
  const app = useSelectedApp();
  return app ? actionsUnavailableReason(app.label, app) : undefined;
}

/** While a federated app is shown: whose data this is and who runs the actions on it. */
export function SelectedAppNotice() {
  const app = useSelectedApp();
  if (!app) return null;
  return (
    <FederatedNotice
      appLabel={app.label}
      mode={app.mode}
      actions={app.actions}
      className="mx-4 mt-5 md:mx-6 md:mt-6"
    />
  );
}

const APP_TEXT = {
  noun: 'App',
  search: 'Search apps',
  empty: 'No apps.',
};

/**
 * The topbar's "App" control (the federated console): whose media the console shows, in the kit's
 * searchable `ScopeMenu` (this app first, federated apps hinted, the shown app's mode badged next
 * to it). Nothing when the console shows only this app.
 */
export function AppPickerControl() {
  const { picker, fresh } = useAppPicker();
  const queryClient = useQueryClient();
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
  const currentApp = current === undefined ? undefined : picker.apps.find((a) => a.id === current);
  const local = picker.local.label;

  return (
    <div className="flex items-center gap-1.5" data-app-picker="">
      <ScopeMenu
        items={picker.apps.map((a) => ({
          id: a.id,
          label: a.label,
          ...(a.mode === 'federated' ? { hint: 'federated' } : {}),
        }))}
        // "Everything" here is this app: the option first, `?app=` absent.
        all
        current={current}
        text={{ ...APP_TEXT, all: local, some: local }}
        labelOf={(id) => picker.apps.find((a) => a.id === id)?.label ?? id}
        onChoose={writeAppToUrl}
      />
      {currentApp && (
        <AppModeBadge
          appLabel={currentApp.label}
          mode={currentApp.mode}
          actions={currentApp.actions}
          className="hidden sm:inline-flex"
        />
      )}
    </div>
  );
}
