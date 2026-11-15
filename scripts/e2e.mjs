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

  // ---- Spike 3: WebCodecs frame stepping (now the app's MediaSource) ----
  const clips = ['h264_60fps_bframes.mp4', 'hevc_60fps.mp4', 'h264_vfr.mp4'];
  for (const clip of clips) {
    const p = join(root, 'test-data', 'generated', clip);
    const f = await main.evaluate((path) => window.huskylog.e2eRegister(path), p);
    await main.evaluate((file) => window.dispatchEvent(new CustomEvent('hl-e2e-add', { detail: file })), f);
    const k = clip.replace('.mp4', '');
    const id = await main.waitForFunction((name) => {
      const m = window.__hl.media.getState();
      const id = m.order.find((x) => m.videos[x].name === name);
      return id && m.videos[id].status !== 'loading' ? id : null;
    }, k, { timeout: 20000 }).then((h) => h.jsonValue());
    const info = await main.evaluate((i) => window.__hl.media.getState().videos[i], id);
    log(`${k}: track`, { codec: info.video?.codec, supported: info.video?.supported, frames: info.video?.frames, keyframes: info.video?.keyframes, fps: info.video && +info.video.fpsAvg.toFixed(3), error: info.error ?? null });
    if (!info.video?.supported) continue;
    const go = (i) => main.evaluate(async ([vid, n]) => {
      const s = window.__hl.mediaSource(vid);
      const t0 = performance.now();
      await s.frame(n);
      return { ptsS: s.ptsUs(n) / 1e6, ms: +(performance.now() - t0).toFixed(1) };
    }, [id, i]);
    log(`${k}: seek 300`, await go(300));
    const b = await go(301), c = await go(299);
    log(`${k}: step +1 / -1`, { pts301: b.ptsS, ms301: b.ms, pts299: c.ptsS, ms299: c.ms });
    log(`${k}: last frame`, await go(info.video.frames - 1));
  }

  log('blocked network requests', await main.evaluate(() => window.huskylog.blockedRequests()));
} catch (err) {
  console.error('E2E FAILED:', err);
  process.exitCode = 1;
} finally {
  await app.close();
}
