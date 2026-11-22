import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { OverlayLayer } from '../../overlay/OverlayLayer';
import { registerExportSource } from '../../export/registry';
import { SourceMenu, type PickedSource } from '../../ui/SourceMenu';
import type { OverlayItem } from '../../overlay/model';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { buildAligned } from '@core/series/decimate';
import { interpAt, medianDt, rangeStats } from '@core/series/series';
import { useRemoved } from '../../data/remove';
import { channelExists, loadChannel, primaryLog, refKey, useLogs, type ChannelRef, type LoadedChannel } from '../../data/logs';
import { fmtTime, timeDomain, useTimeline } from '../../data/timeline';
import { ChannelPicker } from './ChannelPicker';
import { DEFAULT_GRAPH, modeColor, nextColor, type GraphCfg, type SeriesCfg } from './model';
import { ExportDialog, PresetMenu, StatsTable } from './GraphParts';
import { ExpressionEditor, type ExprDraft } from './ExpressionEditor';
import { loadExpression, useExpressions } from '../../data/expressions';
import { streamSolution, useSync } from '../../data/sync';

/** Maps a non-reference log's local times onto the master timeline (cached per mapping). */
const mapped = new WeakMap<LoadedChannel, { a: number; b: number; out: LoadedChannel }>();
function toMasterTime(stream: string, d: LoadedChannel | null): LoadedChannel | null {
  const s = streamSolution(stream);
  if (!d || !s || s.status !== 'synced' || (s.a === 1 && s.b === 0)) return d;
  const hit = mapped.get(d);
  if (hit && hit.a === s.a && hit.b === s.b) return hit.out;
  const out = { ...d, t: d.t.map((x) => s.a * x + s.b) };
  mapped.set(d, { a: s.a, b: s.b, out });
  return out;
}

export interface ResolvedSeries {
  cfg: SeriesCfg; ref: ChannelRef; key: string; data: LoadedChannel | null;
  missing: boolean; isExpr: boolean; error?: string; axis: 'left' | 'right'; label: string;
}

const AXIS = '#8a94a3', GRID = '#2a313b', PLAYHEAD = '#ffcc00';

