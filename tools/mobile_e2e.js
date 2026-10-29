// The mobile app in headless Chromium with a fake camera (tools/mobile_fake_camera.py): every screen opens, the AR
// reads the labels, points to the slot, flags the wrong side and picks. Screenshots for the docs with --shots.
//
//   node tools/mobile_e2e.js --info demo.json --video shelf.mjpeg [--shots docs/screenshots/mobile]
//   (demo.json from: python tools/mobile_demo.py --token-file demo.json)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const info = JSON.parse(fs.readFileSync(args.info, 'utf8'));
const shots = typeof args.shots === 'string' ? args.shots : '';
if (shots) fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };

async function waitFor(page, fn, ms = 12000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await page.evaluate(fn).catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(250);
  }
}

(async () => {
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${args.video}`],
  });
  const errors = [];
  const open = async ({ width = 390, height = 844, dark = false, token = true } = {}) => {
    const ctx = await browser.newContext({
      viewport: { width, height }, deviceScaleFactor: 2, isMobile: width < 900, hasTouch: true, ignoreHTTPSErrors: true,
      permissions: ['camera'], locale: 'th-TH', colorScheme: dark ? 'dark' : 'light',
    });
    if (token) await ctx.addInitScript((t) => { localStorage.setItem('rrs.token', JSON.stringify(t)); }, info.token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/SSL certificate|service ?worker/i.test(m.text())) errors.push(m.text()); });
    return { ctx, page };
  };
  const shot = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const go = async (page, route, wait = 1500) => { await page.evaluate((r) => { location.hash = r; }, `#/${route}`); await sleep(wait); };
  const texts = (page, sel) => page.$$eval(sel, (els) => els.map((e) => `${e.className} :: ${e.innerText.replace(/\s+/g, ' ').trim()}`));

  const { ctx, page } = await open();
  await page.goto(`${info.app}#/home`);
  check(await waitFor(page, () => document.querySelectorAll('.stat').length === 4), 'home: four numbers of today');
  await sleep(800);
  await shot(page, 'm1_home');
  await go(page, 'prod');
  check(await waitFor(page, () => document.querySelectorAll('.queue-card').length > 0), 'production: queue of the station');
  await shot(page, 'm2_queue');
  await page.click('.queue-card');
  check(await waitFor(page, () => !!document.querySelector('.sheet .stepper')), 'production: record sheet opens with a stepper');
  await sleep(500);
  await shot(page, 'm3_record');
  await page.keyboard.press('Escape');
  await sleep(400);
  await go(page, 'prod/job/SO6910-016');
  check(await waitFor(page, () => document.querySelectorAll('.part-card').length > 0), 'job: parts with their steps');
  await shot(page, 'm4_job');
  await go(page, 'stock/item/RRS-T-022-L-84', 2500);
  check(await waitFor(page, () => !!document.querySelector('.view3d canvas') && document.querySelectorAll('.six-cell').length === 6),
    'item: 3D model and the six numbers');
  await shot(page, 'm5_item3d');
  await go(page, 'pick/job/SO6910-015');
  check(await waitFor(page, () => document.querySelectorAll('.pick-row').length > 0), 'picking: lines in shelf order');
  await shot(page, 'm6_picklist');

  // ---- AR ------------------------------------------------------------------------------------------
  await go(page, 'scan?mode=info', 500);
  const info1 = await waitFor(page, () => (document.querySelectorAll('.arc.item').length >= 2 ? document.querySelectorAll('.arc').length : 0), 15000);
  const arcs = await texts(page, '.arc');
  console.log(JSON.stringify(arcs));
  check(info1 >= 3 && arcs.some((a) => a.includes('RRS-T-022-L-84') && a.includes('P-POST-04')), 'AR info: labels read, stock on each card');
  await sleep(600);
  await shot(page, 'm7_ar_info');
  await go(page, 'scan?mode=count', 500);
  check(await waitFor(page, () => [...document.querySelectorAll('.arc')].some((a) => a.innerText.includes('แตะเพื่อนับ')), 12000), 'AR count: tap a label to count');
  await page.click('.arc.tap');
  check(await waitFor(page, () => !!document.querySelector('.sheet .count-grid')), 'AR count: count sheet with the system quantity');
  await shot(page, 'm8_ar_count');
  await page.keyboard.press('Escape');
  await sleep(400);
  await go(page, 'pick/job/SO6910-015');
  await page.getByRole('button', { name: /เริ่มหยิบด้วย AR|หยิบต่อด้วย AR/ }).click();
  check(await waitFor(page, () => [...document.querySelectorAll('.arc.near')].length >= 2, 15000), 'AR pick: arrows from the labels to the slot');
  const near = await texts(page, '.arc.near');
  console.log(JSON.stringify(near));
  check(near.some((t) => t.includes('ซ้าย 3 ช่อง')), 'AR pick: P-POST-04 → P-POST-01 is 3 slots to the left');
  await sleep(500);
  await shot(page, 'm9_ar_arrows');
  for (let k = 0; k < 2; k += 1) { await page.getByRole('button', { name: 'ข้าม' }).click(); await sleep(400); }
  check(await waitFor(page, () => !!document.querySelector('.arc.target') && !!document.querySelector('.arc.bad'), 15000),
    'AR pick: the slot lights up, the right-hand post is flagged');
  check(await waitFor(page, () => (document.querySelector('.pp-state.ok') || {}).innerText), 'AR pick: label of the part verified');
  await sleep(900);
  await shot(page, 'm10_ar_target');
  await page.click('.arc.bad');
  check(await waitFor(page, () => (document.querySelector('.ar-alarm') || {}).innerText), 'AR pick: wrong part alarm');
  await sleep(300);
  await shot(page, 'm11_ar_alarm');
  await sleep(3600);
  await page.getByRole('button', { name: /หยิบแล้ว/ }).click();
  check(await waitFor(page, () => (document.querySelector('.pp-code') || {}).innerText === 'RRS-T-022-R-84'), 'AR pick: next part after picking');
  await ctx.close();

  if (shots) {
    const tab = await open({ width: 1024, height: 1366 });
    await tab.page.goto(`${info.app}#/home`);
    await sleep(2200);
    await shot(tab.page, 'm12_ipad_home');
    await tab.ctx.close();
    const dark = await open({ dark: true });
    await dark.page.goto(`${info.app}#/prod`);
    await sleep(2000);
    await shot(dark.page, 'm13_dark_queue');
    await dark.ctx.close();
  }
  const pair = await open({ token: false });
  await pair.page.goto(`${info.app}#pair=${info.code}`);
  check(await waitFor(pair.page, () => (document.querySelector('.code-input') || {}).value), 'pairing page with the code of the QR');
  await sleep(500);
  await shot(pair.page, 'm0_pair');
  await pair.ctx.close();
  await browser.close();
  check(!errors.length, `no errors in the page${errors.length ? `: ${[...new Set(errors)].slice(0, 5).join(' | ')}` : ''}`);
  if (failures.length) {
    console.log(`\n${failures.length} failed`);
    process.exit(1);
  }
  console.log('\nall passed');
})().catch((e) => { console.error(e); process.exit(2); });
