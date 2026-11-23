// Phase 5 harness: overlays (readout + horizon, edit mode), video zoom, and a
// two-monitor session (pop-out with overlays, keyboard in the pop-out, monitor
// memory within a session, across restarts, and fallback when the monitor is gone).
// Usage: npm run build && node scripts/e2e-phase5.mjs
import { _electron as electron } from 'playwright-core';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const shots = join(root, '.e2e');
mkdirSync(shots, { recursive: true });
const logPath = process.env.HUSKYLOG_REF_LOG ?? join(root, 'test-data', 'logs', 'reference.bin');
const vidPath = join(root, 'test-data', 'generated', 'ground_cam_sync.mp4');
if (!existsSync(logPath) || !existsSync(vidPath)) { console.error('need reference log and generated clip (node scripts/gen-sync-video.mjs)'); process.exit(2); }
const truth = JSON.parse(readFileSync(vidPath.replace('.mp4', '.truth.json'), 'utf8'));
const stateFile = join(tmpdir(), 'huskylog-e2e-profile', 'window-state.json');
rmSync(stateFile, { force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };
const exe = process.env.HUSKYLOG_EXE;
const launch = () => electron.launch({
  ...(exe ? { executablePath: exe, args: [] } : { args: [root] }),
  env: { ...process.env, HUSKYLOG_E2E: '1', HUSKYLOG_DISPLAY: process.env.HUSKYLOG_DISPLAY ?? 'secondary' },
});
const near = (a, b, tol) => Math.abs(a - b) <= tol;
// Tolerance covers Windows rounding window sizes to whole device pixels on scaled displays.
const sameBounds = (a, b, tol = 8) => a && b && near(a.x, b.x, tol) && near(a.y, b.y, tol) && near(a.width, b.width, tol) && near(a.height, b.height, tol);
const fmtB = (b) => (b ? `${b.x},${b.y} ${b.width}×${b.height}` : 'none');

/** Bounds of the main window and the (single) pop-out, from the main process. */
const winBounds = (app) => app.evaluate(({ BrowserWindow, screen }) => {
  const all = BrowserWindow.getAllWindows();
  const pop = all.find((w) => w.webContents.getURL().includes('popout.html'));
  const main = all.find((w) => !w.webContents.getURL().includes('popout.html'));
  const primary = screen.getPrimaryDisplay().id;
  const second = screen.getAllDisplays().find((d) => d.id !== primary) ?? screen.getPrimaryDisplay();
  const on = (b) => (b ? screen.getDisplayMatching(b).id : null);
  return {
    main: main?.getBounds(), pop: pop?.getBounds() ?? null, popTitle: pop?.getTitle() ?? null,
    mainDisplay: on(main?.getBounds()), popDisplay: on(pop?.getBounds()), primary, second: second.workArea, secondId: second.id,
  };
});
const setBounds = (app, which, b) => app.evaluate(({ BrowserWindow }, [w, bb]) => {
  const all = BrowserWindow.getAllWindows();
  const win = all.find((x) => x.webContents.getURL().includes('popout.html') === (w === 'pop'));
  win?.setBounds(bb);
}, [which, b]);

async function popOutVideo(app, main) {
  const n = app.windows().length;
  const g = await main.evaluateHandle(() => window.__hl.dock.getPanel('video-0').group.element);
  await (await g.asElement().$('button[aria-label="Pop out"]')).click();
  for (let i = 0; i < 60 && app.windows().length === n; i++) await sleep(100);
  const pop = app.windows().find((w) => w !== main);
  if (pop) await pop.waitForSelector('.overlay-layer[data-window="video-0"]', { timeout: 10000 }).catch(() => {});
  await sleep(500);
  return pop;
}

// ===================== Session 1: overlays, zoom, pop-out =====================
let app = await launch();
try {
  const main = await app.firstWindow();
  main.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 300)));
  await main.waitForFunction(() => !!window.__hl?.dock);
  for (const p of [logPath, vidPath]) {
    const f = await main.evaluate((x) => window.huskylog.e2eRegister(x), p);
    await main.evaluate((file) => window.dispatchEvent(new CustomEvent('hl-e2e-add', { detail: file })), f);
  }
  await main.waitForFunction(() => {
    const l = window.__hl.logs.getState(), m = window.__hl.media.getState();
    return l.order.length && l.logs[l.order[0]].status === 'ready' && m.order.length && m.videos[m.order[0]].status === 'ready';
  }, null, { timeout: 60000 });
  const ids = await main.evaluate(() => ({ log: window.__hl.logs.getState().order[0], vid: window.__hl.media.getState().order[0] }));
  // Sync the clip with the known truth (the Sync tab itself is covered by Phase 4).
  await main.evaluate(([ids, truth]) => {
    const s = window.__hl.syncStore.getState();
    for (const name of ['Prop start', 'Wave']) {
      const ev = s.addEvent(name);
      window.__hl.syncStore.getState().setMarker(ids.log, ev, truth.events[name]);
      window.__hl.syncStore.getState().setMarker(ids.vid, ev, truth.localEvents[name]);
    }
  }, [ids, truth]);

  // Pick a time exactly on a BAT sample near 400 s, so V·I has an exact expected value.
  const T = await main.evaluate(async (log) => {
    const b = await window.__hl.loadChannel({ stream: log, id: 'BAT.Volt' });
    let i = 0; while (i < b.t.length && b.t[i] < 400) i++;
    return b.t[i];
  }, ids.log);
  await main.evaluate((t) => window.__hl.timeline.getState().setT(t), T);

  // ---- Edit mode via the window header ----
  const vg = await main.evaluateHandle(() => window.__hl.dock.getPanel('video-0').group.element);
  const editBtn = await vg.asElement().$('button[aria-label="Edit overlays"]');
  check('video window header has an "Edit overlays" button', !!editBtn);
  await editBtn.click();
  await main.waitForSelector('.overlay-layer[data-window="video-0"] .overlay-toolbar');
  check('edit mode shows the overlay toolbar', (await main.evaluate(() => window.__hl.overlays.getState().editing)) === 'video-0');
  await main.click('.overlay-layer[data-window="video-0"] button:has-text("＋ Widget")'); // a new widget starts as a readout
  await sleep(300);
  const items = () => main.evaluate(() => window.__hl.overlays.getState().byWindow['video-0'] ?? []);
  let ro = (await items())[0];
  check('readout added with default lines', ro?.kind === 'readout' && ro.lines.length === 2, ro?.lines.map((l) => l.source).join(', '));

  // Edit the lines through the editor: altitude, power expression, flight mode.
  const ed = '.overlay-layer[data-window="video-0"] .overlay-editor';
  await main.fill(`${ed} input[aria-label="Label 2"]`, 'P');
  await main.fill(`${ed} input[aria-label="Source 2"]`, 'BAT.Volt * BAT.Curr');
  await main.fill(`${ed} input[aria-label="Format 2"]`, '%.0f');
  await main.fill(`${ed} input[aria-label="Unit 2"]`, 'W');
  await main.click(`${ed} button:has-text("＋ Line")`);
  await main.fill(`${ed} input[aria-label="Label 3"]`, 'Mode');
  await main.fill(`${ed} input[aria-label="Source 3"]`, '@mode');
  await main.click(`${ed} button:has-text("＋ Line")`);
  await main.fill(`${ed} input[aria-label="Source 4"]`, 'NOPE.Thing');
  await sleep(800);
  const expected = await main.evaluate(async ([log, t]) => {
    const at = (c) => { let i = 0; while (i < c.t.length && c.t[i] < t) i++; if (c.t[i] === t) return c.v[i]; const f = (t - c.t[i - 1]) / (c.t[i] - c.t[i - 1]); return c.v[i - 1] + f * (c.v[i] - c.v[i - 1]); };
    const alt = await window.__hl.loadChannel({ stream: log, id: 'POS.RelHomeAlt' });
    const v = await window.__hl.loadChannel({ stream: log, id: 'BAT.Volt' }), c = await window.__hl.loadChannel({ stream: log, id: 'BAT.Curr' });
    const sum = window.__hl.logs.getState().logs[log].summary;
    return { alt: `Alt ${at(alt).toFixed(1)} m`, p: `P ${(at(v) * at(c)).toFixed(0)} W`, mode: `Mode ${sum.modes.find((m) => t >= m.t0 && t < m.t1)?.name}` };
  }, [ids.log, T]);
  let lines = await main.evaluate(() => window.__hl['overlay:video-0'].lines[0]);
  check('readout shows altitude at the playhead (matches the log)', lines[0] === expected.alt, `${lines[0]} (expected ${expected.alt})`);
  check('readout evaluates an expression (BAT.Volt * BAT.Curr)', lines[1] === expected.p, `${lines[1]} (expected ${expected.p})`);
  check('readout shows the flight mode (@mode)', lines[2] === expected.mode, lines[2]);
  const badSrc = await main.$eval(`${ed} input[aria-label="Source 4"]`, (e) => ({ bad: e.classList.contains('bad'), title: e.title }));
  check('unknown channel is flagged in the editor', badSrc.bad && /not in this log/.test(badSrc.title), badSrc.title.slice(0, 70));
  await main.click(`${ed} tr:nth-child(4) button[title="Remove line"]`);
  await main.evaluate((t) => window.__hl.timeline.getState().setT(t + 5), T);
  await sleep(200);
  const moved = await main.evaluate(() => window.__hl['overlay:video-0'].lines[0][0]);
  check('readout follows the playhead', moved !== lines[0] && /^Alt -?\d+\.\d m$/.test(moved), `${lines[0]} → ${moved}`);
  await main.evaluate((t) => window.__hl.timeline.getState().setT(t), T);

  // Drag to move and resize (normalized rect).
  ro = (await items())[0];
  const layer = await main.$('.overlay-layer[data-window="video-0"]');
  const lb = await layer.boundingBox();
  const box = await (await main.$(`.overlay-box[data-overlay="${ro.id}"]`)).boundingBox();
  await main.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await main.mouse.down();
  await main.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 30, { steps: 6 });
  await main.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 40, { steps: 6 });
  await main.mouse.up();
  let r1 = (await items())[0].rect;
  check('drag moves the readout', near(r1.x - ro.rect.x, 80 / lb.width, 0.01) && near(r1.y - ro.rect.y, 40 / lb.height, 0.01),
    `dx ${(r1.x - ro.rect.x).toFixed(3)} (exp ${(80 / lb.width).toFixed(3)}), dy ${(r1.y - ro.rect.y).toFixed(3)}`);
  const se = await (await main.$(`.overlay-box[data-overlay="${ro.id}"] [data-handle="se"]`)).boundingBox();
  await main.mouse.move(se.x + se.width / 2, se.y + se.height / 2);
  await main.mouse.down();
  await main.mouse.move(se.x + se.width / 2 + 60, se.y + se.height / 2 + 30, { steps: 8 });
  await main.mouse.up();
  const r2 = (await items())[0].rect;
  check('corner handle resizes the readout', near(r2.w - r1.w, 60 / lb.width, 0.012) && near(r2.h - r1.h, 30 / lb.height, 0.012) && near(r2.x, r1.x, 1e-9),
    `w ${r1.w.toFixed(3)} → ${r2.w.toFixed(3)}, h ${r1.h.toFixed(3)} → ${r2.h.toFixed(3)}`);
  await main.keyboard.press('ArrowRight');
  const r3 = (await items())[0].rect;
  check('arrow key nudges the selected overlay (not the playhead)', near(r3.x - r2.x, 0.004, 1e-6) && (await main.evaluate(() => window.__hl.timeline.getState().t)) === T);

  // Horizon overlay.
  // Horizon: a new widget, switched to the Horizon type in its menu.
  await main.click('.overlay-layer[data-window="video-0"] button:has-text("＋ Widget")');
  await main.selectOption('.overlay-editor select[aria-label="Widget type"]', 'adi');
  // Move it clear of the readout (where the old ＋ Horizon button put it).
  await main.evaluate(() => { const st = window.__hl.overlays.getState(), it = st.byWindow['video-0'].find((o) => o.kind === 'adi'); st.patch('video-0', it.id, { rect: { x: 0.62, y: 0.55, w: 0.35, h: 0.42 } }); });
  await sleep(500);
  const adi = (await items()).find((o) => o.kind === 'adi');
  const pix = await main.evaluate((rect) => {
    const c = document.querySelector('.overlay-layer[data-window="video-0"] canvas');
    const g = c.getContext('2d');
    const x = Math.round(rect.x * c.width), y = Math.round(rect.y * c.height), w = Math.round(rect.w * c.width), h = Math.round(rect.h * c.height);
    const d = g.getImageData(x, y, w, h).data; let n = 0, white = 0;
    for (let i = 0; i < d.length; i += 4) { if (d[i + 3] > 40) n++; if (d[i] > 220 && d[i + 1] > 220 && d[i + 2] > 220 && d[i + 3] > 200) white++; }
    return { frac: n / (d.length / 4), white };
  }, adi.rect);
  check('horizon overlay draws a see-through HUD', pix.frac > 0.005 && pix.frac < 0.4 && pix.white > 50, `${(pix.frac * 100).toFixed(1)} % of its box painted, ${pix.white} white px`);
  await main.screenshot({ path: join(shots, 'p5-edit.png') });

  // Done → overlays stay, layer lets the mouse through.
  await main.click('.overlay-layer[data-window="video-0"] button:has-text("Done")');
  await sleep(200);
  const pe = await main.$eval('.overlay-layer[data-window="video-0"]', (e) => getComputedStyle(e).pointerEvents);
  check('leaving edit mode keeps overlays and passes the mouse through', (await items()).length === 2 && pe === 'none', `pointer-events ${pe}`);
  const saved = await main.evaluate(() => ({ n: window.__hl.dock.getPanel('video-0').params?.overlays?.length, json: JSON.stringify(window.__hl.dock.toJSON()) }));
  check('overlays are stored with the window (layout JSON)', saved.n === 2 && saved.json.includes(ro.id) && saved.json.includes(adi.id));

  // Normalized positions survive a window resize.
  const px = async () => {
    const l = await (await main.$('.overlay-layer[data-window="video-0"]')).boundingBox();
    await main.evaluate(() => window.__hl.overlays.getState().setEditing('video-0'));
    await sleep(150);
    const b = await (await main.$(`.overlay-box[data-overlay="${ro.id}"]`)).boundingBox();
    await main.evaluate(() => window.__hl.overlays.getState().setEditing(null));
    return { l, b };
  };
  const before = await px();
  await main.evaluate(() => window.__hl.dock.getPanel('video-0').api.setSize({ width: 420 }));
  await sleep(400);
  const after = await px();
  const rr = (await items())[0].rect;
  const okRel = (s) => near(s.b.x - s.l.x, rr.x * s.l.width, 2) && near(s.b.width, rr.w * s.l.width, 2);
  check('overlay keeps its relative position when the window resizes', before.l.width !== after.l.width && okRel(before) && okRel(after),
    `layer ${before.l.width.toFixed(0)} → ${after.l.width.toFixed(0)} px, box ${before.b.width.toFixed(0)} → ${after.b.width.toFixed(0)} px`);
  await main.evaluate(() => window.__hl.dock.getPanel('video-0').api.setSize({ width: 700 }));
  await sleep(300);

  // Overlays on other window types.
  await main.evaluate(() => {
    const st = window.__hl.overlays.getState();
    const mk = (id, lines) => ({ id, kind: 'readout', rect: { x: 0.6, y: 0.05, w: 0.35, h: 0.18 }, style: { color: '#ffffff', bg: '#000000', opacity: 0.5, align: 'left' }, lines });
    st.add('graph-0', mk('g1', [{ label: 'Roll', source: 'ATT.Roll', format: '%.1f', unit: '°' }]));
    st.add('map3d-0', mk('m1', [{ label: 'T', source: '@time', format: '' }]));
  });
  await sleep(500);
  const other = await main.evaluate(() => ({ g: window.__hl['overlay:graph-0']?.lines[0]?.[0], m: window.__hl['overlay:map3d-0']?.lines[0]?.[0] }));
  check('graph and map windows carry overlays too', /^Roll -?\d+\.\d °$/.test(other.g ?? '') && /^T \d+:\d\d\.\d{3}$/.test(other.m ?? ''), `${other.g} · ${other.m}`);

  // ---- Video digital zoom ----
  const stage = await (await main.$('.video-stage')).boundingBox();
  const cx = 0.25, cy = 0.5;
  await main.mouse.move(stage.x + stage.width * cx, stage.y + stage.height * cy);
  await main.mouse.wheel(0, -120);
  await sleep(200);
  await main.mouse.wheel(0, -120);
  await sleep(300);
  const z = await main.evaluate(() => window.__hl.dock.getPanel('video-0').params?.video?.zoom);
  const fixed = z && near(z.x + cx / z.s, cx, 0.002) && near(z.y + cy / z.s, cy, 0.002);
  check('wheel zooms the video about the cursor', z && near(z.s, 1.5625, 1e-6) && fixed, z ? `s=${z.s.toFixed(3)} x=${z.x.toFixed(3)} y=${z.y.toFixed(3)}` : 'no zoom');
  const tf = await main.$eval('.video-zoom', (e) => e.style.transform);
  const layerOutside = await main.$eval('.overlay-layer[data-window="video-0"]', (e) => !e.closest('.video-zoom'));
  check('zoom applies to the frame, overlays stay put', /scale\(1\.5625\)/.test(tf) && layerOutside, tf);
  await main.screenshot({ path: join(shots, 'p5-zoom.png') });
  await main.mouse.dblclick(stage.x + stage.width * 0.5, stage.y + stage.height * 0.5);
  await sleep(200);
  check('double-click resets the zoom', !(await main.evaluate(() => window.__hl.dock.getPanel('video-0').params?.video?.zoom)));

  // ---- Pop-out: overlays render in the other window ----
  const pop = await popOutVideo(app, main);
  check('video window pops out into its own OS window', !!pop);
  if (pop) {
    const d0 = await main.evaluate(() => window.__hl['overlay:video-0'].draws);
    await main.evaluate((t) => window.__hl.timeline.getState().setT(t + 2), T);
    await sleep(300);
    const d = await main.evaluate(() => window.__hl['overlay:video-0']);
    const inPop = await pop.evaluate(() => { const l = document.querySelector('.overlay-layer[data-window="video-0"]'); return l ? { w: l.clientWidth, h: l.clientHeight } : null; });
    check('overlays render inside the pop-out and follow the playhead', d.draws > d0 && inPop && d.w === inPop.w && d.lines[0][0] !== expected.alt, `${d.w}×${d.h} in pop-out, ${d.lines[0][0]}`);
    const b = await winBounds(app);
    check('pop-out opens on the secondary monitor with the window title', b.popDisplay === b.secondId && /Video/.test(b.popTitle ?? ''), `${fmtB(b.pop)} "${b.popTitle}"`);

    // Keyboard inside the pop-out.
    await main.evaluate((t) => { const s = window.__hl.timeline.getState(); s.setPlaying(false); s.setT(t); }, T);
    await pop.keyboard.press('Space');
    await sleep(150);
    const playing = await main.evaluate(() => window.__hl.timeline.getState().playing);
    await pop.keyboard.press('Space');
    await sleep(100);
    const paused = !(await main.evaluate(() => window.__hl.timeline.getState().playing));
    await main.evaluate((t) => window.__hl.timeline.getState().setT(t), T);
    await pop.keyboard.press('ArrowRight');
    const t1 = await main.evaluate(() => window.__hl.timeline.getState().t);
    await pop.keyboard.press('Shift+ArrowLeft');
    const t2 = await main.evaluate(() => window.__hl.timeline.getState().t);
    // → steps to the next video frame (frame-exact), so at most 1/30 s here.
    check('Space and arrow keys work inside the pop-out', playing && paused && t1 - T > 0 && t1 - T <= 1 / 30 + 1e-6 && near(t2 - t1, -1, 1e-9), `play ${playing}, pause ${paused}, → ${(t1 - T).toFixed(4)} s, ⇧← ${(t2 - t1).toFixed(3)} s`);

    // Edit overlays inside the pop-out.
    await pop.click('button[aria-label="Edit overlays"]');
    await pop.waitForSelector('.overlay-toolbar');
    const pb = await (await pop.$(`.overlay-box[data-overlay="${ro.id}"]`)).boundingBox();
    const pl = await (await pop.$('.overlay-layer')).boundingBox();
    const rp0 = (await items())[0].rect;
    await pop.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
    await pop.mouse.down();
    await pop.mouse.move(pb.x + pb.width / 2 + 50, pb.y + pb.height / 2 + 20, { steps: 8 });
    await pop.mouse.up();
    const rp1 = (await items())[0].rect;
    check('overlays can be edited inside the pop-out', near(rp1.x - rp0.x, 50 / pl.width, 0.01), `dx ${(rp1.x - rp0.x).toFixed(3)} (exp ${(50 / pl.width).toFixed(3)})`);
    await pop.click('.overlay-toolbar button:has-text("Done")');
    await pop.screenshot({ path: join(shots, 'p5-popout.png') });

    // Monitor memory within a session: move, dock back, pop out again.
    // The window lands where Windows actually put it (sizes snap to device pixels).
    await setBounds(app, 'pop', { x: b.second.x + 60, y: b.second.y + 50, width: 820, height: 540 });
    await sleep(600);
    const target = (await winBounds(app)).pop;
    await pop.click('button[aria-label="Dock"]');
    for (let i = 0; i < 40 && app.windows().length > 1; i++) await sleep(100);
    check('docking back closes the pop-out window', app.windows().length === 1);
    const pop2 = await popOutVideo(app, main);
    const b2 = await winBounds(app);
    check('re-opened pop-out returns to where it was', sameBounds(b2.pop, target), `${fmtB(b2.pop)} (moved to ${fmtB(target)})`);
    const st = JSON.parse(readFileSync(stateFile, 'utf8'));
    check('window positions saved per window id', sameBounds(st.popouts?.['video-0']?.bounds, target) && sameBounds(st.byType?.video?.bounds, target));
    // Leave it popped out, move main window, then quit: both should come back next launch.
    // Must fit the monitor's work area: Windows clamps a new window to it.
    const mainTarget = { x: b.second.x + 30, y: b.second.y + 20, width: Math.min(1380, b.second.width - 60), height: Math.min(780, b.second.height - 40) };
    await setBounds(app, 'main', mainTarget);
    await sleep(600);
    void pop2;
  }
  writeFileSync(join(shots, 'p5-targets.json'), JSON.stringify(await winBounds(app)));
} catch (e) {
  failed++;
  console.error('ERROR', e);
  await app.windows()[0]?.screenshot({ path: join(shots, 'p5-failure.png') }).catch(() => {});
} finally {
  await app.close();
}

