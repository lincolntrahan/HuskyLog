import { RemoveStreamButton } from '../tabs/RemoveStream';
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { provideMissing, saveSession, sessionName, useSession } from '../data/workspace';
import { estimatePack, packAndGo, trimBasis, type PackEstimate, type PackPhase, type VideoMode } from '../pack/packer';
import { checkForUpdatesNow } from './Updates';

/**
 * File menu (DESIGN §11): New, Open, Save, Save As, Pack & Go, plus the
 * "save changes?" prompt, the Pack & Go dialog and the missing-files banner.
 */
const fmtBytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

type Choice = 'save' | 'discard' | 'cancel';
const useAsk = create<{ open: boolean; resolve: ((c: Choice) => void) | null }>(() => ({ open: false, resolve: null }));
function askSave(): Promise<Choice> {
  return new Promise((resolve) => useAsk.setState({ open: true, resolve }));
}

/** Resolves true when it's fine to replace the current session. */
export async function confirmDiscard(): Promise<boolean> {
  if (!useSession.getState().dirty) return true;
  const c = await askSave();
  if (c === 'cancel') return false;
  if (c === 'save') return saveSession(false);
  return true;
}

export async function openPath(path: string): Promise<void> {
  if (!(await confirmDiscard())) return;
  const r = await window.huskylog.openWorkspace(path);
  if (r.error) useSession.setState({ error: r.error });
}
export async function openDialog(): Promise<void> {
  if (!(await confirmDiscard())) return;
  const p = await window.huskylog.pickWorkspace();
  if (p) await openPath(p);
}
export async function newSession(): Promise<void> {
  if (await confirmDiscard()) await window.huskylog.newWorkspace();
}

const usePackUi = create<{ open: boolean }>(() => ({ open: false }));

export function FileMenu() {
  const [menu, setMenu] = useState(false);
  const s = useSession();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 's') { e.preventDefault(); void saveSession(e.shiftKey); }
      else if (k === 'o') { e.preventDefault(); void openDialog(); }
      else if (k === 'n') { e.preventDefault(); void newSession(); }
    };
    window.addEventListener('keydown', onKey);
    const offOpen = window.huskylog.onOpenRequest((p) => void openPath(p));
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setMenu(false); };
    document.addEventListener('mousedown', onDoc);
    return () => { window.removeEventListener('keydown', onKey); offOpen(); document.removeEventListener('mousedown', onDoc); };
  }, []);

  const item = (label: string, keys: string, fn: () => void, title?: string) => (
    <button className="menu-item" title={title} onClick={() => { setMenu(false); fn(); }}><span>{label}</span><span className="muted">{keys}</span></button>
  );
  return (
    <div className="file-menu" ref={ref}>
      <button className={`menu-btn${menu ? ' on' : ''}`} onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu}>File ▾</button>
      {menu && (
        <div className="menu" role="menu">
          {item('New', 'Ctrl+N', () => void newSession())}
          {item('Open…', 'Ctrl+O', () => void openDialog(), 'Open a workspace (.hlws) or pack (.hlpack)')}
          {item('Save', 'Ctrl+S', () => void saveSession(false), s.kind === 'hlpack' ? 'Saves the workspace back into the open pack' : undefined)}
          {item('Save As…', 'Ctrl+Shift+S', () => void saveSession(true), 'Save as a workspace file (.hlws) that refers to your files where they are')}
          <div className="menu-sep" />
          {item('Pack & Go…', '', () => usePackUi.setState({ open: true }), 'One file with the logs, videos and maps of this session, to open on another computer')}
          <div className="menu-sep" />
          {item('Check for updates…', '', () => void checkForUpdatesNow(), 'Looks for a newer HuskyLog on GitHub')}
        </div>
      )}
      <span className="session-name" title={s.path ?? 'Not saved yet'}>
        {sessionName(s)}{s.kind === 'hlpack' ? ' (pack)' : ''}{s.dirty ? <span className="dirty" title="Unsaved changes"> ●</span> : null}
      </span>
      <AskSaveDialog />
      <PackDialog />
      {s.error && (
        <div className="toast err" role="alert">
          {s.error} <button onClick={() => useSession.setState({ error: null })}>×</button>
        </div>
      )}
    </div>
  );
}

