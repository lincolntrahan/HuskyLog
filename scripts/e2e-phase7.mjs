// Phase 7 harness: MP4 / GIF export of window compositions.
// Done-when (DESIGN §14): a 60 s 1080p composite (video + ADI overlay + graph)
// exports correctly. The exported file is decoded back and checked frame by
// frame against the known sync truth (flash + beep at log 400.00 s).
// Usage: npm run build && node scripts/e2e-phase7.mjs
import { _electron as electron } from 'playwright-core';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const shots = join(root, '.e2e');
mkdirSync(shots, { recursive: true });
const logPath = process.env.HUSKYLOG_REF_LOG ?? join(root, 'test-data', 'logs', 'reference.bin');
const vidPath = join(root, 'test-data', 'generated', 'ground_cam_sync.mp4');
if (!existsSync(logPath) || !existsSync(vidPath)) { console.error('need reference log and generated clip (node scripts/gen-sync-video.mjs)'); process.exit(2); }
const truth = JSON.parse(readFileSync(vidPath.replace('.mp4', '.truth.json'), 'utf8'));
const out = mkdtempSync(join(tmpdir(), 'hl-p7-'));
const WAVE = truth.events.Wave; // 400.00 s (log/master time)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };
const exe = process.env.HUSKYLOG_EXE;
const app = await electron.launch({
  ...(exe ? { executablePath: exe, args: [] } : { args: [root] }),
  env: { ...process.env, HUSKYLOG_E2E: '1', HUSKYLOG_DISPLAY: process.env.HUSKYLOG_DISPLAY ?? 'secondary' },
});

/** Opens the export dialog, applies options, exports to `file`; returns the result. */
async function doExport(main, set, file, { cancelAfter } = {}) {
  await main.click('button:has-text("Export video…")');
  await main.waitForSelector('.modal.export');
  await main.evaluate((p) => window.__hl.export.set(p), set);
  await sleep(300);
  await main.evaluate((p) => window.huskylog.e2eSetDialogPaths({ export: p }), file);
  const t0 = Date.now();
  await main.click('.modal.export button:has-text("Export…")');
  if (cancelAfter) {
    await main.waitForFunction((n) => (window.__hl.export.getProgress()?.frame ?? 0) >= n, cancelAfter, { timeout: 60000 });
    await main.click('.modal.export button:has-text("Cancel")');
  }
  await main.waitForFunction(() => !!window.__hl.export.getResult() || !!window.__hl.export.getError(), null, { timeout: 900000 });
  const r = await main.evaluate(() => ({ result: window.__hl.export.getResult(), error: window.__hl.export.getError(), layout: window.__hl.export.layout(), opts: window.__hl.export.getOptions() }));
  r.seconds = (Date.now() - t0) / 1000;
  await main.click('.modal.export button:has-text("Done"), .modal.export button:has-text("Close")');
  return r;
}

/** Loads an exported MP4 as a new video stream and returns its id + info. */
async function openExported(main, file) {
  const f = await main.evaluate((x) => window.huskylog.e2eRegister(x), file);
  const before = await main.evaluate(() => window.__hl.media.getState().order.length);
  await main.evaluate((file) => window.dispatchEvent(new CustomEvent('hl-e2e-add', { detail: file })), f);
  await main.waitForFunction((n) => { const m = window.__hl.media.getState(); return m.order.length > n && m.videos[m.order[n]].status !== 'loading'; }, before, { timeout: 30000 });
  return main.evaluate((n) => { const m = window.__hl.media.getState(); const v = m.videos[m.order[n]]; return { id: v.id, video: v.video, audio: v.audio, error: v.error }; }, before);
}

/** Mean brightness (and white-pixel share) of a region of exported frame i. */
const regionStats = (main, id, i, r) => main.evaluate(async ([id, i, r]) => {
  const bmp = await window.__hl.mediaSource(id).frame(i);
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
  const d = g.getImageData(Math.round(r.x), Math.round(r.y), Math.max(1, Math.round(r.w)), Math.max(1, Math.round(r.h))).data;
  let s = 0, s2 = 0, white = 0; const n = d.length / 4;
  for (let k = 0; k < d.length; k += 4) { const v = (d[k] + d[k + 1] + d[k + 2]) / 3; s += v; s2 += v * v; if (d[k] > 225 && d[k + 1] > 225 && d[k + 2] > 225) white++; }
  const mean = s / n;
  return { mean, std: Math.sqrt(Math.max(0, s2 / n - mean * mean)), white: white / n };
}, [id, i, r]);

