import { toPx } from '@core/overlay/rect';
import { drawAdi, forCamera } from '../adi/drawAdi';
import type { OverlayItem } from './model';
import { adiState, lineValue } from './values';

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
    else drawAdiOverlay(ctx, it, r.x, r.y, r.w, r.h, tMaster);
  }
}
