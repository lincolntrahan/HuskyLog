// Phase 2 harness: expressions in the Graph window on the reference log.
// Usage: npm run build && node scripts/e2e-phase2.mjs
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
  // Start from no named expressions (the e2e profile is separate from the user's).
  await main.evaluate(() => { for (const n of Object.keys(window.__hl.expressions.getState().named)) window.__hl.expressions.getState().removeNamed(n); });
  const f = await main.evaluate((p) => window.huskylog.e2eRegister(p), logPath);
  await main.evaluate((file) => window.dispatchEvent(new CustomEvent('hl-e2e-add', { detail: file })), f);
  await main.click('button[role=tab]:has-text("Import")');
  await main.waitForSelector('text=Ready', { timeout: 30000 });
  await main.click('button[role=tab]:has-text("Review")');
  const graph = main.locator('.graph').first();
  await main.evaluate(() => window.__hl.timeline.getState().setT(450)); // in flight, so live values exist
  const input = main.locator('.expr-input');
  const msg = async () => (await main.textContent('.expr-msg'))?.trim() ?? '';
  const chipVal = (label) => main.evaluate((l) => [...document.querySelectorAll('.chip')].find((c) => c.querySelector('.chip-name').textContent.includes(l))?.querySelector('.chip-val').textContent ?? null, label);
  const waitChip = (label) => main.waitForFunction((l) => [...document.querySelectorAll('.chip')].some((c) => c.querySelector('.chip-name').textContent.includes(l) && /\d/.test(c.querySelector('.chip-val').textContent)), label, { timeout: 15000 });

  // ---- Editor: autocomplete, errors, signature help ----
  await graph.locator('button:has-text("Expression")').click();
  await input.pressSequentially('ATT.Ro');
  await main.waitForSelector('.expr-suggest .pick');
  const firstSug = (await main.textContent('.expr-suggest .pick .pick-id'))?.trim();
  check('autocomplete suggests ATT.Roll first', firstSug === 'ATT.Roll', firstSug);
  await main.keyboard.press('Tab');
  check('Tab completes the token', (await input.inputValue()) === 'ATT.Roll');
  await input.pressSequentially(' - ATT.DesRol');
  await main.keyboard.press('Escape'); // dismiss suggestions, keep the editor open
  check('misspelt channel → error with suggestion', /ATT\.DesRol.*not in this log.*ATT\.DesRoll/.test(await msg()), await msg());
  check('error position is underlined', (await main.textContent('.squiggle'))?.includes('ATT.DesRol') ?? false);
  await input.pressSequentially('l');
  check('valid expression shows ✓', /Valid/.test(await msg()), await msg());
  await input.fill('lowpass(');
  check('signature help for lowpass', /lowpass\(x, hz\)/.test(await msg()), await msg());
  await input.fill('derv(BARO.Alt)');
  check('unknown function → "did you mean deriv"', /Did you mean deriv/.test(await msg()), await msg());

  // ---- Add an expression series with label + unit ----
  await input.fill('ATT.Roll - ATT.DesRoll');
  await main.fill('.expr-row input[aria-label="Label"]', 'Roll error');
  await main.fill('.expr-row input[aria-label="Unit"]', '°');
  await main.click('.modal button:has-text("Add")');
  await waitChip('Roll error');
  check('expression series plots and shows a live value', /°/.test((await chipVal('Roll error')) ?? ''), await chipVal('Roll error'));

  // Stats over a selection (RTL segment).
  await main.evaluate(() => window.__hl.timeline.getState().setRange([420, 480]));
  await main.waitForSelector('.stats tbody tr');
  const statRow = await main.$$eval('.stats tbody tr', (rows) => rows.map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent.trim())));
  check('stats computed for the expression', statRow.length === 1 && /ƒ Roll error/.test(statRow[0][0]) && Number(statRow[0][5]) > 1000, statRow[0]?.slice(0, 6).join(' | '));

  // ---- Named expression: save, use from the picker, compose ----
  await graph.locator('button:has-text("Expression")').click();
  await input.fill('BAT.Volt * BAT.Curr');
  await main.check('.expr-row input[type=checkbox]');
  await main.fill('.expr-row input[aria-label="Label"]', 'power');
  await main.fill('.expr-row input[aria-label="Unit"]', 'W');
  await main.click('.modal button:has-text("Add")');
  await waitChip('ƒ power');
  const named = await main.evaluate(() => window.__hl.expressions.getState().named);
  check('named expression saved', named.power === 'BAT.Volt * BAT.Curr', JSON.stringify(named));
  await graph.locator('button:has-text("Expression")').click();
  await input.fill('integrate(power) / 3600');
  check('named expression usable inside another expression', /Valid/.test(await msg()), await msg());
  await main.fill('.expr-row input[aria-label="Label"]', 'Energy');
  await main.fill('.expr-row input[aria-label="Unit"]', 'Wh');
  await main.click('.modal button:has-text("Add")');
  await waitChip('ƒ Energy');
  await graph.locator('button:has-text("Add")').first().click();
  await main.fill('.picker input', 'power');
  const pickNamed = await main.textContent('.picker .pick');
  check('named expression listed in the channel picker', /≡\s*power/.test(pickNamed ?? ''), pickNamed?.trim());
  await main.keyboard.press('Escape');

  // Self-reference is rejected.
  await graph.locator('button:has-text("Expression")').click();
  await input.fill('loop2 + 1');
  check('unknown name hint', /Unknown name "loop2"/.test(await msg()), await msg());
  await main.click('.modal button:has-text("Cancel")');
  await main.evaluate(() => { const s = window.__hl.expressions.getState(); s.setNamed('a1', 'b1 + 1'); s.setNamed('b1', 'a1 * 2'); });
  await graph.locator('button:has-text("Expression")').click();
  await input.fill('a1');
  check('cycle detected', /refers to itself/.test(await msg()), await msg());
  await main.click('.modal button:has-text("Cancel")');

  // ---- CSV export includes expression columns ----
  await main.evaluate(() => window.__hl.timeline.getState().setRange([420, 425]));
  const csvPath = join(tmpdir(), `huskylog-e2e-expr-${Date.now()}.csv`);
  await main.evaluate((p) => window.huskylog.e2eSaveTextTo(p), csvPath);
  await graph.locator('button:has-text("Export CSV")').click();
  await main.click('.modal button:has-text("Save CSV")');
  for (let i = 0; i < 40 && !existsSync(csvPath); i++) await sleep(100);
  const csv = existsSync(csvPath) ? readFileSync(csvPath, 'utf8').split('\r\n') : [];
  check('CSV header has expression columns with units', csv[0] === 'time_s,ƒ Roll error [°],ƒ power [W],ƒ Energy [Wh]', csv[0]);
  const row = csv[2]?.split(',').map(Number);
  check('CSV power column is plausible (W)', !!row && row[2] > 0 && row[2] < 5000, csv[2]); // ~9 W: gliding home in RTL

  // ---- Preset with expressions round-trips named definitions ----
  await graph.locator('button:has-text("Presets")').click();
  await main.fill('.menu-row input', 'E2E expr preset');
  await main.click('.menu-row button:has-text("Save")');
  await main.waitForSelector('.menu-item:has-text("E2E expr preset")');
  const preset = (await main.evaluate(() => window.huskylog.listPresets())).find((p) => p.name === 'E2E expr preset');
  const pj = preset ? JSON.parse(preset.json) : {};
  check('saved preset embeds the named expressions it uses', pj.named?.power === 'BAT.Volt * BAT.Curr' && pj.series?.some((s) => s.kind === 'expr'), JSON.stringify(pj.named));
  await main.click('.menu-item:has-text("Power & energy")');
  await waitChip('ƒ Used');
  check('built-in expression preset loads (power_W defined on demand)', !!(await main.evaluate(() => window.__hl.expressions.getState().named.power_W)), await chipVal('ƒ Used'));
  await main.evaluate(() => window.__hl.timeline.getState().setRange([300, 530]));
  await sleep(500);
  await main.screenshot({ path: join(shots, 'p2-expressions.png') });

  // Editing an expression series updates it.
  await main.click('.chip:has-text("ƒ Used") .chip-edit');
  await input.fill('integrate(BAT.Curr) / 3600');
  await main.fill('.expr-row input[aria-label="Unit"]', 'Ah');
  await main.click('.modal button:has-text("Update")');
  await main.waitForFunction(() => [...document.querySelectorAll('.chip-val')].some((e) => /Ah/.test(e.textContent)), null, { timeout: 10000 });
  check('editing an expression re-evaluates it', /Ah/.test((await chipVal('ƒ Used')) ?? ''), await chipVal('ƒ Used'));

  console.log('blocked network requests', JSON.stringify(await main.evaluate(() => window.huskylog.blockedRequests())));
} catch (err) {
  console.error('E2E FAILED:', err);
  await app.windows()[0]?.screenshot({ path: join(shots, 'p2-failure.png') }).catch(() => {});
  failed++;
} finally {
  await app.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exitCode = failed ? 1 : 0;
