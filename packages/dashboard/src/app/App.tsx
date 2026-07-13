import type { Tab } from './hash-route';
import { toHash, useHashRoute } from './hash-route';
import { useTopology } from './queries';
import { Dot } from './ui';
import { CollectionsView } from './views/CollectionsView';
import { LibraryBrowseView } from './views/LibraryBrowseView';
import { UploadPanel } from './views/UploadPanel';
import { UploadsView } from './views/UploadsView';

const TABS: { id: Tab; label: string }[] = [
  { id: 'browse', label: 'Library' },
  { id: 'collections', label: 'Collections' },
  { id: 'uploads', label: 'Uploads' },
  { id: 'upload', label: 'Upload' },
];

export function App() {
  const route = useHashRoute();
  const topology = useTopology();

  return (
    <div className="app">
      <header className="app-header">
        <span className="brand">
          <span className="brand-dot" aria-hidden />
          Media · Agora
        </span>
        <nav className="tabs">
          {TABS.map((t) => (
            <a
              key={t.id}
              className={`tab${route.tab === t.id ? ' active' : ''}`}
              href={toHash({ tab: t.id })}
            >
              {t.label}
            </a>
          ))}
        </nav>
        <span className="header-spacer" />
        <span className="topo">
          <span>{topology.data?.disks ?? '—'} disks</span>
          <span className="row-name">
            <Dot tone={topology.data?.hasUploads ? 'ok' : 'idle'} /> uploads
          </span>
          <span className="row-name">
            <Dot tone={topology.data?.actions ? 'ok' : 'idle'} /> actions
          </span>
        </span>
      </header>

      <main className="app-main">
        {route.tab === 'browse' && (
          <LibraryBrowseView
            {...(route.disk ? { disk: route.disk } : {})}
            {...(route.prefix ? { prefix: route.prefix } : {})}
          />
        )}
        {route.tab === 'collections' && <CollectionsView />}
        {route.tab === 'uploads' && <UploadsView />}
        {route.tab === 'upload' && <UploadPanel />}
      </main>
    </div>
  );
}
