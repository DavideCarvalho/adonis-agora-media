import { AuthScreen } from './AuthScreen';
import type { Tab } from './hash-route';
import { toHash, useHashRoute } from './hash-route';
import { useLogout, useMe, useTopology } from './queries';
import { Button, Dot } from './ui';
import { CollectionsView } from './views/CollectionsView';
import { LibraryBrowseView } from './views/LibraryBrowseView';
import { UploadPanel } from './views/UploadPanel';
import { UploadsView } from './views/UploadsView';

const TABS: { id: Tab; label: string }[] = [
  { id: 'browse', label: 'library' },
  { id: 'collections', label: 'collections' },
  { id: 'uploads', label: 'uploads' },
  { id: 'upload', label: 'upload' },
];

/** The media brand mark — three stacked media layers (an object store / gallery), in currentColor so
 *  it inherits the console accent. Ported verbatim from the NestJS sibling console's `App.tsx`. */
function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role="img"
      aria-label="media"
    >
      <title>media</title>
      <path d="M12 3 21 7.5 12 12 3 7.5z" opacity={0.9} />
      <path d="M3 12l9 4.5L21 12" opacity={0.55} />
      <path d="M3 16.5 12 21l9-4.5" opacity={0.3} />
    </svg>
  );
}

export function App() {
  const route = useHashRoute();
  const me = useMe();
  const logout = useLogout();
  const authed = me.data?.state === 'authenticated';
  const topology = useTopology({ enabled: me.data !== undefined && me.data.state !== 'login' });

  if (me.data?.state === 'login') return <AuthScreen modes={me.data.modes} />;

  const stat = (label: string, on: boolean) => (
    <span
      className={`mono flex items-center gap-1 text-[10px] ${on ? 'text-zinc-400' : 'text-zinc-700'}`}
    >
      <Dot tone={on ? 'ok' : 'idle'} />
      {label}
    </span>
  );

  return (
    <>
      <div className="app-bg" />
      <div className="relative z-10 flex h-full flex-col">
        <header className="z-10 flex items-center gap-4 border-b border-border px-5 py-3">
          <div className="flex items-center gap-2.5">
            <div className="grid h-7 w-7 place-items-center rounded-md border border-accent/30 bg-accent/10">
              <LogoMark className="h-4 w-4 text-accent" />
            </div>
            <div className="leading-none">
              <div className="text-sm font-semibold tracking-tight">media</div>
              <div className="mono text-[10px] uppercase tracking-[0.2em] text-zinc-600">agora</div>
            </div>
          </div>

          <nav className="ml-2 flex flex-wrap items-center gap-1">
            {TABS.map((tab) => (
              <Button
                key={tab.id}
                tone={route.tab === tab.id ? 'selected' : 'quiet'}
                className="px-2.5 py-1 text-xs uppercase tracking-wide"
                render={<a href={toHash({ tab: tab.id })}>{tab.label}</a>}
              />
            ))}
          </nav>

          {topology.data && (
            <div className="ml-auto flex items-center gap-3">
              <span className="mono tnum text-[10px] text-zinc-500">
                {topology.data.disks} {topology.data.disks === 1 ? 'disk' : 'disks'}
              </span>
              {stat('uploads', topology.data.hasUploads)}
              {stat('actions', topology.data.actions)}
              <span className="ml-1 flex items-center gap-1.5 text-xs text-zinc-500">
                <Dot tone="ok" pulse />
                live
              </span>
              {authed && (
                <Button
                  tone="ghost"
                  onClick={() => logout.mutate()}
                  className="ml-1 text-[10px] uppercase tracking-wider"
                >
                  {me.data?.state === 'authenticated' && me.data.user.name
                    ? `sign out · ${me.data.user.name}`
                    : 'sign out'}
                </Button>
              )}
            </div>
          )}
        </header>

        <main className="min-h-0 flex-1 overflow-auto p-6">
          {route.tab === 'browse' && (
            <LibraryBrowseView
              {...(route.disk ? { disk: route.disk } : {})}
              {...(route.prefix ? { prefix: route.prefix } : {})}
            />
          )}
          {route.tab === 'collections' && <CollectionsView route={route} />}
          {route.tab === 'uploads' && <UploadsView route={route} />}
          {route.tab === 'upload' && <UploadPanel />}
        </main>
      </div>
    </>
  );
}
