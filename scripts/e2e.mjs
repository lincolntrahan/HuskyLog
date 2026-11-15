// Phase 0 spike harness: drives the built app with Playwright and reports
// whether pop-outs, Cesium-in-a-pop-out and WebCodecs frame stepping work.
// Usage: npm run build && node scripts/e2e.mjs   (screenshots go to .e2e/)
import { _electron as electron } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const shots = join(root, '.e2e');
mkdirSync(shots, { recursive: true });
const results = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (k, v) => { results[k] = v; console.log(k.padEnd(34), typeof v === 'object' ? JSON.stringify(v) : v); };

const exe = process.env.HUSKYLOG_EXE; // test a packaged build instead of out/
const app = await electron.launch({ ...(exe ? { executablePath: exe, args: [] } : { args: [root] }), env: { ...process.env, HUSKYLOG_E2E: '1', HUSKYLOG_DISPLAY: process.env.HUSKYLOG_DISPLAY ?? 'secondary' } });
try {
  const main = await app.firstWindow();
  main.on('console', (m) => { if (m.type() === 'error') console.log('  [renderer error]', m.text().slice(0, 300)); });
  await main.waitForFunction(() => window.__hl?.maps?.['map3d-0']?.frames > 30, null, { timeout: 30000 });
  await sleep(2500); // let imagery tiles load
  await main.screenshot({ path: join(shots, '01-main.png') });
  log('origin', await main.evaluate(() => location.origin));
  log('displays', await app.evaluate(({ screen, BrowserWindow }) => ({ count: screen.getAllDisplays().length, primary: screen.getPrimaryDisplay().bounds, window: BrowserWindow.getAllWindows()[0]?.getBounds() })));
  log('map docked: frames', await main.evaluate(() => window.__hl.maps['map3d-0'].frames));
  log('map docked: brightness', +(await main.evaluate(() => window.__hl['snapshot:map3d-0']())).toFixed(1));

  // ---- Spike 1+2: pop out the map (strategy "keep": move the live WebGL canvas) ----
  const frames = (id) => main.evaluate((i) => window.__hl.maps[i].frames, id);
  const popout = async (panelId) => {
    const n = app.windows().length;
    await main.evaluate((id) => {
      const dock = window.__hl.dock;
      return dock.addPopoutGroup(dock.getPanel(id).group, { popoutUrl: '/popout.html' });
    }, panelId);
    for (let i = 0; i < 50 && app.windows().length === n; i++) await sleep(100);
    const w = app.windows().find((x) => x !== main && !x.isClosed());
    await w.setViewportSize?.({ width: 900, height: 600 }).catch(() => {});
    return w;
  };
  const measure = async (label, id, win) => {
    await sleep(2500);
    const f0 = await frames(id);
    await sleep(1000);
    const f1 = await frames(id);
    const d = await main.evaluate((i) => window.__hl.maps[i], id);
    const b = await main.evaluate((i) => window.__hl[`snapshot:${i}`](), id);
    log(`${label}: fps`, f1 - f0);
    log(`${label}: diag`, { created: d.created, hostIsPopout: d.hostIsPopout, contextLost: d.contextLost, err: d.lastError ?? null });
    log(`${label}: brightness`, +b.toFixed(1));
    if (win) await win.screenshot({ path: join(shots, `${label.replace(/\W+/g, '_')}.png`) });
  };

  await main.evaluate(() => { window.__hl.mapStrategy = 'keep'; });
  let pop = await popout('map3d-0');
  log('popout window opened', !!pop);
  if (pop) log('popout url', pop.url());
  await measure('popout[keep]', 'map3d-0', pop);

  // Drag inside the pop-out: does the camera move? (tests the disableRootEvents fix)
  if (pop) {
    const cam0 = await main.evaluate(() => window.__hl['camera:map3d-0']());
    const box = await pop.evaluate(() => { const c = document.querySelector('canvas'); const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    await pop.mouse.move(cx, cy);
    await pop.mouse.down();
    for (let i = 1; i <= 10; i++) await pop.mouse.move(cx + i * 15, cy + i * 5);
    await pop.mouse.up();
    await sleep(500);
    const cam1 = await main.evaluate(() => window.__hl['camera:map3d-0']());
    log('popout drag moved camera', Math.abs(cam1.lon - cam0.lon) + Math.abs(cam1.lat - cam0.lat) > 1e-6);
  }

  // Hide the main window: does the pop-out keep rendering?
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getSize()[0] >= 1400)?.hide());
  await measure('popout[keep] main hidden', 'map3d-0', null);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => !w.isVisible() && w.showInactive()));

  // Close the pop-out window: the group should return to the grid.
  if (pop) await pop.close();
  await sleep(1500);
  await measure('re-docked[keep]', 'map3d-0', null);

  // Strategy "recreate": destroy and rebuild the viewer on re-parent.
  await main.evaluate(() => { window.__hl.mapStrategy = 'recreate'; });
  pop = await popout('map3d-0');
  await measure('popout[recreate]', 'map3d-0', pop);
  if (pop) await pop.close();
  await sleep(1000);

  // ---- Spike 3: WebCodecs frame stepping ----
  const clips = ['h264_60fps_bframes.mp4', 'hevc_60fps.mp4', 'h264_vfr.mp4'];
  for (const clip of clips) {
    const p = join(root, 'test-data', 'generated', clip);
    const f = await main.evaluate((path) => window.huskylog.e2eRegister(path), p);
    await main.evaluate((file) => {
      // add through the store the same way the Import tab does
      const ev = new CustomEvent('hl-e2e-add', { detail: file }); window.dispatchEvent(ev);
    }, f);
    await main.waitForFunction((name) => {
      const v = window.__hl.videos['video-0'];
      return v && (v.error || (v.codec && v.index === 0 && document.querySelector('select[aria-label="Video file"]')?.selectedOptions[0]?.text === name));
    }, clip, { timeout: 20000 }).catch(() => {});
    const v0 = await main.evaluate(() => ({ ...window.__hl.videos['video-0'] }));
    const k = clip.replace('.mp4', '');
    log(`${k}: track`, { codec: v0.codec, supported: v0.supported, frames: v0.samples, keyframes: v0.keyframes, fps: v0.fps && +v0.fps.toFixed(3), error: v0.error ?? null });
    if (!v0.supported) continue;
    const go = async (i) => {
      await main.evaluate((n) => window.__hl['video:video-0'].setIndex(n), i);
      await main.waitForFunction((n) => window.__hl.videos['video-0'].index === n || window.__hl.videos['video-0'].error, i, { timeout: 15000 });
      const err = await main.evaluate(() => window.__hl.videos['video-0'].error);
      if (err) throw new Error('decode failed: ' + err);
      return main.evaluate(() => ({ ...window.__hl.videos['video-0'] }));
    };
    const a = await go(300);  // mid-GOP random seek
    const b = await go(301);  // forward step (cache)
    const c = await go(299);  // backward step
    const e = await go(v0.samples - 1); // last frame
    log(`${k}: seek 300`, { ptsS: a.ptsUs / 1e6, ms: +a.lastStepMs.toFixed(1) });
    log(`${k}: step +1 / -1`, { pts301: b.ptsUs / 1e6, ms301: +b.lastStepMs.toFixed(1), pts299: c.ptsUs / 1e6, ms299: +c.lastStepMs.toFixed(1) });
    log(`${k}: last frame`, { index: e.index, ptsS: e.ptsUs / 1e6, ms: +e.lastStepMs.toFixed(1) });
    await go(300);
    await main.screenshot({ path: join(shots, `video_${k}_f300.png`) });
  }

  log('blocked network requests', await main.evaluate(() => window.huskylog.blockedRequests()));
} catch (err) {
  console.error('E2E FAILED:', err);
  process.exitCode = 1;
} finally {
  await app.close();
}
