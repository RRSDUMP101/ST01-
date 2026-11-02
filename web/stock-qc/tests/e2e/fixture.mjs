// Browser test of the sample data (src/engine/fixture.js) and the in-browser acceptance self-test (src/engine/selftest.js).
//   RRS_OUT=/tmp/stockqc-fixture node tests/e2e/fixture.mjs [--shots dir]
// Clean start of the demo page: the sample loads by itself (fast, no console errors), the home page shows it, every
// sample role sees its own work and every page at phone width; two flows run by clicking on the sample (a store person
// receives the transfer in transit, accounting approves the count waiting for approval); "เริ่มข้อมูลตัวอย่างใหม่" brings
// the sample back; the self-test passes every criterion in its own memory and leaves the page's data alone.
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

const problems = [];
let current = '';
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|cdnjs|ERR_|net::/.test(m.text())) problems.push(`console (${current}): ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`pageerror (${current}): ${e.message}`));
page.on('dialog', async (d) => { problems.push(`browser dialog (${current}): ${d.type()} ${d.message()}`); await d.dismiss().catch(() => {}); });

// ---- helpers ------------------------------------------------------------------------------------------------
const ready = () => page.waitForFunction(() => window.RRS && window.RRS.app && window.RRS.app.loading === false && window.RRS.app.ledger, null, { timeout: 60000 });
const state = (fn, arg) => page.evaluate(([src, a]) => (0, eval)(src)(window.RRS.app.ledger.state, window.RRS, a), [fn.toString(), arg === undefined ? null : arg]);
async function go(id) {
  await page.evaluate((x) => { location.hash = x; }, id);
  await page.waitForSelector(`.page[data-page="${id}"]`, { timeout: 10000 });
}
async function asUser(id) {
  await page.selectOption('#who-sel', id);
  await page.waitForFunction((x) => document.querySelector('#who-sel') && document.querySelector('#who-sel').value === x
    && window.RRS.app.demoUser === x, id);
}
const mainText = () => page.locator('#main').innerText();
async function waitText(text, timeout, sel) {
  await page.waitForFunction(([x, s]) => (document.querySelector(s || '#main') || {}).innerText.indexOf(x) >= 0, [text, sel || '#main'], { timeout: timeout || 6000 })
    .catch(async () => { throw new Error(`ไม่พบข้อความ "${text}" ใน ${sel || 'หน้า'}\n---\n${(await page.locator(sel || '#main').innerText().catch(() => '')).slice(0, 1500)}`); });
}
const kpi = (label) => page.evaluate((l) => {
  const k = Array.from(document.querySelectorAll('#main .kpi')).find((e) => e.querySelector('.kpi-l') && e.querySelector('.kpi-l').textContent.trim() === l);
  return k ? k.querySelector('.kpi-v').textContent.trim() : null;
}, label);
async function toast(text) {
  await page.waitForFunction((x) => document.querySelector('#toasts').innerText.indexOf(x) >= 0, text, { timeout: 6000 })
    .catch(async () => { throw new Error(`ไม่มีข้อความแจ้ง "${text}" (มี: ${await page.locator('#toasts').innerText()})`); });
}
async function clearToasts() {
  await page.evaluate(() => { document.querySelector('#toasts').innerHTML = ''; });
}
async function dlgOpen() {
  await page.waitForSelector('#dlg:not([hidden]) .dlg-card', { timeout: 6000 });
}
async function dlgSubmit() {
  await page.click('#dlg .dlg-f button[type=submit]');
}
async function dlgClosed() {
  await page.waitForSelector('#dlg[hidden]', { state: 'attached', timeout: 6000 });
}
/** Click the link/button of the home page "งานที่รอคุณ" row with this label. */
async function clickWork(label) {
  const link = page.locator('#main .sec', { hasText: 'งานที่รอคุณ' }).locator('a', { hasText: label }).first();
  assert(await link.count(), `งานที่รอคุณควรมี "${label}"\n---\n${(await mainText()).slice(0, 1200)}`);
  await link.click();
}
async function noOverflow(where) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert(!over, `${where}: หน้ากว้างเกินจอ`);
}
async function shot(name) {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
}
async function step(name, fn) {
  current = name;
  try {
    await fn();
    console.log('ok  ', name);
  } catch (e) {
    problems.push(`${name}: ${e.message}`);
    console.log('FAIL', name, '\n     ', e.message.split('\n')[0]);
    if (shots) await page.screenshot({ path: path.join(shots, `fail-${name.replace(/[^\w]+/g, '_')}.png`), fullPage: true }).catch(() => {});
  }
}

// ---- clean start: the sample builds itself -------------------------------------------------------------------
let fresh = null;
await step('clean start loads the sample quickly', async () => {
  await page.goto(file);
  await ready();
  await page.evaluate(() => localStorage.clear());
  const t0 = Date.now();
  await page.reload();
  await ready();
  const ms = Date.now() - t0;
  fresh = await state((s, R) => ({ seq: s.seq, head: s.head, sample: R.fixture.isSampleState(s), company: s.tables.settings.main.company }));
  assert(fresh.sample && fresh.company === 'ข้อมูลตัวอย่าง', `ควรเป็นข้อมูลตัวอย่าง ได้ ${JSON.stringify(fresh)}`);
  assert(fresh.seq >= 50 && fresh.seq <= 400, `จำนวนรายการบันทึก ${fresh.seq}`);
  assert(ms < 8000, `เปิดหน้าและสร้างข้อมูลตัวอย่างใช้ ${ms} ms`);
  console.log(`      ข้อมูลตัวอย่าง ${fresh.seq} รายการ เปิดหน้าพร้อมใช้ใน ${ms} ms`);
  await page.waitForSelector('.page[data-page="home"]');
  await waitText('ข้อมูลตัวอย่างในเบราว์เซอร์นี้', 6000, '#banner');
});

await step('engine state of the sample', async () => {
  const r = await state((s, R) => {
    const items = Object.values(s.tables.items);
    const users = Object.values(s.tables.users);
    return {
      verify: R.inventory.verifyBalances(s).length,
      daily: R.reports.dailyCheck(s).ok,
      demoItems: items.every((i) => i.id.indexOf('DEMO-') === 0),
      items: items.length,
      roleUsers: users.every((u) => u.id === 'ADMIN' || u.id.indexOf('DEMO_') === 0),
      sampleNames: users.every((u) => /\(ตัวอย่าง\)$/.test(u.name)),
      so: Object.values(s.tables.jobs).every((j) => /^SO-DEMO-\d{3}$/.test(j.soNo)),
      transit: Object.values(s.tables.documents).filter((d) => d.status === 'IN_TRANSIT').length,
      count: Object.values(s.tables.count_sessions).filter((c) => c.status === 'SUBMITTED').length,
      latePo: R.purchasing.outstanding(s, { today: R.util.bkkDate(new Date().toISOString()) }).filter((l) => l.late).length,
    };
  });
  assert(r.verify === 0 && r.daily, `ยอดต้องตรงประวัติและตรวจยอดประจำวันผ่าน ${JSON.stringify(r)}`);
  assert(r.demoItems && r.roleUsers && r.sampleNames && r.so, `ข้อมูลต้องเป็นตัวอย่างทั้งหมด ${JSON.stringify(r)}`);
  assert(r.items >= 20 && r.transit === 1 && r.count === 1 && r.latePo === 2, `เนื้อหาตัวอย่าง ${JSON.stringify(r)}`);
  fresh.items = r.items;
});

await step('home shows the sample data', async () => {
  await go('home');
  assert(await kpi('สินค้าที่ใช้งาน') === String(fresh.items), `สินค้าที่ใช้งาน ควรเป็น ${fresh.items} ได้ ${await kpi('สินค้าที่ใช้งาน')}`);
  assert(await kpi('ระหว่างโอน') === '1', `ระหว่างโอน ควรเป็น 1 ได้ ${await kpi('ระหว่างโอน')}`);
  assert(await kpi('รอบนับค้าง') === '1', `รอบนับค้าง ควรเป็น 1 ได้ ${await kpi('รอบนับค้าง')}`);
  assert(await kpi('บรรทัด PO เลยกำหนด') === '2', `บรรทัด PO เลยกำหนด ควรเป็น 2 ได้ ${await kpi('บรรทัด PO เลยกำหนด')}`);
  assert(Number(await kpi('งานผลิตเปิดอยู่')) >= 2, 'งานผลิตเปิดอยู่ ควรมีอย่างน้อย 2');
  assert(Number(await kpi('ของรอตรวจ')) >= 1, 'ของรอตรวจ ควรมีอย่างน้อย 1 (แผงข้างที่รับจากการผลิต)');
  await waitText('ตรวจยอดประจำวัน');
  await waitText('ข้อตกลง 2/11');
  const opts = await page.evaluate(() => Array.from(document.querySelectorAll('#who-sel option')).map((o) => o.textContent));
  for (const name of ['ผู้ดูแลระบบ (ตัวอย่าง)', 'สโตร์ (ตัวอย่าง)', 'หัวหน้าสโตร์ (ตัวอย่าง)', 'บัญชี (ตัวอย่าง)', 'QC (ตัวอย่าง)', 'หัวหน้า QC (ตัวอย่าง)', 'ดูอย่างเดียว (ตัวอย่าง)']) {
    assert(opts.some((o) => o.indexOf(name) === 0), `ตัวเลือกผู้ใช้ควรมี ${name}`);
  }
  await shot('desktop-home-sample');
});

await step('each sample role sees its own work on the home page', async () => {
  const expect = {
    DEMO_STORE: ['รับของที่โอนมา'], DEMO_ACC: ['อนุมัติผลตรวจนับ', 'กระทบยอดไฟล์ Express', 'บันทึกเลขที่ Express'],
    DEMO_QC: ['ตรวจของที่รอตรวจ'], DEMO_PUR: ['ตามของ PO ที่เลยกำหนดส่ง'], DEMO_MGR: ['ข้อตกลง Phase 0 ที่ยังไม่ตัดสิน'],
  };
  for (const [id, labels] of Object.entries(expect)) {
    await asUser(id);
    await go('home');
    for (const l of labels) await waitText(l);
  }
  await asUser('DEMO_VIEW');
  await go('home');
  await waitText('ไม่มีงานค้างสำหรับบทบาทของคุณ');
});

await step('store person receives the sample transfer by clicking', async () => {
  const trNo = await state((s) => Object.values(s.tables.documents).find((d) => d.status === 'IN_TRANSIT').docNo);
  await asUser('DEMO_STORE');
  await go('home');
  await clickWork('รับของที่โอนมา');
  await page.waitForSelector('.page[data-page="docs"]');
  await page.click(`#main tr[data-act="pick"][data-arg="${trNo}"]`);
  await waitText(trNo);
  await page.click('#main button[data-act="receive"]');
  await dlgOpen();
  await dlgSubmit();
  await dlgClosed();
  await toast('รับโอนแล้ว');
  const r = await state((s, R, no) => ({ status: s.tables.documents[no].status, qty: R.q.qty(s, { code: 'DEMO-WIRE', wh: '02', bin: 'WIP-C1' }),
    transit: R.q.qty(s, { code: 'DEMO-WIRE', wh: R.TRANSIT }), by: s.tables.documents[no].receivedBy }), trNo);
  assert(r.status === 'RECEIVED' && r.qty === 15 && r.transit === 0 && r.by === 'DEMO_STORE', `หลังรับโอน ${JSON.stringify(r)}`);
});

