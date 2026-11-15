import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { UpdateStatus } from '../../../shared/ipc';
import { confirmDiscard } from './FileMenu';

/** Update status from the main process (electron-updater). */
export const useUpdate = create<{ s: UpdateStatus | null; toast: string | null }>(() => ({ s: null, toast: null }));

export async function checkForUpdatesNow(): Promise<void> {
  useUpdate.setState({ toast: 'Checking for updates…' });
  const s = await window.huskylog.checkForUpdates();
  if (s.state === 'disabled') useUpdate.setState({ toast: 'Updates are off in development builds.' });
  else if (s.state === 'current') useUpdate.setState({ toast: `HuskyLog ${s.version} is up to date.` });
  else if (s.state === 'error') useUpdate.setState({ toast: s.error ?? 'Update check failed.' });
  else useUpdate.setState({ toast: null }); // downloading/ready: the status bar shows it
}

export async function restartToUpdate(): Promise<void> {
  if (!(await confirmDiscard())) return;
  await window.huskylog.installUpdate();
}

/** Status-bar notice: downloading / ready to install / results of a manual check. */
export function UpdateNotice() {
  const { s, toast } = useUpdate();
  const [notesOpen, setNotesOpen] = useState(false);
  useEffect(() => {
    void window.huskylog.updateStatus().then((x) => useUpdate.setState({ s: x }));
    return window.huskylog.onUpdateStatus((x) => {
      useUpdate.setState({ s: x });
      if (x.manual && x.state === 'current') useUpdate.setState({ toast: `HuskyLog ${x.version} is up to date.` });
      if (x.manual && x.state === 'error') useUpdate.setState({ toast: x.error ?? 'Update check failed.' });
    });
  }, []);
  useEffect(() => {
    if (!toast || toast.startsWith('Checking')) return;
    const id = window.setTimeout(() => useUpdate.setState({ toast: null }), 6000);
    return () => window.clearTimeout(id);
  }, [toast]);
  (window.__hl as Record<string, unknown>)['update'] = { get: () => useUpdate.getState() };

  return (
    <span className="update-notice">
      {s?.state === 'downloading' && <span className="muted" title={s.notes}>Downloading HuskyLog {s.available} · {Math.round(s.percent ?? 0)} %</span>}
      {s?.state === 'ready' && (
        <span className="update-ready">
          HuskyLog {s.available} is ready.
          {s.notes && <button className="linkish" onClick={() => setNotesOpen((o) => !o)}>What's new</button>}
          <button className="primary" onClick={() => void restartToUpdate()}>Restart to update</button>
        </span>
      )}
      {toast && <span className="muted">{toast}</span>}
      {notesOpen && s?.notes && (
        <div className="update-notes" role="dialog" aria-label="Release notes">
          <b>What's new in {s.available}</b>
          <pre>{s.notes.replace(/<[^>]+>/g, '')}</pre>
          <button onClick={() => setNotesOpen(false)}>Close</button>
        </div>
      )}
    </span>
  );
}
