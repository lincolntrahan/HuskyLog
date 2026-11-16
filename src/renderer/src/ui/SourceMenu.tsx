import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChannelInfo } from '@core/dataflash/summary';
import { channelExists, useLogs } from '../data/logs';
import { useExpressions } from '../data/expressions';
import { HIDDEN_TYPES, QUICK_PICKS, SPECIALS } from './quickPicks';

/**
 * Cascading source menu ("ladder"): hover ATT ▸ to get its fields, IMU ▸
 * IMU[1] ▸ AccZ for multi-instance messages. Organised like UAV Log Viewer:
 * presets on top, then message types A–Z, fields with units, plumbing
 * types hidden. Every column scrolls; a filter box flattens the tree.
 */
export interface PickedSource { source: string; label: string; unit?: string; format?: string }

interface MNode {
  key: string;
  label: string;
  hint?: string;        // muted text on the right (unit, count, label)
  title?: string;
  children?: MNode[];
  pick?: PickedSource;
}

const MAX_FILTER = 300;

function buildTree(channels: ChannelInfo[], named: Record<string, string>, stream: string | undefined, specials: boolean): MNode[] {
  const has = (id: string) => !!stream && channelExists({ stream, id });
  const top: MNode[] = [];
  // Presets (folders), only those this log can show.
  const folders = new Map<string, MNode[]>();
  for (const q of QUICK_PICKS) {
    if (!q.channels.every(has)) continue;
    const list = folders.get(q.folder) ?? [];
    list.push({ key: `p:${q.name}`, label: q.name, hint: q.unit, title: q.source, pick: { source: q.source, label: q.name.replace(/ \(.*\)$/, ''), unit: q.unit, format: q.format } });
    folders.set(q.folder, list);
  }
  if (folders.size) top.push({ key: 'presets', label: '★ Presets', children: [...folders].map(([f, items]) => ({ key: `pf:${f}`, label: f, hint: String(items.length), children: items })) });
  const names = Object.keys(named).sort((a, b) => a.localeCompare(b));
  if (names.length) top.push({ key: 'named', label: 'ƒ Named expressions', hint: String(names.length), children: names.map((n) => ({ key: `n:${n}`, label: n, title: named[n], pick: { source: n, label: n } })) });
  if (specials) top.push({ key: 'special', label: '⚑ Flight state', children: SPECIALS.map((s) => ({ key: `s:${s.source}`, label: s.name, hint: s.source, pick: { source: s.source, label: s.name.split(' ')[0]!, format: '' } })) });

  // Message types A–Z; instances as a sub-level when there are several.
  const byType = new Map<string, Map<string, ChannelInfo[]>>();
  for (const c of channels) {
    if (HIDDEN_TYPES.has(c.type) || c.field === 'TimeUS' || c.field === 'TimeMS') continue;
    const inst = byType.get(c.type) ?? new Map<string, ChannelInfo[]>();
    const k = c.instance === null ? '' : String(c.instance);
    inst.set(k, [...(inst.get(k) ?? []), c]);
    byType.set(c.type, inst);
  }
  const fieldNode = (c: ChannelInfo): MNode => ({
    key: `c:${c.id}`, label: c.field,
    hint: [c.label, c.unit].filter(Boolean).join(' · '),
    title: `${c.id}${c.label ? ` (${c.label})` : ''}${c.unit ? ` [${c.unit}]` : ''} · ${c.rateHz ? `${c.rateHz.toFixed(c.rateHz < 10 ? 1 : 0)} Hz` : ''}`,
    pick: { source: c.id, label: c.label ?? c.field, unit: c.unit || undefined },
  });
  const types = [...byType.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const t of types) {
    const inst = byType.get(t)!;
    const keys = [...inst.keys()].sort((a, b) => Number(a) - Number(b));
    if (keys.length === 1) {
      const fields = inst.get(keys[0]!)!;
      top.push({ key: `t:${t}`, label: keys[0] ? `${t}[${keys[0]}]` : t, hint: String(fields.length), children: fields.map(fieldNode) });
    } else {
      top.push({ key: `t:${t}`, label: t, hint: `${keys.length} ×`, children: keys.map((k) => ({ key: `i:${t}[${k}]`, label: `${t}[${k}]`, hint: String(inst.get(k)!.length), children: inst.get(k)!.map(fieldNode) })) });
    }
  }
  return top;
}

