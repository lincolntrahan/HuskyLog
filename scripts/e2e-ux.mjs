// UX round 1: Sync tab play + drag-scrub, cascading source menu, "G" preset.
// Usage: npm run build && node scripts/e2e-ux.mjs
import { _electron as electron } from 'playwright-core';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const shots = join(root, '.e2e');
mkdirSync(shots, { recursive: true });
const logPath = process.env.HUSKYLOG_REF_LOG ?? join(root, 'test-data', 'logs', 'reference.bin');
const vidPath = join(root, 'test-data', 'generated', 'ground_cam_sync.mp4');
if (!existsSync(logPath) || !existsSync(vidPath)) { console.error('need reference log and generated clip'); process.exit(2); }
const truth = JSON.parse(readFileSync(vidPath.replace('.mp4', '.truth.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`); if (!ok) failed++; };
const exe = process.env.HUSKYLOG_EXE;
const app = await electron.launch({ ...(exe ? { executablePath: exe, args: [] } : { args: [root] }), env: { ...process.env, HUSKYLOG_E2E: '1', HUSKYLOG_DISPLAY: process.env.HUSKYLOG_DISPLAY ?? 'secondary' } });
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

  // ================= Sync tab =================
  await main.click('button[role=tab]:has-text("Sync")');
  await main.waitForSelector('.lane >> nth=1');
  const vidLane = await (await main.$('.lane:nth-child(2) .lane-canvas')).boundingBox();
  // Drag across the video lane: the cursor follows the mouse the whole way.
  const seen = [];
  await main.mouse.move(vidLane.x + vidLane.width * 0.2, vidLane.y + vidLane.height * 0.6);
  await main.mouse.down();
  for (let k = 1; k <= 8; k++) {
    await main.mouse.move(vidLane.x + vidLane.width * (0.2 + 0.05 * k), vidLane.y + vidLane.height * 0.6);
    await sleep(60);
    seen.push((await main.evaluate((id) => window.__hl.sync.getCursors()[id], ids.vid)));
  }
  await main.mouse.up();
  const rising = seen.every((v, i) => i === 0 || v > seen[i - 1]);
  check('dragging in a lane scrubs the cursor continuously', rising && seen.length === 8 && seen[7] - seen[0] > 20, seen.map((v) => v.toFixed(1)).join(' → '));
  await main.waitForFunction((id) => { const p = window.__hl.syncPreview, c = window.__hl.sync.getCursors()[id]; return p && p.index === window.__hl.mediaSource(id).indexAt(c); }, ids.vid, { timeout: 10000 });
  check('preview lands on the frame under the cursor after a fast scrub', true);

  // Jog on the preview: +30 px = +30 frames.
  const before = await main.evaluate((id) => window.__hl.mediaSource(id).indexAt(window.__hl.sync.getCursors()[id]), ids.vid);
  const pv = await (await main.$('.sync-preview-stage')).boundingBox();
  await main.mouse.move(pv.x + pv.width / 2, pv.y + pv.height / 2);
  await main.mouse.down();
  await main.mouse.move(pv.x + pv.width / 2 + 15, pv.y + pv.height / 2, { steps: 3 });
  await main.mouse.move(pv.x + pv.width / 2 + 30, pv.y + pv.height / 2, { steps: 3 });
  await main.mouse.up();
  const after = await main.evaluate((id) => window.__hl.mediaSource(id).indexAt(window.__hl.sync.getCursors()[id]), ids.vid);
  check('dragging on the video preview jogs frame by frame', after - before === 30, `frame ${before} → ${after}`);
  await main.mouse.move(pv.x + pv.width / 2, pv.y + pv.height / 2);
  await main.mouse.wheel(0, 100);
  await sleep(150);
  const wheel = await main.evaluate((id) => window.__hl.mediaSource(id).indexAt(window.__hl.sync.getCursors()[id]), ids.vid);
  check('wheel on the preview steps one frame', wheel === after + 1, `→ ${wheel}`);

  // Play with Space (no click into the tab needed); the review timeline does not start.
  await main.evaluate((id) => { window.__hl.sync.setSelected(id); window.__hl.sync.setCursor(id, 10); }, ids.vid);
  await sleep(200);
  await main.click('.sync-bar .muted >> nth=0'); // focus somewhere neutral
  await main.keyboard.press('Space');
  await sleep(1600);
  const playing = await main.evaluate(() => window.__hl.sync.isPlaying());
  const c1 = await main.evaluate((id) => window.__hl.sync.getCursors()[id], ids.vid);
  const videoShown = await main.$eval('.sync-preview-stage video', (v) => getComputedStyle(v).display !== 'none' && !v.paused);
  check('Space plays the selected video in the Sync tab', playing && videoShown && c1 > 11.0 && c1 < 12.2, `cursor 10 → ${c1.toFixed(2)} s after 1.6 s`);
  check('the Review timeline is not started by Space on the Sync tab', !(await main.evaluate(() => window.__hl.timeline.getState().playing)));
  await main.keyboard.press('Space');
  await sleep(300);
  const c2 = await main.evaluate((id) => window.__hl.sync.getCursors()[id], ids.vid);
  await sleep(500);
  const c3 = await main.evaluate((id) => window.__hl.sync.getCursors()[id], ids.vid);
  check('Space pauses; the cursor stays on the paused frame', !(await main.evaluate(() => window.__hl.sync.isPlaying())) && c2 === c3, `${c2.toFixed(3)} s`);
  // Slow motion to find the exact moment.
  await main.evaluate(() => window.__hl.sync.setRate(0.25));
  await main.evaluate(([id, t]) => window.__hl.sync.setCursor(id, t), [ids.vid, truth.localEvents.Wave - 1]);
  await main.click('.sync-tools button[aria-label="Play"]');
  await sleep(2000);
  await main.click('.sync-tools button[aria-label="Pause"]');
  const c4 = await main.evaluate((id) => window.__hl.sync.getCursors()[id], ids.vid);
  const moved = c4 - (truth.localEvents.Wave - 1);
  check('0.25× playback runs at quarter speed', moved > 0.35 && moved < 0.65, `${moved.toFixed(2)} s of video in 2 s`);
  // Play a log lane too: the cursor advances and the view follows.
  await main.evaluate((id) => { window.__hl.sync.setRate(2); window.__hl.sync.setSelected(id); window.__hl.sync.setCursor(id, 300); }, ids.log);
  await sleep(150);
  await main.evaluate(() => window.__hl.sync.setPlaying(true));
  await sleep(1500);
  await main.evaluate(() => window.__hl.sync.setPlaying(false));
  const lc = await main.evaluate((id) => window.__hl.sync.getCursors()[id], ids.log);
  check('log lanes play too (2×)', lc > 302 && lc < 304, `300 → ${lc.toFixed(2)} s`);
  await main.screenshot({ path: join(shots, 'ux-sync.png') });

  // ================= Cascading source menu (readout) =================
  await main.click('button[role=tab]:has-text("Review")');
  await main.evaluate(() => { window.__hl.overlays.getState().setEditing('video-0'); window.__hl.timeline.getState().setT(60); });
  await main.click('.overlay-layer[data-window="video-0"] button:has-text("＋ Widget")');
  await main.waitForSelector('.overlay-editor');
  await main.click('.overlay-editor button[aria-label="Pick source 1"]');
  await main.waitForSelector('.cascade-col');
  const top = await main.$$eval('.cascade-col[data-level="0"] .cascade-label', (e) => e.map((x) => x.textContent));
  const types = top.filter((t) => /^[A-Z]/.test(t));
  const sorted = [...types].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  check('menu: presets on top, then message types A–Z, plumbing hidden', top[0] === '★ Presets' && top.includes('⚑ Flight state') && JSON.stringify(types) === JSON.stringify(sorted) && !types.includes('FMT') && !types.includes('PARM') && types.includes('ATT'),
    `${top.slice(0, 6).join(', ')} … ${types.length} types`);
  const list0 = await main.$eval('.cascade-col[data-level="0"] .cascade-list', (e) => ({ sh: e.scrollHeight, ch: e.clientHeight, oy: getComputedStyle(e).overflowY }));
  check('long menus scroll', list0.oy === 'auto' && list0.sh > list0.ch, `${list0.ch}px window over ${list0.sh}px`);
  await main.hover('.cascade-col[data-level="0"] [data-key="t:ATT"]');
  await main.waitForSelector('.cascade-col[data-level="1"]');
  const att = await main.$$eval('.cascade-col[data-level="1"] .cascade-row', (e) => e.map((x) => x.textContent));
  check('hovering ATT opens its fields (with units)', att.some((t) => /^Roll.*deg|^Roll.*°/.test(t)) && att.length > 4, att.slice(0, 4).join(' | '));
  const multi = await main.$$eval('.cascade-col[data-level="0"] .cascade-row', (e) => e.map((x) => [x.dataset.key, x.textContent]).filter(([, t]) => /×▸$/.test(t)).map(([k]) => k));
  if (multi.length) {
    await main.hover(`.cascade-col[data-level="0"] [data-key="${multi[0]}"]`);
    await main.waitForFunction(() => document.querySelector('.cascade-col[data-level="1"] .cascade-row')?.textContent?.includes('['));
    const inst = await main.$$eval('.cascade-col[data-level="1"] .cascade-row', (e) => e.map((x) => x.dataset.key));
    await main.hover(`.cascade-col[data-level="1"] [data-key="${inst[1] ?? inst[0]}"]`);
    await main.waitForSelector('.cascade-col[data-level="2"]');
    check('multi-instance messages get an instance level (e.g. IMU ▸ IMU[1] ▸ AccZ)', inst.length >= 2 && (await main.$$('.cascade-col[data-level="2"] .cascade-row')).length > 2, `${multi[0]} → ${inst.join(', ')}`);
  }
  // Presets ▸ Expressions ▸ G
  await main.hover('.cascade-col[data-level="0"] [data-key="presets"]');
  await main.waitForSelector('.cascade-col[data-level="1"] [data-key="pf:Expressions"]');
  await main.hover('.cascade-col[data-level="1"] [data-key="pf:Expressions"]');
  await main.waitForSelector('.cascade-col[data-level="2"] [data-key="p:G (total acceleration)"]');
  await main.click('.cascade-col[data-level="2"] [data-key="p:G (total acceleration)"]');
  await sleep(800);
  const line = await main.evaluate(() => window.__hl.overlays.getState().byWindow['video-0'].at(-1).lines[0]);
  const shown = await main.evaluate(() => window.__hl['overlay:video-0'].lines.at(-1)[0]);
  check('picking fills source, label, unit and format', line.source === 'hypot(IMU.AccX, IMU.AccY, IMU.AccZ) / g' && line.label === 'G' && line.unit === 'g' && line.format === '%.2f', JSON.stringify(line));
  const gVal = Number(/G ([\d.]+) g/.exec(shown)?.[1]);
  check('G reads about 1 g on the ground before takeoff', gVal > 0.95 && gVal < 1.05, shown);
  // Filter flattens the tree.
  await main.click('.overlay-editor button[aria-label="Pick source 2"]');
  await main.waitForSelector('.cascade-filter');
  await main.fill('.cascade-filter', 'att pitch');
  await sleep(150);
  const flt = await main.$$eval('.cascade-col[data-level="0"] .cascade-label', (e) => e.map((x) => x.textContent));
  check('typing filters to matching fields', flt.includes('ATT.Pitch') && flt.length < 15, flt.slice(0, 5).join(', '));
  await main.keyboard.press('Enter');
  await sleep(300);
  const l2 = await main.evaluate(() => window.__hl.overlays.getState().byWindow['video-0'].at(-1).lines[1]);
  check('Enter picks the first match', /Pitch/.test(l2.source), l2.source);
  await main.screenshot({ path: join(shots, 'ux-menu.png') });

  // ================= Graph: G preset and browse ▾ =================
  await main.evaluate(() => window.__hl.overlays.getState().setEditing(null));
  await main.click('.graph-bar button:has-text("Presets")');
  await main.click('text=G (total acceleration)');
  await sleep(1500);
  const gs = await main.evaluate(() => ({ s: window.__hl['graph:graph-0'].getCfg().series, named: window.__hl.expressions.getState().named.G }));
  check('graph preset "G (total acceleration)" plots the accel magnitude in g', gs.s.length === 1 && gs.s[0].id === 'G' && gs.s[0].unit === 'g' && gs.named === 'hypot(IMU.AccX, IMU.AccY, IMU.AccZ) / g', JSON.stringify(gs));
  const chip = await main.textContent('.legend .chip .chip-val');
  check('graph legend shows G in g', /\d\.\d+ g/.test(chip ?? ''), chip);
  await main.click('.graph-bar button[aria-label="Browse channels"]');
  await main.hover('.cascade-col[data-level="0"] [data-key="t:ATT"]');
  await main.waitForSelector('.cascade-col[data-level="1"] [data-key="c:ATT.Roll"]');
  await main.click('.cascade-col[data-level="1"] [data-key="c:ATT.Roll"]');
  await sleep(500);
  check('graph ▾ adds the picked channel', (await main.evaluate(() => window.__hl['graph:graph-0'].getCfg().series.map((s) => s.id))).includes('ATT.Roll'));
} catch (e) {
  failed++;
  console.error('ERROR', e);
  await app.windows()[0]?.screenshot({ path: join(shots, 'ux-failure.png') }).catch(() => {});
} finally {
  await app.close().catch(() => {});
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll UX checks passed');
process.exit(failed ? 1 : 0);
