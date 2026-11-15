import { useEffect, useRef } from 'react';
import type { Waveform } from '../video/MediaSource';
import type { SyncEvent } from '../data/sync';
import { fmtTime } from '../data/timeline';

export interface LaneSignal { label: string; color: string; t: Float64Array; v: Float64Array }

export interface LaneProps {
  /** Local time → x position mapping is given by the view (in the lane's own time). */
  view: [number, number];
  signals?: LaneSignal[];
  waveform?: Waveform | null;
  markers: { eventId: string; t: number }[];
  events: SyncEvent[];
  cursor: number | null;
  suggestion: number | null;
  selected: boolean;
  dim?: string | null;          // overlay text (e.g. "not synced")
  /** Lane time → displayed time for tick labels (Aligned mode shows master time). */
  toDisplay?: (t: number) => number;
  fromDisplay?: (t: number) => number;
  onCursor: (t: number) => void;
  onMarkerDrag: (eventId: string, t: number) => void;
  onView: (v: [number, number]) => void;
  onSelect: () => void;
}

const H = 86;

/** One stream's lane: a signal or audio waveform, markers, cursor, zoom/pan. */
export function Lane(p: LaneProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const props = useRef(p);
  props.current = p;

  useEffect(() => {
    const c = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    if (!w) return;
    c.width = Math.round(w * dpr); c.height = Math.round(H * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, H);
    ctx.fillStyle = p.selected ? '#18222e' : '#141a21';
    ctx.fillRect(0, 0, w, H);
    const [v0, v1] = p.view;
    const X = (t: number) => ((t - v0) / (v1 - v0)) * w;
    const plotTop = 14, plotH = H - 30;

    // Time ticks.
    ctx.fillStyle = '#5d6672'; ctx.strokeStyle = '#232b35'; ctx.font = '10px Segoe UI'; ctx.textBaseline = 'bottom';
    const span = v1 - v0;
    // Ticks are chosen in displayed time (master time in Aligned mode).
    const toD = p.toDisplay ?? ((t: number) => t), fromD = p.fromDisplay ?? ((t: number) => t);
    const d0 = toD(v0), d1 = toD(v1);
    const step = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300].find((s) => (d1 - d0) / s < w / 70) ?? 600;
    for (let td = Math.ceil(d0 / step) * step; td <= d1; td += step) {
      const x = X(fromD(td));
      ctx.beginPath(); ctx.moveTo(x, plotTop); ctx.lineTo(x, H - 14); ctx.stroke();
      ctx.fillText(step < 1 ? `${fmtTime(td)}` : fmtTime(td).replace(/\.000$/, ''), x + 2, H - 1);
    }

    // Signals: min/max per pixel column, each normalised to its visible range.
    for (const s of p.signals ?? []) {
      let lo = Infinity, hi = -Infinity;
      let i0 = 0;
      while (i0 < s.t.length && s.t[i0]! < v0) i0++;
      let i1 = i0;
      while (i1 < s.t.length && s.t[i1]! <= v1) { const x = s.v[i1]!; if (x < lo) lo = x; if (x > hi) hi = x; i1++; }
      if (!(hi > lo)) { lo -= 1; hi += 1; }
      const Y = (x: number) => plotTop + plotH - ((x - lo) / (hi - lo)) * plotH;
      ctx.strokeStyle = s.color; ctx.lineWidth = 1.2; ctx.beginPath();
      let col = -1, mn = 0, mx = 0, started = false;
      const flush = () => { if (col < 0) return; if (!started) { ctx.moveTo(col, Y(mn)); started = true; } ctx.lineTo(col, Y(mn)); ctx.lineTo(col, Y(mx)); };
      for (let i = Math.max(0, i0 - 1); i < Math.min(s.t.length, i1 + 1); i++) {
        const x = Math.round(X(s.t[i]!)), val = s.v[i]!;
        if (Number.isNaN(val)) continue;
        if (x !== col) { flush(); col = x; mn = mx = val; } else { if (val < mn) mn = val; if (val > mx) mx = val; }
      }
      flush();
      ctx.stroke();
    }

    // Audio waveform.
    const wf = p.waveform;
    if (wf) {
      const mid = plotTop + plotH / 2, amp = plotH / 2;
      ctx.fillStyle = '#4ea1ff99';
      for (let x = 0; x < w; x++) {
        const ta = v0 + (x / w) * span, tb = v0 + ((x + 1) / w) * span;
        const ba = Math.max(0, Math.floor((ta - wf.start) / wf.binDt)), bb = Math.min(wf.min.length - 1, Math.ceil((tb - wf.start) / wf.binDt));
        if (bb < 0 || ba >= wf.min.length) continue;
        let mn = 0, mx = 0;
        for (let b = ba; b <= bb; b++) { if (wf.min[b]! < mn) mn = wf.min[b]!; if (wf.max[b]! > mx) mx = wf.max[b]!; }
        ctx.fillRect(x, mid - mx * amp, 1, Math.max(1, (mx - mn) * amp));
      }
    }

    // Markers.
    for (const m of p.markers) {
      const ev = p.events.find((e) => e.id === m.eventId);
      const x = X(m.t);
      if (x < -50 || x > w + 50) continue;
      ctx.strokeStyle = ev?.color ?? '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H - 14); ctx.stroke();
      ctx.fillStyle = ev?.color ?? '#fff';
      ctx.beginPath(); ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 8); ctx.closePath(); ctx.fill();
      ctx.font = 'bold 11px Segoe UI'; ctx.textBaseline = 'top';
      ctx.fillText(ev?.name ?? '?', x + 6, 1);
    }
    if (p.suggestion !== null) {
      const x = X(p.suggestion);
      ctx.strokeStyle = '#7fdbff'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H - 14); ctx.stroke(); ctx.setLineDash([]);
    }
    if (p.cursor !== null) {
      const x = X(p.cursor);
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H - 14); ctx.stroke();
    }
    if (p.dim) {
      ctx.fillStyle = 'rgba(10,12,16,0.65)'; ctx.fillRect(0, 0, w, H);
      ctx.fillStyle = '#c8ced6'; ctx.font = '12px Segoe UI'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(p.dim, w / 2, H / 2); ctx.textAlign = 'left';
    }
    if (!p.signals?.length && !wf && !p.dim) {
      ctx.fillStyle = '#5d6672'; ctx.font = '12px Segoe UI'; ctx.textBaseline = 'middle';
      ctx.fillText(p.waveform === null ? 'No audio track' : 'Loading…', 10, H / 2);
    }
  });

  // Interaction: click = cursor, drag marker head, wheel = zoom, Alt/middle drag = pan.
  useEffect(() => {
    const c = ref.current!;
    const tOf = (x: number) => { const [a, b] = props.current.view; return a + (x / c.clientWidth) * (b - a); };
    let mode: null | { kind: 'marker'; eventId: string } | { kind: 'pan'; x: number; view: [number, number] } | { kind: 'click'; x: number } = null;
    const onDown = (e: MouseEvent) => {
      props.current.onSelect();
      const x = e.offsetX;
      if (e.button === 1 || e.altKey) { mode = { kind: 'pan', x: e.clientX, view: props.current.view }; e.preventDefault(); return; }
      const [a, b] = props.current.view;
      const near = props.current.markers.find((m) => Math.abs(((m.t - a) / (b - a)) * c.clientWidth - x) < 6);
      mode = near && e.offsetY < 26 ? { kind: 'marker', eventId: near.eventId } : { kind: 'click', x: e.clientX };
    };
    const onMove = (e: MouseEvent) => {
      if (!mode) return;
      const r = c.getBoundingClientRect();
      if (mode.kind === 'marker') props.current.onMarkerDrag(mode.eventId, tOf(e.clientX - r.left));
      if (mode.kind === 'pan') {
        const [a, b] = mode.view;
        const dt = ((e.clientX - mode.x) / c.clientWidth) * (b - a);
        props.current.onView([a - dt, b - dt]);
      }
    };
    const onUp = (e: MouseEvent) => {
      if (mode?.kind === 'click' && Math.abs(e.clientX - mode.x) < 3) {
        const r = c.getBoundingClientRect();
        props.current.onCursor(tOf(e.clientX - r.left));
      }
      mode = null;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const [a, b] = props.current.view;
      const xm = tOf(e.offsetX);
      const f = e.deltaY < 0 ? 0.75 : 1.33;
      props.current.onView([xm - (xm - a) * f, xm + (b - xm) * f]);
    };
    const win = c.ownerDocument.defaultView ?? window;
    c.addEventListener('mousedown', onDown);
    c.addEventListener('wheel', onWheel, { passive: false });
    win.addEventListener('mousemove', onMove);
    win.addEventListener('mouseup', onUp);
    return () => {
      c.removeEventListener('mousedown', onDown);
      c.removeEventListener('wheel', onWheel);
      win.removeEventListener('mousemove', onMove);
      win.removeEventListener('mouseup', onUp);
    };
  }, []);

  return <canvas ref={ref} className="lane-canvas" style={{ width: '100%', height: H }} />;
}
