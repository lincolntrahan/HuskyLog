import { useEffect, useRef } from 'react';
import { dragRect, snapRect, type Handle, type NRect } from '@core/overlay/rect';
import { useTimeline } from '../data/timeline';
import { drawOverlays } from './draw';
import { newWidget, useOverlays, type OverlayItem } from './model';
import { lineValue, useOverlayData } from './values';
import { OverlayEditor } from './OverlayEditor';

/** The bit of dockview's panel api the layer needs (parameters round-trip). */
export interface ParamsApi {
  id: string;
  updateParameters: (p: Record<string, unknown>) => void;
}

const EMPTY: OverlayItem[] = [];
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/**
 * Overlay layer for one window (DESIGN §7.7). A canvas on top of the window's
 * content draws every overlay at the master playhead. In edit mode, boxes on
 * top of the canvas can be dragged, resized and edited; positions are
 * normalized (0–1), so they survive resizes and export resolutions.
 * The parent element must be position: relative.
 */
export function OverlayLayer({ api, initial }: { api: ParamsApi; initial?: OverlayItem[] }) {
  const win = api.id;
  const items = useOverlays((s) => s.byWindow[win] ?? EMPTY);
  const editing = useOverlays((s) => s.editing === win);
  const selected = useOverlays((s) => s.selected);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Restore from the panel's saved parameters once, then mirror changes back.
  useEffect(() => {
    const st = useOverlays.getState();
    if (!st.byWindow[win] && initial?.length) st.set(win, initial);
  }, [win]); // eslint-disable-line react-hooks/exhaustive-deps
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    api.updateParameters({ overlays: items });
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live drawing: playhead, data arrival, item edits and resizes.
  useEffect(() => {
    const canvas = canvasRef.current!, root = rootRef.current!;
    const hl = window.__hl as Record<string, unknown>;
    const diag = { draws: 0, lines: [] as string[][], w: 0, h: 0 };
    hl[`overlay:${win}`] = diag;
    const draw = () => {
      const w = root.clientWidth, h = root.clientHeight;
      const dpr = (root.ownerDocument.defaultView ?? window).devicePixelRatio || 1;
      if (!w || !h) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const t = useTimeline.getState().t;
      drawOverlays(ctx, w, h, items, t);
      diag.draws++; diag.w = w; diag.h = h;
      diag.lines = items.map((it) => (it.lines ?? []).map((l) => { const v = lineValue(l, it, t); return `${v.label} ${v.text}`.trim(); }));
    };
    draw();
    const u1 = useTimeline.subscribe((s, p) => { if (s.t !== p.t) draw(); });
    const u2 = useOverlayData.subscribe(draw);
    const ro = new ResizeObserver(draw);
    ro.observe(root);
    return () => { u1(); u2(); ro.disconnect(); };
  }, [items, win]);

  // Edit-mode keys on the host window (works inside pop-outs too).
  useEffect(() => {
    if (!editing) return;
    const host = rootRef.current!.ownerDocument.defaultView ?? window;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const st = useOverlays.getState();
      if (e.key === 'Escape') { st.setEditing(null); return; }
      const sel = (st.byWindow[win] ?? []).find((o) => o.id === st.selected);
      if (!sel) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { st.remove(win, sel.id); e.preventDefault(); return; }
      const step = e.shiftKey ? 0.02 : 0.004;
      const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const m = d[e.key];
      if (m) { st.patch(win, sel.id, { rect: dragRect(sel.rect, 'move', m[0], m[1]) }); e.preventDefault(); e.stopPropagation(); }
    };
    host.addEventListener('keydown', onKey, true);
    return () => host.removeEventListener('keydown', onKey, true);
  }, [editing, win]);

  const startDrag = (e: React.MouseEvent, item: OverlayItem, handle: Handle) => {
    e.stopPropagation(); e.preventDefault();
    // preventDefault keeps focus where it was; drop it so arrow keys nudge this overlay.
    (e.currentTarget.ownerDocument.activeElement as HTMLElement | null)?.blur?.();
    const st = useOverlays.getState();
    st.select(item.id);
    const root = rootRef.current!;
    const host = root.ownerDocument.defaultView ?? window;
    const W = root.clientWidth, H = root.clientHeight;
    const x0 = e.clientX, y0 = e.clientY, r0: NRect = item.rect;
    const onMove = (ev: MouseEvent) => {
      let r = dragRect(r0, handle, (ev.clientX - x0) / W, (ev.clientY - y0) / H);
      if (handle === 'move' && !ev.altKey) r = snapRect(r);
      useOverlays.getState().patch(win, item.id, { rect: r });
    };
    const onUp = () => { host.removeEventListener('mousemove', onMove); host.removeEventListener('mouseup', onUp); };
    host.addEventListener('mousemove', onMove);
    host.addEventListener('mouseup', onUp);
  };

  const st = useOverlays.getState;
  const sel = items.find((o) => o.id === selected);
  return (
    <div ref={rootRef} className={`overlay-layer${editing ? ' editing' : ''}`} data-window={win}>
      <canvas ref={canvasRef} className="overlay-canvas" />
      {editing && (
        <>
          <div className="overlay-backdrop" onMouseDown={() => st().select(null)} />
          {items.map((it) => (
            <div key={it.id} className={`overlay-box${it.id === selected ? ' sel' : ''}`} data-overlay={it.id}
              style={{ left: `${it.rect.x * 100}%`, top: `${it.rect.y * 100}%`, width: `${it.rect.w * 100}%`, height: `${it.rect.h * 100}%` }}
              onMouseDown={(e) => startDrag(e, it, 'move')}>
              <span className="overlay-tag">{it.kind === 'adi' ? 'Horizon' : it.kind === 'sticks' ? 'Sticks' : 'Readout'}</span>
              {it.id === selected && HANDLES.map((h) => (
                <span key={h} className={`overlay-handle h-${h}`} data-handle={h} onMouseDown={(e) => startDrag(e, it, h)} />
              ))}
            </div>
          ))}
          <div className="overlay-toolbar" onMouseDown={(e) => e.stopPropagation()}>
            <button onClick={() => st().add(win, newWidget())} title="Add a widget, then pick its type (readout, horizon, pilot sticks) in its menu">＋ Widget</button>
            <span className="muted small" title="drag to move (Alt: no snap) · handles resize · arrows nudge · Del removes">drag to move (Alt: no snap) · handles resize · arrows nudge · Del removes</span>
            <button className="primary" onClick={() => st().setEditing(null)}>Done</button>
          </div>
          {sel && <OverlayEditor win={win} item={sel} side={sel.rect.x + sel.rect.w / 2 < 0.5 ? 'right' : 'left'} />}
        </>
      )}
    </div>
  );
}
