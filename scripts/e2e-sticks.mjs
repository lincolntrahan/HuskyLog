// Pilot-sticks overlay harness (v0.1.6): stick dots and channel 5–8 sliders
// against positions computed independently from the log's RCIN and RC params.
// Usage: npm run build && node scripts/e2e-sticks.mjs
import { _electron as electron } from 'playwright-core';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const shots = join(root, '.e2e');
mkdirSync(shots, { recursive: true });
const logPath = process.env.HUSKYLOG_REF_LOG ?? join(root, 'test-data', 'logs', 'reference.bin');
const vidPath = join(root, 'test-data', 'generated', 'ground_cam_sync.mp4');
if (!existsSync(logPath) || !existsSync(vidPath)) { console.error('need reference log and generated clip'); process.exit(2); }
const truth = JSON.parse(readFileSync(vidPath.replace('.mp4', '.truth.json'), 'utf8'));
const out = mkdtempSync(join(tmpdir(), 'hl-sticks-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };
const app = await electron.launch({ args: [root], env: { ...process.env, HUSKYLOG_E2E: '1', HUSKYLOG_DISPLAY: process.env.HUSKYLOG_DISPLAY ?? 'secondary' } });

const RECT = { x: 0.05, y: 0.05, w: 0.6, h: 0.6 };

try {
  const main = await app.firstWindow();
  main.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 300)));
  await main.waitForFunction(() => !!window.__hl?.dock);
  for (const p of [logPath, vidPath]) {
    const f = await main.evaluate((x) => window.huskylog.e2eRegister(x), p);
    await main.evaluate((file) => window.dispatchEvent(new CustomEvent('hl-e2e-add', { detail: file })), f);
  }
  await main.waitForFunction(() => { const l = window.__hl.logs.getState(), m = window.__hl.media.getState(); return l.order.length && l.logs[l.order[0]].status === 'ready' && m.order.length && m.videos[m.order[0]].status === 'ready'; }, null, { timeout: 60000 });
  const ids = await main.evaluate(() => ({ log: window.__hl.logs.getState().order[0], vid: window.__hl.media.getState().order[0] }));
  await main.evaluate(([ids, truth]) => {
    const h = window.__hl;
    for (const name of ['Prop start', 'Wave']) { const ev = h.syncStore.getState().addEvent(name); h.syncStore.getState().setMarker(ids.log, ev, truth.events[name]); h.syncStore.getState().setMarker(ids.vid, ev, truth.localEvents[name]); }
  }, [ids, truth]);
  await main.evaluate(() => window.__hl.dock.getPanel('video-0').api.setSize({ width: 900, height: 600 }));

  // Moments with clear inputs: full throttle with right aileron, and low throttle with a big left/right stick.
  const pick = await main.evaluate(async ([log, t0, t1]) => {
    const ch = async (n) => window.__hl.loadChannel({ stream: log, id: `RCIN.C${n}` });
    const [c1, c2, c3, c4, c5, c6, c7, c8] = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(ch));
    const at = (c, t) => { let lo = 0, hi = c.t.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (c.t[m] <= t) lo = m; else hi = m - 1; } return c.v[lo]; };
    let best = null, score = -1;
    for (let i = 0; i < c3.t.length; i += 10) {
      const t = c3.t[i];
      if (t < t0 || t > t1) continue;
      const s = (at(c3, t) - 988) / 1023 + Math.abs(at(c1, t) - 1500) / 511 + Math.abs(at(c2, t) - 1500) / 511 + Math.abs(at(c4, t) - 1500) / 511;
      if (s > score) { score = s; best = t; }
    }
    const pw = (t) => ({ c1: at(c1, t), c2: at(c2, t), c3: at(c3, t), c4: at(c4, t), c5: at(c5, t), c6: at(c6, t), c7: at(c7, t), c8: at(c8, t) });
    return { t: best, pwm: pw(best) };
  }, [ids.log, truth.events['Prop start'], truth.events['Prop start'] + 100]);
  console.log(`  moment ${pick.t.toFixed(2)} s: ${JSON.stringify(pick.pwm)}`);
  await main.evaluate(([t, rect]) => {
    const h = window.__hl;
    h.overlays.getState().add('video-0', { id: 'st', kind: 'sticks', rect, style: { color: '#ffffff', bg: '#000000', opacity: 0.5, align: 'left' }, stickMode: 2, aux: true, values: true });
    h.timeline.getState().setT(t);
  }, [pick.t, RECT]);
  await sleep(1200);

  /** Yellow dot centroids per gimbal and the aux bar fills, from the overlay canvas (layout mirrors drawSticksOverlay). */
  const measure = () => main.evaluate((rect) => {
    const c = document.querySelector('.overlay-layer[data-window="video-0"] canvas.overlay-canvas');
    const dpr = c.width / c.clientWidth;
    const g2 = c.getContext('2d');
    const x = rect.x * c.clientWidth, y = rect.y * c.clientHeight, w = rect.w * c.clientWidth, h = rect.h * c.clientHeight;
    const pad = Math.max(3, Math.min(w, h) * 0.05), fs = Math.max(8, Math.min(14, Math.min(w, h) * 0.065));
    const labelH = fs * 1.5 * 2, auxH = Math.max(fs * 3.2, h * 0.28), gArea = h - auxH - 2 * pad;
    const g = Math.max(10, Math.min((w - 3 * pad) / 2, gArea - labelH));
    const gy = y + pad + Math.max(0, (gArea - labelH - g) / 2), gx = [x + (w - 2 * g - pad) / 2, x + (w - 2 * g - pad) / 2 + g + pad];
    const yellow = (r, gg, b) => r > 240 && gg > 190 && gg < 215 && b < 30;
    const dots = gx.map((ox) => {
      const d = g2.getImageData(Math.round(ox * dpr), Math.round(gy * dpr), Math.round(g * dpr), Math.round(g * dpr)).data;
      const W = Math.round(g * dpr);
      let sx = 0, sy = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) if (yellow(d[i], d[i + 1], d[i + 2])) { const p = i / 4; sx += p % W; sy += Math.floor(p / W); n++; }
      if (!n) return null;
      const inner = g / 2 - g * 0.1;
      return { x: (sx / n / dpr - g / 2) / inner, y: -(sy / n / dpr - g / 2) / inner, n };
    });
    // Aux bars: fraction of the bar row that is yellow.
    const top = y + h - pad - auxH + fs * 0.3, rowH = (auxH - fs * 0.3) / 2, colW = (w - 3 * pad) / 2;
    g2.save(); g2.font = `${fs * 0.85}px Segoe UI, system-ui, sans-serif`; const lw = g2.measureText('CH8 ').width; const vw = g2.measureText(' 2000').width; g2.restore();
    const aux = [0, 1, 2, 3].map((i) => {
      const cx = x + pad + (i % 2) * (colW + pad), cy = top + Math.floor(i / 2) * rowH + rowH / 2;
      const bx = cx + lw, bw = Math.max(10, colW - lw - vw);
      const row = g2.getImageData(Math.round(bx * dpr), Math.round(cy * dpr), Math.round(bw * dpr), 1).data;
      let last = -1; for (let k = 0; k < row.length / 4; k++) if (yellow(row[k * 4], row[k * 4 + 1], row[k * 4 + 2])) last = k;
      return (last + 1) / (row.length / 4);
    });
    return { dots, aux };
  }, RECT);

  // Expected, from the log's parameters (AETR, RC1-4 988/1500/2011, RC5-8 1100/1500/1900; throttle trim = min).
  const cen = (v) => Math.max(-1, Math.min(1, v >= 1500 ? (v - 1500) / 511 : (v - 1500) / 512));
  const thr = (v) => Math.max(0, Math.min(1, (v - 988) / 1023)) * 2 - 1;
  const aux = (v) => Math.max(0, Math.min(1, (v - 1100) / 800));
  const p = pick.pwm;
  const want2 = { left: { x: cen(p.c4), y: thr(p.c3) }, right: { x: cen(p.c1), y: -cen(p.c2) } };
  const m2 = await measure();
  const near = (a, b) => a && Math.abs(a.x - b.x) < 0.08 && Math.abs(a.y - b.y) < 0.08;
  const fmt = (d) => (d ? `${d.x.toFixed(2)},${d.y.toFixed(2)}` : 'none');
  check('mode 2: left stick = rudder + throttle', near(m2.dots[0], want2.left), `dot ${fmt(m2.dots[0])} want ${fmt(want2.left)}`);
  check('mode 2: right stick = aileron + elevator (forward = up)', near(m2.dots[1], want2.right), `dot ${fmt(m2.dots[1])} want ${fmt(want2.right)}`);
  const wantAux = [p.c5, p.c6, p.c7, p.c8].map(aux);
  check('channel 5–8 sliders match RCIN C5–C8', m2.aux.every((f, i) => Math.abs(f - Math.max(wantAux[i], 0.02)) < 0.06), `bars ${m2.aux.map((f) => f.toFixed(2)).join(' ')} want ${wantAux.map((f) => f.toFixed(2)).join(' ')}`);
  const shot = join(shots, 'sticks-overlay.png');
  const stage = await main.$('.dv-react-part .video-stage');
  await stage.screenshot({ path: shot });
  // Mode 1 swaps throttle and elevator.
  await main.evaluate(() => window.__hl.overlays.getState().patch('video-0', 'st', { stickMode: 1 }));
  await sleep(500);
  const m1 = await measure();
  check('mode 1: throttle on the right stick, elevator on the left', near(m1.dots[0], { x: cen(p.c4), y: -cen(p.c2) }) && near(m1.dots[1], { x: cen(p.c1), y: thr(p.c3) }), `left ${fmt(m1.dots[0])} right ${fmt(m1.dots[1])}`);
  await main.evaluate(() => window.__hl.overlays.getState().patch('video-0', 'st', { stickMode: 2, flipElevator: true }));
  await sleep(500);
  const mf = await measure();
  check('"flip elevator" mirrors only the elevator axis', near(mf.dots[1], { x: cen(p.c1), y: cen(p.c2) }) && near(mf.dots[0], want2.left), `right ${fmt(mf.dots[1])}`);
  await main.evaluate(() => window.__hl.overlays.getState().patch('video-0', 'st', { flipElevator: false }));
  // Export: the overlay is drawn into the video (same code as on screen).
  const mp4 = join(out, 'sticks.mp4');
  await main.click('button:has-text("Export video…")');
  await main.waitForSelector('.modal.export');
  await main.evaluate((p) => window.__hl.export.set(p), { windows: ['video-0'], layout: 'grid', format: 'mp4', res: '720p', fps: 30, range: [pick.t - 0.5, pick.t + 0.5], audio: '' });
  await sleep(300);
  await main.evaluate((p) => window.huskylog.e2eSetDialogPaths({ export: p }), mp4);
  await main.click('.modal.export button:has-text("Export…")');
  await main.waitForFunction(() => !!window.__hl.export.getResult() || !!window.__hl.export.getError(), null, { timeout: 120000 });
  await main.click('.modal.export button:has-text("Done"), .modal.export button:has-text("Close")');
  const f = await main.evaluate((x) => window.huskylog.e2eRegister(x), mp4);
  await main.evaluate((file) => window.dispatchEvent(new CustomEvent('hl-e2e-add', { detail: file })), f);
  await main.waitForFunction(() => window.__hl.media.getState().order.length > 1 && window.__hl.media.getState().videos[window.__hl.media.getState().order[1]].status === 'ready', null, { timeout: 30000 });
  const yellowPx = await main.evaluate(async () => {
    const id = window.__hl.media.getState().order[1];
    const bmp = await window.__hl.mediaSource(id).frame(15);
    const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
    let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 220 && d[i + 1] > 170 && d[i + 1] < 225 && d[i + 2] < 70) n++;
    return n;
  });
  check('exported video shows the sticks overlay', yellowPx > 200, `${yellowPx} stick-yellow pixels`);
  const saved = await main.evaluate(() => window.__hl.dock.getPanel('video-0').params?.overlays?.find((o) => o.id === 'st'));
  check('the sticks overlay is saved with the window', saved?.kind === 'sticks' && saved.aux === true, JSON.stringify(saved && { kind: saved.kind, mode: saved.stickMode }));
  console.log(`  screenshot: ${shot}`);
} finally {
  await app.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
