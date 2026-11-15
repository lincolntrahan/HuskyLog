// Phase 6 harness: workspace (.hlws) save/open, Pack & Go (.hlpack) in all three
// video modes, open-in-place, "laptop B" (fresh profile, originals gone, offline),
// missing-file locate, saving back into a pack, and the unsaved-changes guard.
// Usage: npm run build && node scripts/e2e-phase6.mjs
import { _electron as electron } from 'playwright-core';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const shots = join(root, '.e2e');
mkdirSync(shots, { recursive: true });
const refLog = process.env.HUSKYLOG_REF_LOG ?? join(root, 'test-data', 'logs', 'reference.bin');
const refVid = join(root, 'test-data', 'generated', 'ground_cam_sync.mp4');
if (!existsSync(refLog) || !existsSync(refVid)) { console.error('need reference log and generated clip (node scripts/gen-sync-video.mjs)'); process.exit(2); }
const truth = JSON.parse(readFileSync(refVid.replace('.mp4', '.truth.json'), 'utf8'));
const FRAME = 1 / 30;

// "Laptop A" works on copies, so they can disappear later.
const work = mkdtempSync(join(tmpdir(), 'hl-p6-'));
const aDir = join(work, 'laptopA'), bDir = join(work, 'usb');
mkdirSync(aDir); mkdirSync(bDir);
const logA = join(aDir, 'flight.bin'), vidA = join(aDir, 'groundcam.mp4');
copyFileSync(refLog, logA); copyFileSync(refVid, vidA);
const hlws = join(aDir, 'session.hlws');
const packs = { full: join(aDir, 'full.hlpack'), trim: join(aDir, 'trim.hlpack'), reencode: join(aDir, 'small.hlpack') };
const mapsInProfile = existsSync(join(tmpdir(), 'huskylog-e2e-profile', 'maps')) && statSync(join(tmpdir(), 'huskylog-e2e-profile', 'maps')).isDirectory();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };
const exe = process.env.HUSKYLOG_EXE;
const launch = (extraEnv = {}, extraArgs = []) => electron.launch({
  ...(exe ? { executablePath: exe, args: extraArgs } : { args: [root, ...extraArgs] }),
  env: { ...process.env, HUSKYLOG_E2E: '1', HUSKYLOG_DISPLAY: process.env.HUSKYLOG_DISPLAY ?? 'secondary', ...extraEnv },
});
const fmtMB = (n) => `${(n / 1e6).toFixed(2)} MB`;
const masterToVideo = (snap, t) => { const s = snap.sol[snap.vids[0].id]; return (t - s.b) / s.a; };
const listZip = (p) => execFileSync(join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe'), ['-tf', p], { encoding: 'utf8' }).trim().split(/\r?\n/);

async function boot(app) {
  const main = await app.firstWindow();
  main.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 300)));
  await main.waitForFunction(() => !!window.__hl?.dock && !!window.__hl?.workspace);
  return main;
}
/** Waits for a reload into another session, then for its streams to be ready and settled. */
async function waitSession(main, path) {
  await main.waitForFunction((p) => {
    const ws = window.__hl?.workspace?.useSession?.getState();
    return ws && ws.path && ws.path.toLowerCase() === p.toLowerCase();
  }, path, { timeout: 60000 });
  await settled(main);
}
async function settled(main) {
  await main.waitForFunction(() => {
    const l = window.__hl.logs.getState(), m = window.__hl.media.getState();
    const busy = Object.values(l.logs).some((x) => x.status === 'loading') || Object.values(m.videos).some((x) => x.status === 'loading');
    return !busy && window.__hl.workspace.useSession.getState().savedKey !== null;
  }, null, { timeout: 60000 });
}
const S = (main) => main.evaluate(() => window.__hl.workspace.useSession.getState());
async function menu(main, item) {
  await main.click('.menu-btn');
  await main.click(`.menu-item:has-text("${item}")`);
}
async function frameBrightness(main, t) {
  await main.evaluate((x) => window.__hl.timeline.getState().setT(x), t);
  await main.waitForFunction(() => { const d = window.__hl['video:video-0']; return d && d.drawn === d.index && d.index >= 0; }, null, { timeout: 15000 });
  return main.evaluate(() => {
    const c = document.querySelector('.video-stage canvas');
    const x = document.createElement('canvas'); x.width = 32; x.height = 18;
    const g = x.getContext('2d'); g.drawImage(c, 0, 0, 32, 18);
    const px = g.getImageData(0, 0, 32, 18).data; let s = 0;
    for (let i = 0; i < px.length; i += 4) s += (px[i] + px[i + 1] + px[i + 2]) / 3;
    return s / (px.length / 4);
  });
}
async function flashAligned(main, label) {
  const T = truth.events.Wave;
  const before = await frameBrightness(main, T - 2 * FRAME);
  const after = await frameBrightness(main, T + 1.2 * FRAME);
  check(`${label}: video still lines up with the log (flash at the "Wave" event)`, before < 80 && after > 200, `2 frames before ${before.toFixed(0)}, after ${after.toFixed(0)}`);
}
/** Snapshot of everything a session should carry over. */
const snapshot = (main) => main.evaluate(() => {
  const h = window.__hl;
  const sol = h.syncStore.getState().solution.streams;
  const dock = h.dock;
  return {
    logs: h.logs.getState().order.map((id) => ({ id, name: h.logs.getState().logs[id].name, path: h.logs.getState().logs[id].path })),
    vids: h.media.getState().order.map((id) => ({ id, name: h.media.getState().videos[id].name, url: h.media.getState().videos[id].url, size: h.media.getState().videos[id].size, dur: h.media.getState().videos[id].video?.durationS, start: h.media.getState().videos[id].video?.startS })),
    sol: Object.fromEntries(Object.entries(sol).map(([k, v]) => [k, { status: v.status, a: v.a, b: v.b }])),
    events: h.syncStore.getState().events.map((e) => e.name),
    graph: dock.getPanel('graph-0')?.params?.graph?.series?.map((s) => s.id) ?? [],
    overlays: (dock.getPanel('video-0')?.params?.overlays ?? []).map((o) => o.lines?.map((l) => l.source).join('+') ?? o.kind),
    zoom: dock.getPanel('video-0')?.params?.video?.zoom ?? null,
    expr: h.expressions.getState().named.e2e_power ?? null,
    exprKeys: Object.keys(h.expressions.getState().named).sort(),
    t: h.timeline.getState().t, range: h.timeline.getState().range,
    popouts: dock.toJSON().popoutGroups?.length ?? 0,
    panels: dock.panels.map((p) => p.id).sort(),
  };
});

