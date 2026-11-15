// Phase 4 harness: video import, Sync tab and the synced Video window.
// Uses the reference log and a synthetic ground-camera clip with known truth
// (scripts/gen-sync-video.mjs): camera started at log 297.5 s, clock +300 ppm.
// Usage: npm run build && node scripts/e2e-phase4.mjs
import { _electron as electron } from 'playwright-core';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const shots = join(root, '.e2e');
mkdirSync(shots, { recursive: true });
const logPath = process.env.HUSKYLOG_REF_LOG ?? join(root, 'test-data', 'logs', 'reference.bin');
const vidPath = join(root, 'test-data', 'generated', 'ground_cam_sync.mp4');
if (!existsSync(logPath) || !existsSync(vidPath)) { console.error('need reference log and generated clip (node scripts/gen-sync-video.mjs)'); process.exit(2); }
const truth = JSON.parse(readFileSync(vidPath.replace('.mp4', '.truth.json'), 'utf8'));
const FRAME = 1 / 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };
const exe = process.env.HUSKYLOG_EXE;
const app = await electron.launch({
  ...(exe ? { executablePath: exe, args: [] } : { args: [root] }),
  env: { ...process.env, HUSKYLOG_E2E: '1', HUSKYLOG_DISPLAY: process.env.HUSKYLOG_DISPLAY ?? 'secondary' },
});
try {
  const main = await app.firstWindow();
  main.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 300)));
  await main.waitForFunction(() => !!window.__hl?.dock);
  for (const p of [logPath, vidPath]) {
    const f = await main.evaluate((x) => window.huskylog.e2eRegister(x), p);
    await main.evaluate((file) => window.dispatchEvent(new CustomEvent('hl-e2e-add', { detail: file })), f);
  }
  await main.click('button[role=tab]:has-text("Import")');
  await main.waitForSelector('text=Ready · sync it on the Sync tab', { timeout: 30000 });
  await main.waitForSelector('table.files >> text=ArduPlane', { timeout: 30000 });
  const vidRow = await main.textContent('table.files:has-text("Video") tbody tr');
  check('video imported with codec, fps and audio', /avc1.*1280×720.*30\.00 fps.*mp4a/.test(vidRow ?? ''), vidRow?.replace(/\s+/g, ' ').slice(0, 110));
  const ids = await main.evaluate(() => ({ log: window.__hl.logs.getState().order[0], vid: window.__hl.media.getState().order[0] }));
  const read = await main.evaluate((id) => { const s = window.__hl.mediaSource(id); return { read: s.parseBytes, size: s.size }; }, ids.vid);
  check('opening a video reads only its index (moov stored at the end)', read.read < read.size * 0.6, `${(read.read / 1e6).toFixed(2)} of ${(read.size / 1e6).toFixed(2)} MB`);

  // Review shows "not synced" before any markers.
  await main.click('button[role=tab]:has-text("Review")');
  await main.waitForFunction(() => window.__hl['video:video-0']?.overlay === 'unsynced', null, { timeout: 10000 });
  check('Video window says "not synced" before syncing', true);

  // ---- Sync tab ----
  await main.click('button[role=tab]:has-text("Sync")');
  await main.waitForSelector('.lane >> nth=1');
  await main.waitForSelector('.lane-head:has-text("audio waveform")', { timeout: 20000 });
  check('lanes for log and video; audio waveform decoded', (await main.$$('.lane')).length === 2);
  for (const name of ['Prop start', 'Wave']) {
    await main.fill('input[aria-label="New event name"]', name);
    await main.click('button:has-text("Add event")');
  }
  const ev = await main.evaluate(() => Object.fromEntries(window.__hl.syncStore.getState().events.map((e) => [e.name, e.id])));
  const S = (fn, ...a) => main.evaluate(([f, args]) => window.__hl.sync[f](...args), [fn, a]);

  // Log lane: snap on ESC RPM near the spin-up, then place markers at the truth times.
  await S('setSelected', ids.log);
  await S('setCursor', ids.log, 314.6);
  await sleep(100);
  await S('snap');
  await sleep(100);
  const logSnap = (await S('getSuggest'))[ids.log];
  check('log snap on ESC.RPM finds the spin-up', logSnap > 313.9 && logSnap < 314.5, logSnap?.toFixed(3));
  // Commanded-vs-physical hint when snapping on the throttle output.
  await S('setActiveEvent', ev['Prop start']);
  await main.click('.lane:nth-child(1) .lane-chan >> nth=0');
  check('warning when placing "Prop start" on the throttle command', !!(await main.$('.warn:has-text("throttle")')));
  await main.click('.lane:nth-child(1) .lane-chan >> nth=1');
  await S('setCursor', ids.log, truth.events['Prop start']);
  await sleep(50);
  await S('place');
  await S('setActiveEvent', ev.Wave);
  await sleep(50);
  await S('setCursor', ids.log, truth.events.Wave);
  await sleep(50);
  await S('place');

  // Video lane: find each event by audio snap, accept, place.
  await S('setSelected', ids.vid);
  const videoSnaps = {};
  for (const [name, guess] of [['Prop start', 16.2], ['Wave', 102.0]]) {
    await S('setActiveEvent', ev[name]);
    await S('setCursor', ids.vid, guess);
    await sleep(80);
    await S('snap');
    await sleep(80);
    videoSnaps[name] = (await S('getSuggest'))[ids.vid];
    await S('acceptSnap');
    await sleep(80);
    await S('place');
    await sleep(80);
  }
  for (const name of ['Prop start', 'Wave']) {
    const err = (videoSnaps[name] - truth.localEvents[name]) * 1000;
    check(`audio snap finds "${name}" on the video`, Math.abs(err) < 15, `${videoSnaps[name]?.toFixed(4)} s (truth ${truth.localEvents[name].toFixed(4)}, ${err.toFixed(1)} ms)`);
  }
  await sleep(300);
  const sol = await main.evaluate((id) => window.__hl.syncStore.getState().solution.streams[id], ids.vid);
  const mapped = (L) => sol.a * L + sol.b;
  const e1 = (mapped(truth.localEvents['Prop start']) - truth.events['Prop start']) * 1000;
  const e2 = (mapped(truth.localEvents.Wave) - truth.events.Wave) * 1000;
  check('solver: video synced with drift', sol.status === 'synced' && sol.usedDrift, `a=${sol.a.toFixed(6)} (truth ${truth.A}), b=${sol.b.toFixed(4)} (truth ${truth.B}), ${sol.driftPpm.toFixed(0)} ppm`);
  check('mapping error at both events < 1 frame', Math.abs(e1) < FRAME * 1000 && Math.abs(e2) < FRAME * 1000, `${e1.toFixed(1)} ms, ${e2.toFixed(1)} ms`);
  check('residuals listed', /Prop start: -?\d+\.\d ms/.test((await main.textContent('.sync-results')) ?? ''));
  await main.click('.lane:nth-child(1) .lane-head');
  await main.click('.seg button:has-text("Aligned")');
  await sleep(500);
  await main.screenshot({ path: join(shots, 'p4-sync.png') });

  // ---- Review: frames line up with the log ----
  await main.click('button[role=tab]:has-text("Review")');
  const frameBrightness = async (t) => {
    await main.evaluate((x) => window.__hl.timeline.getState().setT(x), t);
    await main.waitForFunction(() => { const d = window.__hl['video:video-0']; return d && d.drawn === d.index && d.index >= 0; }, null, { timeout: 10000 });
    return main.evaluate(() => {
      const c = document.querySelector('.video-stage canvas');
      const x = document.createElement('canvas'); x.width = 32; x.height = 18;
      const g = x.getContext('2d'); g.drawImage(c, 0, 0, 32, 18);
      const px = g.getImageData(0, 0, 32, 18).data; let s = 0;
      for (let i = 0; i < px.length; i += 4) s += (px[i] + px[i + 1] + px[i + 2]) / 3;
      return s / (px.length / 4);
    });
  };
  for (const name of ['Prop start', 'Wave']) {
    const T = truth.events[name];
    const before = await frameBrightness(T - 2 * FRAME);
    const after = await frameBrightness(T + 1.2 * FRAME);
    check(`at log time of "${name}" the video shows the flash (±1 frame)`, before < 80 && after > 200, `2 frames before: ${before.toFixed(0)}, 1 frame after: ${after.toFixed(0)}`);
  }
  await main.evaluate(() => window.__hl.timeline.getState().setT(400.1));
  await sleep(600);
  await main.screenshot({ path: join(shots, 'p4-review.png') });

  // Playback: the native player stays locked to the log clock.
  await main.evaluate(() => { const s = window.__hl.timeline.getState(); s.setT(395); s.setSpeed(1); s.setPlaying(true); });
  await sleep(2500);
  const play = await main.evaluate(() => {
    const v = document.querySelector('.video-stage video');
    const t = window.__hl.timeline.getState().t;
    const s = window.__hl.syncStore.getState().solution.streams[window.__hl.media.getState().order[0]];
    return { showing: window.__hl['video:video-0'].showing, currentTime: v.currentTime, expected: (t - s.b) / s.a, paused: v.paused };
  });
  await main.evaluate(() => window.__hl.timeline.getState().setPlaying(false));
  const drift = Math.abs(play.currentTime - play.expected);
  // Two clocks sampled a few ms apart, so allow 2 frames; the player re-locks beyond 1.
  check('during playback the video plays and stays within ~2 frames', play.showing === 'video' && !play.paused && drift < 2 * FRAME, `drift ${(drift * 1000).toFixed(1)} ms`);
  console.log('      blocked network requests:', JSON.stringify(await main.evaluate(() => window.huskylog.blockedRequests())));
} catch (err) {
  console.error('E2E FAILED:', err);
  await app.windows()[0]?.screenshot({ path: join(shots, 'p4-failure.png') }).catch(() => {});
  failed++;
} finally {
  await app.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exitCode = failed ? 1 : 0;
