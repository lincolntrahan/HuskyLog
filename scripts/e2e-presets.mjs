// Readout presets + AETR-in-PWM harness (v0.1.9).
// Usage: npm run build && node scripts/e2e-presets.mjs
import { _electron as electron } from 'playwright-core';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const logPath = process.env.HUSKYLOG_REF_LOG ?? join(root, 'test-data', 'logs', 'reference.bin');
const vidPath = join(root, 'test-data', 'generated', 'ground_cam_sync.mp4');
if (!existsSync(logPath) || !existsSync(vidPath)) { console.error('need reference log and generated clip'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };
const launch = () => electron.launch({ args: [root], env: { ...process.env, HUSKYLOG_E2E: '1', HUSKYLOG_DISPLAY: process.env.HUSKYLOG_DISPLAY ?? 'secondary' } });
const ED = '.overlay-editor';

async function boot(app) {
  const main = await app.firstWindow();
  main.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 300)));
  await main.waitForFunction(() => !!window.__hl?.dock);
  for (const p of [logPath, vidPath]) {
    const f = await main.evaluate((x) => window.huskylog.e2eRegister(x), p);
    await main.evaluate((file) => window.dispatchEvent(new CustomEvent('hl-e2e-add', { detail: file })), f);
  }
  await main.waitForFunction(() => { const l = window.__hl.logs.getState(); return l.order.length && l.logs[l.order[0]].status === 'ready'; }, null, { timeout: 60000 });
  return main;
}

