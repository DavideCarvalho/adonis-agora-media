import { useEffect, useState } from 'react';

export type Tab = 'browse' | 'uploads' | 'upload';

export interface Route {
  tab: Tab;
  disk?: string;
  prefix?: string;
}

const TABS: Tab[] = ['browse', 'uploads', 'upload'];

/** Parse `#/browse/{disk}?prefix={prefix}` into a {@link Route}. */
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const queryIndex = raw.indexOf('?');
  const pathPart = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  const queryPart = queryIndex === -1 ? '' : raw.slice(queryIndex + 1);
  const segments = pathPart.split('/').filter(Boolean);
  const tab = (segments[0] as Tab) ?? 'browse';
  const route: Route = { tab: TABS.includes(tab) ? tab : 'browse' };
  if (segments[1]) route.disk = decodeURIComponent(segments[1]);
  const query = new URLSearchParams(queryPart ?? '');
  const prefix = query.get('prefix');
  if (prefix) route.prefix = prefix;
  return route;
}

/** Build a hash string for a {@link Route}. */
export function toHash(route: Route): string {
  let path = `#/${route.tab}`;
  if (route.disk) path += `/${encodeURIComponent(route.disk)}`;
  if (route.prefix) path += `?prefix=${encodeURIComponent(route.prefix)}`;
  return path;
}

export function navigate(route: Route): void {
  window.location.hash = toHash(route);
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() =>
    parseHash(typeof window === 'undefined' ? '' : window.location.hash),
  );
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