export function GraphPanel({ api, params }: IDockviewPanelProps<{ graph?: GraphCfg; overlays?: OverlayItem[] }>) {
  const [cfg, setCfgState] = useState<GraphCfg>(params?.graph ?? DEFAULT_GRAPH);
  const setCfg = useCallback((next: GraphCfg) => {
    setCfgState(next);
    api.updateParameters({ graph: next });
  }, [api]);

  // Lines from a log removed on the Import tab go with it.
  const removed = useRemoved((s) => s.ids);
  useEffect(() => {
    const keep = cfg.series.filter((s) => !s.stream || !removed.includes(s.stream));
    if (keep.length !== cfg.series.length) setCfg({ ...cfg, series: keep });
  }, [removed]); // eslint-disable-line react-hooks/exhaustive-deps

  const logs = useLogs();
  const primary = primaryLog();
  const named = useExpressions((s) => s.named);
  const exprVersion = useExpressions((s) => s.version);
  const syncSolution = useSync((s) => s.solution);
  const [loaded, setLoaded] = useState<Record<string, LoadedChannel | null>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [exprEdit, setExprEdit] = useState<{ index: number | null } | null>(null);
  const [picker, setPicker] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [xRange, setXRange] = useState<[number, number] | null>(null);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const range = useTimeline((s) => s.range);
  const crop = useTimeline((s) => s.crop);
  // A new workspace crop resets this graph's own zoom.
  useEffect(() => { setXRange(null); }, [crop]);
  const playT = useTimeline((s) => s.t);

  // Resolve series → refs → loaded data.
  const resolved = useMemo<ResolvedSeries[]>(() => {
    const units: string[] = [];
    const base = cfg.series.map((s) => {
      const ref = { stream: s.stream ?? primary?.id ?? '', id: s.id };
      // Expression results depend on named-expression edits, so the version is part of the key.
      const key = s.kind === 'expr' ? `${ref.stream}|expr|${s.id}|${s.unit ?? ''}|v${exprVersion}` : refKey(ref);
      const data = toMasterTime(ref.stream, loaded[key] ?? null);
      if (s.visible && data && !units.includes(data.unit)) units.push(data.unit);
      return { s, ref, key, data };
    });
    const [left, right] = units;
    const multi = logs.order.length > 1;
    return base.map(({ s, ref, key, data }) => {
      const unit = data?.unit ?? '';
      const axis = s.axis !== 'auto' ? s.axis : right !== undefined && unit === right && unit !== left ? 'right' : 'left';
      const streamName = multi ? `${logs.logs[ref.stream]?.name ?? '?'}: ` : '';
      const ready = !!ref.stream && logs.logs[ref.stream]?.status === 'ready';
      const isExpr = s.kind === 'expr';
      const label = isExpr ? `ƒ ${s.name || s.id}` : `${s.id}${data?.info?.label ? ` (${data.info.label})` : ''}`;
      return {
        cfg: s, ref, key, data, axis, isExpr,
        error: errors[key],
        missing: ready && (isExpr ? !!errors[key] : !channelExists(ref)),
        label: `${streamName}${label}`,
      };
    });
  }, [cfg, loaded, errors, primary?.id, logs, exprVersion, syncSolution]);

  useEffect(() => {
    for (const r of resolved) {
      const k = r.key;
      if (!r.ref.stream || k in loaded || k in errors) continue;
      if (logs.logs[r.ref.stream]?.status !== 'ready') continue;
      if (!r.isExpr && r.missing) continue;
      setLoaded((m) => ({ ...m, [k]: null }));
      const p = r.isExpr ? loadExpression(r.ref.stream, r.cfg.id, named, r.cfg.unit ?? '') : loadChannel(r.ref);
      void p.then(
        (d) => setLoaded((m) => ({ ...m, [k]: d })),
        (e: unknown) => {
          setErrors((m) => ({ ...m, [k]: e instanceof Error ? e.message : String(e) }));
          setLoaded((m) => { const n = { ...m }; delete n[k]; return n; });
        },
      );
    }
  }, [resolved, loaded, errors, logs, named]);

  const visible = resolved.filter((r) => r.cfg.visible && r.data);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // Export: the plot canvas as drawn (playhead at the export time), plus a legend with values.
  useEffect(() => registerExportSource({
    id: api.id, type: 'graph', title: api.title ?? 'Graph', content: () => hostRef.current?.parentElement ?? null,
    draw: async (c, t, w, h) => {
      const u = plotRef.current;
      c.fillStyle = '#14171c'; c.fillRect(0, 0, w, h);
      if (!u) return;
      u.redraw(false);
      c.drawImage(u.ctx.canvas, 0, 0, w, h);
      const rows = visibleRef.current.map((r) => ({ color: r.cfg.color, text: `${r.label}  ${fmtLegend(interpAt(r.data!, t, 5 * medianDt(r.data!.t) || Infinity))} ${r.data!.unit}`.trim() }));
      if (!rows.length) return;
      const fs = Math.max(10, Math.round(h * 0.035)), pad = fs * 0.5;
      c.font = `${fs}px Segoe UI, sans-serif`;
      const bw = Math.max(...rows.map((r) => c.measureText(r.text).width)) + fs * 1.6 + pad * 2;
      const x0 = (u.bbox.left / u.ctx.canvas.width) * w + pad, y0 = (u.bbox.top / u.ctx.canvas.height) * h + pad;
      c.fillStyle = 'rgba(20, 23, 28, 0.78)';
      c.fillRect(x0, y0, bw, rows.length * fs * 1.35 + pad * 1.2);
      c.textBaseline = 'middle';
      rows.forEach((r, i) => {
        const cy = y0 + pad + fs * 1.35 * (i + 0.5);
        c.fillStyle = r.color; c.fillRect(x0 + pad, cy - fs * 0.3, fs * 0.8, fs * 0.6);
        c.fillStyle = '#d7dce3'; c.fillText(r.text, x0 + pad + fs * 1.2, cy);
      });
    },
  }), [api.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const domain = useMemo<[number, number]>(() => {
    let a = Infinity, b = -Infinity;
    for (const r of visible) { a = Math.min(a, r.data!.t[0]!); b = Math.max(b, r.data!.t[r.data!.t.length - 1]!); }
    if (crop) return crop;
    return Number.isFinite(a) ? [a, b] : timeDomain();
  }, [visible.map((r) => r.key).join(), crop]); // eslint-disable-line react-hooks/exhaustive-deps
  // Average of each line over the crop (shown in the legend).
  const cropAvg = useMemo(() => {
    if (!crop) return {} as Record<string, number>;
    return Object.fromEntries(visible.map((r) => [r.key, rangeStats(r.data!, crop[0], crop[1]).mean]));
  }, [visible.map((r) => r.key).join(), crop]); // eslint-disable-line react-hooks/exhaustive-deps
  const view = xRange ?? domain;

  // ---- uPlot ----
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const stateRef = useRef({ view, domain, visible, modes: primary?.summary?.modes ?? [], armed: primary?.summary?.armed ?? [], modeBands: cfg.modeBands });
  stateRef.current = { view, domain, visible, modes: primary?.summary?.modes ?? [], armed: primary?.summary?.armed ?? [], modeBands: cfg.modeBands };

  const structure = visible.map((r) => `${r.key}:${r.cfg.color}:${r.axis}`).join('|');
  const leftUnits = [...new Set(visible.filter((r) => r.axis === 'left').map((r) => r.data!.unit).filter(Boolean))].join(', ');
  const rightUnits = [...new Set(visible.filter((r) => r.axis === 'right').map((r) => r.data!.unit).filter(Boolean))].join(', ');
  const hasRight = visible.some((r) => r.axis === 'right');

  const syncSelect = useCallback(() => {
    const u = plotRef.current;
    if (!u) return;
    const r = useTimeline.getState().range;
    if (!r) { u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false); return; }
    const l = Math.max(0, u.valToPos(r[0], 'x')), rr = Math.min(u.over.clientWidth, u.valToPos(r[1], 'x'));
    u.setSelect({ left: l, top: 0, width: Math.max(0, rr - l), height: u.over.clientHeight }, false);
  }, []);

  const refresh = useCallback(() => {
    const u = plotRef.current;
    if (!u) return;
    const { view: [x0, x1], visible: vis } = stateRef.current;
    const data = buildAligned(vis.map((r) => r.data!), x0, x1, u.over.clientWidth || 600);
    u.setData(data as uPlot.AlignedData);
    u.setScale('x', { min: x0, max: x1 });
    syncSelect();
  }, [syncSelect]);

  useEffect(() => {
    const host = hostRef.current!;
    const ctxOf = (u: uPlot) => u.ctx;
    const drawBands = (u: uPlot) => {
      const st = stateRef.current;
      if (!st.modeBands) return;
      const ctx = ctxOf(u);
      const { left, top, width, height } = u.bbox;
      ctx.save();
      ctx.font = `${11 * devicePixelRatio}px Segoe UI, sans-serif`;
      for (const m of st.modes) {
        const a = Math.max(left, u.valToPos(m.t0, 'x', true)), b = Math.min(left + width, u.valToPos(m.t1, 'x', true));
        if (b <= a) continue;
        const c = modeColor(m.name);
        ctx.globalAlpha = 0.09; ctx.fillStyle = c; ctx.fillRect(a, top, b - a, height);
        ctx.globalAlpha = 0.85; ctx.fillStyle = c;
        if (b - a > 40 * devicePixelRatio) ctx.fillText(m.name, a + 4 * devicePixelRatio, top + 13 * devicePixelRatio);
      }
      ctx.globalAlpha = 0.6; ctx.strokeStyle = '#ff6b6b'; ctx.setLineDash([4 * devicePixelRatio, 4 * devicePixelRatio]);
      for (const [a, d] of st.armed) for (const t of [a, d]) {
        const x = u.valToPos(t, 'x', true);
        if (x < left || x > left + width) continue;
        ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + height); ctx.stroke();
      }
      ctx.restore();
    };
    const drawPlayhead = (u: uPlot) => {
      const x = u.valToPos(useTimeline.getState().t, 'x', true);
      const { left, top, width, height } = u.bbox;
      if (x < left || x > left + width) return;
      const ctx = ctxOf(u);
      ctx.save(); ctx.strokeStyle = PLAYHEAD; ctx.lineWidth = 1.5 * devicePixelRatio;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + height); ctx.stroke(); ctx.restore();
    };
    const opts: uPlot.Options = {
      width: host.clientWidth || 600,
      height: host.clientHeight || 300,
      scales: { x: { time: false }, y: { auto: true }, y2: { auto: true } },
      axes: [
        { stroke: AXIS, grid: { stroke: GRID }, ticks: { stroke: GRID }, values: (_u, vals) => vals.map((v) => fmtTime(v).replace(/\.?0+$/, '')) },
        { scale: 'y', stroke: AXIS, grid: { stroke: GRID }, ticks: { stroke: GRID }, label: leftUnits, size: 56 },
        ...(hasRight ? [{ scale: 'y2', side: 1 as const, stroke: AXIS, grid: { show: false }, ticks: { stroke: GRID }, label: rightUnits, size: 56 }] : []),
      ],
      series: [
        {},
        ...visible.map((r) => ({ label: r.label, stroke: r.cfg.color, width: 1.25, scale: r.axis === 'right' ? 'y2' : 'y', spanGaps: false, points: { show: false } })),
      ],
      legend: { show: false },
      cursor: {
        drag: { x: true, y: false, setScale: false },
        points: { show: false },
        bind: { dblclick: () => () => { setXRange(null); return null; } },
      },
      hooks: {
        drawClear: [drawBands],
        draw: [drawPlayhead],
        setSelect: [(u) => {
          const { left, width } = u.select;
          if (width >= 3) useTimeline.getState().setRange([u.posToVal(left, 'x'), u.posToVal(left + width, 'x')]);
        }],
        setCursor: [(u) => {
          const l = u.cursor.left;
          setHoverT(l !== undefined && l >= 0 ? u.posToVal(l, 'x') : null);
        }],
      },
    };
    const u = new uPlot(opts, [[]], host);
    plotRef.current = u;

    // Wheel zoom around the cursor; middle-drag or Alt-drag to pan.
    const over = u.over;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const [x0, x1] = stateRef.current.view;
      const [d0, d1] = stateRef.current.domain;
      const xv = u.posToVal(e.offsetX, 'x');
      const f = e.deltaY < 0 ? 0.8 : 1.25;
      let a = xv - (xv - x0) * f, b = xv + (x1 - xv) * f;
      if (b - a >= d1 - d0) { setXRange(null); return; }
      if (a < d0) { b += d0 - a; a = d0; }
      if (b > d1) { a -= b - d1; b = d1; }
      setXRange([a, b]);
    };
    let pan: { x: number; v: [number, number] } | null = null;
    let down: { x: number; y: number } | null = null;
    // Right-drag: crop the whole workspace to the dragged time range.
    let cropDrag: { x0: number; band: HTMLDivElement } | null = null;
    const onDown = (e: MouseEvent) => {
      if (e.button === 2) {
        const band = over.ownerDocument.createElement('div');
        band.className = 'graph-crop-band';
        band.style.left = `${e.offsetX}px`; band.style.width = '0px';
        over.appendChild(band);
        cropDrag = { x0: e.offsetX, band };
        e.stopPropagation(); e.preventDefault();
      } else if (e.button === 1 || (e.button === 0 && e.altKey)) {
        pan = { x: e.clientX, v: stateRef.current.view };
        e.stopPropagation(); e.preventDefault();
      } else if (e.button === 0) {
        down = { x: e.clientX, y: e.clientY };
      }
    };
    // A click (press + release without moving) moves the playhead and clears the selection.
    const onClickUp = (e: MouseEvent) => {
      if (down && Math.abs(e.clientX - down.x) < 3 && Math.abs(e.clientY - down.y) < 3) {
        useTimeline.getState().setT(u.posToVal(e.offsetX, 'x'));
        useTimeline.getState().setRange(null);
      }
      down = null;
    };
    over.addEventListener('mouseup', onClickUp);
    const onMove = (e: MouseEvent) => {
      if (cropDrag) {
        const x = Math.max(0, Math.min(over.clientWidth, e.clientX - over.getBoundingClientRect().left));
        cropDrag.band.style.left = `${Math.min(x, cropDrag.x0)}px`;
        cropDrag.band.style.width = `${Math.abs(x - cropDrag.x0)}px`;
        return;
      }
      if (!pan) return;
      const dx = ((e.clientX - pan.x) / over.clientWidth) * (pan.v[1] - pan.v[0]);
      const [d0, d1] = stateRef.current.domain;
      let a = pan.v[0] - dx, b = pan.v[1] - dx;
      if (a < d0) { b += d0 - a; a = d0; }
      if (b > d1) { a -= b - d1; b = d1; }
      setXRange([a, b]);
    };
    const onUp = (e: MouseEvent) => {
      pan = null;
      if (cropDrag) {
        const x = Math.max(0, Math.min(over.clientWidth, e.clientX - over.getBoundingClientRect().left));
        cropDrag.band.remove();
        if (Math.abs(x - cropDrag.x0) >= 4) useTimeline.getState().setCrop([u.posToVal(cropDrag.x0, 'x'), u.posToVal(x, 'x')]);
        cropDrag = null;
      }
    };
    const onCtx = (e: MouseEvent) => e.preventDefault();
    over.addEventListener('contextmenu', onCtx);
    over.addEventListener('wheel', onWheel, { passive: false });
    over.addEventListener('mousedown', onDown, true);
    const win = host.ownerDocument.defaultView ?? window;
    win.addEventListener('mousemove', onMove);
    win.addEventListener('mouseup', onUp);

    const ro = new ResizeObserver(() => {
      if (!host.clientWidth || !host.clientHeight) return;
      u.setSize({ width: host.clientWidth, height: host.clientHeight });
      refresh();
    });
    ro.observe(host);
    refresh();

    const unsub = useTimeline.subscribe((s, prev) => {
      if (s.t !== prev.t) u.redraw(false);
      if (s.range !== prev.range) syncSelect();
    });
    return () => {
      unsub(); ro.disconnect();
      win.removeEventListener('mousemove', onMove);
      win.removeEventListener('mouseup', onUp);
      u.destroy();
      plotRef.current = null;
    };
  }, [structure, leftUnits, rightUnits, hasRight]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { refresh(); }, [view[0], view[1], refresh]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { plotRef.current?.redraw(false); }, [cfg.modeBands]);

  // Keyboard: Esc clears selection, Z zooms to it.
  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.key === 'Escape') useTimeline.getState().setRange(null);
    if ((e.key === 'z' || e.key === 'Z') && range) setXRange(range);
  };

  // ---- series editing ----
  const existing = new Set(resolved.filter((r) => !r.isExpr).map((r) => refKey(r.ref)));
  const addRef = (r: ChannelRef) => {
    if (existing.has(refKey(r))) return;
    const s: SeriesCfg = { id: r.id, color: nextColor(cfg.series.map((x) => x.color)), axis: 'auto', visible: true };
    if (r.stream !== primary?.id) s.stream = r.stream;
    setCfg({ ...cfg, series: [...cfg.series, s] });
  };
  const update = (i: number, p: Partial<SeriesCfg>) => setCfg({ ...cfg, series: cfg.series.map((s, k) => (k === i ? { ...s, ...p } : s)) });
  const remove = (i: number) => setCfg({ ...cfg, series: cfg.series.filter((_, k) => k !== i) });
  const addNamedRef = (name: string, stream: string) => {
    if (cfg.series.some((x) => x.kind === 'expr' && x.id === name)) return;
    const s: SeriesCfg = { id: name, kind: 'expr', color: nextColor(cfg.series.map((x) => x.color)), axis: 'auto', visible: true };
    if (stream !== primary?.id) s.stream = stream;
    setCfg({ ...cfg, series: [...cfg.series, s] });
  };
  /** A pick from the cascading menu: a channel, a named expression, or a preset expression. */
  const addPicked = (p: PickedSource) => {
    if (!primary) return;
    if (channelExists({ stream: primary.id, id: p.source })) return addRef({ stream: primary.id, id: p.source });
    if (p.source in named) return addNamedRef(p.source, primary.id);
    if (cfg.series.some((x) => x.kind === 'expr' && x.id === p.source)) return;
    setCfg({ ...cfg, series: [...cfg.series, { id: p.source, kind: 'expr', name: p.label, unit: p.unit, color: nextColor(cfg.series.map((x) => x.color)), axis: 'auto', visible: true }] });
  };
  const saveExpr = (d: ExprDraft) => {
    const idx = exprEdit?.index ?? null;
    let id = d.src;
    if (d.saveAsNamed && d.name) {
      useExpressions.getState().setNamed(d.name, d.src);
      id = d.name; // the series refers to the named expression
    }
    const prev = idx !== null ? cfg.series[idx] : undefined;
    const s: SeriesCfg = {
      ...(prev ?? { color: nextColor(cfg.series.map((x) => x.color)), axis: 'auto', visible: true }),
      id, kind: 'expr',
      ...(d.name && !d.saveAsNamed ? { name: d.name } : { name: undefined }),
      ...(d.unit ? { unit: d.unit } : { unit: undefined }),
    };
    setErrors({});
    setCfg({ ...cfg, series: idx !== null ? cfg.series.map((x, k) => (k === idx ? s : x)) : [...cfg.series, s] });
    setExprEdit(null);
  };
  const editing = exprEdit?.index != null ? cfg.series[exprEdit.index] : undefined;
  const editInitial: Partial<ExprDraft> | undefined = editing
    ? (editing.id in named
      ? { src: named[editing.id], name: editing.id, unit: editing.unit ?? '', saveAsNamed: true }
      : { src: editing.id, name: editing.name ?? '', unit: editing.unit ?? '', saveAsNamed: false })
    : undefined;

  const readT = hoverT ?? playT;
  const fmtVal = (v: number) => (Number.isNaN(v) ? '–' : Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(2) : v.toPrecision(4));
  (window.__hl as Record<string, unknown>)[`graph:${api.id}`] = { setCfg, getCfg: () => cfg, setXRange, refresh: () => refresh() };

  return (
    <div className="hl-panel graph" tabIndex={0} onKeyDown={onKey}>
      <div className="graph-bar">
        <span className="src-cell"><button onClick={() => setPicker((p) => !p)} title="Add a channel (search)">＋ Add</button><SourceMenu stream={primary?.id} specials={false} compact ariaLabel="Browse channels" onPick={addPicked} /></span>
        <button onClick={() => setExprEdit({ index: null })} disabled={!primary} title="Add a math expression, e.g. ATT.Roll - ATT.DesRoll">ƒx Expression</button>
        <PresetMenu cfg={cfg} onApply={(c) => { setErrors({}); setCfg(c); }} />
        <button onClick={() => setXRange(null)} disabled={!xRange} title="Show the whole log (double-click the plot)">Fit</button>
        <button onClick={() => range && setXRange(range)} disabled={!range} title="Zoom to the selected range (Z)">Zoom to selection</button>
        <button onClick={() => setExporting(true)} disabled={!visible.length} title="Export the selection, the crop range or the whole log as CSV">Export CSV…</button>
        <label className="chk"><input type="checkbox" checked={cfg.modeBands} onChange={(e) => setCfg({ ...cfg, modeBands: e.target.checked })} /> Modes</label>
        <span className="graph-hint muted">drag: select · right-drag: crop workspace · click: playhead · wheel: zoom · Alt/middle-drag: pan</span>
      </div>
      <div className="legend">
        {resolved.map((r, i) => (
          <div key={r.key} className={`chip${r.cfg.visible ? '' : ' off'}${r.missing ? ' missing' : ''}`} title={r.error ?? (r.missing ? 'This channel is not in the current log' : r.isExpr ? r.cfg.id : r.label)}>
            <input type="color" value={r.cfg.color} onChange={(e) => update(i, { color: e.target.value })} aria-label={`Colour of ${r.cfg.id}`} />
            <span className="chip-name" onClick={() => update(i, { visible: !r.cfg.visible })}>{r.label}</span>
            <span className="chip-val">{r.data ? `${fmtVal(interpAt(r.data, readT, 5 * medianDt(r.data.t) || Infinity))} ${r.data.unit}` : r.error ? 'error' : r.missing ? 'missing' : '…'}</span>
            {crop && r.data && r.key in cropAvg && <span className="chip-avg" title={`Average over the crop ${fmtTime(crop[0])} → ${fmtTime(crop[1])}`}>avg {fmtVal(cropAvg[r.key]!)}</span>}
            <button className="chip-axis" title="Axis: auto / left / right" onClick={() => update(i, { axis: r.cfg.axis === 'auto' ? 'left' : r.cfg.axis === 'left' ? 'right' : 'auto' })}>
              {r.cfg.axis === 'auto' ? (r.axis === 'right' ? 'R' : 'L') + '·' : r.cfg.axis === 'left' ? 'L' : 'R'}
            </button>
            {r.isExpr && <button className="chip-edit" title="Edit expression" onClick={() => setExprEdit({ index: i })}>✎</button>}
            <button className="chip-x" title="Remove" onClick={() => remove(i)}>×</button>
          </div>
        ))}
        {resolved.length === 0 && <span className="muted">No series. Click ＋ Add or pick a preset.</span>}
      </div>
      <div className="plot-wrap"><div className="plot-host" ref={hostRef} /><OverlayLayer api={api} initial={params?.overlays} /></div>
      {(range ?? crop) && visible.length > 0 && <StatsTable series={visible} range={(range ?? crop)!} caption={range ? 'Selection' : 'Crop'} />}
      <div className="graph-status muted">
        {hoverT !== null ? `cursor ${fmtTime(hoverT)}` : `playhead ${fmtTime(playT)}`}
        {range ? ` · selection ${fmtTime(range[0])} → ${fmtTime(range[1])} (${(range[1] - range[0]).toFixed(3)} s)` : ''}
      </div>
      {picker && (
        <div className="overlay-pop">
          <ChannelPicker existing={existing} onClose={() => setPicker(false)}
            onPick={(r, keep) => { if (r.named) addNamedRef(r.id, r.stream); else addRef(r); if (!keep) setPicker(false); }} />
        </div>
      )}
      {exprEdit && primary && (
        <ExpressionEditor stream={editing?.stream ?? primary.id} initial={editInitial} onCancel={() => setExprEdit(null)} onDone={saveExpr} />
      )}
      {exporting && visible.length > 0 && <ExportDialog series={visible} selection={range} crop={crop} logName={primary?.name ?? 'log'} onClose={() => setExporting(false)} />}
    </div>
  );
}

export { rangeStats };

const fmtLegend = (v: number) => (Number.isNaN(v) ? '–' : Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(2) : v.toPrecision(4));
