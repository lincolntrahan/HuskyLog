// Phase 3 harness: 3D map (track, aircraft, camera modes), offline map cache
// (a real download around the reference log's field), and the horizon window.
// Usage: npm run build && node scripts/e2e-phase3.mjs   (needs internet once)
import { _electron as electron } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const shots = join(root, '.e2e');
mkdirSync(shots, { recursive: true });
const logPath = process.env.HUSKYLOG_REF_LOG ?? join(root, 'test-data', 'logs', 'reference.bin');
if (!existsSync(logPath)) { console.error('reference log missing:', logPath); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };
const exe = process.env.HUSKYLOG_EXE;
const launch = () => electron.launch({
  ...(exe ? { executablePath: exe, args: [] } : { args: [root] }),
  env: { ...process.env, HUSKYLOG_E2E: '1', HUSKYLOG_DISPLAY: process.env.HUSKYLOG_DISPLAY ?? 'secondary' },
});

async function openLog(main) {
  main.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 300)));
  await main.waitForFunction(() => !!window.__hl?.dock);
  const f = await main.evaluate((p) => window.huskylog.e2eRegister(p), logPath);
  await main.evaluate((file) => window.dispatchEvent(new CustomEvent('hl-e2e-add', { detail: file })), f);
  await main.waitForFunction(() => window.__hl['mapState:map3d-0']?.().trackPoints > 0, null, { timeout: 30000 });
  // Give the map most of the window for screenshots.
  await main.evaluate(() => { const d = window.__hl.dock; d.getPanel('map3d-0').api.setSize({ height: 620, width: 1150 }); });
}
const mapState = (main) => main.evaluate(() => window.__hl['mapState:map3d-0']());
const waitTiles = async (main, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if ((await mapState(main)).tilesLoaded) return true; await sleep(250); }
  return false;
};

