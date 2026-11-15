/**
 * Primary-flight-display style artificial horizon, drawn on a 2D canvas.
 * Shared by the ADI window, the ADI overlay (Phase 5) and video export
 * (Phase 7), so it must not depend on React or the DOM beyond the context.
 */
export interface AdiState {
  roll: number;       // deg, + right wing down
  pitch: number;      // deg, + nose up
  heading: number;    // deg 0–360
  airspeed?: number;  // m/s
  altitude?: number;  // m
  mode?: string;
  armed?: boolean;
  speedLabel?: string;
  altLabel?: string;
}

export interface AdiOptions {
  /** Transparent background outside the attitude ball (for overlays). */
  overlay?: boolean;
  /** Draw speed/altitude tapes and heading tape. */
  tapes?: boolean;
}

const SKY = '#2f6fb3', SKY2 = '#7fb3e6', GROUND = '#7a4f2a', GROUND2 = '#3d2714';
const FG = '#ffffff', AMBER = '#ffcc00', FONT = 'Segoe UI, system-ui, sans-serif';

export function drawAdi(ctx: CanvasRenderingContext2D, w: number, h: number, s: AdiState, o: AdiOptions = {}): void {
  const tapes = o.tapes ?? true;
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  if (!o.overlay) { ctx.fillStyle = '#0d1014'; ctx.fillRect(0, 0, w, h); }

  const tapeW = tapes ? Math.max(46, Math.min(80, w * 0.13)) : 0;
  const headH = tapes ? Math.max(24, Math.min(38, h * 0.09)) : 0;
  const footH = tapes ? 22 : 0;
  // Attitude area (square-ish) between the tapes.
  const ax = tapeW + 6, ay = headH + 6, aw = w - 2 * (tapeW + 6), ah = h - headH - footH - 12;
  if (aw < 40 || ah < 40) { ctx.restore(); return; }
  const cx = ax + aw / 2, cy = ay + ah / 2;
  const r = Math.min(aw, ah) / 2;
  const pxPerDeg = r / 25; // ±25° visible

  // ---- Attitude ball (clipped) ----
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(ax, ay, aw, ah, 8);
  ctx.clip();
  ctx.translate(cx, cy);
  ctx.rotate((-s.roll * Math.PI) / 180);
  const off = s.pitch * pxPerDeg;
  const big = Math.hypot(aw, ah) * 2;
  let g = ctx.createLinearGradient(0, -big / 2 + off, 0, off);
  g.addColorStop(0, SKY); g.addColorStop(1, SKY2);
  ctx.fillStyle = g;
  ctx.fillRect(-big, -big + off, big * 2, big);
  g = ctx.createLinearGradient(0, off, 0, off + big / 2);
  g.addColorStop(0, GROUND); g.addColorStop(1, GROUND2);
  ctx.fillStyle = g;
  ctx.fillRect(-big, off, big * 2, big);
  ctx.strokeStyle = FG; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(-big, off); ctx.lineTo(big, off); ctx.stroke();

  // Pitch ladder every 5°, labels every 10°.
  ctx.fillStyle = FG; ctx.lineWidth = 1.5;
  ctx.font = `${Math.max(10, r * 0.09)}px ${FONT}`;
  ctx.textBaseline = 'middle';
  for (let p = -90; p <= 90; p += 5) {
    if (p === 0) continue;
    const y = off - p * pxPerDeg;
    if (Math.abs(y) > r * 1.3) continue;
    const len = p % 10 === 0 ? r * 0.36 : r * 0.18;
    ctx.beginPath(); ctx.moveTo(-len / 2, y); ctx.lineTo(len / 2, y); ctx.stroke();
    if (p % 10 === 0) {
      ctx.textAlign = 'right'; ctx.fillText(String(Math.abs(p)), -len / 2 - 4, y);
      ctx.textAlign = 'left'; ctx.fillText(String(Math.abs(p)), len / 2 + 4, y);
    }
  }
  ctx.restore();

  // ---- Roll scale (fixed) and pointer (rotates) ----
  ctx.save();
  ctx.translate(cx, cy);
  const rr = r * 0.92;
  ctx.strokeStyle = FG; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(0, 0, rr, (-150 * Math.PI) / 180, (-30 * Math.PI) / 180); ctx.stroke();
  for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
    const t = ((a - 90) * Math.PI) / 180;
    const l = a % 30 === 0 ? r * 0.09 : r * 0.05;
    ctx.beginPath(); ctx.moveTo(Math.cos(t) * rr, Math.sin(t) * rr); ctx.lineTo(Math.cos(t) * (rr + l), Math.sin(t) * (rr + l)); ctx.stroke();
  }
  ctx.rotate((-s.roll * Math.PI) / 180);
  ctx.fillStyle = AMBER;
  ctx.beginPath(); ctx.moveTo(0, -rr + 1); ctx.lineTo(-r * 0.05, -rr + r * 0.09); ctx.lineTo(r * 0.05, -rr + r * 0.09); ctx.closePath(); ctx.fill();
  ctx.restore();

  // ---- Fixed aircraft symbol ----
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = '#000'; ctx.fillStyle = AMBER; ctx.lineWidth = 1;
  const wl = r * 0.42, ww = r * 0.05;
  for (const sgn of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(sgn * r * 0.1, -ww / 2); ctx.lineTo(sgn * wl, -ww / 2); ctx.lineTo(sgn * wl, ww / 2);
    ctx.lineTo(sgn * (r * 0.1 + ww), ww / 2); ctx.lineTo(sgn * (r * 0.1 + ww), ww * 2); ctx.lineTo(sgn * r * 0.1, ww * 2); ctx.closePath();
    ctx.fill(); ctx.stroke();
  }
  ctx.fillRect(-ww / 2, -ww / 2, ww, ww); ctx.strokeRect(-ww / 2, -ww / 2, ww, ww);
  ctx.restore();

  if (tapes) {
    drawTape(ctx, 0, ay, tapeW, ah, s.airspeed, 5, 1, s.speedLabel ?? 'm/s', 'left');
    drawTape(ctx, w - tapeW, ay, tapeW, ah, s.altitude, 10, 0, s.altLabel ?? 'm', 'right');
    drawHeading(ctx, ax, 0, aw, headH, s.heading);
    // Footer: mode and arming.
    ctx.font = `bold 13px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = s.armed ? '#ff6b6b' : '#8a94a3';
    ctx.fillText(s.armed === undefined ? '' : s.armed ? 'ARMED' : 'DISARMED', ax, h - footH / 2);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#3ddc97';
    ctx.fillText(s.mode ?? '', ax + aw, h - footH / 2);
  }
  ctx.restore();
}

function drawTape(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, v: number | undefined, step: number, decimals: number, unit: string, side: 'left' | 'right') {
  ctx.save();
  ctx.fillStyle = 'rgba(20, 24, 30, 0.75)';
  ctx.fillRect(x, y, w, h);
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  const cy = y + h / 2;
  const pxPerUnit = h / (step * 8);
  ctx.strokeStyle = '#c8ced6'; ctx.fillStyle = '#c8ced6'; ctx.lineWidth = 1;
  ctx.font = `11px ${FONT}`; ctx.textBaseline = 'middle';
  if (v !== undefined && Number.isFinite(v)) {
    const lo = Math.floor((v - step * 5) / step) * step;
    for (let k = lo; k <= v + step * 5; k += step) {
      const ty = cy - (k - v) * pxPerUnit;
      const tx = side === 'left' ? x + w : x;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(tx + (side === 'left' ? -8 : 8), ty); ctx.stroke();
      ctx.textAlign = side === 'left' ? 'right' : 'left';
      ctx.fillText(String(k), side === 'left' ? x + w - 11 : x + 11, ty);
    }
  }
  ctx.restore();
  // Readout box.
  ctx.save();
  const bh = 24;
  ctx.fillStyle = '#000'; ctx.strokeStyle = FG; ctx.lineWidth = 1.5;
  ctx.fillRect(x + 2, cy - bh / 2, w - 4, bh); ctx.strokeRect(x + 2, cy - bh / 2, w - 4, bh);
  ctx.fillStyle = FG; ctx.font = `bold 14px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(v === undefined || !Number.isFinite(v) ? '---' : v.toFixed(decimals), x + w / 2, cy);
  ctx.fillStyle = '#8a94a3'; ctx.font = `10px ${FONT}`;
  ctx.fillText(unit, x + w / 2, y + h + 9);
  ctx.restore();
}

