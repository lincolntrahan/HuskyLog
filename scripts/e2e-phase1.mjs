// Phase 1 harness: loads the reference log in the built app and exercises the
// graph (preset, range stats, CSV export), messages and parameters windows.
// Usage: npm run build && node scripts/e2e-phase1.mjs
import { _electron as electron } from 'playwright-core';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const shots = join(root, '.e2e');
mkdirSync(shots, { recursive: true });
const logPath = process.env.HUSKYLOG_REF_LOG ?? join(root, 'test-data', 'logs', 'reference.bin');
if (!existsSync(logPath)) { console.error('reference log missing:', logPath); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (k, v) => console.log(k.padEnd(30), typeof v === 'object' ? JSON.stringify(v) : v);
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };

const exe = process.env.HUSKYLOG_EXE;
const app = await electron.launch({
  ...(exe ? { executablePath: exe, args: [] } : { args: [root] }),
  env: { ...process.env, HUSKYLOG_E2E: '1', HUSKYLOG_DISPLAY: process.env.HUSKYLOG_DISPLAY ?? 'secondary' },
});
try {
  const main = await app.firstWindow();
  main.on('console', (m) => { if (m.type() === 'error') console.log('  [renderer error]', m.text().slice(0, 300)); });
  main.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 300)));
  await main.waitForFunction(() => !!window.__hl?.dock);

  // Load the log through the same path as the Import tab.
  const t0 = Date.now();
  const f = await main.evaluate((p) => window.huskylog.e2eRegister(p), logPath);
  await main.evaluate((file) => window.dispatchEvent(new CustomEvent('hl-e2e-add', { detail: file })), f);
  await main.waitForFunction(() => document.querySelectorAll('.chip').length === 0); // graph empty
  await main.click('button[role=tab]:has-text("Import")');
  await main.waitForSelector('text=Ready', { timeout: 30000 });
  log('log load (read+index+summary)', `${Date.now() - t0} ms`);
  await main.screenshot({ path: join(shots, 'p1-import.png') });
  const importRow = await main.textContent('table.files tbody tr');
  check('import shows firmware/board', /ArduPlane V4\.7\.2.*MatekH743/.test(importRow ?? ''), importRow?.slice(0, 90));

  // Graph: open picker, search, add channels.
  await main.click('button[role=tab]:has-text("Review")');
  const graph = main.locator('.graph').first();
  await graph.locator('button:has-text("Add")').click();
  await main.fill('.picker input', 'att roll');
  const first = (await main.textContent('.pick .pick-id'))?.trim();
  check('fuzzy search "att roll" ranks ATT.Roll first', first === 'ATT.Roll', `got ${first}`);
  await main.keyboard.press('Enter');
  await graph.locator('button:has-text("Add")').click();
  await main.fill('.picker input', 'throttle');
  const thr = (await main.textContent('.pick'))?.trim();
  check('RCOU.C1 labelled Throttle and findable by label', /RCOU\.C1\s*Throttle/.test(thr ?? ''), thr?.slice(0, 40));
  await main.keyboard.press('Escape');

  // Apply a built-in preset (replaces series).
  await graph.locator('button:has-text("Presets")').click();
  await main.click('.menu-item:has-text("Attitude tracking")');
  await main.waitForFunction(() => [...document.querySelectorAll('.chip-val')].every((e) => !e.textContent.includes('…')) && document.querySelectorAll('.chip').length === 4, null, { timeout: 15000 });
  const chips = await main.$$eval('.chip-name', (els) => els.map((e) => e.textContent));
  check('preset loads 4 attitude series', chips.length === 4, chips.join(', '));

  // Select a range by dragging on the plot (RTL segment ~418–484 s).
  await main.evaluate(() => window.__hl['graph:graph-0'].setXRange([300, 560]));
  await sleep(300);
  const box = await graph.locator('.u-over').boundingBox();
  const xOf = (t) => box.x + ((t - 300) / 260) * box.width;
  await main.mouse.move(xOf(420), box.y + box.height / 2);
  await main.mouse.down();
  await main.mouse.move(xOf(450), box.y + box.height / 2, { steps: 8 });
  await main.mouse.move(xOf(480), box.y + box.height / 2, { steps: 8 });
  await main.mouse.up();
  await main.waitForSelector('.stats table', { timeout: 5000 });
  const range = await main.evaluate(() => window.__hl.dock && document.querySelector('.sel-pill')?.textContent);
  log('selection', range);
  const stats = await main.$$eval('.stats tbody tr', (rows) => rows.map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent.trim())));
  log('stats rows', stats.map((r) => r.slice(0, 6).join(' | ')));
  check('stats table has a row per series with numbers', stats.length === 4 && stats.every((r) => /\d/.test(r[1] ?? '') && Number(r[5]) > 100));
  await main.screenshot({ path: join(shots, 'p1-graph-selection.png') });

  // Click sets the playhead and clears the selection.
  await main.mouse.click(xOf(500), box.y + box.height / 3);
  const tPlay = await main.textContent('.timeline .time');
  check('click moves playhead to ~8:20', /^8:(19|20|21)\./.test(tPlay ?? ''), tPlay);
  check('click clears selection', (await main.$('.stats table')) === null);

  // Re-select and export CSV to a temp file (dialog bypassed by the e2e hook).
  await main.mouse.move(xOf(420), box.y + box.height / 2);
  await main.mouse.down();
  await main.mouse.move(xOf(425), box.y + box.height / 2, { steps: 6 });
  await main.mouse.up();
  const csvPath = join(tmpdir(), `huskylog-e2e-${Date.now()}.csv`);
  await main.evaluate((p) => window.huskylog.e2eSaveTextTo(p), csvPath);
  await graph.locator('button:has-text("Export CSV")').click();
  await main.click('.modal button:has-text("Save CSV")');
  for (let i = 0; i < 40 && !existsSync(csvPath); i++) await sleep(100);
  const csv = existsSync(csvPath) ? readFileSync(csvPath, 'utf8').split('\r\n') : [];
  log('csv header', csv[0]);
  log('csv rows', csv.length - 2);
  check('CSV has time + 4 columns with units', csv[0] === 'time_s,ATT.Roll [°],ATT.DesRoll [°],ATT.Pitch [°],ATT.DesPitch [°]', csv[0]);
  check('CSV ~25 Hz over ~5 s (ATT rate)', csv.length - 2 > 100 && csv.length - 2 < 160, String(csv.length - 2));

  // Save a user preset and read it back.
  await graph.locator('button:has-text("Presets")').click();
  await main.fill('.menu-row input', 'E2E test preset');
  await main.click('.menu-row button:has-text("Save")');
  await main.waitForSelector('.menu-item:has-text("E2E test preset")', { timeout: 5000 });
  const saved = await main.evaluate(() => window.huskylog.listPresets());
  check('user preset saved to disk', saved.some((p) => p.name === 'E2E test preset' && p.json.includes('ATT.DesPitch')));
  await main.mouse.move(5, 5);

  // Messages + params.
  await main.click('.dv-tab:has-text("Messages")');
  const modeRows = await main.$$eval('tr.k-MODE td:nth-child(3)', (els) => els.map((e) => e.textContent));
  check('messages list modes MANUAL/RTL/MANUAL', modeRows.join() === 'MANUAL,RTL,MANUAL', modeRows.join());
  await main.click('.dv-tab:has-text("Parameters")');
  await main.fill('.table-panel input[aria-label="Search parameters"]', 'SERVO1_FUNCTION');
  const p = await main.textContent('.table-panel table.grid tbody tr');
  check('params shows SERVO1_FUNCTION = 70', /SERVO1_FUNCTION\s*70/.test(p ?? ''), p);
  await main.click('button:has-text("Changes")');
  const nChanges = await main.$$eval('.table-panel table.grid tbody tr', (r) => r.length);
  check('param changes hide housekeeping (fewer than 98)', nChanges < 98, String(nChanges));
  await main.screenshot({ path: join(shots, 'p1-review.png') });

  // Graph in a pop-out keeps working.
  const n = app.windows().length;
  await main.evaluate(() => window.__hl.dock.addPopoutGroup(window.__hl.dock.getPanel('graph-0').group, { popoutUrl: '/popout.html' }));
  for (let i = 0; i < 50 && app.windows().length === n; i++) await sleep(100);
  const pop = app.windows().find((w) => w !== main);
  await sleep(1500);
  const popOk = pop && (await pop.evaluate(() => document.querySelectorAll('.u-over').length === 1 && document.querySelectorAll('.chip').length === 4));
  check('graph renders inside a pop-out', !!popOk);
  if (pop) await pop.screenshot({ path: join(shots, 'p1-graph-popout.png') });

  log('blocked network requests', await main.evaluate(() => window.huskylog.blockedRequests()));
} catch (err) {
  console.error('E2E FAILED:', err);
  await app.windows()[0]?.screenshot({ path: join(shots, 'p1-failure.png') }).catch(() => {});
  failed++;
} finally {
  await app.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exitCode = failed ? 1 : 0;
