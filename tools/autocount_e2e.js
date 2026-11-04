// นับอัตโนมัติ in headless Chromium: the fake camera shows a crate of 28 pipe ends (mobile_fake_camera.py … pipes);
// count mode → นับจากภาพ → tap one pipe end → the count (in the worker) → ใช้จำนวน fills the count sheet.
// node tools/autocount_e2e.js --info demo.json --video pipes.mjpeg [--shot out.png]
const fs = require('fs');
const { chromium } = require('playwright');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const info = JSON.parse(fs.readFileSync(args.info, 'utf8'));
const EXPECT = 28;

(async () => {
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${args.video}`],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 412, height: 900 }, permissions: ['camera'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const base = info.app.replace(/\/$/, '');
  await page.goto(`${base}/#auth=${encodeURIComponent(info.token)}`);
  await page.waitForTimeout(1200);
  await page.goto(`${base}/#/scan?mode=count`);
  await page.waitForTimeout(3500);
  await page.getByText('นับจากภาพ').first().click();
  await page.waitForSelector('.tapcount img');
  await page.waitForTimeout(400);
  const box = await page.locator('.tapcount img').boundingBox();
  // a pipe end of the scene (1280 x 720): column 3, row 2
  await page.mouse.click(box.x + (400 + 3 * 122) / 1280 * box.width, box.y + (320 + 2 * 106) / 720 * box.height);
  await page.waitForFunction(() => !document.querySelector('.tc-busy') && document.querySelectorAll('.tc-dot').length > 0, null, { timeout: 15000 });
  const found = Number(await page.locator('.tc-count b').textContent());
  const unsure = await page.locator('.tc-dot.unsure').count();
  if (args.shot) await page.screenshot({ path: args.shot });
  await page.getByText(/ใช้จำนวน/).click();
  await page.waitForTimeout(500);
  const counted = await page.locator('.stepper input').inputValue().catch(() => '');
  console.log(JSON.stringify({ expect: EXPECT, found, unsure, counted, errors }));
  await browser.close();
  process.exit(Math.abs(found - EXPECT) <= 1 && counted === String(found) && !errors.length ? 0 : 1);
})();