function flatten(nodes: MNode[], out: { node: MNode; path: string }[] = [], path = ''): { node: MNode; path: string }[] {
  for (const n of nodes) {
    if (n.pick) out.push({ node: n, path });
    if (n.children) flatten(n.children, out, n.key.startsWith('t:') || n.key.startsWith('i:') ? n.label : path);
  }
  return out;
}

export function SourceMenu({ stream, value, onPick, specials = true, placeholder = 'Choose…', ariaLabel, compact = false }: {
  stream: string | undefined;
  value?: string;
  onPick: (p: PickedSource) => void;
  specials?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  /** Just a ▾ button (next to a text field that shows the value). */
  compact?: boolean;
}) {
  const logs = useLogs();
  const named = useExpressions((s) => s.named);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const tree = useMemo(() => buildTree(stream ? logs.logs[stream]?.summary?.channels ?? [] : [], named, stream, specials), [stream, logs.logs, named, specials]);
  return (
    <>
      <button ref={btn} type="button" className={`source-btn${compact ? ' compact' : ''}`} aria-label={ariaLabel} aria-haspopup="menu" aria-expanded={open} title={value || placeholder}
        onClick={() => setOpen((o) => !o)}>
        {!compact && <span className="source-val">{value || <span className="muted">{placeholder}</span>}</span>}<span className="caret">▾</span>
      </button>
      {open && btn.current && createPortal(
        <Cascade anchor={btn.current} tree={tree} onClose={() => setOpen(false)} onPick={(p) => { setOpen(false); onPick(p); }} />,
        btn.current.ownerDocument.body,
      )}
    </>
  );
}

