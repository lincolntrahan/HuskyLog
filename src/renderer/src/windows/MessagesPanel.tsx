import { useEffect, useMemo, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { LogEvent } from '@core/dataflash/summary';
import { primaryLog, useLogs } from '../data/logs';
import { fmtTime, useTimeline } from '../data/timeline';

const KINDS: LogEvent['kind'][] = ['MSG', 'MODE', 'EV', 'ARM', 'ERR'];

/** Filterable list of log messages, modes, events and arming. Click to jump. */
export function MessagesPanel(_props: IDockviewPanelProps) {
  useLogs((s) => s.logs); // re-render when logs load
  const log = primaryLog();
  const [q, setQ] = useState('');
  const [kinds, setKinds] = useState<Set<LogEvent['kind']>>(new Set(KINDS));
  const t = useTimeline((s) => s.t);
  const listRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    const ql = q.toLowerCase();
    return (log?.summary?.events ?? []).filter((e) => kinds.has(e.kind) && (!ql || e.text.toLowerCase().includes(ql)));
  }, [log?.summary, q, kinds]);

  // Highlight the latest event at or before the playhead.
  let current = -1;
  for (let i = 0; i < rows.length && rows[i]!.t <= t; i++) current = i;
  useEffect(() => {
    if (useTimeline.getState().playing) listRef.current?.querySelector('.cur')?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  if (!log?.summary) return <div className="hl-panel"><div className="placeholder">Load a .bin log on the Import tab.</div></div>;
  return (
    <div className="hl-panel table-panel">
      <div className="graph-bar">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" aria-label="Filter messages" />
        {KINDS.map((k) => (
          <label key={k} className="chk">
            <input type="checkbox" checked={kinds.has(k)} onChange={(e) => {
              const n = new Set(kinds);
              if (e.target.checked) n.add(k); else n.delete(k);
              setKinds(n);
            }} /> {k}
          </label>
        ))}
        <span className="muted">{rows.length} rows</span>
      </div>
      <div className="table-scroll" ref={listRef}>
        <table className="grid">
          <thead><tr><th style={{ width: 90 }}>Time</th><th style={{ width: 60 }}>Type</th><th>Text</th></tr></thead>
          <tbody>
            {rows.map((e, i) => (
              <tr key={i} className={`${i === current ? 'cur ' : ''}k-${e.kind}`} onClick={() => useTimeline.getState().setT(e.t)}>
                <td className="mono">{fmtTime(e.t)}</td><td>{e.kind}</td><td>{e.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
