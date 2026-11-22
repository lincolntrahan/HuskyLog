// Feature harness (v0.1.3): PCM camera audio, removing imported streams,
// the horizon for backward-facing cameras, and the workspace crop range.
// Usage: npm run build && node scripts/e2e-features.mjs
import { _electron as electron } from 'playwright-core';
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const logPath = process.env.HUSKYLOG_REF_LOG ?? join(root, 'test-data', 'logs', 'reference.bin');
const gen = join(root, 'test-data', 'generated');
const pcmPath = join(gen, 'ground_cam_pcm.mov'), aacPath = join(gen, 'ground_cam_sync.mp4');
if (!existsSync(logPath) || !existsSync(pcmPath)) { console.error('need reference log and generated clips (node scripts/gen-sync-video.mjs)'); process.exit(2); }
const truth = JSON.parse(readFileSync(join(gen, 'ground_cam_sync.truth.json'), 'utf8'));
const out = mkdtempSync(join(tmpdir(), 'hl-feat-'));
const log2Path = join(out, 'second_log.bin');
copyFileSync(logPath, log2Path);
const WAVE = truth.events.Wave;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };
const app = await electron.launch({ args: [root], env: { ...process.env, HUSKYLOG_E2E: '1', HUSKYLOG_DISPLAY: process.env.HUSKYLOG_DISPLAY ?? 'secondary' } });

const add = async (main, p) => {
  const f = await main.evaluate((x) => window.huskylog.e2eRegister(x), p);
  await main.evaluate((file) => window.dispatchEvent(new CustomEvent('hl-e2e-add', { detail: file })), f);
};
/** Beep onset minus `t` (s) in a stream's waveform, or null. */
const onset = (main, id, t) => main.evaluate(async ([id, t]) => {
  const wf = await window.__hl.mediaSource(id).getWaveform();
  if (!wf) return null;
  const i0 = Math.floor((t - 1 - wf.start) / wf.binDt);
  let noise = 0; for (let i = i0 - 100; i < i0; i++) noise = Math.max(noise, wf.rms[i] ?? 0);
  for (let i = i0; i < i0 + 400; i++) if ((wf.rms[i] ?? 0) > Math.max(0.05, noise * 4)) return wf.start + i * wf.binDt - t;
  return null;
}, [id, t]);