// ============================ Laptop A: build a session ============================
let app = await launch();
let A = null;
try {
  const main = await boot(app);
  for (const p of [logA, vidA]) {
    const f = await main.evaluate((x) => window.huskylog.e2eRegister(x), p);
    await main.evaluate((file) => window.dispatchEvent(new CustomEvent('hl-e2e-add', { detail: file })), f);
  }
  await settled(main);
  const ids = await main.evaluate(() => ({ log: window.__hl.logs.getState().order[0], vid: window.__hl.media.getState().order[0] }));
  check('fresh session is not dirty', !(await S(main)).dirty);
  await main.evaluate(([ids, truth]) => {
    const h = window.__hl;
    for (const name of ['Prop start', 'Wave']) {
      const ev = h.syncStore.getState().addEvent(name);
      h.syncStore.getState().setMarker(ids.log, ev, truth.events[name]);
      h.syncStore.getState().setMarker(ids.vid, ev, truth.localEvents[name]);
    }
    h.expressions.getState().setNamed('e2e_power', 'BAT.Volt * BAT.Curr');
    const g = h['graph:graph-0'];
    g.setCfg({ ...g.getCfg(), series: [{ id: 'ATT.Roll', color: '#ff5c8a', axis: 'auto', visible: true }, { id: 'e2e_power', kind: 'expr', name: 'Power', unit: 'W', color: '#4ea1ff', axis: 'right', visible: true }] });
    h.overlays.getState().add('video-0', { id: 'ovA', kind: 'readout', rect: { x: 0.05, y: 0.05, w: 0.3, h: 0.15 }, style: { color: '#ffffff', bg: '#000000', opacity: 0.4, align: 'left' }, lines: [{ label: 'Alt', source: 'POS.RelHomeAlt', format: '%.1f', unit: 'm' }, { label: 'Mode', source: '@mode', format: '' }] });
    const v = h.dock.getPanel('video-0');
    v.api.updateParameters({ video: { ...v.params.video, zoom: { s: 1.5, x: 0.1, y: 0.2 } } });
    h.timeline.getState().setRange([380, 420]);
    h.timeline.getState().setT(401.25);
  }, [ids, truth]);
  // Graph window popped out (second monitor).
  const n = app.windows().length;
  await main.evaluate(() => window.__hl.dock.addPopoutGroup(window.__hl.dock.getPanel('graph-0').group, { popoutUrl: '/popout.html?w=graph-0&k=graph' }));
  for (let i = 0; i < 50 && app.windows().length === n; i++) await sleep(100);
  await sleep(1500);
  const st = await S(main);
  const title = await main.title();
  check('changes mark the session dirty (title shows ●)', st.dirty && title.startsWith('•'), `"${title}"`);

  // ---- Save As .hlws through the File menu ----
  await main.evaluate((p) => window.huskylog.e2eSetDialogPaths({ save: p }), hlws);
  await menu(main, 'Save As…');
  await main.waitForFunction(() => !window.__hl.workspace.useSession.getState().dirty, null, { timeout: 15000 });
  const ws = JSON.parse(readFileSync(hlws, 'utf8'));
  const sLog = ws.streams.find((s) => s.kind === 'log'), sVid = ws.streams.find((s) => s.kind === 'video');
  check('workspace saved with relative paths and file hashes', sLog?.file.rel === 'flight.bin' && sVid?.file.rel === 'groundcam.mp4' && /^[0-9a-f]{64}$/.test(sLog.file.quickHash ?? ''),
    `${sLog?.file.rel}, ${sVid?.file.rel}`);
  const layoutTxt = JSON.stringify(ws.layout);
  check('workspace holds sync, expressions, windows, overlays, zoom and pop-out', ws.sync.events.length === 2 && ws.expressions.e2e_power && layoutTxt.includes('ovA') && layoutTxt.includes('"zoom"') && (ws.layout.popoutGroups?.length ?? 0) === 1 && layoutTxt.includes('e2e_power'));
  check('saving clears the dirty mark', !(await S(main)).dirty && !(await main.title()).startsWith('•'), await main.title());
  A = await snapshot(main);

  // ---- Pack & Go in all three modes ----
  const packTimes = {};
  for (const [mode, label] of [['full', 'Full videos'], ['trim', 'Trim to the selected range'], ['reencode', 'Re-encode smaller']]) {
    await menu(main, 'Pack & Go…');
    await main.waitForSelector('.modal.pack');
    await main.click(`.modal.pack label.radio:has-text("${label}") input`);
    await main.waitForFunction(() => !!window.__hl.pack.getEstimate(), null, { timeout: 20000 });
    await sleep(300);
    const est = await main.evaluate(() => window.__hl.pack.getEstimate());
    await main.evaluate((p) => window.huskylog.e2eSetDialogPaths({ pack: p }), packs[mode]);
    const t0 = Date.now();
    await main.click('.modal.pack button:has-text("Pack…")');
    await main.waitForFunction(() => !!window.__hl.pack.getResult() || !!window.__hl.pack.getError(), null, { timeout: 300000 });
    packTimes[mode] = (Date.now() - t0) / 1000;
    const res = await main.evaluate(() => ({ r: window.__hl.pack.getResult(), e: window.__hl.pack.getError() }));
    if (mode === 'trim') await main.screenshot({ path: join(shots, 'p6-pack.png') });
    await main.click('.modal.pack button:has-text("Done"), .modal.pack button:has-text("Close")');
    check(`Pack & Go (${mode}) writes a pack`, !!res.r && existsSync(packs[mode]), res.e ?? `${fmtMB(res.r?.bytes ?? 0)} in ${packTimes[mode].toFixed(1)} s, estimate ${fmtMB(est.bytes)}`);
    if (mode === 'full') {
      const names = listZip(packs.full);
      const want = ['workspace.hlws', 'manifest.json'];
      check('pack is a standard zip with workspace, manifest, streams and maps', want.every((w) => names.includes(w)) && names.some((n) => /^streams\/log\d+\/flight\.bin$/.test(n)) && names.some((n) => /^streams\/vid\d+\/groundcam\.mp4$/.test(n)) && (!mapsInProfile || names.some((n) => /^maps\/.+\.mbtiles$/.test(n))), names.join(', '));
    }
  }
  const sz = Object.fromEntries(Object.entries(packs).map(([k, p]) => [k, existsSync(p) ? statSync(p).size : 0]));
  check('packs written in all three modes', sz.full > 0 && sz.trim > 0 && sz.reencode > 0, `full ${fmtMB(sz.full)}, trim ${fmtMB(sz.trim)}, re-encode ${fmtMB(sz.reencode)}`);
  check('session stays saved after packing (packing does not change it)', !(await S(main)).dirty);

  // ---- Not a pack: friendly error ----
  const bogus = join(aDir, 'bogus.hlpack');
  writeFileSync(bogus, 'not a zip');
  await main.evaluate((p) => window.huskylog.e2eSetDialogPaths({ open: p }), bogus);
  await menu(main, 'Open…');
  await main.waitForSelector('.toast.err', { timeout: 10000 });
  check('opening a broken pack shows an error and keeps the session', /not a HuskyLog pack/.test((await main.textContent('.toast.err')) ?? '') && (await main.evaluate(() => window.__hl.logs.getState().order.length)) === 1);
  await main.click('.toast.err button');

  // ---- Reopen the trimmed pack in place ----
  await main.evaluate((p) => window.huskylog.e2eSetDialogPaths({ open: p }), packs.trim);
  await menu(main, 'Open…');
  await waitSession(main, packs.trim);
  await sleep(1500);
  const T = await snapshot(main);
  check('pack restores streams with the same ids and names', JSON.stringify(T.logs.map((x) => [x.id, x.name])) === JSON.stringify(A.logs.map((x) => [x.id, x.name])) && JSON.stringify(T.vids.map((x) => [x.id, x.name])) === JSON.stringify(A.vids.map((x) => [x.id, x.name])));
  check('video is served from inside the pack (no extraction)', T.vids[0]?.url.includes(encodeURIComponent('!/streams/')) && T.logs[0]?.path.includes('pack-cache'), T.vids[0]?.url.slice(0, 90));
  // Selection 380–420 s ± 5 s → video 77.5 s to its end (112 s), cut at the keyframe before.
  const expDur = A.vids[0].dur - (masterToVideo(A, 375) - A.vids[0].start);
  check('trimmed video keeps only the selected range ± 5 s (whole GOPs)', T.vids[0].size < A.vids[0].size * 0.5 && T.vids[0].dur >= expDur - 0.01 && T.vids[0].dur < expDur + 2.5,
    `${A.vids[0].dur.toFixed(1)} s → ${T.vids[0].dur.toFixed(1)} s (expected ≥ ${expDur.toFixed(1)} s), ${fmtMB(A.vids[0].size)} → ${fmtMB(T.vids[0].size)}`);
  const vid = A.vids[0].id;
  check('sync markers moved with the trim (same drift, new offset)', T.sol[vid].status === 'synced' && Math.abs(T.sol[vid].a - A.sol[vid].a) < 1e-9 && Math.abs(T.sol[vid].b - A.sol[vid].b) > 10,
    `a ${A.sol[vid].a.toFixed(6)} → ${T.sol[vid].a.toFixed(6)}, b ${A.sol[vid].b.toFixed(3)} → ${T.sol[vid].b.toFixed(3)}`);
  check('windows, graph series, overlays, zoom, expression and playhead restored',
    JSON.stringify(T.graph) === JSON.stringify(A.graph) && JSON.stringify(T.overlays) === JSON.stringify(A.overlays) && JSON.stringify(T.zoom) === JSON.stringify(A.zoom) && T.expr === A.expr && Math.abs(T.t - A.t) < 1e-6 && JSON.stringify(T.range) === JSON.stringify(A.range) && JSON.stringify(T.panels) === JSON.stringify(A.panels),
    `graph ${T.graph.join(',')}, overlays ${T.overlays.join(';')}, t ${T.t.toFixed(2)}`);
  check('pop-out window reopened', T.popouts === 1 && app.windows().length === 2, `${app.windows().length} windows`);
  await flashAligned(main, 'trimmed pack');
  await main.evaluate((t) => window.__hl.timeline.getState().setT(t), A.t);
  await main.screenshot({ path: join(shots, 'p6-reopened.png') });

  // ---- Re-encoded pack ----
  await main.evaluate((p) => window.huskylog.e2eSetDialogPaths({ open: p }), packs.reencode);
  await menu(main, 'Open…');
  await waitSession(main, packs.reencode);
  const R = await main.evaluate(() => window.__hl.media.getState().videos[window.__hl.media.getState().order[0]].video);
  check('re-encoded video is H.264 ≤ 720p, frame rate kept', /^avc1/.test(R.codec) && R.height <= 720 && Math.abs(R.fpsAvg - 30) < 0.5, `${R.codec} ${R.width}×${R.height} ${R.fpsAvg.toFixed(2)} fps, ${R.durationS.toFixed(1)} s`);
  await flashAligned(main, 're-encoded pack');

  // ---- Save back into the open pack ----
  const offsetBefore = await main.evaluate(() => { const v = window.__hl.media.getState().videos[window.__hl.media.getState().order[0]]; return v.url; });
  const exprName = `e2e_saved_${Date.now()}`; // the personal library on this profile keeps names across runs
  await main.evaluate((n) => window.__hl.expressions.getState().setNamed(n, 'GPS.Spd * 3.6'), exprName);
  await main.waitForFunction(() => window.__hl.workspace.useSession.getState().dirty, null, { timeout: 5000 });
  await main.keyboard.press('Control+s');
  await main.waitForFunction(() => !window.__hl.workspace.useSession.getState().dirty, null, { timeout: 15000 });
  check('Ctrl+S saves back into the open pack', (await S(main)).kind === 'hlpack' && listZip(packs.reencode).filter((n) => n === 'workspace.hlws').length === 1);
  await main.evaluate((p) => window.huskylog.openWorkspace(p), packs.reencode);
  await sleep(500);
  await waitSession(main, packs.reencode);
  const back = await main.evaluate((n) => ({ e: window.__hl.expressions.getState().named[n], all: Object.keys(window.__hl.expressions.getState().named), url: window.__hl.media.getState().videos[window.__hl.media.getState().order[0]].url }), exprName);
  check('the change is in the pack after reopening; media untouched', back.e === 'GPS.Spd * 3.6' && back.url === offsetBefore);
  const wantKeys = [...A.exprKeys, exprName].sort();
  check('opening a workspace sets exactly its expressions', JSON.stringify([...back.all].sort()) === JSON.stringify(wantKeys), `${back.all.length} expressions`);
  await flashAligned(main, 'pack after save');

  // ---- Unsaved-changes guard ----
  await main.evaluate(() => window.__hl.timeline.getState().setRange([390, 410]));
  await main.waitForFunction(() => window.__hl.workspace.useSession.getState().dirty, null, { timeout: 5000 });
  await main.evaluate(() => window.huskylog.e2eSetDialogPaths({ closeChoice: 2 }));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('popout'))?.close());
  await sleep(800);
  check('closing with unsaved changes can be cancelled', app.windows().length >= 1 && (await main.evaluate(() => !!window.__hl)));
  // New (discard): in-app prompt.
  await menu(main, 'New');
  await main.waitForSelector('.modal[aria-label="Unsaved changes"]');
  await main.click('.modal button:has-text("Cancel")');
  check('"New" asks before discarding changes', (await S(main)).path?.toLowerCase() === packs.reencode.toLowerCase());
  await main.evaluate(() => window.huskylog.e2eSetDialogPaths({ closeChoice: 1 }));
} catch (e) {
  failed++;
  console.error('ERROR', e);
  await app.windows()[0]?.screenshot({ path: join(shots, 'p6-failure.png') }).catch(() => {});
} finally {
  await app.close().catch(() => {});
}

