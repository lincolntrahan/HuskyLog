import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChannelInfo } from '@core/dataflash/summary';
import { useLogs, type ChannelRef } from '../../data/logs';
import { useExpressions } from '../../data/expressions';

interface Item { stream: string; streamName: string; c: ChannelInfo; named?: string }

/** Fuzzy match: every space-separated token must appear; earlier/prefix hits rank higher. */
function score(hay: string, id: string, tokens: string[]): number | null {
  let s = 0;
  for (const tk of tokens) {
    const k = hay.indexOf(tk);
    if (k < 0) return null;
    s += k + (id.startsWith(tk) ? -50 : 0) + (hay.includes(`.${tk}`) ? -10 : 0);
  }
  return s;
}

export function ChannelPicker({ onPick, onClose, existing }: {
  onPick: (r: ChannelRef & { named?: boolean }, keepOpen: boolean) => void;
  onClose: () => void;
  existing: Set<string>;
}) {
  const logs = useLogs();
  const named = useExpressions((st) => st.named);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const items = useMemo<Item[]>(() => {
    const first = logs.order.find((id) => logs.logs[id]?.summary);
    const namedItems: Item[] = first ? Object.entries(named).map(([n, def]) => ({
      stream: first, streamName: logs.logs[first]!.name, named: def,
      c: { id: n, type: '', instance: null, field: n, unit: '', count: 0, rateHz: 0 },
    })) : [];
    return [...namedItems, ...logs.order.flatMap((id) => {
      const l = logs.logs[id]!;
      return (l.summary?.channels ?? []).map((c) => ({ stream: id, streamName: l.name, c }));
    })];
  }, [logs, named]);
  const multi = logs.order.length > 1;

  const matches = useMemo(() => {
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return items.slice(0, 200);
    const scored: [number, Item][] = [];
    for (const it of items) {
      const id = it.c.id.toLowerCase();
      const hay = `${id} ${(it.c.label ?? '').toLowerCase()} ${multi ? it.streamName.toLowerCase() : ''}`;
      const s = score(hay, id, tokens);
      if (s !== null) scored.push([s, it]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1].c.id.localeCompare(b[1].c.id, undefined, { numeric: true }));
    return scored.slice(0, 200).map((x) => x[1]);
  }, [q, items, multi]);

  useEffect(() => setSel(0), [q]);

  const pick = (it: Item | undefined, keep: boolean) => it && onPick({ stream: it.stream, id: it.c.id, named: !!it.named }, keep);

  return (
    <div className="picker" onKeyDown={(e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown') { setSel((s) => Math.min(matches.length - 1, s + 1)); e.preventDefault(); }
      if (e.key === 'ArrowUp') { setSel((s) => Math.max(0, s - 1)); e.preventDefault(); }
      if (e.key === 'Enter') pick(matches[sel], e.shiftKey);
    }}>
      <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search channels… e.g. att roll, imu1 accz, throttle" aria-label="Search channels" />
      <div className="picker-list" role="listbox">
        {items.length === 0 && <div className="muted pad">Load a .bin log on the Import tab first.</div>}
        {items.length > 0 && matches.length === 0 && <div className="muted pad">No channels match.</div>}
        {matches.map((it, k) => {
          const key = `${it.stream}|${it.c.id}`;
          return (
            <div key={key} role="option" aria-selected={k === sel} className={k === sel ? 'pick sel' : 'pick'}
              onMouseEnter={() => setSel(k)} onMouseDown={(e) => { e.preventDefault(); pick(it, e.shiftKey); }}>
              {it.named !== undefined && <span className="sug-kind k-named" title="Named expression">≡</span>}
              <span className="pick-id">{it.c.id}</span>
              {it.named !== undefined && <span className="pick-meta mono">{it.named}</span>}
              {it.c.label && <span className="pick-label">{it.c.label}</span>}
              {it.named === undefined && <span className="pick-meta">{it.c.unit || '—'} · {it.c.rateHz >= 1 ? `${Math.round(it.c.rateHz)} Hz` : `${it.c.count} pts`}{multi ? ` · ${it.streamName}` : ''}</span>}
              {existing.has(key) && <span className="pick-added">added</span>}
            </div>
          );
        })}
      </div>
      <div className="picker-hint muted">Enter or click to add · Shift to add and keep open · Esc to close</div>
    </div>
  );
}