await step('accounting approves the sample count by clicking (counters cannot)', async () => {
  const ct = await state((s) => Object.values(s.tables.count_sessions).find((c) => c.status === 'SUBMITTED').id);
  // the store lead counted this session: it cannot approve it (separation of duties shown on the screen)
  await asUser('DEMO_LEAD');
  await go('counts');
  await page.click(`#main tr[data-act="pick"][data-arg="${ct}"]`);
  await waitText('อนุมัติเองไม่ได้');
  await asUser('DEMO_ACC');
  await go('home');
  await clickWork('อนุมัติผลตรวจนับ');
  await page.waitForSelector('.page[data-page="counts"]');
  await page.click(`#main tr[data-act="pick"][data-arg="${ct}"]`);
  await page.waitForSelector('#ct-approval');
  const inputs = await page.locator('#ct-approval input[id^="ct-r-"]').count();
  assert(inputs === 2, `ควรมีช่องเหตุผล 2 ช่อง (สีรองพื้น ใบเจียร) ได้ ${inputs}`);
  await page.fill('#ct-r-0', 'ตัวอย่าง: เบิกใช้หน้างานแล้วไม่ได้บันทึก');
  await page.fill('#ct-r-1', 'ตัวอย่าง: ใบเจียรแตกทิ้งไปแล้ว');
  await page.click('#ct-approval form[data-form="approve"] button[type=submit]');
  await dlgOpen();
  await dlgSubmit();
  await dlgClosed();
  await toast(`อนุมัติผลนับ ${ct} แล้ว`);
  const r = await state((s, R, id) => {
    const c = s.tables.count_sessions[id];
    const d = s.tables.documents[c.docNo] || { lines: [] };
    return { status: c.status, by: c.approvedBy, type: d.type, wh: d.lines.map((l) => l.wh), adj: d.lines.map((l) => [l.code, l.base]),
      paint: R.q.qty(s, { code: 'DEMO-PAINT-P', wh: '01', bin: 'RM-C1', status: 'AVAILABLE' }), verify: R.inventory.verifyBalances(s).length };
  }, ct);
  assert(r.status === 'APPROVED' && r.by === 'DEMO_ACC' && r.type === 'AJ', `รอบนับหลังอนุมัติ ${JSON.stringify(r)}`);
  assert(JSON.stringify(r.adj) === JSON.stringify([['DEMO-PAINT-P', -6], ['DEMO-DISC', -3]]) || JSON.stringify(r.adj) === JSON.stringify([['DEMO-DISC', -3], ['DEMO-PAINT-P', -6]]), `ใบปรับยอด ${JSON.stringify(r.adj)}`);
  assert(r.wh.every((w) => w === '01') && r.paint === 30 && r.verify === 0, `ยอดหลังอนุมัติ ${JSON.stringify(r)}`);
  await shot('desktop-count-approved');
});

