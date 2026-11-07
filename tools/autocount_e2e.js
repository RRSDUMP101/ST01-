// นับอัตโนมัติ in headless Chromium: the fake camera shows a crate of 28 pipe ends (mobile_fake_camera.py … pipes);
// count mode → นับจากภาพ → tap one pipe end → the count (in the worker) → ใช้จำนวน fills the count sheet.
// node tools/autocount_e2e.js --info demo.json --video pipes.mjpeg [--shot out.png] [--width 412 --height 900]
// --layout: only that the ring and the dots sit where the finger was (a portrait picture on a short screen)
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
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: Number(args.width || 412), height: Number(args.height || 900) }, permissions: ['camera'] });
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
  // a pipe end of the scene (1280 x 720): column 3, row 2 - turned counter-clockwise in a portrait picture
  const fx = (400 + 3 * 122) / 1280; const fy = (320 + 2 * 106) / 720;
  const [ux, uy] = box.height > box.width ? [fy, 1 - fx] : [fx, fy];
  const tapX = box.x + ux * box.width; const tapY = box.y + uy * box.height;
  await page.mouse.click(tapX, tapY);
  await page.waitForFunction(() => !document.querySelector('.tc-busy') && document.querySelectorAll('.tc-dot').length > 0, null, { timeout: 15000 });
  // the ring of the sample is drawn where the finger was, on the picture as it is shown now (the panel below grows)
  const ring = await page.evaluate(() => {
    const r = document.querySelector('.tc-sample').getBoundingClientRect();
    const i = document.querySelector('.tapcount img').getBoundingClientRect();
    const f = document.querySelector('.tc-img').getBoundingClientRect();
    const n = document.querySelector('.tapcount img');
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, img: [i.x, i.y, i.width, i.height], frame: [f.x, f.y, f.width, f.height], nat: [n.naturalWidth, n.naturalHeight] };
  });
  const now = await page.locator('.tapcount img').boundingBox();
  const want = [now.x + (tapX - box.x) / box.width * now.width, now.y + (tapY - box.y) / box.height * now.height];
  const ringOff = Math.round(Math.hypot(ring.x - want[0], ring.y - want[1]));
  const frameOff = Math.round(Math.max(...ring.img.map((v, k) => Math.abs(v - ring.frame[k]))));
  const found = Number(await page.locator('.tc-count b').textContent());
  const unsure = await page.locator('.tc-dot.unsure').count();
  if (args.shot) await page.screenshot({ path: args.shot });
  await page.getByText(/ใช้จำนวน/).click();
  await page.waitForTimeout(500);
  const counted = await page.locator('.stepper input').inputValue().catch(() => '');
  console.log(JSON.stringify({ expect: EXPECT, found, unsure, counted, ringOff, frameOff, shown: ring.img.map(Math.round), picture: ring.nat, errors }));
  await browser.close();
  const counts = args.layout || (Math.abs(found - EXPECT) <= 1 && counted === String(found));
  process.exit(counts && ringOff <= 3 && frameOff <= 1 && !errors.length ? 0 : 1);
})();
