import { useMemo, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { paramChanges, paramsAt } from '@core/dataflash/summary';
import { primaryLog, useLogs } from '../data/logs';
import { fmtTime, useTimeline } from '../data/timeline';

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : String(+v.toPrecision(7)));

/** Parameters at the playhead time, non-default filter, in-flight change list, .param export. */
export function ParamsPanel(_props: IDockviewPanelProps) {
  useLogs((s) => s.logs);
  const log = primaryLog();
  const t = useTimeline((s) => s.t);
  const [q, setQ] = useState('');
  const [nonDefault, setNonDefault] = useState(false);
  const [view, setView] = useState<'values' | 'changes'>('values');
  const [housekeeping, setHousekeeping] = useState(false);
  const params = log?.summary?.params ?? [];

  // Bucket the playhead to 1 s so scrubbing does not recompute 1000+ rows every frame.
  const tb = Math.floor(t);
  const current = useMemo(() => [...paramsAt(params, tb + 0.999).values()].sort((a, b) => a.name.localeCompare(b.name)), [params, tb]);
  const changes = useMemo(() => paramChanges(params, housekeeping), [params, housekeeping]);
  const ql = q.toUpperCase();

  if (!log?.summary) return <div className="hl-panel"><div className="placeholder">Load a .bin log on the Import tab.</div></div>;

  const exportParam = () => {
    const text = current.map((p) => `${p.name},${fmt(p.value)}`).join('\r\n') + '\r\n';
    void window.huskylog.saveText(`${log.name}.param`, text, [{ name: 'ArduPilot parameters', extensions: ['param', 'parm'] }]);
  };
  const shown = current.filter((p) => (!ql || p.name.includes(ql)) && (!nonDefault || (p.default !== null && p.value !== p.default)));

  return (
    <div className="hl-panel table-panel">
      <div className="graph-bar">
        <button className={view === 'values' ? 'primary' : ''} onClick={() => setView('values')}>Values</button>
        <button className={view === 'changes' ? 'primary' : ''} onClick={() => setView('changes')}>Changes ({changes.length})</button>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" aria-label="Search parameters" />
        {view === 'values' ? (
          <>
            <label className="chk"><input type="checkbox" checked={nonDefault} onChange={(e) => setNonDefault(e.target.checked)} /> Non-default only</label>
            <span className="muted">{shown.length} at {fmtTime(t)}</span>
            <button onClick={exportParam}>Export .param…</button>
          </>
        ) : (
          <label className="chk"><input type="checkbox" checked={housekeeping} onChange={(e) => setHousekeeping(e.target.checked)} /> Include automatic (STAT_, BARO_GND…)</label>
        )}
      </div>
      <div className="table-scroll">
        {view === 'values' ? (
          <table className="grid">
            <thead><tr><th>Name</th><th>Value</th><th>Default</th></tr></thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.name} className={p.default !== null && p.value !== p.default ? 'nondef' : ''}>
                  <td className="mono">{p.name}</td><td className="mono">{fmt(p.value)}</td><td className="mono muted">{p.default === null ? '' : fmt(p.default)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="grid">
            <thead><tr><th style={{ width: 90 }}>Time</th><th>Name</th><th>From</th><th>To</th></tr></thead>
            <tbody>
              {changes.filter((c) => !ql || c.name.includes(ql)).map((c, i) => (
                <tr key={i} onClick={() => useTimeline.getState().setT(c.t)}>
                  <td className="mono">{fmtTime(c.t)}</td><td className="mono">{c.name}</td><td className="mono">{fmt(c.from)}</td><td className="mono">{fmt(c.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
