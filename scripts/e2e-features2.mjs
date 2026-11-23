// Feature harness, part 2 (v0.1.5): video adjustments (rotate, mirror,
// straighten, crop) and compressed copies on import.
// Usage: npm run build && node scripts/e2e-features2.mjs
import { _electron as electron } from 'playwright-core';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const logPath = process.env.HUSKYLOG_REF_LOG ?? join(root, 'test-data', 'logs', 'reference.bin');
const gen = join(root, 'test-data', 'generated');
if (!existsSync(logPath) || !existsSync(join(gen, 'ground_cam_pcm.mov'))) { console.error('need reference log and generated clips (node scripts/gen-sync-video.mjs)'); process.exit(2); }
const truth = JSON.parse(readFileSync(join(gen, 'ground_cam_sync.truth.json'), 'utf8'));
const out = mkdtempSync(join(tmpdir(), 'hl-feat2-'));
// Copies: compression writes next to the original.
const camA = join(out, 'camA.mp4'), camB = join(out, 'camB.mov'), camC = join(out, 'camC.mp4');
copyFileSync(join(gen, 'ground_cam_sync.mp4'), camA);
copyFileSync(join(gen, 'ground_cam_pcm.mov'), camB);
// camC: a camera-like high-bitrate file (20 Mbit/s), so a compressed copy is worth making.
execFileSync(createRequire(import.meta.url)('ffmpeg-static'), ['-y', '-hide_banner', '-loglevel', 'error', '-i', join(gen, 'ground_cam_sync.mp4'), '-t', '40', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '20M', '-minrate', '20M', '-maxrate', '20M', '-bufsize', '20M', '-x264-params', 'nal-hrd=cbr', '-c:a', 'copy', camC]);
const WAVE = truth.events.Wave;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };
const app = await electron.launch({ args: [root], env: { ...process.env, HUSKYLOG_E2E: '1', HUSKYLOG_DISPLAY: process.env.HUSKYLOG_DISPLAY ?? 'secondary' } });
const add = async (main, p) => {
  const f = await main.evaluate((x) => window.huskylog.e2eRegister(x), p);
  await main.evaluate((file) => window.dispatchEvent(new CustomEvent('hl-e2e-add', { detail: file })), f);
};

/** Where the bright "GROUND CAM" caption sits in the Video window's canvas (fractions), and the canvas aspect. */
const caption = (main) => main.evaluate(() => {
  const c = document.querySelector('.video-panel canvas');
  const g = c.getContext('2d'), W = c.width, H = c.height, d = g.getImageData(0, 0, W, H).data;
  let sx = 0, sy = 0, n = 0, corners = 0;
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
    const i = (y * W + x) * 4;
    if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) { sx += x; sy += y; n++; }
  }
  for (const [x, y] of [[2, 2], [W - 3, 2], [2, H - 3], [W - 3, H - 3]]) { const i = (y * W + x) * 4; if (d[i] + d[i + 1] + d[i + 2] < 15) corners++; }
  return { x: n ? sx / n / W : -1, y: n ? sy / n / H : -1, aspect: W / H, W, H, blackCorners: corners };
});
const settle = async (main) => { await main.evaluate(() => window.__hl.timeline.getState().setT(window.__hl.timeline.getState().t + 1e-4)); await sleep(700); };