try {
  const main = await app.firstWindow();
  main.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 300)));
  await main.waitForFunction(() => !!window.__hl?.dock && !!window.__hl?.workspace);
  for (const p of [logPath, vidPath]) {
    const f = await main.evaluate((x) => window.huskylog.e2eRegister(x), p);
    await main.evaluate((file) => window.dispatchEvent(new CustomEvent('hl-e2e-add', { detail: file })), f);
  }
  await main.waitForFunction(() => { const l = window.__hl.logs.getState(), m = window.__hl.media.getState(); return l.order.length && l.logs[l.order[0]].status === 'ready' && m.order.length && m.videos[m.order[0]].status === 'ready'; }, null, { timeout: 60000 });
  const ids = await main.evaluate(() => ({ log: window.__hl.logs.getState().order[0], vid: window.__hl.media.getState().order[0] }));
  await main.evaluate(([ids, truth]) => {
    const h = window.__hl;
    for (const name of ['Prop start', 'Wave']) {
      const ev = h.syncStore.getState().addEvent(name);
      h.syncStore.getState().setMarker(ids.log, ev, truth.events[name]);
      h.syncStore.getState().setMarker(ids.vid, ev, truth.localEvents[name]);
    }
    const g = h['graph:graph-0'];
    g.setCfg({ ...g.getCfg(), series: [{ id: 'ATT.Roll', color: '#ff5c8a', axis: 'auto', visible: true }, { id: 'ATT.Pitch', color: '#4ea1ff', axis: 'auto', visible: true }] });
    const st = h.overlays.getState();
    st.add('video-0', { id: 'ro', kind: 'readout', rect: { x: 0.03, y: 0.62, w: 0.3, h: 0.3 }, style: { color: '#ffffff', bg: '#000000', opacity: 0.6, align: 'left' }, lines: [{ label: 'Alt', source: 'POS.RelHomeAlt', format: '%.1f', unit: 'm' }, { label: 'Mode', source: '@mode', format: '' }] });
    st.add('video-0', { id: 'hud', kind: 'adi', rect: { x: 0.55, y: 0.35, w: 0.42, h: 0.6 }, style: { color: '#ffffff', bg: '#000000', opacity: 0 }, hud: true, tapes: false });
    h.timeline.getState().setT(355.5);
  }, [ids, truth]);
  await sleep(2500);
  const tBefore = await main.evaluate(() => window.__hl.timeline.getState().t);

  // ---- The done-when export: 60 s, 1080p30, video (with HUD + readout overlays) + graph, audio ----
  await main.click('button:has-text("Export video…")');
  await main.waitForSelector('.modal.export');
  const listed = await main.$$eval('.modal.export input[aria-label^="Export "]', (els) => els.map((e) => e.getAttribute('aria-label')));
  check('export dialog lists the exportable windows', listed.length >= 4 && listed.some((l) => /video-0/.test(l)) && listed.some((l) => /graph-0/.test(l)) && listed.some((l) => /map3d-0/.test(l)), listed.join(' | '));
  await sleep(800);
  const prevOk = await main.$eval('.ex-preview canvas', (c) => { const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; return c.width > 0 && s / (d.length / 4) > 10; });
  check('dialog shows a live preview of the composite', prevOk);
  await main.screenshot({ path: join(shots, 'p7-dialog.png') });
  await main.click('.modal.export button:has-text("Close")');

  const T0 = 348, T1 = 408; // 60 s, the "Wave" flash at 400 s is at output 52.000 s
  const mp4 = join(out, 'composite.mp4');
  const r = await doExport(main, { windows: ['video-0', 'graph-0'], layout: 'grid', format: 'mp4', res: '1080p', fps: 30, range: [T0, T1], audio: ids.vid }, mp4);
  check('60 s 1080p composite exports', !!r.result && existsSync(mp4), r.error ?? `${r.result.frames} frames, ${(r.result.bytes / 1e6).toFixed(1)} MB in ${r.seconds.toFixed(0)} s (${(r.result.frames / r.seconds).toFixed(1)} frames/s, encoder ${r.result.encoder})`);
  const tAfter = await main.evaluate(() => window.__hl.timeline.getState().t);
  check("the user's playhead is back where it was", tAfter === tBefore, `${tBefore} → ${tAfter}`);
  const vRect = r.layout.find((p) => p.id === 'video-0'), gRect = r.layout.find((p) => p.id === 'graph-0');

  const ex = await openExported(main, mp4);
  check('exported MP4 is H.264 1080p, 30 fps, 1800 frames, with audio', /^avc1/.test(ex.video?.codec) && ex.video.width === 1920 && ex.video.height === 1080 && Math.abs(ex.video.frames - 1800) <= 1 && Math.abs(ex.video.fpsAvg - 30) < 0.05 && ex.audio?.codec?.startsWith('mp4a'),
    `${ex.video?.codec} ${ex.video?.width}×${ex.video?.height} ${ex.video?.fpsAvg?.toFixed(3)} fps, ${ex.video?.frames} frames, ${ex.video?.durationS?.toFixed(3)} s, audio ${ex.audio?.codec}`);
  check('first frame at 0 s, frame times exact', Math.abs(ex.video.startS) < 1e-6 && Math.abs(ex.video.endS - 1799 / 30) < 1e-4, `start ${ex.video.startS}, end ${ex.video.endS.toFixed(4)}`);
  // Sync through the export: the flash is at output (400 − 348) = 52.000 s → frame 1560.
  const fWave = Math.round((WAVE - T0) * 30);
  const inner = { x: vRect.x + vRect.w * 0.35, y: vRect.y + vRect.h * 0.05, w: vRect.w * 0.15, h: vRect.h * 0.25 }; // clear of the overlays
  const before = await regionStats(main, ex.id, fWave - 2, inner);
  const after = await regionStats(main, ex.id, fWave + 1, inner);
  check('frame-exact: the flash is on the right exported frame', before.mean < 80 && after.mean > 200, `frame ${fWave - 2}: ${before.mean.toFixed(0)}, frame ${fWave + 1}: ${after.mean.toFixed(0)}`);
  const hudR = { x: vRect.x + vRect.w * 0.55, y: vRect.y + vRect.h * 0.35, w: vRect.w * 0.42, h: vRect.h * 0.6 };
  const hud = await regionStats(main, ex.id, 300, hudR);
  check('ADI (HUD) overlay is drawn on the video', hud.white > 0.003, `${(hud.white * 100).toFixed(2)} % white HUD pixels`);
  const ro = await regionStats(main, ex.id, 300, { x: vRect.x + vRect.w * 0.03, y: vRect.y + vRect.h * 0.62, w: vRect.w * 0.3, h: vRect.h * 0.3 });
  check('readout overlay is drawn on the video', ro.white > 0.01 && ro.std > 20, `${(ro.white * 100).toFixed(1)} % text pixels`);
  const gr = await regionStats(main, ex.id, 300, gRect);
  const gr2 = await regionStats(main, ex.id, 1500, { x: gRect.x, y: gRect.y, w: gRect.w, h: gRect.h });
  check('graph is drawn (with legend)', gr.std > 15 && gr2.std > 15, `contrast ${gr.std.toFixed(0)} / ${gr2.std.toFixed(0)}`);
  // Audio: the beep with the flash is at output 52.000 s.
  const onset = await main.evaluate(async ([id, t]) => {
    const wf = await window.__hl.mediaSource(id).getWaveform();
    if (!wf) return null;
    const i0 = Math.floor((t - 1 - wf.start) / wf.binDt);
    let noise = 0; for (let i = i0 - 100; i < i0; i++) noise = Math.max(noise, wf.rms[i] ?? 0);
    for (let i = i0; i < i0 + 400; i++) if ((wf.rms[i] ?? 0) > Math.max(0.05, noise * 4)) return wf.start + i * wf.binDt;
    return null;
  }, [ex.id, WAVE - T0]);
  check('audio is in sync with the picture (beep at the flash)', onset !== null && Math.abs(onset - (WAVE - T0)) < 0.02, onset === null ? 'no onset' : `onset ${onset.toFixed(3)} s (flash ${(WAVE - T0).toFixed(3)} s)`);

  // ---- Two video feeds (sequential readers): each tile frame-exact ----
  // A second copy of the clip, synced 0.5 s later: its flash lands 15 frames after the first.
  const vid2Path = join(out, 'second_cam.mp4');
  copyFileSync(vidPath, vid2Path);
  const before2 = await main.evaluate(() => window.__hl.media.getState().order.length);
  const f2 = await main.evaluate((x) => window.huskylog.e2eRegister(x), vid2Path);
  await main.evaluate((file) => window.dispatchEvent(new CustomEvent('hl-e2e-add', { detail: file })), f2);
  await main.waitForFunction((n) => { const m = window.__hl.media.getState(); return m.order.length > n && m.videos[m.order[n]].status === 'ready'; }, before2, { timeout: 30000 });
  const vid2 = await main.evaluate((n) => window.__hl.media.getState().order[n], before2);
  await main.evaluate(([vid2, truth]) => {
    const h = window.__hl, st = h.syncStore.getState();
    for (const ev of st.events) st.setMarker(vid2, ev.id, truth.localEvents[ev.name] - 0.5);
    h.dock.addPanel({ id: 'video-1', component: 'video', title: 'Video 2', params: { video: { stream: vid2, muted: true } }, position: { referencePanel: 'video-0', direction: 'below' } });
  }, [vid2, truth]);
  await sleep(1500);
  const twoFile = join(out, 'two-feeds.mp4');
  const W0 = WAVE - 2;
  const r2 = await doExport(main, { windows: ['video-0', 'video-1'], layout: 'grid', format: 'mp4', res: '720p', fps: 30, range: [W0, W0 + 4], audio: '' }, twoFile);
  check('two video feeds export', !!r2.result, r2.error ?? `${r2.result.frames} frames in ${r2.seconds.toFixed(1)} s`);
  const e2 = await openExported(main, twoFile);
  const tile = (id) => { const p = r2.layout.find((q) => q.id === id); return { x: p.x + p.w * 0.35, y: p.y + p.h * 0.3, w: p.w * 0.3, h: p.h * 0.4 }; };
  const fw = Math.round((WAVE - W0) * 30); // 60
  const s = async (id, i) => (await regionStats(main, e2.id, i, tile(id))).mean;
  const a = [await s('video-0', fw - 2), await s('video-0', fw + 1)], b = [await s('video-1', fw + 13), await s('video-1', fw + 16)];
  const bEarly = await s('video-1', fw + 1);
  check('two feeds: each tile shows its own frame-exact flash', a[0] < 80 && a[1] > 200 && b[0] < 80 && b[1] > 200 && bEarly < 80,
    `feed 1: frame ${fw - 2} ${a[0].toFixed(0)}, ${fw + 1} ${a[1].toFixed(0)}; feed 2: frame ${fw + 1} ${bEarly.toFixed(0)}, ${fw + 13} ${b[0].toFixed(0)}, ${fw + 16} ${b[1].toFixed(0)}`);
  await main.evaluate(() => window.__hl.dock.getPanel('video-1')?.api.close());

  // ---- Map + picture-in-picture, short clip ----
  const pipFile = join(out, 'pip.mp4');
  const rp = await doExport(main, { windows: ['map3d-0', 'video-0'], layout: 'pip', format: 'mp4', res: '720p', fps: 30, range: [396, 399], audio: '' }, pipFile);
  const mapR = rp.layout.find((p) => p.id === 'map3d-0'), insR = rp.layout.find((p) => p.id === 'video-0');
  check('picture-in-picture layout: map full frame, video inset', mapR && mapR.w === 1280 && insR && insR.w < 500 && insR.x > 700, JSON.stringify(rp.layout.map((p) => [p.id, p.x, p.y, p.w, p.h])));
  const pe = await openExported(main, pipFile);
  check('map + video exported (silent, 720p)', pe.video?.width === 1280 && pe.video?.frames === 90 && !pe.audio, `${pe.video?.width}×${pe.video?.height}, ${pe.video?.frames} frames, audio ${pe.audio ? 'yes' : 'none'}`);
  const mapStats = await regionStats(main, pe.id, 45, { x: 50, y: 50, w: 600, h: 400 });
  check('3D map is rendered from the offline tiles', mapStats.std > 12 && mapStats.mean > 25, `brightness ${mapStats.mean.toFixed(0)}, contrast ${mapStats.std.toFixed(0)}`);

  // ---- As-on-screen layout keeps the on-screen arrangement ----
  await main.click('button:has-text("Export video…")');
  await main.waitForSelector('.modal.export');
  await main.evaluate(() => window.__hl.export.set({ windows: ['map3d-0', 'video-0', 'graph-0'], layout: 'screen', format: 'mp4', res: '1080p' }));
  await sleep(200);
  const scr = await main.evaluate(() => {
    const rect = (sel) => document.querySelector(sel)?.getBoundingClientRect();
    return { lay: window.__hl.export.layout(), map: rect('.map-panel'), graph: rect('.plot-wrap'), video: rect('.video-stage') };
  });
  await main.click('.modal.export button:has-text("Close")');
  const L = Object.fromEntries(scr.lay.map((p) => [p.id, p]));
  const ratio = (a, b) => a / b;
  check('as-on-screen layout keeps positions and proportions', L['map3d-0'].x < L['video-0'].x && L['map3d-0'].y < L['graph-0'].y && Math.abs(ratio(L['map3d-0'].w, L['graph-0'].w) - ratio(scr.map.width, scr.graph.width)) < 0.02,
    scr.lay.map((p) => `${p.id} ${p.x},${p.y} ${p.w}×${p.h}`).join(' · '));

  // ---- GIF ----
  const gif = join(out, 'clip.gif');
  const rg = await doExport(main, { windows: ['video-0'], layout: 'grid', format: 'gif', gifW: 640, gifFps: 15, range: [WAVE - 2, WAVE + 3] }, gif);
  check('GIF (5 s, 15 fps, 640 px) exports', !!rg.result && existsSync(gif), rg.error ?? `${rg.result.frames} frames, ${(rg.result.bytes / 1e6).toFixed(2)} MB in ${rg.seconds.toFixed(1)} s`);
  const gv = rg.layout.find((p) => p.id === 'video-0');
  const g = await main.evaluate(async ([file, gv]) => {
    const f = await window.huskylog.e2eRegister(file);
    const data = await (await fetch(f.url)).arrayBuffer();
    const head = new TextDecoder().decode(new Uint8Array(data, 0, 6));
    const dec = new ImageDecoder({ data, type: 'image/gif' });
    await dec.tracks.ready;
    const n = dec.tracks.selectedTrack.frameCount;
    const bright = async (i) => {
      const { image } = await dec.decode({ frameIndex: i });
      const c = new OffscreenCanvas(image.displayWidth, image.displayHeight);
      const x = c.getContext('2d'); x.drawImage(image, 0, 0);
      const w = c.width, h = c.height;
      const d = x.getImageData(gv.x + gv.w * 0.35, gv.y + gv.h * 0.05, gv.w * 0.15, gv.h * 0.25).data; let s = 0;
      for (let k = 0; k < d.length; k += 4) s += (d[k] + d[k + 1] + d[k + 2]) / 3;
      image.close();
      return { mean: s / (d.length / 4), w, h };
    };
    const a = await bright(28), b = await bright(31);
    let dur = 0; for (let i = 0; i < n; i++) { const r = await dec.decode({ frameIndex: i }); dur += r.image.duration ?? 0; r.image.close(); }
    return { head, n, a, b, durS: dur / 1e6 };
  }, [gif, gv]);
  check('GIF is valid: 75 frames, 5.00 s, 640×360', g.head === 'GIF89a' && g.n === 75 && Math.abs(g.durS - 5) < 0.011 && g.a.w === 640 && g.a.h === 360, `${g.head}, ${g.n} frames, ${g.durS.toFixed(2)} s, ${g.a.w}×${g.a.h}`);
  check('GIF frames are in sync (flash from frame 30)', g.a.mean < 80 && g.b.mean > 200, `frame 28: ${g.a.mean.toFixed(0)}, frame 31: ${g.b.mean.toFixed(0)}`);
  const longGif = await main.evaluate(() => { window.__hl.export.open(); return true; });
  void longGif;
  await main.waitForSelector('.modal.export');
  await main.evaluate(() => window.__hl.export.set({ format: 'gif', range: [300, 330] }));
  await sleep(200);
  const gifDisabled = await main.$eval('.modal.export input[name="ex-format"]:nth-of-type(1)', () => document.querySelectorAll('.modal.export input[name="ex-format"]')[1].disabled);
  check('GIF is only offered for ≤ 10 s', gifDisabled && (await main.evaluate(() => window.__hl.export.getOptions()?.format)) === 'mp4');
  await main.click('.modal.export button:has-text("Close")');

  // ---- Cancel ----
  const cancelFile = join(out, 'cancel.mp4');
  const rc = await doExport(main, { windows: ['video-0', 'graph-0'], layout: 'grid', format: 'mp4', res: '720p', fps: 30, range: [350, 400], audio: '' }, cancelFile, { cancelAfter: 20 });
  check('export can be cancelled (no file left, playhead restored)', /cancelled/i.test(rc.error ?? '') && !existsSync(cancelFile) && !existsSync(`${cancelFile}.partial`) && (await main.evaluate(() => window.__hl.timeline.getState().t)) === tBefore, rc.error ?? 'not cancelled');
  check('no network requests', (await main.evaluate(() => window.huskylog.blockedRequests())).length === 0);
  void statSync;
} catch (e) {
  failed++;
  console.error('ERROR', e);
  await app.windows()[0]?.screenshot({ path: join(shots, 'p7-failure.png') }).catch(() => {});
} finally {
  await app.close().catch(() => {});
  rmSync(out, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll Phase 7 checks passed');
process.exit(failed ? 1 : 0);
