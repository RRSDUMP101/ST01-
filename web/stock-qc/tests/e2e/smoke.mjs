// Browser smoke test of dist/index.html (demo mode): every page renders without errors, at desktop and phone width.
//   node tests/e2e/smoke.mjs [--shots dir]
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.env.RRS_OUT ? path.resolve(process.env.RRS_OUT) : path.join(here, '..', '..', 'dist');
const file = 'file://' + path.join(distDir, 'index.html');
const shotsArg = process.argv.indexOf('--shots');
const shots = shotsArg > 0 ? process.argv[shotsArg + 1] : null;
if (shots) fs.mkdirSync(shots, { recursive: true });

const browser = await chromium.launch();
const problems = [];
for (const vp of [{ name: 'desktop', width: 1366, height: 860 }, { name: 'phone', width: 390, height: 844 }]) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|cdnjs|ERR_|net::/.test(m.text())) problems.push(`[${vp.name}] console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[${vp.name}] pageerror: ${e.message}`));
  await page.goto(file);
  await page.waitForFunction(() => window.RRS && window.RRS.app && !window.RRS.app.loading && window.RRS.app.ledger, null, { timeout: 60000 });
  const ids = await page.evaluate(() => Object.keys(window.RRS.ui.pages));
  for (const id of ids) {
    await page.evaluate((x) => { location.hash = x; }, id);
    await page.waitForFunction((x) => document.querySelector(`.page[data-page="${x}"]`), id, { timeout: 10000 }).catch(() => problems.push(`[${vp.name}] ${id}: did not render`));
    const bad = await page.evaluate(() => {
      const t = document.querySelector('#main').innerText;
      const over = document.documentElement.scrollWidth > window.innerWidth + 1;
      return { broken: /หน้านี้แสดงไม่ได้/.test(t) ? t.slice(0, 300) : '', over };
    });
    if (bad.broken) problems.push(`[${vp.name}] ${id}: ${bad.broken}`);
    if (bad.over) problems.push(`[${vp.name}] ${id}: page wider than the screen`);
    if (shots) await page.screenshot({ path: path.join(shots, `${vp.name}-${id}.png`), fullPage: vp.name === 'desktop' });
  }
  await page.close();
}
await browser.close();
if (problems.length) {
  console.log('PROBLEMS\n' + problems.join('\n'));
  process.exit(1);
}
console.log('smoke ok');
