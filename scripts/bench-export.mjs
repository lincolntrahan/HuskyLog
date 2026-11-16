// Export benchmark: frames/s for 1, 2 and 3 video feeds in different layouts,
// plus decode-only throughput, to find where multi-video export time goes.
// Usage: npm run build && node scripts/bench-export.mjs [video.mp4 ...]
import { _electron as electron } from 'playwright-core';
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const logPath = process.env.HUSKYLOG_REF_LOG ?? join(root, 'test-data', 'logs', 'reference.bin');
const base = process.argv[2] ?? join(root, 'test-data', 'generated', 'ground_cam_sync.mp4');
if (!existsSync(logPath) || !existsSync(base)) { console.error('need reference log and a clip'); process.exit(2); }
const tmp = mkdtempSync(join(tmpdir(), 'hl-bench-'));
// Three distinct files (copies) so each feed has its own source and decoder.
const vids = process.argv.length > 4 ? process.argv.slice(2, 5) : [0, 1, 2].map((i) => { const p = join(tmp, `feed${i}_${basename(base)}`); copyFileSync(base, p); return p; });
const T0 = Number(process.env.BENCH_T0 ?? 360), DUR = Number(process.env.BENCH_DUR ?? 6), FPS = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await electron.launch({ args: [root], env: { ...process.env, HUSKYLOG_E2E: '1', HUSKYLOG_DISPLAY: process.env.HUSKYLOG_DISPLAY ?? 'secondary' } });
try {
  await app.evaluate(({ app }) => {
    app.on('render-process-gone', (_e, _w, d) => console.log('RENDER GONE', JSON.stringify(d)));
    app.on('child-process-gone', (_e, d) => console.log('CHILD GONE', JSON.stringify(d)));
  });
  app.process().stdout?.on('data', (b) => { const s = String(b); if (/GONE/.test(s)) process.stdout.write(s); });
  const main = await app.firstWindow();
  main.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 300)));
  await main.waitForFunction(() => !!window.__hl?.dock && !!window.__hl?.workspace);
  for (const p of [logPath, ...vids]) {
    const f = await main.evaluate((x) => window.huskylog.e2eRegister(x), p);
    await main.evaluate((file) => window.dispatchEvent(new CustomEvent('hl-e2e-add', { detail: file })), f);
  }
  await main.waitForFunction((n) => { const l = window.__hl.logs.getState(), m = window.__hl.media.getState(); return l.order.length && l.logs[l.order[0]].status === 'ready' && m.order.length === n && m.order.every((id) => m.videos[id].status === 'ready'); }, vids.length, { timeout: 90000 });
  const info = await main.evaluate(([T0]) => {
    const h = window.__hl, m = h.media.getState(), log = h.logs.getState().order[0];
    // Same sync for every feed: local = master - 297.5 (roughly the generated clip's truth).
    for (const name of ['A', 'B']) {
      const ev = h.syncStore.getState().addEvent(name);
      const tm = name === 'A' ? 320 : 400;
      h.syncStore.getState().setMarker(log, ev, tm);
      for (const id of m.order) h.syncStore.getState().setMarker(id, ev, tm - 297.5);
    }
    const d = h.dock;
    m.order.forEach((id, i) => {
      if (i === 0) { d.getPanel('video-0').api.updateParameters({ video: { stream: id, muted: true } }); return; }
      d.addPanel({ id: `video-${i}`, component: 'video', title: `Video ${i}`, params: { video: { stream: id, muted: true } }, position: { referencePanel: i === 1 ? 'video-0' : 'graph-0', direction: i === 1 ? 'below' : 'right' } });
    });
    h.timeline.getState().setT(T0);
    return m.order.map((id) => { const v = m.videos[id].video; return { id, res: `${v.width}x${v.height}`, fps: v.fpsAvg.toFixed(1), frames: v.frames, keyframes: v.keyframes, gopS: (v.durationS / Math.max(1, v.keyframes)).toFixed(2), codec: v.codec }; });
  }, [T0]);
  console.log('feeds:', JSON.stringify(info));
  // Time every decode request (export and the live Video windows share the sources).
  await main.evaluate(() => {
    const h = window.__hl; h.benchDecodeMs = 0;
    for (const id of h.media.getState().order) {
      const s = h.mediaSource(id), orig = s.frame.bind(s);
      s.frame = (i) => { const t = performance.now(); const p = orig(i); p.then(() => { h.benchDecodeMs += performance.now() - t; }, () => undefined); return p; };
    }
  });
  await sleep(4000);

  // ---- decode-only: sequential frames at 30 fps across 1..3 feeds ----
  for (const n of process.env.BENCH_NO_DECODE ? [] : [1, 2, 3]) {
    const r = await main.evaluate(async ([n, T0, DUR, FPS]) => {
      const h = window.__hl, ids = h.media.getState().order.slice(0, n);
      // Fresh sources would be fairer, but the cache only holds 90 frames and we start 30 s away.
      const warm = ids.map((id) => h.mediaSource(id));
      const t = performance.now();
      const frames = Math.round(DUR * FPS);
      for (let i = 0; i < frames; i++) for (const s of warm) await s.frame(s.indexAt(T0 + i / FPS - 297.5));
      return { ms: performance.now() - t, frames };
    }, [n, 300 + 10 * n, DUR, FPS]);
    console.log(`decode-only ${n} feed(s): ${(r.frames / (r.ms / 1000)).toFixed(1)} output frames/s  (${(r.ms / r.frames).toFixed(1)} ms per output frame)`);
  }

  // ---- full exports ----
  const cases = [
    ['1 video, grid', ['video-0'], 'grid'],
    ['2 videos, grid', ['video-0', 'video-1'], 'grid'],
    ['2 videos, PiP video main', ['video-0', 'video-1'], 'pip'],
    ['map + 2 videos, PiP map main', ['map3d-0', 'video-0', 'video-1'], 'pip'],
    ['3 videos, grid', ['video-0', 'video-1', 'video-2'], 'grid'],
    ['map + graph + 3 videos, grid', ['map3d-0', 'graph-0', 'video-0', 'video-1', 'video-2'], 'grid'],
  ];
  let k = 0;
  const only = process.env.BENCH_CASES ? process.env.BENCH_CASES.split(',').map(Number) : null;
  for (const [name, windows, layout] of cases) {
    const t0 = T0 + Number(process.env.BENCH_STEP ?? 8) * ++k;
    if (only && !only.includes(k)) continue;
    for (const q of process.env.BENCH_AB ? ['high', 'chain', 'low', 'high', 'chain', 'low'] : [process.env.BENCH_Q ?? 'chain']) {
    await main.evaluate((q) => { window.__hl.videoDrawOpts.mode = q; }, q); // a fresh stretch of video each time, so the cache doesn't help
    await main.click('button:has-text("Export video…")');
    await main.waitForSelector('.modal.export');
    await main.evaluate((p) => window.__hl.export.set(p), { windows, layout, format: 'mp4', res: '1080p', fps: FPS, range: [t0, t0 + DUR], audio: '' });
    await sleep(300);
    const file = join(tmp, `case${k}.mp4`);
    await main.evaluate((p) => window.huskylog.e2eSetDialogPaths({ export: p }), file);
    await main.evaluate(() => { window.__hl.benchDecodeMs = 0; });
    const start = Date.now();
    await main.click('.modal.export button:has-text("Export…")');
    await main.waitForFunction(() => !!window.__hl.export.getResult() || !!window.__hl.export.getError(), null, { timeout: 900000 });
    const r = await main.evaluate(() => ({ result: window.__hl.export.getResult(), error: window.__hl.export.getError(), layout: window.__hl.export.layout(), dec: window.__hl.benchDecodeMs }));
    const s = (Date.now() - start) / 1000;
    const sizes = r.layout.map((p) => `${p.id.replace('video-', 'v')}:${p.w}x${p.h}`).join(' ');
    console.log(`${(name + (' [' + q + ']')).padEnd(44)} ${r.error ? 'ERROR ' + r.error : `${(r.result.frames / s).toFixed(1)} frames/s  (${(s * 1000 / r.result.frames).toFixed(0)} ms/frame, decode requests ~${(r.dec / r.result.frames).toFixed(0)} ms, enc ${r.result.encoder})`}   [${sizes}]`);
    if (r.result?.timing) { const f = r.result.frames, T = r.result.timing, ms = (x) => (x / f).toFixed(0); console.log('    per frame: render ' + ms(T.render) + ' ms, encode ' + ms(T.encode) + ' ms; draw ' + Object.entries(T.draw).map(([k, v]) => k + ' ' + ms(v)).join(', ')); }
    await main.click('.modal.export button:has-text("Done"), .modal.export button:has-text("Close")');
    }
  }
} finally {
  await app.close();
}
