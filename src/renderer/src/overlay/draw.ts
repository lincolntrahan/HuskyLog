import { toPx } from '@core/overlay/rect';
import { drawAdi, forCamera } from '../adi/drawAdi';
import type { OverlayItem } from './model';
import { adiState, lineValue, sticksState, streamOf } from './values';
import { gimbals } from '@core/overlay/sticks';

/**
 * Canvas drawing for overlays. The live overlay layer and video export
 * (Phase 7, drawFrame) both use this, so what you see is what exports.
 * Text auto-fits its box, so a readout looks the same at any resolution.
 */
const FONT = 'Segoe UI, system-ui, sans-serif';
const MONO = 'Consolas, "Cascadia Mono", monospace';

export function hexA(color: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1]!, 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export function drawReadout(ctx: CanvasRenderingContext2D, item: OverlayItem, x: number, y: number, w: number, h: number, tMaster: number): void {
  const lines = (item.lines ?? []).map((l) => lineValue(l, item, tMaster));
  const st = item.style;
  ctx.save();
  if (st.opacity > 0) {
    ctx.fillStyle = hexA(st.bg, st.opacity);
    ctx.beginPath(); ctx.roundRect(x, y, w, h, Math.min(6, h * 0.08)); ctx.fill();
  }
  if (!lines.length) { ctx.restore(); return; }
  const pad = Math.max(2, Math.min(w, h) * 0.06);
  const iw = w - 2 * pad, ih = h - 2 * pad;
  // Fit: line height from the box height, then shrink if the widest line overflows.
  let size = (ih / lines.length) * 0.78;
  const labelW = (s: number) => { ctx.font = `${s}px ${FONT}`; return Math.max(0, ...lines.map((l) => (l.label ? ctx.measureText(`${l.label} `).width : 0))); };
  const valueW = (s: number) => { ctx.font = `bold ${s}px ${MONO}`; return Math.max(0, ...lines.map((l) => ctx.measureText(l.text).width)); };
  const need = labelW(size) + valueW(size);
  if (need > iw) size *= iw / need;
  size = Math.max(4, size);
  const lw = labelW(size);
  const rowH = ih / lines.length;
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = Math.max(1, size * 0.12);
  lines.forEach((l, i) => {
    const cy = y + pad + rowH * (i + 0.5);
    ctx.fillStyle = l.error ? '#ff8080' : st.color;
    if (st.align === 'left') {
      ctx.globalAlpha = 0.75; ctx.font = `${size}px ${FONT}`; ctx.textAlign = 'left';
      ctx.fillText(l.label, x + pad, cy);
      ctx.globalAlpha = 1; ctx.font = `bold ${size}px ${MONO}`;
      ctx.fillText(l.text, x + pad + lw, cy);
    } else {
      const text = l.label ? `${l.label} ${l.text}` : l.text;
      ctx.font = `bold ${size}px ${MONO}`; ctx.textAlign = st.align;
      ctx.fillText(text, st.align === 'center' ? x + w / 2 : x + w - pad, cy);
    }
  });
  ctx.restore();
}

export function drawAdiOverlay(ctx: CanvasRenderingContext2D, item: OverlayItem, x: number, y: number, w: number, h: number, tMaster: number): void {
  ctx.save();
  if (item.style.opacity > 0) { ctx.fillStyle = hexA(item.style.bg, item.style.opacity); ctx.fillRect(x, y, w, h); }
  const s = adiState(item, tMaster);
  ctx.translate(x, y);
  if (s) drawAdi(ctx, w, h, forCamera(s, item.facing), { overlay: true, tapes: item.tapes ?? false, hud: item.hud ?? true });
  ctx.restore();
}

/** Draws every overlay of a window onto ctx (w×h CSS pixels) at master time t. */
export function drawOverlays(ctx: CanvasRenderingContext2D, w: number, h: number, items: OverlayItem[], tMaster: number): void {
  for (const it of items) {
    const r = toPx(it.rect, w, h);
    if (it.kind === 'readout') drawReadout(ctx, it, r.x, r.y, r.w, r.h, tMaster);
    else if (it.kind === 'sticks') drawSticksOverlay(ctx, it, r.x, r.y, r.w, r.h, tMaster);
    else drawAdiOverlay(ctx, it, r.x, r.y, r.w, r.h, tMaster);
  }
}

const STICK = '#ffcc00';

/**
 * Pilot sticks: two gimbals (Mode 2: throttle + rudder left, elevator +
 * aileron right; Mode 1 swaps throttle and elevator) and, below them, sliders
 * for channels 5–8. Positions come from the log's RC input, calibrated with
 * its RCn_* parameters.
 */