try {
  const main = await app.firstWindow();
  main.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 300)));
  await main.waitForFunction(() => !!window.__hl?.dock && !!window.__hl?.workspace);
  for (const p of [logPath, camA, camB]) await add(main, p);
  await main.waitForFunction(() => { const l = window.__hl.logs.getState(), m = window.__hl.media.getState(); return l.order.length && l.logs[l.order[0]].status === 'ready' && m.order.length === 2 && m.order.every((id) => m.videos[id].status === 'ready'); }, null, { timeout: 60000 });
  const ids = await main.evaluate(() => ({ log: window.__hl.logs.getState().order[0], a: window.__hl.media.getState().order[0], b: window.__hl.media.getState().order[1] }));
  await main.evaluate(([ids, truth, WAVE]) => {
    const h = window.__hl;
    for (const name of ['Prop start', 'Wave']) {
      const ev = h.syncStore.getState().addEvent(name);
      h.syncStore.getState().setMarker(ids.log, ev, truth.events[name]);
      h.syncStore.getState().setMarker(ids.a, ev, truth.localEvents[name]);
      h.syncStore.getState().setMarker(ids.b, ev, truth.localEvents[name]);
    }
    h.dock.getPanel('video-0').api.updateParameters({ video: { stream: ids.a, muted: true } });
    h.timeline.getState().setT(WAVE - 5);
  }, [ids, truth, WAVE]);
  await main.click('button[role=tab]:has-text("Review")');
  await sleep(1500);

  // ---------------------------------------------------------------- adjust
  const c0 = await caption(main);
  check('unadjusted: caption top-left, 16:9', c0.x < 0.5 && c0.y < 0.3 && Math.abs(c0.aspect - 16 / 9) < 0.02, JSON.stringify(c0));
  await main.click('button[role=tab]:has-text("Import")');
  await main.click(`button[aria-label="Adjust ${ids.a}"]`);
  await main.waitForSelector('.modal[aria-label="Adjust video"]');
  await sleep(500);
  await main.click('button[aria-label="Rotate right"]');
  await main.click('.modal[aria-label="Adjust video"] button:has-text("Apply")');
  const adj = await main.evaluate((id) => window.__hl.media.getState().videos[id].adjust, ids.a);
  await main.click('button[role=tab]:has-text("Review")');
  await settle(main);
  const c1 = await caption(main);
  check('rotate 90° (dialog): portrait, caption top-right', adj?.rot === 90 && Math.abs(c1.aspect - 9 / 16) < 0.02 && c1.x > 0.5 && c1.y < 0.5, JSON.stringify(c1));
  const setAdj = (a) => main.evaluate(([id, a]) => window.__hl.setAdjust(id, a), [ids.a, a]);
  const base = { rot: 0, flipH: false, flipV: false, fine: 0, crop: { x: 0, y: 0, w: 1, h: 1 } };
  await setAdj({ ...base, flipH: true }); await settle(main);
  const c2 = await caption(main);
  await setAdj({ ...base, flipV: true }); await settle(main);
  const c3 = await caption(main);
  check('mirror ↔ moves the caption right, flip ↕ moves it down', c2.x > 0.5 && c2.y < 0.3 && c3.x < 0.5 && c3.y > 0.7, `mirror ${c2.x.toFixed(2)},${c2.y.toFixed(2)} · flip ${c3.x.toFixed(2)},${c3.y.toFixed(2)}`);
  await setAdj({ ...base, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } }); await settle(main);
  const c4 = await caption(main);
  check('crop to the top-left quarter: same aspect, caption bigger', Math.abs(c4.aspect - 16 / 9) < 0.02 && c4.x < 0.7 && c4.y < 0.5 && c4.x > c0.x, JSON.stringify(c4));
  await setAdj({ ...base, fine: 10 }); await settle(main);
  const c5 = await caption(main);
  const cf = await main.evaluate((id) => { const v = window.__hl.media.getState().videos[id].video; return window.__hl.cornerFreeCrop(v.width, v.height, 10); }, ids.a);
  await setAdj({ ...base, fine: 10, crop: cf }); await settle(main);
  const c6 = await caption(main);
  check('straighten 10°: black corners, gone after "crop out corners"', c5.blackCorners === 4 && c6.blackCorners === 0, `corners ${c5.blackCorners} → ${c6.blackCorners}`);
  await setAdj({ ...base, rot: 90 }); await settle(main);
  const saved = await main.evaluate((id) => window.__hl.workspace.captureWorkspace().streams.find((s) => s.id === id)?.adjust, ids.a);
  check('adjustments are saved with the workspace', saved?.rot === 90);
  // Playing with an adjustment: the canvas is painted from the playing video (and stays readable).
  const hashOf = () => main.evaluate(() => { const c = document.querySelector('.video-panel canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) >>> 0; return { h, portrait: c.width < c.height }; });
  await main.evaluate(() => window.__hl.timeline.getState().setPlaying(true));
  await sleep(800); const p1 = await hashOf().catch((e) => ({ err: String(e) }));
  await sleep(1000); const p2 = await hashOf().catch((e) => ({ err: String(e) }));
  await main.evaluate(() => window.__hl.timeline.getState().setPlaying(false));
  check('playing an adjusted video paints rotated frames', !p1.err && p1.portrait && p2.portrait && p1.h !== p2.h, JSON.stringify({ p1, p2 }));
  // Export applies the adjustment: a portrait picture pillarboxed in the 16:9 tile.
  const ex = join(out, 'adjusted.mp4');
  await main.click('button:has-text("Export video…")');
  await main.waitForSelector('.modal.export');
  await main.evaluate((p) => window.__hl.export.set(p), { windows: ['video-0'], layout: 'grid', format: 'mp4', res: '720p', fps: 30, range: [WAVE - 5, WAVE - 4], audio: '' });
  await sleep(300);
  await main.evaluate((p) => window.huskylog.e2eSetDialogPaths({ export: p }), ex);
  await main.click('.modal.export button:has-text("Export…")');
  await main.waitForFunction(() => !!window.__hl.export.getResult() || !!window.__hl.export.getError(), null, { timeout: 120000 });
  const layout = await main.evaluate(() => window.__hl.export.layout());
  await main.click('.modal.export button:has-text("Done"), .modal.export button:has-text("Close")');
  await add(main, ex);
  await main.waitForFunction((n) => window.__hl.media.getState().order.length > n && window.__hl.media.getState().videos[window.__hl.media.getState().order[n]].status === 'ready', 2, { timeout: 30000 });
  const exStats = await main.evaluate(async ([tile]) => {
    const id = window.__hl.media.getState().order[2];
    const bmp = await window.__hl.mediaSource(id).frame(10);
    const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
    const col = (fx) => { const d = g.getImageData(Math.round(tile.x + tile.w * fx), Math.round(tile.y + tile.h / 2), 1, 1).data; return d[0] + d[1] + d[2]; };
    return { left: col(0.05), mid: col(0.5), right: col(0.95) };
  }, [layout.find((p) => p.id === 'video-0')]);
  check('export draws the adjusted (portrait) picture', exStats.left < 15 && exStats.right < 15 && exStats.mid > 40, JSON.stringify(exStats));
  await main.evaluate((id) => window.__hl.removeStream(id), await main.evaluate(() => window.__hl.media.getState().order[2]));

  // ---------------------------------------------------------------- compress
  const brightAt = (id, tMaster) => main.evaluate(async ([id, t]) => {
    const h = window.__hl, src = h.mediaSource(id);
    const sol = h.syncStore.getState().solution.streams[id];
    const local = (t - sol.b) / sol.a;
    const bmp = await src.frame(src.indexAt(local));
    const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
    const d = g.getImageData(bmp.width * 0.3, bmp.height * 0.4, bmp.width * 0.4, bmp.height * 0.3).data;
    let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
    return s / (d.length / 4) / 3;
  }, [id, tMaster]);
  await main.click('button[role=tab]:has-text("Import")');
  await main.click(`button[aria-label="Compress ${ids.a}"]`);
  await main.waitForSelector('.modal[aria-label="Compress video"]');
  const dlgText = await main.textContent('.modal[aria-label="Compress video"]');
  await main.click('.modal[aria-label="Compress video"] button:has-text("Compress")');
  await main.waitForFunction((id) => ['done', 'error'].includes(window.__hl.compress.getState().jobs[id]?.status), ids.a, { timeout: 180000 });
  const jobA = await main.evaluate((id) => { const j = window.__hl.compress.getState().jobs[id], v = window.__hl.media.getState().videos[id]; return { status: j.status, error: j.error, path: v.path, original: v.original, adjust: v.adjust ?? null, w: v.video.width, h: v.video.height, rot: v.video.rotation }; }, ids.a);
  check('compress: writes NAME.huskylog.mp4 beside the original and switches to it', jobA.status === 'done' && jobA.path.endsWith('camA.huskylog.mp4') && existsSync(join(out, 'camA.huskylog.mp4')) && jobA.original?.name === 'camA.mp4' && /huskylog\.mp4/.test(dlgText), jobA.error ?? jobA.path);
  check('compress bakes in the rotation (720×1280, no rotation flag, adjustment cleared)', jobA.w === 720 && jobA.h === 1280 && jobA.rot === 0 && jobA.adjust === null, `${jobA.w}×${jobA.h} rot ${jobA.rot}`);
  const before = await brightAt(ids.a, WAVE - 0.1), after = await brightAt(ids.a, WAVE + 0.05);
  check('sync is frame-exact through compression (flash on the right frame)', before < 80 && after > 200, `before ${before.toFixed(0)}, after ${after.toFixed(0)}`);
  // PCM video, trimmed to the flight: AAC audio, beep at the flash, shorter.
  const lenB = await main.evaluate((id) => window.__hl.media.getState().videos[id].video.durationS, ids.b);
  // Trim basis: the selection (20 s around the flash), else the whole log (which spans this clip).
  await main.evaluate((W) => window.__hl.timeline.getState().setRange([W - 10, W + 10]), WAVE);
  await main.evaluate((id) => window.__hl.compressNow(id, { quality: '720', trim: true }), ids.b);
  await main.waitForFunction((id) => ['done', 'error'].includes(window.__hl.compress.getState().jobs[id]?.status), ids.b, { timeout: 180000 });
  const jobB = await main.evaluate(async ([id, WAVE]) => {
    const h = window.__hl, j = h.compress.getState().jobs[id], v = h.media.getState().videos[id];
    const sol = h.syncStore.getState().solution.streams[id];
    const flash = (WAVE - sol.b) / sol.a;
    const wf = await h.mediaSource(id).getWaveform();
    let onset = null;
    if (wf) {
      const i0 = Math.floor((flash - 1 - wf.start) / wf.binDt);
      let noise = 0; for (let i = i0 - 100; i < i0; i++) noise = Math.max(noise, wf.rms[i] ?? 0);
      for (let i = i0; i < i0 + 400; i++) if ((wf.rms[i] ?? 0) > Math.max(0.05, noise * 4)) { onset = wf.start + i * wf.binDt - flash; break; }
    }
    return { status: j.status, error: j.error, audio: v.audio, dur: v.video.durationS, onset, before: j.before, after: j.after };
  }, [ids.b, WAVE]);
  check('compress a PCM video: AAC audio in sync (beep at the flash)', jobB.status === 'done' && jobB.audio?.codec === 'mp4a.40.2' && jobB.onset !== null && Math.abs(jobB.onset) < 0.02, jobB.error ?? `onset ${jobB.onset?.toFixed(4)} s`);
  await main.evaluate(() => window.__hl.timeline.getState().setRange(null));
  // 20 s selection ± 5 s, clipped by the clip's end, rounded out to whole keyframe groups (1 s).
  const fl = truth.localEvents.Wave, wantDur = Math.min(lenB, fl + 15) - Math.max(0, fl - 15);
  check('"only the selection" trims the copy to it (± 5 s)', jobB.dur >= wantDur - 0.1 && jobB.dur <= wantDur + 1.1, `${lenB.toFixed(1)} s → ${jobB.dur.toFixed(1)} s (want ≈ ${wantDur.toFixed(1)} s), ${(jobB.before / 1e6).toFixed(1)} → ${(jobB.after / 1e6).toFixed(1)} MB`);
  // Compressing a compressed copy again never overwrites: NAME.huskylog-2.mp4, same original.
  await main.evaluate((id) => window.__hl.compressNow(id, { quality: '720', trim: false }), ids.a);
  await main.waitForFunction((id) => ['done', 'error'].includes(window.__hl.compress.getState().jobs[id]?.status), ids.a, { timeout: 180000 });
  const again = await main.evaluate((id) => { const v = window.__hl.media.getState().videos[id]; return { path: v.path, original: v.original?.name }; }, ids.a);
  check('compressing again makes NAME.huskylog-2.mp4 (no overwrite)', again.path.endsWith('camA.huskylog-2.mp4') && again.original === 'camA.mp4' && existsSync(join(out, 'camA.huskylog.mp4')), again.path);
  // "Compress new videos": a newly added video is compressed automatically.
  await main.check('input[aria-label="Compress new videos"]');
  await add(main, camC);
  await main.waitForFunction(() => { const m = window.__hl.media.getState(); const id = m.order.find((x) => m.videos[x].name === 'camC'); return id && window.__hl.compress.getState().jobs[id]?.status === 'done'; }, null, { timeout: 180000 });
  const c = await main.evaluate(() => { const m = window.__hl.media.getState(); const v = Object.values(m.videos).find((x) => x.name === 'camC'); return { path: v.path, original: v.original?.name }; });
  check('"Compress new videos" compresses a newly added video', c.path.endsWith('camC.huskylog.mp4') && c.original === 'camC.mp4', c.path);
  await main.uncheck('input[aria-label="Compress new videos"]');
  const ws = await main.evaluate(() => window.__hl.workspace.captureWorkspace().streams.filter((s) => s.kind === 'video').map((s) => ({ file: s.file.name, original: s.original?.name })));
  check('the workspace refers to the compressed copies and remembers the originals', ws.every((s) => /huskylog/.test(s.file) && s.original), JSON.stringify(ws));
  console.log(`  sizes: camA ${(statSync(camA).size / 1e6).toFixed(1)} MB → ${(statSync(join(out, 'camA.huskylog.mp4')).size / 1e6).toFixed(1)} MB (720p, already small); camC ${(statSync(camC).size / 1e6).toFixed(1)} MB → ${(statSync(join(out, 'camC.huskylog.mp4')).size / 1e6).toFixed(1)} MB; camB ${(statSync(camB).size / 1e6).toFixed(1)} MB → ${(statSync(join(out, 'camB.huskylog.mp4')).size / 1e6).toFixed(1)} MB`);
} finally {
  await app.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