try {
  const main = await app.firstWindow();
  main.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 300)));
  await main.waitForFunction(() => !!window.__hl?.dock && !!window.__hl?.workspace);
  for (const p of [logPath, pcmPath]) await add(main, p);
  await main.waitForFunction(() => { const l = window.__hl.logs.getState(), m = window.__hl.media.getState(); return l.order.length && l.logs[l.order[0]].status === 'ready' && m.order.length && m.videos[m.order[0]].status === 'ready'; }, null, { timeout: 60000 });
  const ids = await main.evaluate(() => ({ log: window.__hl.logs.getState().order[0], vid: window.__hl.media.getState().order[0] }));

  // ---------------------------------------------------------------- PCM audio
  const a = await main.evaluate((id) => window.__hl.media.getState().videos[id].audio, ids.vid);
  check('PCM camera audio is recognised', a?.codec === 'pcm_s16le' && a.sampleRate === 32000 && a.channels === 1 && a.supported, JSON.stringify(a));
  const so = await onset(main, ids.vid, truth.localEvents.Wave);
  check('PCM waveform: the beep is at the flash', so !== null && Math.abs(so) < 0.02, `onset − flash = ${so?.toFixed(4)} s`);
  await main.evaluate(([ids, truth]) => {
    const h = window.__hl;
    for (const name of ['Prop start', 'Wave']) {
      const ev = h.syncStore.getState().addEvent(name);
      h.syncStore.getState().setMarker(ids.log, ev, truth.events[name]);
      h.syncStore.getState().setMarker(ids.vid, ev, truth.localEvents[name]);
    }
  }, [ids, truth]);
  // Export 4 s around the flash with the PCM audio.
  const mp4 = join(out, 'pcm.mp4');
  await main.click('button:has-text("Export video…")');
  await main.waitForSelector('.modal.export');
  await main.evaluate((p) => window.__hl.export.set(p), { windows: ['video-0'], layout: 'grid', format: 'mp4', res: '720p', fps: 30, range: [WAVE - 2, WAVE + 2], audio: ids.vid });
  await sleep(300);
  await main.evaluate((p) => window.huskylog.e2eSetDialogPaths({ export: p }), mp4);
  await main.click('.modal.export button:has-text("Export…")');
  await main.waitForFunction(() => !!window.__hl.export.getResult() || !!window.__hl.export.getError(), null, { timeout: 120000 });
  const exErr = await main.evaluate(() => window.__hl.export.getError());
  await main.click('.modal.export button:has-text("Done"), .modal.export button:has-text("Close")');
  await add(main, mp4);
  await main.waitForFunction(() => { const m = window.__hl.media.getState(); return m.order.length > 1 && m.videos[m.order[1]].status !== 'loading'; }, null, { timeout: 30000 });
  const exId = await main.evaluate(() => window.__hl.media.getState().order[1]);
  const exA = await main.evaluate((id) => window.__hl.media.getState().videos[id].audio, exId);
  check('export converts PCM audio to AAC', !exErr && exA?.codec === 'mp4a.40.2' && exA.sampleRate === 48000, exErr ?? JSON.stringify(exA));
  const eo = await onset(main, exId, 2);
  check('exported audio is in sync with the picture', eo !== null && Math.abs(eo) < 0.02, `onset − flash = ${eo?.toFixed(4)} s`);

  // ---------------------------------------------------------------- remove
  await main.click('button[role=tab]:has-text("Import")');
  await main.waitForSelector('table.files');
  const rows = await main.$$eval('table.files tbody tr', (rs) => rs.length);
  await main.click(`button[aria-label="Remove ${exId}"]`);
  await main.waitForSelector('.modal[aria-label="Remove from session"]');
  const dlg = await main.textContent('.modal[aria-label="Remove from session"]');
  await main.click('.modal[aria-label="Remove from session"] button:has-text("Remove")');
  await sleep(300);
  const afterRm = await main.evaluate((id) => ({ has: !!window.__hl.media.getState().videos[id], rows: document.querySelectorAll('table.files tbody tr').length }), exId);
  check('remove a video (confirm, then gone from the list)', /Remove pcm/.test(dlg) && !afterRm.has && afterRm.rows === rows - 1, `rows ${rows} → ${afterRm.rows}`);
  // Second log with markers, a graph line and a readout bound to it.
  await add(main, log2Path);
  await main.waitForFunction(() => { const l = window.__hl.logs.getState(); return l.order.length > 1 && l.logs[l.order[1]].status === 'ready'; }, null, { timeout: 60000 });
  const log2 = await main.evaluate(() => window.__hl.logs.getState().order[1]);
  await main.evaluate((log2) => {
    const h = window.__hl, ev = h.syncStore.getState().events[0].id;
    h.syncStore.getState().setMarker(log2, ev, 314);
    const g = h['graph:graph-0'];
    g.setCfg({ ...g.getCfg(), series: [{ id: 'ATT.Roll', color: '#ff5c8a', axis: 'auto', visible: true }, { id: 'ATT.Pitch', stream: log2, color: '#4ea1ff', axis: 'auto', visible: true }] });
    h.overlays.getState().add('video-0', { id: 'ro2', kind: 'readout', stream: log2, rect: { x: 0.05, y: 0.05, w: 0.3, h: 0.2 }, style: { color: '#ffffff', bg: '#000000', opacity: 0.6, align: 'left' }, lines: [{ label: 'Alt', source: 'POS.RelHomeAlt', format: '%.1f', unit: 'm' }] });
  }, log2);
  await sleep(500);
  await main.click(`button[aria-label="Remove ${log2}"]`);
  const dlg2 = await main.textContent('.modal[aria-label="Remove from session"]');
  await main.click('.modal[aria-label="Remove from session"] button:has-text("Remove")');
  await sleep(500);
  const rm2 = await main.evaluate((log2) => {
    const h = window.__hl;
    return { has: !!h.logs.getState().logs[log2], markers: h.syncStore.getState().markers[log2], series: h['graph:graph-0'].getCfg().series.map((s) => s.id), ro: h.overlays.getState().byWindow['video-0'].find((o) => o.id === 'ro2')?.stream ?? null };
  }, log2);
  check('remove a log: its markers, graph line and readout binding go with it', /1 sync marker/.test(dlg2) && /1 readout/.test(dlg2) && !rm2.has && rm2.markers === undefined && rm2.series.join() === 'ATT.Roll' && rm2.ro === null, JSON.stringify(rm2));
  await add(main, log2Path);
  await main.waitForFunction(() => window.__hl.logs.getState().order.length > 1, null, { timeout: 30000 });
  check('a removed file can be added again', true);
  const log2b = await main.evaluate(() => window.__hl.logs.getState().order[1]);
  await main.evaluate((id) => window.__hl.removeStream(id), log2b);

  // ---------------------------------------------------------------- horizon for a backward camera
  await main.click('button[role=tab]:has-text("Review")');
  const tRoll = await main.evaluate(async (log) => {
    // A clear bank with the nose near level, so the horizon stays inside the box both ways.
    const ch = await window.__hl.loadChannel({ stream: log, id: 'ATT.Roll' });
    const pi = await window.__hl.loadChannel({ stream: log, id: 'ATT.Pitch' });
    let best = -1;
    for (let i = 0; i < ch.v.length; i++) {
      const r = Math.abs(ch.v[i]);
      if (r < 15 || r > 30) continue;
      const k = Math.min(pi.t.length - 1, Math.max(0, pi.t.findIndex((x) => x >= ch.t[i])));
      if (Math.abs(pi.v[k]) < 3 && (best < 0 || r > Math.abs(ch.v[best]))) best = i;
    }
    return { t: ch.t[best], roll: ch.v[best] };
  }, ids.log);
  await main.evaluate((t) => {
    const h = window.__hl;
    h.overlays.getState().add('video-0', { id: 'hz', kind: 'adi', rect: { x: 0.3, y: 0.2, w: 0.4, h: 0.6 }, style: { color: '#ffffff', bg: '#000000', opacity: 0 }, hud: false, tapes: false });
    h.timeline.getState().setT(t);
  }, tRoll.t);
  /** Horizon slope in the overlay canvas: + when the right side is lower. */
  const slope = () => main.evaluate(() => {
    const c = document.querySelector('.overlay-layer[data-window="video-0"] canvas.overlay-canvas');
    const g = c.getContext('2d'), W = c.width, H = c.height;
    const x0 = 0.3 * W, w = 0.4 * W, y0 = 0.2 * H, h = 0.6 * H;
    const edge = (fx) => {
      const x = Math.round(x0 + w * fx);
      const col = g.getImageData(x, Math.round(y0), 1, Math.round(h)).data;
      for (let y = 1; y < col.length / 4; y++) { const r = col[y * 4], b = col[y * 4 + 2]; if (r > b + 20) return y; } // sky (blue) above, ground (brown) below
      return -1;
    };
    return edge(0.65) - edge(0.35);
  });
  await sleep(600);
  const fwd = await slope();
  await main.evaluate(() => window.__hl.overlays.getState().patch('video-0', 'hz', { facing: 'backward' }));
  await sleep(600);
  const back = await slope();
  check('horizon: "camera faces backward" mirrors the roll', fwd !== 0 && Math.sign(fwd) === -Math.sign(back) && Math.abs(Math.abs(fwd) - Math.abs(back)) <= 3, `roll ${tRoll.roll.toFixed(1)}°: slope forward ${fwd} px, backward ${back} px`);

  // ---------------------------------------------------------------- crop
  const full = await main.evaluate(() => window.__hl.timeDomain());
  const scrub = await main.$('.scrub-wrap');
  const sb = await scrub.boundingBox();
  await main.mouse.move(sb.x + sb.width * 0.3, sb.y + sb.height / 2);
  await main.mouse.down({ button: 'right' });
  await main.mouse.move(sb.x + sb.width * 0.5, sb.y + sb.height / 2, { steps: 5 });
  await main.mouse.up({ button: 'right' });
  await sleep(300);
  const c1 = await main.evaluate(() => ({ crop: window.__hl.timeline.getState().crop, dom: window.__hl.timeDomain(), pill: document.querySelector('.crop-pill')?.textContent ?? '' }));
  const want = [full[0] + 0.3 * (full[1] - full[0]), full[0] + 0.5 * (full[1] - full[0])];
  check('right-drag on the timeline crops the workspace', c1.crop && Math.abs(c1.crop[0] - want[0]) < (full[1] - full[0]) * 0.02 && Math.abs(c1.crop[1] - want[1]) < (full[1] - full[0]) * 0.02 && c1.dom[0] === c1.crop[0] && /Cropped/.test(c1.pill), `${c1.crop?.map((x) => x.toFixed(1))} (wanted ≈ ${want.map((x) => x.toFixed(1))})`);
  // Right-drag on the graph narrows it further; the graph's x range follows; the legend shows averages.
  const over = await main.$('[data-testid="graph-0"] .u-over, .dv-react-part .u-over');
  const ob = await over.boundingBox();
  await main.mouse.move(ob.x + ob.width * 0.25, ob.y + ob.height / 2);
  await main.mouse.down({ button: 'right' });
  await main.mouse.move(ob.x + ob.width * 0.75, ob.y + ob.height / 2, { steps: 5 });
  await main.mouse.up({ button: 'right' });
  await sleep(800);
  const c2 = await main.evaluate(async (log) => {
    const h = window.__hl, crop = h.timeline.getState().crop;
    const g = document.querySelector('.u-over').closest('.hl-panel');
    const avg = g.querySelector('.chip-avg')?.textContent ?? '';
    const ch = await h.loadChannel({ stream: log, id: 'ATT.Roll' });
    let s = 0, n = 0; for (let i = 0; i < ch.t.length; i++) if (ch.t[i] >= crop[0] && ch.t[i] <= crop[1]) { s += ch.v[i]; n++; }
    return { crop, avg, mean: s / n, stats: !!g.querySelector('.stats'), statsHead: g.querySelector('.stats th')?.textContent ?? '' };
  }, ids.log);
  const shown = Number((c2.avg.match(/-?[\d.]+/) ?? [NaN])[0]);
  check('right-drag on a graph crops further', c2.crop[0] > c1.crop[0] && c2.crop[1] < c1.crop[1], c2.crop.map((x) => x.toFixed(2)).join(' → '));
  check('graph legend shows each line\'s average over the crop', Math.abs(shown - c2.mean) < Math.max(0.01, Math.abs(c2.mean) * 0.01), `legend "${c2.avg}", computed ${c2.mean.toFixed(3)}`);
  check('crop stats table (mean, min, max)', c2.stats && /Crop/.test(c2.statsHead), c2.statsHead);
  // Export dialogs: "Crop to range" ticked, range = crop.
  await main.click('button:has-text("Export video…")');
  await main.waitForSelector('.modal.export');
  const ev = await main.evaluate(() => ({ chk: document.querySelector('.modal.export input[aria-label="Crop to range"]')?.checked ?? null, a: document.querySelector('input[aria-label="Export start"]').value, b: document.querySelector('input[aria-label="Export end"]').value }));
  await main.click('.modal.export input[aria-label="Crop to range"]');
  const ev2 = await main.evaluate(() => ({ a: document.querySelector('input[aria-label="Export start"]').value }));
  await main.click('.modal.export button:has-text("Close"), .modal.export button:has-text("Cancel")');
  const fmt = (t) => { const m = Math.floor(t / 60); return `${m}:${(t - m * 60).toFixed(3).padStart(6, '0')}`; };
  check('video export: "Crop to range" sets the export range', ev.chk === true && ev.a === fmt(c2.crop[0]) && ev.b === fmt(c2.crop[1]) && ev2.a !== ev.a, `${ev.a} → ${ev.b}, unticked start ${ev2.a}`);
  await main.click('button:has-text("Export CSV…")');
  const csv = await main.evaluate(() => ({ chk: document.querySelector('.modal[aria-label="Export CSV"] input[aria-label="Crop to range"]')?.checked ?? null, text: document.querySelector('.modal[aria-label="Export CSV"] p.muted')?.textContent ?? '' }));
  await main.click('.modal[aria-label="Export CSV"] button:has-text("Cancel")');
  check('CSV export: "Crop to range" exports the crop', csv.chk === true && csv.text.startsWith('crop range') && csv.text.includes(fmt(c2.crop[0])), csv.text);
  const saved = await main.evaluate(() => window.__hl.workspace.captureWorkspace().ui.crop);
  check('the crop is saved with the workspace', saved && saved[0] === c2.crop[0] && saved[1] === c2.crop[1]);
  await main.click('button[aria-label="Clear crop"]');
  const c3 = await main.evaluate(() => ({ crop: window.__hl.timeline.getState().crop, dom: window.__hl.timeDomain() }));
  check('× on the crop shows the whole flight again', c3.crop === null && c3.dom[0] === full[0] && c3.dom[1] === full[1]);
} finally {
  await app.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