// ============ Laptop B: fresh profile, originals gone, opened by double-click ============
copyFileSync(packs.full, join(bDir, 'full.hlpack'));
rmSync(logA, { force: true }); rmSync(vidA, { force: true });
const profileB = mkdtempSync(join(tmpdir(), 'hl-p6-profileB-'));
app = await launch({ HUSKYLOG_PROFILE: profileB }, [join(bDir, 'full.hlpack')]);
try {
  const main = await boot(app);
  await waitSession(main, join(bDir, 'full.hlpack'));
  await sleep(1500);
  const B = await snapshot(main);
  check('laptop B: pack opened from the command line (file association)', B.logs.length === 1 && B.vids.length === 1);
  check('laptop B: identical session (sync, windows, overlays, expression, playhead)',
    JSON.stringify(B.sol) === JSON.stringify(A.sol) && JSON.stringify(B.graph) === JSON.stringify(A.graph) && JSON.stringify(B.overlays) === JSON.stringify(A.overlays) && B.expr === A.expr && Math.abs(B.t - A.t) < 1e-6 && JSON.stringify(B.panels) === JSON.stringify(A.panels) && B.popouts === 1);
  await flashAligned(main, 'laptop B');
  if (mapsInProfile) {
    const areas = await main.evaluate(() => window.huskylog.mapAreas());
    const st = await S(main);
    check('laptop B: map areas came with the pack', areas.length >= 1 && st.importedMapAreas.length >= 1, areas.map((a) => `${a.name} (${fmtMB(a.bytes)})`).join(', '));
    await main.evaluate(() => window.__hl.timeline.getState().setT(410));
    await sleep(4000);
    const mapState = await main.evaluate(() => window.__hl['mapState:map3d-0']?.());
    check('laptop B: 3D map draws from the packed tiles', mapState?.terrain === true && mapState?.layers >= 1, JSON.stringify({ terrain: mapState?.terrain, layers: mapState?.layers }));
  }
  const blocked = await main.evaluate(() => window.huskylog.blockedRequests());
  check('laptop B: no network requests (offline)', blocked.length === 0, blocked.slice(0, 2).join(', '));
  await main.screenshot({ path: join(shots, 'p6-laptopB.png') });
} catch (e) {
  failed++;
  console.error('ERROR', e);
} finally {
  await app.close().catch(() => {});
}