let app = await launch();
try {
  let main = await app.firstWindow();
  // Clean slate: remove cached areas in the throwaway e2e profile.
  await main.waitForFunction(() => !!window.huskylog);
  for (const a of await main.evaluate(() => window.huskylog.mapAreas())) await main.evaluate((id) => window.huskylog.mapDelete(id), a.id);
  await main.reload();
  await openLog(main);

  // ---- Track and aircraft without any cache ----
  await main.evaluate(() => window.__hl.timeline.getState().setT(450));
  await sleep(800);
  let st = await mapState(main);
  check('track drawn from the log (POS, decimated)', st.trackPoints > 1000 && st.trackPoints <= 4001, String(st.trackPoints));
  check('aircraft shown at the playhead', st.aircraft && st.aircraftWindow !== null);
  check('flown-so-far segment built', st.pastIdx > 0, String(st.pastIdx));
  check('"no offline map" prompt shown', !!(await main.$('.map-banner:has-text("No offline map")')));

  // ---- Download the field area ----
  await main.click('.map-banner button:has-text("Download")');
  await main.fill('.cache-modal input[aria-label="Margin"]', '1000');
  await sleep(500);
  const estText = await main.textContent('.cache-modal .modal-actions .muted');
  console.log('      estimate:', estText);
  const t0 = Date.now();
  await main.click('.cache-modal button:has-text("Download")');
  await main.waitForSelector('.cache-modal td:has-text("Complete")', { timeout: 180000 });
  const areas = await main.evaluate(() => window.huskylog.mapAreas());
  check('area downloaded completely', areas.length === 1 && areas[0].complete && areas[0].failed === 0,
    `${areas[0]?.tiles} tiles, ${(areas[0]?.bytes / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await main.click('.cache-modal button:has-text("Close")');
  await main.waitForFunction(() => window.__hl['mapState:map3d-0']?.().layers === 2 && window.__hl['mapState:map3d-0']?.().terrain, null, { timeout: 20000 });
  await sleep(1500);
  st = await mapState(main);
  check('imagery layer + terrain active', st.layers === 2 && st.terrain);
  check('ground at home from cached terrain', st.ground?.source === 'cached terrain' && st.ground.h > 0 && st.ground.h < 60, JSON.stringify(st.ground));
  check('banner gone once the flight is covered', !(await main.$('.map-banner:has-text("No offline map")')));
  await waitTiles(main);
  const camH = (await main.evaluate(() => window.__hl['camera:map3d-0']())).height;
  check('initial free view frames the flight (not the globe)', camH < 5000, `camera height ${camH.toFixed(0)} m`);
  await main.screenshot({ path: join(shots, 'p3-map-free.png') });

  // ---- Camera modes ----
  for (const mode of ['Chase', 'Top', 'Follow']) {
    await main.click(`.map-bar button:has-text("${mode}")`);
    await sleep(600);
    await waitTiles(main, 8000);
    const s = await mapState(main);
    const box = await main.locator('.map-host').boundingBox();
    const centred = s.aircraftWindow && Math.abs(s.aircraftWindow.x - box.width / 2) < box.width * 0.2 && Math.abs(s.aircraftWindow.y - box.height / 2) < box.height * 0.3;
    check(`${mode} camera keeps the aircraft near the centre`, !!centred, s.aircraftWindow ? `${s.aircraftWindow.x.toFixed(0)},${s.aircraftWindow.y.toFixed(0)} in ${box.width.toFixed(0)}×${box.height.toFixed(0)}` : 'off-screen');
    await main.screenshot({ path: join(shots, `p3-map-${mode.toLowerCase()}.png`) });
  }
  // Playback moves the aircraft in chase mode.
  await main.click('.map-bar button:has-text("Chase")');
  await main.evaluate(() => { const s = window.__hl.timeline.getState(); s.setT(430); s.setSpeed(4); s.setPlaying(true); });
  await sleep(1500);
  await main.evaluate(() => window.__hl.timeline.getState().setPlaying(false));
  const tAfter = await main.evaluate(() => window.__hl.timeline.getState().t);
  check('playback advances while the map renders', tAfter > 434, tAfter.toFixed(2));

  // ---- Click on the track moves the playhead ----
  await main.click('.map-bar button:has-text("Top")');
  await main.evaluate(() => window.__hl.timeline.getState().setT(500));
  await sleep(500);
  st = await mapState(main);
  const host = await main.locator('.map-host').boundingBox();
  if (st.aircraftWindow) {
    await main.mouse.click(host.x + st.aircraftWindow.x, host.y + st.aircraftWindow.y);
    await sleep(300);
    const tClick = await main.evaluate(() => window.__hl.timeline.getState().t);
    check('clicking the track sets the playhead nearby', Math.abs(tClick - 500) < 15, tClick.toFixed(2));
    await main.click('.map-bar button:has-text("Free")');
  } else check('clicking the track sets the playhead nearby', false, 'aircraft off-screen');

  // ---- Altitude reference: AMSL vs relative ----
  await main.selectOption('.map-bar select', 'amsl');
  await sleep(800);
  check('AMSL mode renders', (await mapState(main)).trackPoints > 0);
  await main.selectOption('.map-bar select', 'relative');

  // ---- Horizon ----
  await main.click('.dv-tab:has-text("Horizon")');
  await main.evaluate(() => window.__hl.timeline.getState().setT(450));
  await sleep(500);
  const adi = await main.evaluate(() => window.__hl['adi:adi-0']);
  const att = await main.evaluate(async () => {
    const t = 450;
    const g = window.__hl['graph:graph-0'];
    return { t, g: !!g };
  });
  check('horizon shows attitude, speed, altitude, mode at the playhead', adi && Number.isFinite(adi.roll) && Number.isFinite(adi.airspeed) && Number.isFinite(adi.altitude) && adi.mode === 'RTL' && adi.armed === true,
    adi ? `roll ${adi.roll.toFixed(1)} pitch ${adi.pitch.toFixed(1)} hdg ${adi.heading.toFixed(0)} as ${adi.airspeed?.toFixed(1)} alt ${adi.altitude?.toFixed(1)} ${adi.mode}` : 'none');
  void att;
  await main.locator('.adi-panel').screenshot({ path: join(shots, 'p3-adi.png') });

  console.log('      blocked renderer network requests:', JSON.stringify(await main.evaluate(() => window.huskylog.blockedRequests())));
  await app.close();

  // ---- Restart: the cache persists and works without downloading ----
  app = await launch();
  main = await app.firstWindow();
  await openLog(main);
  await main.waitForFunction(() => window.__hl['mapState:map3d-0']?.().layers === 2, null, { timeout: 20000 });
  await main.evaluate(() => window.__hl.timeline.getState().setT(450));
  await waitTiles(main);
  const b = await main.evaluate(() => window.__hl['snapshot:map3d-0']());
  check('after restart, cached imagery + terrain load offline', (await mapState(main)).terrain && b > 20, `brightness ${b.toFixed(1)}`);
  await main.screenshot({ path: join(shots, 'p3-map-restart.png') });
} catch (err) {
  console.error('E2E FAILED:', err);
  await app.windows()[0]?.screenshot({ path: join(shots, 'p3-failure.png') }).catch(() => {});
  failed++;
} finally {
  await app.close().catch(() => {});
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exitCode = failed ? 1 : 0;