export function drawSticksOverlay(ctx: CanvasRenderingContext2D, item: OverlayItem, x: number, y: number, w: number, h: number, tMaster: number): void {
  const st = item.style;
  const s = sticksState(item, tMaster);
  if (!s && streamOf(item)) return; // trimmed out
  ctx.save();
  if (st.opacity > 0) { ctx.fillStyle = hexA(st.bg, st.opacity); ctx.beginPath(); ctx.roundRect(x, y, w, h, Math.min(6, h * 0.06)); ctx.fill(); }
  const pad = Math.max(3, Math.min(w, h) * 0.05);
  const fs = Math.max(8, Math.min(14, Math.min(w, h) * 0.065));
  ctx.textBaseline = 'middle';
  const noData = !s || (Object.values(s.raw).every((a) => Number.isNaN(a.pwm)) && !s.loading);
  if (noData) {
    ctx.fillStyle = hexA(st.color, 0.8); ctx.font = `${fs}px ${FONT}`; ctx.textAlign = 'center';
    ctx.fillText(s ? 'No RC input (RCIN) in this log' : 'No log', x + w / 2, y + h / 2);
    ctx.restore(); return;
  }
  const mode = item.stickMode ?? 2;
  const showAux = item.aux ?? true, showVals = !!item.values;
  const labelH = fs * 1.5 * (showVals ? 2 : 1);
  const auxH = showAux ? Math.max(fs * 3.2, h * 0.28) : 0;
  const gArea = h - auxH - 2 * pad;
  const g = Math.max(10, Math.min((w - 3 * pad) / 2, gArea - labelH));
  const gy = y + pad + Math.max(0, (gArea - labelH - g) / 2);
  const gx = [x + (w - 2 * g - pad) / 2, x + (w - 2 * g - pad) / 2 + g + pad];
  const gm = gimbals(s.input, mode);
  const us = (v: number) => (Number.isNaN(v) ? '–' : Math.round(v).toString());
  const sides = mode === 1
    ? [{ dot: gm.left, label: 'RUD · ELE', vals: `R ${us(s.raw.yaw.pwm)}  E ${us(s.raw.pitch.pwm)}` }, { dot: gm.right, label: 'AIL · THR', vals: `A ${us(s.raw.roll.pwm)}  T ${us(s.raw.throttle.pwm)}` }]
    : [{ dot: gm.left, label: 'RUD · THR', vals: `R ${us(s.raw.yaw.pwm)}  T ${us(s.raw.throttle.pwm)}` }, { dot: gm.right, label: 'AIL · ELE', vals: `A ${us(s.raw.roll.pwm)}  E ${us(s.raw.pitch.pwm)}` }];
  sides.forEach((side, i) => {
    const ox = gx[i]!, r = Math.min(8, g * 0.12);
    ctx.fillStyle = 'rgba(0,0,0,.25)';
    ctx.beginPath(); ctx.roundRect(ox, gy, g, g, r); ctx.fill();
    ctx.strokeStyle = hexA(st.color, 0.7); ctx.lineWidth = Math.max(1, g * 0.012);
    ctx.beginPath(); ctx.roundRect(ox, gy, g, g, r); ctx.stroke();
    ctx.strokeStyle = hexA(st.color, 0.25);
    ctx.beginPath(); ctx.moveTo(ox + g / 2, gy + g * 0.08); ctx.lineTo(ox + g / 2, gy + g * 0.92); ctx.moveTo(ox + g * 0.08, gy + g / 2); ctx.lineTo(ox + g * 0.92, gy + g / 2); ctx.stroke();
    const { x: dx, y: dy } = side.dot;
    if (Number.isFinite(dx) && Number.isFinite(dy)) {
      const inner = g / 2 - g * 0.1;
      const px = ox + g / 2 + dx * inner, py = gy + g / 2 - dy * inner;
      ctx.strokeStyle = hexA(STICK, 0.55); ctx.lineWidth = Math.max(1.5, g * 0.03);
      ctx.beginPath(); ctx.moveTo(ox + g / 2, gy + g / 2); ctx.lineTo(px, py); ctx.stroke();
      ctx.fillStyle = STICK; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.lineWidth = Math.max(1, g * 0.015);
      ctx.beginPath(); ctx.arc(px, py, Math.max(3, g * 0.075), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.fillStyle = hexA(st.color, 0.85); ctx.textAlign = 'center';
    ctx.font = `${fs * 0.85}px ${FONT}`;
    ctx.fillText(side.label, ox + g / 2, gy + g + fs * 0.75);
    if (showVals) { ctx.font = `${fs * 0.85}px ${MONO}`; ctx.fillText(side.vals, ox + g / 2, gy + g + fs * 2.1); }
  });
  if (showAux) {
    // Channels 5–8: two columns of slim bars with the trim position marked.
    const top = y + h - pad - auxH + fs * 0.3, rowH = (auxH - fs * 0.3) / 2;
    const colW = (w - 3 * pad) / 2;
    s.aux.forEach((a, i) => {
      const cx = x + pad + (i % 2) * (colW + pad), cy = top + Math.floor(i / 2) * rowH + rowH / 2;
      ctx.font = `${fs * 0.85}px ${FONT}`; ctx.textAlign = 'left'; ctx.fillStyle = hexA(st.color, 0.85);
      const lab = `CH${a.ch}`;
      const lw = ctx.measureText('CH8 ').width;
      ctx.fillText(lab, cx, cy);
      const vw = showVals ? ctx.measureText(' 2000').width : 0;
      const bx = cx + lw, bw = Math.max(10, colW - lw - vw), bh = Math.max(4, Math.min(rowH * 0.42, fs * 0.8));
      ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.beginPath(); ctx.roundRect(bx, cy - bh / 2, bw, bh, bh / 2); ctx.fill();
      ctx.strokeStyle = hexA(st.color, 0.6); ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(bx, cy - bh / 2, bw, bh, bh / 2); ctx.stroke();
      if (Number.isFinite(a.v)) {
        ctx.fillStyle = STICK; ctx.beginPath(); ctx.roundRect(bx, cy - bh / 2, Math.max(bh, bw * a.v), bh, bh / 2); ctx.fill();
      }
      if (Number.isFinite(a.trim) && a.trim > 0.02 && a.trim < 0.98) { ctx.strokeStyle = hexA(st.color, 0.9); ctx.beginPath(); ctx.moveTo(bx + bw * a.trim, cy - bh * 0.9); ctx.lineTo(bx + bw * a.trim, cy + bh * 0.9); ctx.stroke(); }
      if (showVals) { ctx.font = `${fs * 0.8}px ${MONO}`; ctx.textAlign = 'right'; ctx.fillStyle = hexA(st.color, 0.85); ctx.fillText(us(a.pwm), cx + colW, cy); }
    });
  }
  ctx.restore();
}
