import { useEffect, useState } from 'react';
import { useApp, type AppTab } from './store';
import { ImportTab } from './tabs/ImportTab';
import { SyncTab } from './tabs/SyncTab';
import { ReviewTab } from './tabs/ReviewTab';
import { FileMenu } from './workspace/FileMenu';
import { UpdateNotice } from './workspace/Updates';

const TABS: { id: AppTab; label: string }[] = [
  { id: 'import', label: 'Import' },
  { id: 'sync', label: 'Sync' },
  { id: 'review', label: 'Review' },
];

export function App() {
  const { tab, setTab } = useApp();
  const [blocked, setBlocked] = useState(0);
  const [version, setVersion] = useState('');

  useEffect(() => {
    void window.huskylog.info().then((i) => setVersion(i.version));
    const id = setInterval(() => void window.huskylog.blockedRequests().then((b) => setBlocked(b.length)), 2000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">HuskyLog</div>
        <FileMenu />
        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'tab active' : 'tab'} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="content">
        {/* Review stays mounted when hidden so docked and popped-out windows keep their state. */}
        <section className="pane" hidden={tab !== 'import'}><ImportTab /></section>
        <section className="pane" hidden={tab !== 'sync'}><SyncTab /></section>
        <section className="pane" hidden={tab !== 'review'}><ReviewTab /></section>
      </main>
      <footer className="statusbar">
        <span className="status-left"><span>v{version}</span><UpdateNotice /></span>
        <span className="offline" title="All network access is blocked except explicit map downloads">
          ● Offline mode{blocked ? ` — ${blocked} request(s) blocked` : ''}
        </span>
      </footer>
    </div>
  );
}