function AskSaveDialog() {
  const { open, resolve } = useAsk();
  if (!open) return null;
  const done = (c: Choice) => { useAsk.setState({ open: false, resolve: null }); resolve?.(c); };
  return (
    <div className="modal-back">
      <div className="modal" role="dialog" aria-label="Unsaved changes">
        <p>Save changes to <b>{sessionName(useSession.getState())}</b> first?</p>
        <div className="modal-row">
          <button className="primary" onClick={() => done('save')} autoFocus>Save</button>
          <button onClick={() => done('discard')}>Don't save</button>
          <button onClick={() => done('cancel')}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function PackDialog() {
  const open = usePackUi((s) => s.open);
  const [mode, setMode] = useState<VideoMode>('full');
  const [maps, setMaps] = useState(true);
  const [est, setEst] = useState<PackEstimate | null>(null);
  const [estErr, setEstErr] = useState<string | null>(null);
  const [phase, setPhase] = useState<PackPhase | null>(null);
  const [result, setResult] = useState<{ path: string; bytes: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const signal = useRef({ cancelled: false });

  useEffect(() => {
    if (!open) return;
    let stale = false;
    setEst(null); setEstErr(null);
    estimatePack(mode, maps).then((e) => { if (!stale) setEst(e); }, (e: unknown) => { if (!stale) setEstErr(String(e)); });
    return () => { stale = true; };
  }, [open, mode, maps]);
  (window.__hl as Record<string, unknown>)['pack'] = { open: () => usePackUi.setState({ open: true }), getEstimate: () => est, getResult: () => result, getError: () => err, getPhase: () => phase };
  if (!open) return null;

  const close = () => { usePackUi.setState({ open: false }); setPhase(null); setResult(null); setErr(null); };
  const start = async () => {
    const name = sessionName(useSession.getState()).replace(/\.(hlws|hlpack)$/i, '');
    const out = await window.huskylog.pickPackPath(`${name === 'Untitled' ? 'session' : name}.hlpack`);
    if (!out) return;
    signal.current = { cancelled: false };
    setErr(null); setResult(null);
    setPhase({ phase: 'planning', fraction: 0, label: 'Starting…' });
    try {
      setResult(await packAndGo(out, mode, maps, setPhase, signal.current));
    } catch (e) {
      setErr(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));
    }
    setPhase(null);
  };
  const modes: [VideoMode, string, string][] = [
    ['full', 'Full videos', 'Originals, stored without recompression (fastest).'],
    ['trim', trimBasis()?.kind === 'selection' ? 'Trim to the selected range' : 'Trim to the synced range', `Stream copy (no quality loss) of ${trimBasis()?.kind === 'selection' ? 'the selected time range' : 'the part that overlaps the log'}, ± 5 s. Cuts at keyframes; sync stays exact.`],
    ['reencode', 'Re-encode smaller', 'H.264 at up to 720p, trimmed like above. Takes longer.'],
  ];
  return (
    <div className="modal-back">
      <div className="modal pack" role="dialog" aria-label="Pack & Go">
        <h3>Pack &amp; Go</h3>
        <p className="muted">One .hlpack file with this session's logs, videos, sync and windows. Double-click it on another computer to open it, offline.</p>
        <fieldset disabled={!!phase}>
          {modes.map(([m, label, note]) => (
            <label key={m} className="radio"><input type="radio" name="pack-mode" checked={mode === m} onChange={() => setMode(m)} /> <b>{label}</b> <span className="muted">{note}</span></label>
          ))}
          <label className="chk"><input type="checkbox" checked={maps} onChange={(e) => setMaps(e.target.checked)} /> Include offline map areas for these flights</label>
        </fieldset>
        <div className="pack-est">
          {estErr && <span className="err">{estErr}</span>}
          {!est && !estErr && <span className="muted">Estimating…</span>}
          {est && (
            <>
              <table className="files small">
                <tbody>
                  {est.perStream.map((p) => <tr key={p.id}><td>{p.name}</td><td>{fmtBytes(p.bytes)}</td><td className="muted">{p.note}</td></tr>)}
                  {maps && <tr><td>Maps</td><td>{fmtBytes(est.mapBytes)}</td><td className="muted">{est.mapAreas.length ? est.mapAreas.map((a) => a.name).join(', ') : 'no downloaded area covers these flights'}</td></tr>}
                </tbody>
              </table>
              <div><b>{est.exact ? '' : 'about '}{fmtBytes(est.bytes)}</b>{est.exact ? '' : ' (logs are compressed, so usually smaller)'}</div>
            </>
          )}
        </div>
        {phase && (
          <div className="pack-progress">
            <progress max={1} value={phase.fraction} /> <span className="small">{phase.label} · {(phase.fraction * 100).toFixed(0)} %</span>
          </div>
        )}
        {result && <div className="ok">Packed: {result.path} ({fmtBytes(result.bytes)})</div>}
        {err && <div className="err">{err}</div>}
        <div className="modal-row">
          {!phase && !result && <button className="primary" onClick={() => void start()} disabled={!est}>Pack…</button>}
          {phase && <button onClick={() => { signal.current.cancelled = true; }}>Cancel</button>}
          <button onClick={close} disabled={!!phase}>{result ? 'Done' : 'Close'}</button>
        </div>
      </div>
    </div>
  );
}

/** Banner for streams whose files were not found when the session opened. */
export function MissingFiles() {
  const missing = useSession((s) => s.missing);
  const [msg, setMsg] = useState<string | null>(null);
  if (!missing.length) return null;
  const locate = async (id: string) => {
    const m = missing.find((x) => x.id === id)!;
    const r = await window.huskylog.locateFile(m.ref.name, m.ref.size, m.ref.quickHash);
    if (!r) return;
    if (!r.matches && !window.confirm(`${r.file.name} is not the same file as the one saved in this workspace (size or content differs). Use it anyway?`)) return;
    provideMissing(id, r.file);
    setMsg(r.matches ? null : `${r.file.name} differs from the saved file; sync markers may not line up.`);
  };
  return (
    <div className="missing">
      <b>Some files of this workspace were not found.</b>
      {missing.map((m) => (
        <div key={m.id} className="missing-row">
          <span>{m.kind === 'log' ? 'Log' : 'Video'} <b>{m.ref.name}</b> <span className="muted">{fmtBytes(m.ref.size)}{m.ref.path ? ` · was ${m.ref.path}` : ''}</span></span>
          <button onClick={() => void locate(m.id)}>Locate…</button>
          <RemoveStreamButton id={m.id} />
        </div>
      ))}
      {msg && <div className="warn">{msg}</div>}
    </div>
  );
}