await step('the sample stays after a reload and comes back with "เริ่มข้อมูลตัวอย่างใหม่"', async () => {
  const before = await state((s) => ({ seq: s.seq, head: s.head }));
  await page.reload();
  await ready();
  const after = await state((s) => ({ seq: s.seq, head: s.head }));
  assert(after.seq === before.seq && after.head === before.head, 'โหลดหน้าใหม่ต้องไม่สร้างข้อมูลตัวอย่างซ้ำ');
  await asUser('ADMIN');
  await page.click('#banner button[data-act="_resetDemo"]');
  await dlgOpen();
  await waitText('ล้างข้อมูลตัวอย่างในเบราว์เซอร์นี้', 4000, '#dlg');
  await dlgSubmit();
  await ready();
  await page.waitForFunction((n) => window.RRS.app.ledger.state.seq === n, fresh.seq, { timeout: 15000 });
  const r = await state((s) => ({ seq: s.seq, transit: Object.values(s.tables.documents).filter((d) => d.status === 'IN_TRANSIT').length,
    count: Object.values(s.tables.count_sessions).filter((c) => c.status === 'SUBMITTED').length }));
  assert(r.seq === fresh.seq && r.transit === 1 && r.count === 1, `ข้อมูลตัวอย่างใหม่ ${JSON.stringify(r)}`);
});