let app = await launch();
try {
  const main = await boot(app);
  const log = await main.evaluate(() => window.__hl.logs.getState().order[0]);

  // ---------------------------------------------------------------- AETR in PWM
  const aetr = await main.evaluate(async (log) => {
    const out = {};
    for (const f of ['Ail', 'Elev', 'Rudd', 'Thr', 'Flap']) {
      const c = await window.__hl.loadChannel({ stream: log, id: `AETR.${f}` });
      let mn = 1e9, mx = -1e9; for (const v of c.v) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
      out[f] = { mn, mx, unit: c.unit, sumUnit: window.__hl.logs.getState().logs[log].summary.channels.find((x) => x.id === `AETR.${f}`)?.unit };
    }
    // Expressions see the same values.
    out.expr = await window.__hl.loadExpression?.(log, 'AETR.Ail', {}).then((s) => s && [Math.min(...s.v.slice(0, 2000)), Math.max(...s.v.slice(0, 2000))]).catch(() => null);
    return out;
  }, log);
  check('AETR aileron/elevator/rudder read 1000–2000 µs', ['Ail', 'Elev', 'Rudd'].every((f) => aetr[f].mn >= 999.9 && aetr[f].mx <= 2000.1 && aetr[f].mx > 1900 && aetr[f].unit === 'us' && aetr[f].sumUnit === 'us'), JSON.stringify({ Ail: aetr.Ail, Rudd: aetr.Rudd }));
  check('AETR throttle reads 1000–2000 µs (from 0–100 %)', aetr.Thr.mn === 1000 && aetr.Thr.mx > 1900 && aetr.Thr.mx <= 2000 && aetr.Thr.unit === 'us', JSON.stringify(aetr.Thr));
  check('other fields are unchanged (AETR.Flap still 0–100)', aetr.Flap.mx <= 100 && aetr.Flap.unit !== 'us', JSON.stringify(aetr.Flap));

  // ---------------------------------------------------------------- built-in presets
  await main.evaluate(() => { window.__hl.timeline.getState().setT(400); window.__hl.overlays.getState().setEditing('video-0'); });
  await sleep(400);
  await main.click('.overlay-layer[data-window="video-0"] button:has-text("＋ Widget")');
  await sleep(300);
  const sel = () => main.evaluate(() => { const s = window.__hl.overlays.getState(); return s.byWindow['video-0'].find((o) => o.id === s.selected); });
  const before = await sel();
  const opts = await main.$$eval(`${ED} select[aria-label="Readout preset"] option`, (os) => os.map((o) => o.value).filter(Boolean));
  check('built-in presets offered: Propulsion, Flight state, Radio', ['Propulsion', 'Flight state', 'Radio'].every((n) => opts.includes(n)), opts.join(', '));
  const apply = async (name, how = 'Replace lines') => { await main.selectOption(`${ED} select[aria-label="Readout preset"]`, name); await main.click(`${ED} button:has-text("${how}")`); await sleep(1200); return sel(); };
  const values = (item) => main.evaluate((item) => item.lines.map((l) => { const v = window.__hl.lineValue(l, item, 400); return `${l.label}=${v.text}${v.error ? '!' : ''}`; }), item);
  const prop = await apply('Propulsion');
  const pv = await values(prop);
  check('Propulsion: 8 lines from this log\'s channels', prop.lines.map((l) => l.source).join('|') === 'ESC.RPM|BAT.Volt|BAT.Curr|BAT.Volt * BAT.Curr|CTUN.ThO|ESC.Temp|BAT.CurrTot * 1000|BAT.EnrgTot', prop.lines.map((l) => l.source).join(' | '));
  check('Propulsion: every line has a value', pv.every((s) => !s.includes('!') && !s.endsWith('=?')), pv.join('  '));
  check('applying grows the widget to fit the lines', prop.rect.h > before.rect.h, `${before.rect.h.toFixed(2)} → ${prop.rect.h.toFixed(2)}`);
  const fl = await apply('Flight state');
  const fv = await values(fl);
  check('Flight state: altitude, airspeed, G, climb, ground speed (all valued)', fl.lines.length === 5 && fl.lines[2].source.startsWith('hypot(') && fl.lines[3].source === '-XKF1.VD' && fv.every((s) => !s.includes('!')), fv.join('  '));
  const ra = await apply('Radio', 'Add lines');
  const rv = await values(ra);
  check('Radio added below: RSSI and link quality found; dBm and packet rate left to pick', ra.lines.length === 9 && ra.lines[5].source === 'RSSI.RXRSSI * 100' && ra.lines[6].source === '' && ra.lines[7].source === 'RSSI.RXLQ' && ra.lines[8].source === '', rv.slice(5).join('  '));

  // ---------------------------------------------------------------- your own presets
  await main.click(`${ED} button:has-text("Save lines as preset…")`);
  await main.fill(`${ED} input[aria-label="Preset name"]`, 'E2E test set');
  await main.click(`${ED} button:has-text("Save")`);
  await sleep(200);
  const mine1 = await main.$$eval(`${ED} select[aria-label="Readout preset"] optgroup[label="Mine"] option`, (os) => os.map((o) => o.value));
  check('save lines as a preset of your own', mine1.includes('E2E test set'), mine1.join(', '));
  // Edit: drop a line, update the preset, apply it to a fresh widget.
  await main.evaluate(() => { const s = window.__hl.overlays.getState(); const it = s.byWindow['video-0'].find((o) => o.id === s.selected); s.patch('video-0', it.id, { lines: it.lines.slice(0, 3) }); });
  await sleep(200);
  await main.click(`${ED} button:has-text("Update")`);
  await main.click('.overlay-layer[data-window="video-0"] button:has-text("＋ Widget")');
  await sleep(300);
  const fresh = await apply('E2E test set');
  check('update your preset, then apply it elsewhere', fresh.lines.length === 3 && fresh.lines[0].source === 'altitude' || (fresh.lines.length === 3 && fresh.lines[0].label === 'Altitude'), fresh.lines.map((l) => l.label).join(', '));
} finally { await app.close(); }

// Your presets survive a restart; then delete it.
app = await launch();
try {
  const main = await boot(app);
  await main.evaluate(() => window.__hl.overlays.getState().setEditing('video-0'));
  await sleep(300);
  await main.click('.overlay-layer[data-window="video-0"] button:has-text("＋ Widget")');
  await sleep(300);
  const kept = await main.$$eval(`${ED} select[aria-label="Readout preset"] optgroup[label="Mine"] option`, (os) => os.map((o) => o.value));
  check('your presets are still there after a restart', kept.includes('E2E test set'), kept.join(', '));
  await main.selectOption(`${ED} select[aria-label="Readout preset"]`, 'E2E test set');
  await main.click(`${ED} button:has-text("Delete")`);
  await sleep(200);
  const gone = await main.$$eval(`${ED} select[aria-label="Readout preset"] option`, (os) => os.map((o) => o.value));
  check('delete your preset', !gone.includes('E2E test set'), gone.join(', '));
} finally { await app.close(); }
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