// ============ Workspace whose files moved: missing → locate ============
app = await launch();
try {
  const main = await boot(app);
  await main.evaluate((p) => window.huskylog.openWorkspace(p), hlws);
  await waitSession(main, hlws);
  const st = await S(main);
  check('workspace with moved files lists them as missing', st.missing.length === 2, st.missing.map((m) => m.ref.name).join(', '));
  await main.click('button[role=tab]:has-text("Import")');
  await main.waitForSelector('.missing');
  for (const p of [refLog, refVid]) {
    await main.evaluate((x) => window.huskylog.e2eSetDialogPaths({ locate: x }), p);
    await main.click('.missing button:has-text("Locate…") >> nth=0');
    await sleep(600);
  }
  await settled(main);
  const L = await snapshot(main);
  const st2 = await S(main);
  check('located files (same content, other folder) are accepted and synced', st2.missing.length === 0 && L.sol[A.vids[0].id]?.status === 'synced' && Math.abs(L.sol[A.vids[0].id].b - A.sol[A.vids[0].id].b) < 1e-9);
  await main.click('button[role=tab]:has-text("Review")');
  await flashAligned(main, 'located files');
} catch (e) {
  failed++;
  console.error('ERROR', e);
} finally {
  await app.close().catch(() => {});
}

rmSync(work, { recursive: true, force: true });
rmSync(profileB, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : '\nAll Phase 6 checks passed');
process.exit(failed ? 1 : 0);