await step('self-test passes every criterion and leaves the page data alone', async () => {
  const before = await state((s) => ({ seq: s.seq, head: s.head }));
  const r = await page.evaluate(async () => {
    const t0 = Date.now();
    const prog = [];
    const res = await window.RRS.selftest.run({ onProgress: (p) => prog.push(p.done) });
    return { ms: Date.now() - t0, prog: prog.length, total: res.length, fails: res.filter((x) => !x.pass).map((x) => `${x.id} ${x.detail}`),
      ids: res.map((x) => x.id).join(','), uat: window.RRS.reports.UAT_CRITERIA.map((c) => c.id).join(','),
      thai: res.every((x) => /[฀-๿]/.test(x.detail) && /[฀-๿]/.test(x.criterion)) };
  });
  assert(!r.fails.length, `เกณฑ์ไม่ผ่าน:\n${r.fails.join('\n')}`);
  assert(r.ids === r.uat && r.prog === r.total && r.thai, `ผลทดสอบ ${JSON.stringify(r).slice(0, 300)}`);
  console.log(`      ทดสอบเกณฑ์ตรวจรับ ${r.total} ข้อ ผ่านทั้งหมดใน ${r.ms} ms`);
  const after = await state((s) => ({ seq: s.seq, head: s.head }));
  assert(after.seq === before.seq && after.head === before.head, 'การทดสอบต้องไม่แตะข้อมูลของหน้า');
});

await step('every page renders the sample for each role at phone width', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  const ids = await page.evaluate(() => Object.keys(window.RRS.ui.pages));
  for (const who of ['ADMIN', 'DEMO_STORE', 'DEMO_QC', 'DEMO_PLAN', 'DEMO_VIEW']) {
    await asUser(who);
    for (const id of ids) {
      await go(id);
      const broken = await page.evaluate(() => /หน้านี้แสดงไม่ได้/.test(document.querySelector('#main').innerText));
      assert(!broken, `${who} ${id}: หน้านี้แสดงไม่ได้\n${(await mainText()).slice(0, 400)}`);
      await noOverflow(`${who} ${id}`);
    }
  }
  await asUser('ADMIN');
  await go('home');
  await shot('phone-home-sample');
  await page.setViewportSize({ width: 1366, height: 900 });
});

await browser.close();
if (problems.length) {
  console.log('PROBLEMS\n' + problems.join('\n'));
  process.exit(1);
}
console.log('fixture ok');