function drawHeading(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, hdg: number) {
  ctx.save();
  ctx.fillStyle = 'rgba(20, 24, 30, 0.75)';
  ctx.fillRect(x, y, w, h);
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  const cx = x + w / 2;
  const pxPerDeg = w / 90; // ±45°
  ctx.strokeStyle = '#c8ced6'; ctx.fillStyle = '#c8ced6'; ctx.lineWidth = 1;
  ctx.font = `11px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const names: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  for (let a = Math.floor((hdg - 50) / 5) * 5; a <= hdg + 50; a += 5) {
    const tx = cx + (a - hdg) * pxPerDeg;
    const n = ((a % 360) + 360) % 360;
    const major = n % 10 === 0;
    ctx.beginPath(); ctx.moveTo(tx, y + h); ctx.lineTo(tx, y + h - (major ? 8 : 4)); ctx.stroke();
    if (n % 30 === 0) ctx.fillText(names[n] ?? String(n / 10), tx, y + 3);
  }
  ctx.restore();
  ctx.save();
  ctx.fillStyle = '#000'; ctx.strokeStyle = FG; ctx.lineWidth = 1.5;
  const bw = 46;
  ctx.fillRect(cx - bw / 2, y + 1, bw, h - 2); ctx.strokeRect(cx - bw / 2, y + 1, bw, h - 2);
  ctx.fillStyle = FG; ctx.font = `bold 14px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(Math.round(((hdg % 360) + 360) % 360)).padStart(3, '0'), cx, y + h / 2);
  ctx.restore();
}