function Cascade({ anchor, tree, onClose, onPick }: { anchor: HTMLElement; tree: MNode[]; onClose: () => void; onPick: (p: PickedSource) => void }) {
  const doc = anchor.ownerDocument, win = doc.defaultView ?? window;
  const [path, setPath] = useState<{ key: string; top: number }[]>([]);
  const [filter, setFilter] = useState('');
  const [hi, setHi] = useState<{ col: number; idx: number }>({ col: 0, idx: -1 });
  const root = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const hoverTimer = useRef<number | undefined>(undefined);
  const r = anchor.getBoundingClientRect();
  const [origin, setOrigin] = useState({ left: r.left, top: r.bottom + 2 });

  useLayoutEffect(() => {
    // Keep the first column on screen (flip above the button when there is no room below).
    const below = win.innerHeight - r.bottom, above = r.top;
    const top = below < 260 && above > below ? Math.max(8, r.top - Math.min(420, above - 8)) : r.bottom + 2;
    setOrigin({ left: Math.min(r.left, win.innerWidth - 260), top });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    inputRef.current?.focus();
    const onDown = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node)) onClose(); };
    doc.addEventListener('mousedown', onDown, true);
    return () => doc.removeEventListener('mousedown', onDown, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const columns: MNode[][] = useMemo(() => {
    if (filter.trim()) {
      const q = filter.trim().toLowerCase().split(/\s+/);
      const flat = flatten(tree).filter(({ node, path: p }) => {
        const hay = `${p}.${node.label} ${node.pick!.source} ${node.hint ?? ''} ${node.title ?? ''}`.toLowerCase();
        return q.every((t) => hay.includes(t));
      });
      return [flat.slice(0, MAX_FILTER).map(({ node, path: p }) => ({ ...node, label: p && !node.key.startsWith('p:') ? `${p}.${node.label}` : node.label }))];
    }
    const cols: MNode[][] = [tree];
    let level = tree;
    for (const step of path) {
      const n = level.find((x) => x.key === step.key);
      if (!n?.children) break;
      cols.push(n.children);
      level = n.children;
    }
    return cols;
  }, [tree, path, filter]);

  const openAt = (col: number, n: MNode, el: HTMLElement) => {
    const top = el.getBoundingClientRect().top;
    setPath((p) => (n.children ? [...p.slice(0, col), { key: n.key, top }] : p.slice(0, col)));
  };
  const activate = (col: number, n: MNode, el: HTMLElement) => {
    if (n.pick) onPick(n.pick);
    else if (n.children) openAt(col, n, el);
  };

  const onKey = (e: React.KeyboardEvent) => {
    const col = Math.min(hi.col, columns.length - 1), list = columns[col] ?? [];
    const row = (c: number, i: number) => root.current?.querySelector<HTMLElement>(`[data-col="${c}"][data-idx="${i}"]`);
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const idx = Math.max(0, Math.min(list.length - 1, hi.idx + (e.key === 'ArrowDown' ? 1 : -1)));
      setHi({ col, idx });
      const el = row(col, idx);
      el?.scrollIntoView({ block: 'nearest' });
      if (el && list[idx]?.children && !filter) openAt(col, list[idx]!, el);
    } else if (e.key === 'ArrowRight' && list[hi.idx]?.children && !filter) {
      e.preventDefault();
      const el = row(col, hi.idx);
      if (el) openAt(col, list[hi.idx]!, el);
      setHi({ col: col + 1, idx: 0 });
    } else if (e.key === 'ArrowLeft' && col > 0) {
      e.preventDefault();
      setPath((p) => p.slice(0, col - 1));
      setHi({ col: col - 1, idx: (columns[col - 1] ?? []).findIndex((n) => n.key === path[col - 1]?.key) });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const n = list[hi.idx] ?? (filter ? list[0] : undefined);
      const el = row(col, Math.max(0, hi.idx));
      if (n && el) activate(col, n, el);
    }
  };

  // Column geometry: each opens to the right of the previous one at the hovered row.
  const COL_W = 230;
  let x = origin.left;
  const cols = columns.map((list, c) => {
    const top = c === 0 ? origin.top : Math.max(8, Math.min(path[c - 1]?.top ?? origin.top, win.innerHeight - 160));
    const left = c === 0 ? x : x + COL_W - 2;
    if (c > 0) x = left;
    return { list, top, left: left + COL_W > win.innerWidth ? Math.max(8, win.innerWidth - COL_W * (columns.length - c)) : left, maxH: win.innerHeight - top - 10 - (c === 0 ? 34 : 0) };
  });

  return (
    <div ref={root} className="cascade" role="menu" onKeyDown={onKey}>
      {cols.map(({ list, top, left, maxH }, c) => (
        <div key={c} className="cascade-col" style={{ top, left, width: COL_W }} data-level={c}>
          {c === 0 && (
            <input ref={inputRef} className="cascade-filter" placeholder="Type to filter (e.g. imu accz)…" value={filter}
              onChange={(e) => { setFilter(e.target.value); setPath([]); setHi({ col: 0, idx: e.target.value ? 0 : -1 }); }} aria-label="Filter sources" />
          )}
          <div className="cascade-list" style={{ maxHeight: Math.max(120, Math.min(maxH, 520)) }}>
            {list.length === 0 && <div className="cascade-empty muted">{filter ? 'No match' : 'Nothing here'}</div>}
            {list.map((n, i) => {
              const openHere = path[c]?.key === n.key;
              const lit = (hi.col === c && hi.idx === i) || openHere;
              return (
                <div key={n.key} role="menuitem" data-col={c} data-idx={i} data-key={n.key} title={n.title}
                  className={`cascade-row${lit ? ' lit' : ''}${n.children ? ' sub' : ''}`}
                  onMouseEnter={(e) => {
                    const el = e.currentTarget;
                    setHi({ col: c, idx: i });
                    window.clearTimeout(hoverTimer.current);
                    hoverTimer.current = window.setTimeout(() => { if (!filter) { if (n.children) openAt(c, n, el); else setPath((p) => p.slice(0, c)); } }, 90);
                  }}
                  onClick={(e) => activate(c, n, e.currentTarget)}>
                  <span className="cascade-label">{n.label}</span>
                  {n.hint && <span className="cascade-hint">{n.hint}</span>}
                  {n.children && <span className="cascade-arrow">▸</span>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
