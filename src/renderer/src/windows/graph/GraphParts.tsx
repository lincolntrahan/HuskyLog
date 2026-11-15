import { useEffect, useState } from 'react';
import { rangeStats, toCsv, type TimeBase } from '@core/series/series';
import { fmtTime } from '../../data/timeline';
import { BUILTIN_PRESETS, cfgFromPreset, parsePreset, presetFromCfg, type GraphCfg, type GraphPreset } from './model';
import type { ResolvedSeries } from './GraphPanel';
import { requirements } from '@core/expr/evaluate';
import { useExpressions } from '../../data/expressions';

/** Named expressions used (directly or indirectly) by a graph's expression series. */
function namedUsedBy(cfg: GraphCfg): Record<string, string> {
  const all = useExpressions.getState().named;
  const out: Record<string, string> = {};
  for (const s of cfg.series) {
    if (s.kind !== 'expr') continue;
    try { for (const n of requirements(s.id, all).names) out[n] = all[n]!; } catch { /* broken expression: skip */ }
  }
  return out;
}

const num = (v: number) => (Number.isNaN(v) ? '–' : Math.abs(v) >= 1000 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(3) : v.toPrecision(4));
const colName = (r: ResolvedSeries) => `${r.label}${r.data?.unit ? ` [${r.data.unit}]` : ''}`;

/** Mean / std dev / min / max per series over the global selection (raw samples, not decimated). */
export function StatsTable({ series, range }: { series: ResolvedSeries[]; range: [number, number] }) {
  const rows = series.map((r) => ({ r, s: rangeStats(r.data!, range[0], range[1]) }));
  const copy = () => {
    const head = ['series', 'unit', 'mean', 'std', 'min', 't_min', 'max', 't_max', 'n'].join('\t');
    const lines = rows.map(({ r, s }) => [r.label, r.data!.unit, s.mean, s.std, s.min, s.tMin, s.max, s.tMax, s.n].join('\t'));
    void navigator.clipboard.writeText([head, ...lines].join('\n'));
  };
  return (
    <div className="stats">
      <table>
        <thead>
          <tr><th>Series</th><th>Mean</th><th>Std dev</th><th>Min</th><th>Max (peak)</th><th>Samples</th><th><button onClick={copy} title="Copy as tab-separated text">Copy</button></th></tr>
        </thead>
        <tbody>
          {rows.map(({ r, s }) => (
            <tr key={r.ref.stream + r.ref.id}>
              <td><span className="dot" style={{ background: r.cfg.color }} />{r.label}</td>
              <td>{num(s.mean)} {r.data!.unit}</td>
              <td>{num(s.std)}</td>
              <td title={`at ${fmtTime(s.tMin)}`}>{num(s.min)}</td>
              <td title={`at ${fmtTime(s.tMax)}`}>{num(s.max)}</td>
              <td>{s.n}</td>
              <td />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ExportDialog({ series, range, logName, onClose }: { series: ResolvedSeries[]; range: [number, number]; logName: string; onClose: () => void }) {
  const [kind, setKind] = useState<TimeBase['kind']>('fastest');
  const [hz, setHz] = useState(50);
  const [status, setStatus] = useState('');
  const doExport = async () => {
    const base: TimeBase = kind === 'fixed' ? { kind, hz } : { kind };
    const csv = toCsv(series.map((r) => ({ name: colName(r), series: r.data! })), range[0], range[1], base);
    const name = `${logName}_${range[0].toFixed(1)}-${range[1].toFixed(1)}s.csv`;
    const path = await window.huskylog.saveText(name, csv, [{ name: 'CSV', extensions: ['csv'] }]);
    if (path) { setStatus(`Saved ${path}`); setTimeout(onClose, 900); }
  };
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Export CSV">
        <h3>Export selection as CSV</h3>
        <p className="muted">{fmtTime(range[0])} → {fmtTime(range[1])} · {series.length} column(s) plus <code>time_s</code></p>
        <label className="radio"><input type="radio" checked={kind === 'fastest'} onChange={() => setKind('fastest')} /> Timestamps of the fastest series (others interpolated)</label>
        <label className="radio"><input type="radio" checked={kind === 'fixed'} onChange={() => setKind('fixed')} /> Fixed rate <input type="number" min={0.1} max={10000} value={hz} onChange={(e) => setHz(Number(e.target.value))} style={{ width: 70 }} /> Hz</label>
        <label className="radio"><input type="radio" checked={kind === 'union'} onChange={() => setKind('union')} /> Every timestamp from every series</label>
        <div className="modal-actions">
          <span className="muted">{status}</span>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => void doExport()} disabled={kind === 'fixed' && !(hz > 0)}>Save CSV…</button>
        </div>
      </div>
    </div>
  );
}

export function PresetMenu({ cfg, onApply }: { cfg: GraphCfg; onApply: (c: GraphCfg) => void }) {
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState<GraphPreset[]>([]);
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const reload = () => window.huskylog.listPresets().then((files) => {
    const ok: GraphPreset[] = [];
    for (const f of files) { try { ok.push({ ...parsePreset(f.json), name: f.name }); } catch { /* skip bad files */ } }
    setUser(ok.sort((a, b) => a.name.localeCompare(b.name)));
  });
  useEffect(() => { if (open) void reload(); }, [open]);

  const apply = (p: GraphPreset) => {
    if (p.named) useExpressions.getState().mergeNamed(p.named);
    onApply(cfgFromPreset(p));
    setOpen(false);
  };
  const save = async () => {
    if (!name.trim()) return;
    await window.huskylog.savePreset(name.trim(), JSON.stringify(presetFromCfg(name.trim(), cfg, namedUsedBy(cfg)), null, 2));
    setName('');
    await reload();
  };
  const importFile = async () => {
    const f = await window.huskylog.openText([{ name: 'HuskyLog preset', extensions: ['json'] }]);
    if (!f) return;
    try {
      const p = parsePreset(f.content);
      await window.huskylog.savePreset(p.name, JSON.stringify(p, null, 2));
      await reload();
      setErr('');
    } catch (e) { setErr(String(e)); }
  };
  const exportFile = (p: GraphPreset) =>
    window.huskylog.saveText(`${p.name}.json`, JSON.stringify(p, null, 2), [{ name: 'HuskyLog preset', extensions: ['json'] }]);

  return (
    <div className="menu-wrap">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open}>Presets ▾</button>
      {open && (
        <div className="menu" onMouseLeave={() => setOpen(false)}>
          <div className="menu-head">Built-in</div>
          {BUILTIN_PRESETS.map((p) => <div key={p.name} className="menu-item" onClick={() => apply(p)}>{p.name}</div>)}
          <div className="menu-head">Saved</div>
          {user.length === 0 && <div className="menu-item muted">None yet</div>}
          {user.map((p) => (
            <div key={p.name} className="menu-item row">
              <span onClick={() => apply(p)}>{p.name}</span>
              <span className="menu-actions">
                <button title="Export to a file to share" onClick={() => void exportFile(p)}>⇩</button>
                <button title="Delete" onClick={() => void window.huskylog.deletePreset(p.name).then(reload)}>×</button>
              </span>
            </div>
          ))}
          <div className="menu-sep" />
          <div className="menu-row">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Save current as…" onKeyDown={(e) => e.key === 'Enter' && void save()} aria-label="Preset name" />
            <button onClick={() => void save()} disabled={!name.trim() || cfg.series.length === 0}>Save</button>
          </div>
          <div className="menu-item" onClick={() => void importFile()}>Import preset file…</div>
          {err && <div className="menu-item err">{err}</div>}
        </div>
      )}
    </div>
  );
}
