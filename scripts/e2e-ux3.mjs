// UX round 3 harness (v0.1.7): step buttons (Review + Sync), trimming
// streams in Sync, header layout, overlay widgets with a type menu.
// Usage: npm run build && node scripts/e2e-ux3.mjs
import { _electron as electron } from 'playwright-core';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const logPath = process.env.HUSKYLOG_REF_LOG ?? join(root, 'test-data', 'logs', 'reference.bin');
const vidPath = join(root, 'test-data', 'generated', 'ground_cam_sync.mp4');
if (!existsSync(logPath) || !existsSync(vidPath)) { console.error('need reference log and generated clip'); process.exit(2); }
const truth = JSON.parse(readFileSync(vidPath.replace('.mp4', '.truth.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };
const app = await electron.launch({ args: [root], env: { ...process.env, HUSKYLOG_E2E: '1', HUSKYLOG_DISPLAY: process.env.HUSKYLOG_DISPLAY ?? 'secondary' } });

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
  await main.evaluate(([ids, truth]) => {
    const h = window.__hl;
    for (const name of ['Prop start', 'Wave']) { const ev = h.syncStore.getState().addEvent(name); h.syncStore.getState().setMarker(ids.log, ev, truth.events[name]); h.syncStore.getState().setMarker(ids.vid, ev, truth.localEvents[name]); }
  }, [ids, truth]);

  // ---------------------------------------------------------------- header
  const hdr = await main.evaluate(() => {
    const W = document.querySelector('.topbar').getBoundingClientRect().width;
    const tabs = document.querySelector('.tabs').getBoundingClientRect(), file = document.querySelector('.menu-btn').getBoundingClientRect();
    return { W, tabsLeft: tabs.left, tabsRight: tabs.right, fileLeft: file.left };
  });
  check('header: File on the left, tabs on the right', hdr.fileLeft < hdr.W * 0.2 && hdr.tabsLeft > hdr.W * 0.6 && hdr.W - hdr.tabsRight < 40, JSON.stringify(hdr));

  // ---------------------------------------------------------------- Review stepping
  const T0 = truth.events.Wave - 20;
  await main.evaluate((t) => window.__hl.timeline.getState().setT(t), T0);
  await sleep(600);
  const vstate = () => main.evaluate(() => ({ t: window.__hl.timeline.getState().t, i: window.__hl['video:video-0']?.index }));
  const s0 = await vstate();
  await main.click('.timeline button[aria-label="Forward 1 frame"]'); await sleep(250);
  const s1 = await vstate();
  await main.click('.timeline button[aria-label="Forward 10 frames"]'); await sleep(250);
  const s2 = await vstate();
  await main.click('.timeline button[aria-label="Back 1 frame"]'); await sleep(250);
  const s3 = await vstate();
  check('Review: ±1 and +10 frame step exactly one / ten video frames', s1.i === s0.i + 1 && s2.i === s1.i + 10 && s3.i === s2.i - 1, `frames ${s0.i} → ${s1.i} → ${s2.i} → ${s3.i}`);
  await main.click('.timeline button[aria-label="Forward 10 seconds"]'); await sleep(150);
  const s4 = await vstate();
  await main.click('.timeline button[aria-label="Back 1 second"]'); await sleep(150);
  const s5 = await vstate();
  check('Review: +10 s and −1 s', Math.abs(s4.t - s3.t - 10) < 1e-6 && Math.abs(s5.t - s4.t + 1) < 1e-6, `${s3.t.toFixed(3)} → ${s4.t.toFixed(3)} → ${s5.t.toFixed(3)}`);
  await main.click('.video-panel'); await main.keyboard.press('.'); await sleep(250);
  const s6 = await vstate();
  await main.keyboard.press('Shift+Comma'); await sleep(250);
  const s7 = await vstate();
  check('Review keys: "." +1 frame, Shift+"," −10 frames', s6.i === s5.i + 1 && s7.i === s6.i - 10, `${s5.i} → ${s6.i} → ${s7.i}`);

  // ---------------------------------------------------------------- Sync stepping + trim
  await main.click('button[role=tab]:has-text("Sync")');
  await sleep(800);
  await main.evaluate((vid) => { window.__hl.sync.setSelected(vid); window.__hl.sync.setCursor(vid, 30); }, ids.vid);
  await sleep(300);
  const groups = await main.$$eval('.sync-tools .tool-title', (els) => els.map((e) => e.textContent));
  check('Sync controls are grouped (Move, Marker, Trim)', ['Move', 'Marker', 'Trim'].every((g) => groups.includes(g)), groups.join(' · '));
  const cur = () => main.evaluate((id) => window.__hl.sync.getCursors()[id], ids.vid);
  const frameOf = (t) => main.evaluate(([id, t]) => window.__hl.mediaSource(id).indexAt(t), [ids.vid, t]);
  const c0 = await cur(); const f0 = await frameOf(c0);
  await main.click('.sync-tools button[aria-label="Forward 10 frames"]'); await sleep(200);
  const c1 = await cur(); const f1 = await frameOf(c1);
  await main.click('.sync-tools button[aria-label="Back 1 second"]'); await sleep(200);
  const c2 = await cur();
  check('Sync video lane: +10 frames, −1 s', f1 === f0 + 10 && Math.abs(c2 - c1 + 1) < 1e-6, `frame ${f0} → ${f1}, ${c1.toFixed(3)} → ${c2.toFixed(3)} s`);
  // Log lane steps by samples of the highlighted channel.
  await main.evaluate((log) => { window.__hl.sync.setSelected(log); window.__hl.sync.setCursor(log, 400); }, ids.log);
  await sleep(300);
  const labels = await main.$$eval('.sync-tools .step-buttons button', (bs) => bs.map((b) => b.textContent));
  await main.click('.sync-tools button[aria-label="Forward 1 sample"]'); await sleep(200);
  const lc1 = await main.evaluate((id) => window.__hl.sync.getCursors()[id], ids.log);
  await main.click('.sync-tools button[aria-label="Forward 10 samples"]'); await sleep(200);
  const lc2 = await main.evaluate((id) => window.__hl.sync.getCursors()[id], ids.log);
  check('Sync log lane: steps by samples', labels.includes('+1smp') && lc1 > 400 && lc1 - 400 < 0.5 && lc2 > lc1 && (lc2 - lc1) / (lc1 - 400) > 5, `400 → ${lc1.toFixed(4)} → ${lc2.toFixed(4)}`);
  // Trim the video to local 20…60 s with the buttons, and the log to 330…420 s.
  await main.evaluate((vid) => { window.__hl.sync.setSelected(vid); window.__hl.sync.setCursor(vid, 20); }, ids.vid);
  await sleep(200);
  await main.click('button[aria-label="Trim start here"]');
  await main.evaluate((vid) => window.__hl.sync.setCursor(vid, 60), ids.vid);
  await sleep(200);
  await main.click('button[aria-label="Trim end here"]');
  const vt = await main.evaluate((id) => window.__hl.syncStore.getState().options[id]?.trim, ids.vid);
  const keeps = await main.textContent('.sync-tools .tool-group:has(.tool-title:text("Trim")) .muted');
  check('trim start/end buttons set the kept range', vt && Math.abs(vt[0] - 20) < 1e-6 && Math.abs(vt[1] - 60) < 1e-6 && /keeps 0:20/.test(keeps), `${JSON.stringify(vt)} · "${keeps}"`);
  await main.evaluate((log) => { window.__hl.sync.setSelected(log); window.__hl.sync.setCursor(log, 330); }, ids.log);
  await sleep(200);
  await main.click('button[aria-label="Trim start here"]');
  await main.evaluate((log) => window.__hl.sync.setCursor(log, 420), ids.log);
  await sleep(200);
  await main.click('button[aria-label="Trim end here"]');
  await main.click('button[role=tab]:has-text("Review")');
  await sleep(500);
  const dom = await main.evaluate(() => window.__hl.timeDomain());
  const vidA = truth.B + 20 * truth.A, vidB = truth.B + 60 * truth.A;
  check('Review timeline spans only the kept parts', Math.abs(dom[0] - Math.min(330, vidA)) < 0.05 && Math.abs(dom[1] - Math.max(420, vidB)) < 0.05, `domain ${dom.map((x) => x.toFixed(2)).join(' → ')} (want ${Math.min(330, vidA).toFixed(2)} → ${Math.max(420, vidB).toFixed(2)})`);
  // Video: trimmed at local 10 s, normal at local 30 s.
  const at = async (local) => { await main.evaluate((t) => window.__hl.timeline.getState().setT(t), truth.B + local * truth.A); await sleep(500); return main.evaluate(() => window.__hl['video:video-0']?.overlay); };
  const ov10 = await at(10), ov30 = await at(30);
  check('video shows "Trimmed" outside its trim', ov10 === 'trimmed' && ov30 === null, `local 10 s: ${ov10}, 30 s: ${ov30}`);
  // Graph line and readout leave out the trimmed log part.
  await main.evaluate(() => { const g = window.__hl['graph:graph-0']; g.setCfg({ ...g.getCfg(), series: [{ id: 'ATT.Roll', color: '#ff5c8a', axis: 'auto', visible: true }] }); });
  await main.evaluate(() => window.__hl.overlays.getState().add('video-0', { id: 'ro', kind: 'readout', rect: { x: 0.05, y: 0.05, w: 0.3, h: 0.15 }, style: { color: '#ffffff', bg: '#000000', opacity: 0.6, align: 'left' }, lines: [{ label: 'Roll', source: 'ATT.Roll', format: '%.1f', unit: '°' }] }));
  await sleep(1500);
  const readout = await main.evaluate(async ([inT, outT]) => {
    const h = window.__hl;
    const item = h.overlays.getState().byWindow['video-0'].find((o) => o.id === 'ro');
    await new Promise((r) => setTimeout(r, 300));
    return { in: h.lineValue(item.lines[0], item, inT).text, out: h.lineValue(item.lines[0], item, outT).text };
  }, [400, 320]);
  const graphRange = await main.evaluate(() => window.__hl['graph:graph-0'].dataRange());
  check('readouts show nothing outside the log trim', readout.in !== '–' && readout.out === '–', JSON.stringify(readout));
  check('graph lines are clipped to the log trim', graphRange && graphRange[0] >= 330 - 1e-6 && graphRange[1] <= 420 + 1e-6, JSON.stringify(graphRange));
  const saved = await main.evaluate((id) => window.__hl.workspace.captureWorkspace().sync.options[id]?.trim, ids.vid);
  check('trims are saved with the workspace', saved && saved[0] === 20 && saved[1] === 60);

  // ---------------------------------------------------------------- widgets
  await main.evaluate(() => window.__hl.overlays.getState().setEditing('video-0'));
  await sleep(300);
  const addButtons = await main.$$eval('.overlay-layer[data-window="video-0"] .overlay-toolbar button', (bs) => bs.map((b) => b.textContent));
  await main.click('.overlay-layer[data-window="video-0"] button:has-text("＋ Widget")');
  await sleep(300);
  const w0 = await main.evaluate(() => { const s = window.__hl.overlays.getState(); return s.byWindow['video-0'].find((o) => o.id === s.selected); });
  await main.selectOption('.overlay-editor select[aria-label="Widget type"]', 'adi');
  const w1 = await main.evaluate((id) => window.__hl.overlays.getState().byWindow['video-0'].find((o) => o.id === id), w0.id);
  await main.selectOption('.overlay-editor select[aria-label="Widget type"]', 'sticks');
  await sleep(200);
  const w2 = await main.evaluate((id) => window.__hl.overlays.getState().byWindow['video-0'].find((o) => o.id === id), w0.id);
  const sticksOpts = await main.$$eval('.overlay-editor select[aria-label="Transmitter mode"]', (e) => e.length);
  await main.selectOption('.overlay-editor select[aria-label="Widget type"]', 'readout');
  const w3 = await main.evaluate((id) => window.__hl.overlays.getState().byWindow['video-0'].find((o) => o.id === id), w0.id);
  check('one "＋ Widget" button replaces the per-type buttons', addButtons.filter((t) => t.startsWith('＋')).join() === '＋ Widget', addButtons.join(' | '));
  check('widget type menu switches readout → horizon → sticks → readout in place', w0.kind === 'readout' && w1.kind === 'adi' && w2.kind === 'sticks' && w3.kind === 'readout' && w3.rect.x === w0.rect.x && w3.rect.y === w0.rect.y && w1.rect.h > w0.rect.h && w3.lines?.length === w0.lines.length && sticksOpts === 1,
    `${w0.kind} → ${w1.kind} → ${w2.kind} → ${w3.kind}, position kept, horizon ${w1.rect.w}×${w1.rect.h}, ${w3.lines?.length} lines`);
  await main.evaluate(() => window.__hl.overlays.getState().setEditing(null));
} finally {
  await app.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