// ===================== Session 2: memory across a restart =====================
if (!existsSync(join(shots, 'p5-targets.json')) || !existsSync(stateFile)) { console.log(`
${failed + 1} check(s) failed (session 1 did not finish)`); process.exit(1); }
const prev = JSON.parse(readFileSync(join(shots, 'p5-targets.json'), 'utf8'));
app = await launch();
try {
  const main = await app.firstWindow();
  await main.waitForFunction(() => !!window.__hl?.dock);
  await sleep(500);
  const b0 = await winBounds(app);
  check('main window reopens where it was after a restart', sameBounds(b0.main, prev.main), `${fmtB(b0.main)} (was ${fmtB(prev.main)})`);
  await popOutVideo(app, main);
  const b1 = await winBounds(app);
  check('pop-out reopens on the same monitor and position after a restart', sameBounds(b1.pop, prev.pop) && b1.popDisplay === prev.popDisplay, `${fmtB(b1.pop)} (was ${fmtB(prev.pop)})`);
} catch (e) {
  failed++;
  console.error('ERROR', e);
} finally {
  await app.close();
}

// ============ Session 3: remembered monitor no longer connected ============
const st = JSON.parse(readFileSync(stateFile, 'utf8'));
const gone = { x: -40000, y: -30000, width: 900, height: 600 };
for (const k of Object.keys(st.popouts)) st.popouts[k].bounds = gone;
for (const k of Object.keys(st.byType)) st.byType[k].bounds = gone;
st.last.bounds = gone;
st.main.bounds = { ...gone, width: 1500, height: 950 };
writeFileSync(stateFile, JSON.stringify(st));
app = await launch();
try {
  const main = await app.firstWindow();
  await main.waitForFunction(() => !!window.__hl?.dock);
  await sleep(500);
  await popOutVideo(app, main);
  const b = await winBounds(app);
  const inside = (r, a) => r && r.x >= a.x - 8 && r.y >= a.y - 8 && r.x + r.width <= a.x + a.width + 8 && r.y + r.height <= a.y + a.height + 8;
  check('windows fall back to a connected monitor when the saved one is gone', inside(b.main, b.second) && inside(b.pop, b.second), `main ${fmtB(b.main)}, pop-out ${fmtB(b.pop)}`);
} catch (e) {
  failed++;
  console.error('ERROR', e);
} finally {
  await app.close();
}

console.log(failed ? `\n${failed} check(s) failed` : '\nAll Phase 5 checks passed');
process.exit(failed ? 1 : 0);
