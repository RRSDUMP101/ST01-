// Review test of the Phase 6 screens (รายงาน, เศษเหล็กใช้ซ้ำ, ทดสอบรับงาน (UAT), สำรองและกู้คืน, คู่มือตามบทบาท) used the way
// store / production / QC / accounting / managers would: wrong input (empty, letters in numbers, negative numbers, dates
// the wrong way round, unknown codes), roles without permission and one person signing for two areas, user text that must
// stay text, and every screen at phone width (390 px) with the main action on screen.
//   RRS_OUT=/tmp/stockqc-p6-review node tests/e2e/p6-review.mjs [--shots dir]
// Steps:
//  1. reports: a negative "days" and "minCount" fall back to the defaults with a Thai warning; reversed dates are named;
//  2. offcuts: no plate chosen / letters / negative sizes refused and nothing recorded, a user limited to one warehouse
//     only gets that warehouse and no buttons on pieces elsewhere; the finder takes material/thickness from a chosen plate,
//     drops a piece opened earlier, has "ใช้เศษนี้" on screen at 390 px and only prefills the job when used from the finder;
//  3. UAT: the record button is on screen at 390 px (no sideways scroll), an empty criterion id is named first;
//  4. UAT sign-off (uat.signoff): empty state, viewer/admin cannot sign, REJECT needs a reason, a person who accepted one
//     area cannot accept another (refused, nothing written), three different people accept store / QC / accounting;
//  5. backup: one verification is recorded once; a file name with HTML stays text;
//  6. guide: codes labelled as system codes, sign-off steps link to the sign-off tab, training self/future refused;
//  7. phone width for all five pages and the sign-off dialog; no page errors, no browser alert/confirm/prompt.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.env.RRS_OUT ? path.resolve(process.env.RRS_OUT) : path.join(here, '..', '..', 'dist');
const file = 'file://' + path.join(distDir, 'index.html');
const shotsArg = process.argv.indexOf('--shots');
const shots = shotsArg > 0 ? process.argv[shotsArg + 1] : null;
if (shots) fs.mkdirSync(shots, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rrs-p6r-'));

const problems = [];
let current = '';
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
page.on('console', (m) => {
  if (m.type() !== 'error' || /fonts\.g|cdnjs|ERR_|net::/.test(m.text())) return;
  problems.push(`console (${current}): ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`pageerror (${current}): ${e.message}`));
page.on('dialog', async (d) => { problems.push(`browser dialog (${current}): ${d.type()} ${d.message()}`); await d.dismiss().catch(() => {}); });

// ---- helpers (same conventions as p6.mjs) ----------------------------------------------------------------------
const ready = () => page.waitForFunction(() => window.RRS && window.RRS.app && window.RRS.app.loading === false && window.RRS.app.ledger, null, { timeout: 120000 });
async function exec(kind, payload, user) {
  return page.evaluate(async ([k, p, u]) => {
    const st = window.RRS.app.ledger.state;
    const admin = u || Object.values(st.tables.users || {}).find((x) => x.roles.indexOf('admin') >= 0 && x.active !== false).id;
    const r = await window.RRS.app.ledger.execute({ kind: k, payload: p }, { user: admin });
    return { ok: r.ok, errors: r.errors || [], result: r.result || {} };
  }, [kind, payload, user || null]);
}
async function must(kind, payload, user) {
  const r = await exec(kind, payload, user);
  if (!r.ok) throw new Error(`${kind}: ${r.errors.map((e) => e.message).join(' / ')}`);
  return r;
}
async function go(id) {
  await page.evaluate((x) => { location.hash = x; }, id);
  await page.waitForSelector(`.page[data-page="${id}"]`, { timeout: 10000 });
}
async function reopen(id) {
  await go('home');
  await go(id);
}
async function asUser(id) {
  await page.selectOption('#who-sel', id);
  await page.waitForFunction((x) => document.querySelector('#who-sel') && document.querySelector('#who-sel').value === x, id);
}
const mainText = () => page.locator('#main').innerText();
async function waitText(text, timeout) {
  await page.waitForFunction((x) => document.querySelector('#main').innerText.indexOf(x) >= 0, text, { timeout: timeout || 6000 })
    .catch(async () => { throw new Error(`ไม่พบข้อความ "${text}" ในหน้า\n---\n${(await mainText()).slice(0, 2000)}`); });
}
async function waitGone(text, timeout) {
  await page.waitForFunction((x) => document.querySelector('#main').innerText.indexOf(x) < 0, text, { timeout: timeout || 6000 })
    .catch(() => { throw new Error(`ข้อความ "${text}" ยังอยู่ในหน้า`); });
}
async function waitIn(sel, text, timeout) {
  await page.waitForFunction(([s, x]) => { const e = document.querySelector(s); return !!e && e.innerText.indexOf(x) >= 0; }, [sel, text], { timeout: timeout || 6000 })
    .catch(async () => { throw new Error(`ไม่พบ "${text}" ใน ${sel}: ${(await page.locator(sel).first().innerText().catch(() => '(ไม่มี)')).slice(0, 1500)}`); });
}
const kpi = (label) => page.evaluate((l) => {
  const k = Array.from(document.querySelectorAll('#main .kpi')).find((e) => e.querySelector('.kpi-l').textContent.trim() === l);
  return k ? k.querySelector('.kpi-v').textContent.trim() : null;
}, label);
const kpiSub = (label) => page.evaluate((l) => {
  const k = Array.from(document.querySelectorAll('#main .kpi')).find((e) => e.querySelector('.kpi-l').textContent.trim() === l);
  return k && k.querySelector('.kpi-s') ? k.querySelector('.kpi-s').textContent.trim() : null;
}, label);
const rowCells = (sel, text) => page.evaluate(([s, x]) => {
  const tr = Array.from(document.querySelectorAll(s)).find((r) => r.innerText.indexOf(x) >= 0);
  return tr ? Array.from(tr.children).map((td) => td.innerText.trim()) : null;
}, [sel, text]);
const state = (fn, arg) => page.evaluate(([src, a]) => (0, eval)(src)(window.RRS.app.ledger.state, window.RRS, a), [fn.toString(), arg === undefined ? null : arg]);
async function waitState(fn, arg, what) {
  for (let i = 0; i < 80; i++) {
    if (await state(fn, arg)) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`สถานะในระบบไม่เป็นไปตามที่คาด: ${what}`);
}
async function noOverflow(where) {
  const over = await page.evaluate(() => {
    const vw = window.innerWidth;
    if (document.documentElement.scrollWidth > vw + 1) return 'document ' + document.documentElement.scrollWidth;
    const card = document.querySelector('#dlg:not([hidden]) .dlg-card');
    if (card && card.getBoundingClientRect().right > vw + 1) return 'dialog ' + Math.round(card.getBoundingClientRect().right);
    return '';
  });
  assert(!over, `${where}: กว้างเกินจอ (${over})`);
}
/** The element is fully on screen horizontally (no sideways scrolling needed to reach it). */
async function onScreenX(sel, where) {
  const r = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { left: b.left, right: b.right, vw: window.innerWidth };
  }, sel);
  assert(r, `${where}: ไม่พบ ${sel}`);
  assert(r.left >= 0 && r.right <= r.vw + 1, `${where}: ${sel} อยู่นอกจอ (${Math.round(r.left)}–${Math.round(r.right)} / ${r.vw})`);
}
async function noImg(where) {
  assert(await page.locator('img[src="x"]').count() === 0, `${where}: ข้อความผู้ใช้กลายเป็น HTML`);
}
async function dlgOpen() {
  await page.waitForSelector('#dlg:not([hidden]) .dlg-card');
}
async function dlgSubmit() {
  await page.click('#dlg .dlg-f button[type="submit"]');
}
async function dlgClose() {
  await page.click('#dlg .dlg-h [data-dlg-close]');
  await dlgClosed();
}
async function dlgClosed() {
  await page.waitForSelector('#dlg[hidden]', { state: 'attached', timeout: 8000 })
    .catch(async () => { throw new Error(`หน้าต่างยังไม่ปิด: ${await page.locator('#dlg').innerText().catch(() => '')}`); });
}
async function dlgError(text) {
  await page.waitForFunction((x) => document.querySelector('#dlg-err') && document.querySelector('#dlg-err').innerText.indexOf(x) >= 0, text, { timeout: 5000 })
    .catch(async () => { throw new Error(`หน้าต่างควรบอก "${text}" ได้ "${await page.locator('#dlg-err').innerText().catch(() => '')}"`); });
}
async function clearToasts() {
  await page.evaluate(() => { document.querySelector('#toasts').innerHTML = ''; });
}
async function waitToast(text, timeout) {
  await page.waitForFunction((x) => document.querySelector('#toasts').innerText.indexOf(x) >= 0, text, { timeout: timeout || 6000 })
    .catch(async () => { throw new Error(`ไม่พบข้อความแจ้ง "${text}" ได้ "${await page.locator('#toasts').innerText().catch(() => '')}"`); });
}
async function typeLive(sel, value) {
  await page.fill(sel, String(value));
  await page.waitForTimeout(450);
}
async function tab(id) {
  await page.click(`#main .tabs button[data-arg="${id}"]`);
  await page.waitForSelector(`#main .tabs button.on[data-arg="${id}"]`);
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
    await page.evaluate(() => { const b = document.querySelector('#dlg'); if (b && !b.hidden) { const c = b.querySelector('.dlg-h [data-dlg-close]'); if (c) c.click(); } }).catch(() => {});
  }
}
const phone = () => page.setViewportSize({ width: 390, height: 844 });
const desktop = () => page.setViewportSize({ width: 1366, height: 900 });
const EVIL = '<img src=x onerror=alert(1)>';
const offcutsOf = (code) => state((s, R, c) => Object.values(s.tables.offcuts || {}).filter((o) => o.code === c).length, code);

// ---- a clean demo page ------------------------------------------------------------------------------------------------
await page.goto(file);
await ready();
await page.evaluate(() => localStorage.clear());
await page.reload();
await ready();

await step('setup', async () => {
  await must('warehouse.upsert', { code: 'P6RW', name: 'คลังรีวิวพีหก' });
  await must('bin.upsert', { wh: 'P6RW', code: 'P6R-OFF', name: 'แร็คเศษรีวิว' });
  await must('item.upsert', { code: 'P6R-PL6', name: 'แผ่นรีวิวพีหก หนา 6', baseUnit: 'แผ่น', type: 'RM', trackLot: 'none', material: 'P6R-MAT', thickness: 6,
    width: 1219, length: 2438, unitCost: 3000 });
  for (const [id, name, roles, extra] of [['P6RLEAD', 'หัวหน้าสโตร์รีวิว', ['store_lead']], ['P6RQCL', 'หัวหน้าQCรีวิว', ['qc_lead']],
    ['P6RACC', 'บัญชีรีวิว', ['accounting']], ['P6RDUAL', 'หัวหน้าสโตร์และบัญชีรีวิว', ['store_lead', 'accounting']], ['P6RVIEW', 'ผู้ดูรีวิว', ['viewer']],
    ['P6RPROD', 'ผลิตรีวิว', ['production'], { warehouses: ['P6RW'] }], ['P6RSTORE', 'สโตร์รีวิว ' + EVIL, ['store']]]) {
    await must('user.upsert', Object.assign({ id, name, roles }, extra || {}));
  }
  await must('doc.post', { type: 'AJ', remark: 'ยอดตั้งต้นรีวิวพีหก', lines: [{ code: 'P6R-PL6', qty: 2, wh: 'P6RW' }] });
  // a piece in another warehouse (the production user is limited to P6RW)
  await must('bin.upsert', { wh: 'P6RW', code: 'P6R-A1', name: 'ชั้นแผ่น' });
  const other = await state((s) => Object.values(s.tables.warehouses).find((w) => w.code !== 'P6RW' && w.active !== false && w.code !== 'TRANSIT'));
  const bins = await state((s, R, wh) => Object.values(s.tables.bins).filter((b) => b.wh === wh && b.active !== false).map((b) => b.code), other.code);
  await must('offcut.add', { code: 'P6R-PL6', width: 700, length: 800, wh: other.code, bin: bins[0] || '', createdFrom: 'P6R ชิ้นที่คลังอื่น' });
  await page.waitForFunction(() => document.querySelector('#who-sel') && Array.from(document.querySelector('#who-sel').options).some((o) => o.value === 'P6RSTORE'));
});

await step('reports: negative days / count fall back with a warning, reversed dates are named', async () => {
  await go('reports');
  await tab('nonMoving');
  const def = await state((s, R) => R.reports.nonMoving(s, {}).days);
  await typeLive('#rp-nonMoving-days', '-5');
  await waitText('จำนวนวันต้องเป็น 0 ขึ้นไป');
  const sub = await kpiSub('รายการค้างนาน');
  assert(sub && sub.indexOf(`${def} วันขึ้นไป`) >= 0 && sub.indexOf('-5') < 0, `ค่าติดลบต้องใช้ค่าตั้งต้น ${def} วัน: ${sub}`);
  const n = await state((s, R, d) => R.reports.nonMoving(s, { today: d }).totals.items, await page.evaluate(() => window.RRS.util.bkkDate(new Date().toISOString())));
  assert(await kpi('รายการค้างนาน') === String(n), `จำนวนรายการค้างนานต้องตรงกับค่าตั้งต้นของระบบ ${n}`);
  // letters cannot be typed into the number box: it stays empty and the default applies without a warning
  await page.fill('#rp-nonMoving-days', '');
  await page.locator('#rp-nonMoving-days').pressSequentially('abc');
  await page.waitForTimeout(450);
  assert(await page.$eval('#rp-nonMoving-days', (e) => e.value) === '', 'ช่องจำนวนวันต้องไม่รับตัวอักษร');
  await waitGone('จำนวนวันต้องเป็น 0 ขึ้นไป');
  await typeLive('#rp-nonMoving-days', '0');
  await waitGone('จำนวนวันต้องเป็น 0 ขึ้นไป');

  await tab('countAccuracy');
  await page.fill('#rp-countAccuracy-from', '2026-12-31');
  await page.dispatchEvent('#rp-countAccuracy-from', 'change');
  await page.waitForSelector('#rp-countAccuracy-to');
  await page.fill('#rp-countAccuracy-to', '2026-01-01');
  await page.dispatchEvent('#rp-countAccuracy-to', 'change');
  await waitText('อยู่หลังวันที่ "ถึง"');
  await page.click('#main .toolbar button[data-act="clear"]');
  await waitGone('อยู่หลังวันที่ "ถึง"');

  await tab('repeatIssues');
  await typeLive('#rp-repeatIssues-minCount', '1');
  await waitText('นับว่าเป็นปัญหาซ้ำได้ตั้งแต่ 2 ครั้งขึ้นไป');
  const sub2 = await kpiSub('ปัญหาซ้ำ');
  assert(sub2 && sub2.indexOf('2 ครั้งขึ้นไป') >= 0, `ต้องนับตาม 2 ครั้ง: ${sub2}`);
  await typeLive('#rp-repeatIssues-minCount', '3');
  await waitGone('นับว่าเป็นปัญหาซ้ำได้ตั้งแต่ 2 ครั้งขึ้นไป');
  await page.click('#main .toolbar button[data-act="clear"]');
});

await step('offcuts: no plate / letters / negative refused and nothing recorded; one-warehouse user', async () => {
  await asUser('P6RPROD');
  await go('offcuts');
  await page.click('#oc-new');
  await page.waitForSelector('#oc-reg-code');
  const whs = await page.$$eval('#oc-reg-wh option', (o) => o.map((x) => x.value).filter(Boolean));
  assert(whs.length === 1 && whs[0] === 'P6RW' && await page.$eval('#oc-reg-wh', (e) => e.value) === 'P6RW', `ผู้ใช้ที่จำกัดคลังต้องเลือกได้แค่ P6RW: ${whs}`);
  const before = await offcutsOf('P6R-PL6');
  await page.fill('#oc-reg-w', '300');
  await page.click('form[data-form="reg"] button[type="submit"]');
  await waitToast('เลือกแผ่นต้นทาง');
  assert(await page.$eval('#oc-reg-w', (e) => e.value) === '300', 'ค่าที่กรอกต้องไม่หายเมื่อยังไม่เลือกแผ่น');
  await page.selectOption('#oc-reg-code', 'P6R-PL6');
  await page.waitForFunction(() => document.querySelector('#oc-reg-mat').value === 'P6R-MAT');
  await page.fill('#oc-reg-w', '');
  await page.locator('#oc-reg-w').pressSequentially('abc');
  await page.fill('#oc-reg-l', '400');
  await clearToasts();
  await page.click('form[data-form="reg"] button[type="submit"]');
  await waitToast('ความกว้างต้องเป็นตัวเลขมากกว่า 0');
  await page.fill('#oc-reg-w', '-20');
  await clearToasts();
  await page.click('form[data-form="reg"] button[type="submit"]');
  await waitToast('ความกว้างต้องเป็นตัวเลขมากกว่า 0');
  assert(await offcutsOf('P6R-PL6') === before, 'บันทึกไม่ได้ต้องไม่มีเศษเกิดขึ้น');
  await page.fill('#oc-reg-w', '500');
  await page.fill('#oc-reg-l', '600');
  await page.selectOption('#oc-reg-bin', 'P6R-OFF');
  await page.fill('#oc-reg-remark', EVIL);
  await clearToasts();
  await page.click('form[data-form="reg"] button[type="submit"]');
  await waitToast('เขียนรหัสนี้บนชิ้นเศษ');
  await page.waitForSelector('#oc-detail');
  await waitIn('#oc-detail', EVIL);
  await noImg('offcut remark');
  // the piece in the other warehouse: no use / scrap buttons, the reason is named
  const otherId = await state((s) => Object.values(s.tables.offcuts).find((o) => o.createdFrom === 'P6R ชิ้นที่คลังอื่น').id);
  await page.click(`#oc-list tbody tr[data-arg="${otherId}"]`);
  await waitIn('#oc-detail', otherId);
  assert(await page.locator('#oc-use-btn').count() === 0 && await page.locator('#oc-scrap-btn').count() === 0, 'ผู้ใช้ที่ไม่มีสิทธิ์คลังนั้นต้องไม่เห็นปุ่มใช้/ทิ้ง');
  await waitIn('#oc-detail', 'ไม่มีสิทธิ์จัดการเศษในคลัง');
});

await step('offcuts: finder uses the chosen plate, drops an old selection, action on screen at 390 px', async () => {
  const mine = await state((s) => Object.values(s.tables.offcuts).find((o) => o.code === 'P6R-PL6' && o.width === 500).id);
  await go('offcuts');
  await tab('list');
  await page.click(`#oc-list tbody tr[data-arg="${mine}"]`);
  await page.waitForSelector('#oc-detail');
  await tab('find');
  assert(await page.locator('#oc-detail').count() === 1, 'ก่อนค้นหา ชิ้นที่เปิดไว้ยังแสดงได้');
  await page.fill('#oc-f-mat', 'ZZZ-ไม่มีวัสดุนี้');
  await page.fill('#oc-f-thk', '99');
  await page.fill('#oc-f-w', '200');
  await page.fill('#oc-f-l', '300');
  await page.selectOption('#oc-f-code', 'P6R-PL6');
  await page.click('form[data-form="find"] button[type="submit"]');
  await page.waitForSelector('#oc-fit tbody tr');
  await waitText('ตามแผ่น P6R-PL6');
  const ids = await page.$$eval('#oc-fit tbody tr', (trs) => trs.map((tr) => tr.children[1].innerText.trim()));
  const sug = await state((s, R) => R.reports.suggestOffcuts(s, { code: 'P6R-PL6', width: 200, length: 300, job: '' }).rows.map((r) => r.id));
  assert(JSON.stringify(ids) === JSON.stringify(sug) && ids.indexOf(mine) >= 0, `เลือกแผ่นแล้วต้องใช้วัสดุ/ความหนาของแผ่น: ${ids} / ${sug}`);
  assert(await page.locator('#oc-detail').count() === 0, 'ค้นหาใหม่แล้วชิ้นที่เปิดไว้ก่อนต้องไม่ค้างอยู่');
  await phone();
  await reopen('offcuts');
  await page.waitForSelector('#oc-fit tbody tr');
  await onScreenX(`#oc-fit tbody tr:first-child button[data-act="use"]`, 'ปุ่ม ใช้เศษนี้ ที่ 390 px');
  await noOverflow('offcuts find 390');
  await desktop();
  // "use" from the detail of the list does not take the job of an older search
  await page.fill('#oc-f-for', 'P6R งานจากการค้นหา');
  await page.click('form[data-form="find"] button[type="submit"]');
  await page.waitForSelector('#oc-fit tbody tr');
  await tab('list');
  await page.click(`#oc-list tbody tr[data-arg="${mine}"]`);
  await page.click('#oc-use-btn');
  await dlgOpen();
  assert(await page.$eval('#oc-use-for', (e) => e.value) === '', 'ใช้จากหน้าทะเบียนต้องไม่เติมงานจากการค้นหาครั้งก่อน');
  await dlgClose();
  await tab('find');
  await page.click(`#oc-fit button[data-act="use"][data-arg="${mine}"]`);
  await dlgOpen();
  assert(await page.$eval('#oc-use-for', (e) => e.value) === 'P6R งานจากการค้นหา', 'ใช้จากผลค้นหาต้องเติมงานที่กรอกไว้');
  await page.fill('#oc-use-for', EVIL);
  await dlgSubmit();
  await dlgClosed();
  await waitState((s, R, id) => s.tables.offcuts[id].status === 'USED' && s.tables.offcuts[id].usedFor === '<img src=x onerror=alert(1)>', mine, 'เศษถูกใช้กับงานที่พิมพ์');
  await waitIn('#oc-detail', EVIL);
  await noImg('offcut usedFor');
});

await step('uat: record button on screen at 390 px, empty id named first', async () => {
  await asUser('P6RLEAD');
  await phone();
  await reopen('uat');
  await tab('criteria');
  await page.locator('#uat-ph-1').scrollIntoViewIfNeeded();
  await onScreenX('#uat-ph-1 button[data-act="record"][data-arg="P1-3"]', 'ปุ่ม บันทึกผล ที่ 390 px');
  const fits = await page.$eval('#uat-ph-1 .tbl-wrap', (e) => e.scrollWidth <= e.clientWidth + 1);
  assert(fits, 'ตารางเกณฑ์ต้องไม่ต้องเลื่อนข้างที่ 390 px');
  await noOverflow('uat 390');
  await desktop();
  await page.click('#uat-add');
  await dlgOpen();
  await dlgSubmit();
  await dlgError('ใส่รหัสเกณฑ์');
  await dlgClose();
  // the merged column still shows who tested and the evidence
  await page.click('#main button[data-act="record"][data-arg="P3-2"]');
  await dlgOpen();
  await page.check('#dlg input[name="status"][value="PASS"]');
  await page.fill('#uat-evidence', 'P6R หลักฐาน ' + EVIL);
  await dlgSubmit();
  await dlgClosed();
  await waitState((s) => s.tables.uat['P3-2'] && s.tables.uat['P3-2'].status === 'PASS' && s.tables.uat['P3-2'].tester === 'P6RLEAD', null, 'P3-2 ผ่าน');
  const row = await rowCells('#uat-ph-3 tbody tr', 'P3-2');
  assert(row && row[1].indexOf('ผ่าน') >= 0 && row[2].indexOf('หัวหน้าสโตร์รีวิว') >= 0 && row[2].indexOf('P6R หลักฐาน ' + EVIL) >= 0, `แถว P3-2: ${row}`);
  await noImg('uat evidence');
});

await step('uat sign-off: empty, read-only users, reason required, one person per area, three areas accepted', async () => {
  await asUser('P6RVIEW');
  await go('uat');
  await tab('signoff');
  await waitText('ยังไม่มีการลงนาม');
  await waitText('ยอมรับแล้ว 0 จาก 3 ฝ่าย');
  assert(await page.locator('#uat-sign button[data-act="sign"]').count() === 0, 'ผู้ดูอย่างเดียวต้องไม่เห็นปุ่มลงนาม');
  await waitText('คุณดูผลได้อย่างเดียว');
  const admin = await state((s) => Object.values(s.tables.users).find((u) => u.roles.indexOf('admin') >= 0 && u.active !== false).id);
  await asUser(admin);
  assert(await page.locator('#uat-sign button[data-act="sign"]').count() === 0, 'ผู้ดูแลระบบที่ไม่มีบทบาทของฝ่ายต้องไม่เห็นปุ่มลงนาม');
  const chk = await state((s, R) => R.reports.dailyCheck(s).ok);
  assert(chk, 'ข้อมูลทดสอบต้องตรวจยอดผ่าน เพื่อให้ลงนามยอมรับได้');

  // store lead: no choice, REJECT without a reason, then ACCEPT with text that must stay text
  await asUser('P6RLEAD');
  assert(await page.locator('#uat-sign button[data-act="sign"]').count() === 1, 'หัวหน้าสโตร์ต้องลงนามได้เฉพาะฝ่ายสโตร์');
  await page.click('#uat-sign button[data-act="sign"][data-arg="store"]');
  await dlgOpen();
  await waitIn('#dlg', 'หัวหน้าสโตร์รีวิว (ระบบบันทึกให้)');
  await dlgSubmit();
  await dlgError('เลือกผล');
  await page.check('#dlg input[name="decision"][value="REJECT"]');
  await dlgSubmit();
  await dlgError('ไม่ยอมรับต้องระบุเหตุผล');
  assert(await state((s) => !Object.keys(s.tables.uat_signoffs || {}).length), 'บันทึกไม่ได้ต้องไม่มีการลงนาม');
  await page.check('#dlg input[name="decision"][value="ACCEPT"]');
  await page.fill('#sg-note', 'ยอดตรงกับนับจริง ' + EVIL);
  await dlgSubmit();
  await dlgClosed();
  await waitToast('ฝ่ายสโตร์ยอมรับแล้ว');
  await waitState((s) => Object.values(s.tables.uat_signoffs || {}).some((x) => x.area === 'store' && x.by === 'P6RLEAD' && x.decision === 'ACCEPT'), null, 'สโตร์ยอมรับโดย P6RLEAD');
  const sg = await state((s) => Object.values(s.tables.uat_signoffs)[0]);
  const row = await rowCells('#uat-sign tbody tr', 'สโตร์');
  assert(row && row[1].indexOf('ยอมรับ') >= 0 && row[2].indexOf('หัวหน้าสโตร์รีวิว') >= 0 && row[3].indexOf(new Intl.NumberFormat('th-TH').format(sg.seq)) >= 0 && row[4].indexOf('ยอดตรงกับนับจริง ' + EVIL) >= 0,
    `แถวสโตร์: ${row}`);
  await noImg('signoff note');
  await page.waitForFunction(() => /1\/3/.test(document.querySelector('#main .tabs button[data-arg="signoff"]').innerText));

  // one person (store lead + accounting) accepts the store area, then may not accept accounting as well
  await asUser('P6RDUAL');
  assert(await page.locator('#uat-sign button[data-act="sign"]').count() === 2, 'คนที่มีสองบทบาทต้องเห็นปุ่มของทั้งสองฝ่าย');
  await page.click('#uat-sign button[data-act="sign"][data-arg="store"]');
  await dlgOpen();
  await page.check('#dlg input[name="decision"][value="ACCEPT"]');
  await dlgSubmit();
  await dlgClosed();
  await waitState((s) => Object.values(s.tables.uat_signoffs).filter((x) => x.area === 'store').length === 2, null, 'สโตร์ลงนามใหม่โดย P6RDUAL');
  await waitIn('#uat-sign', 'คุณยอมรับฝ่ายสโตร์แล้ว');
  const n0 = await state((s) => Object.keys(s.tables.uat_signoffs).length);
  await page.click('#uat-sign button[data-act="sign"][data-arg="accounting"]');
  await dlgOpen();
  await page.check('#dlg input[name="decision"][value="ACCEPT"]');
  await dlgSubmit();
  await dlgError('ต้องเป็นคนละคน');
  assert(await state((s, R, n) => Object.keys(s.tables.uat_signoffs).length === n, n0), 'คนเดียวยอมรับสองฝ่ายต้องไม่ถูกบันทึก');
  await dlgClose();

  // QC lead and accounting: three different people – complete
  await asUser('P6RQCL');
  await page.click('#uat-sign button[data-act="sign"][data-arg="qc"]');
  await dlgOpen();
  await page.check('#dlg input[name="decision"][value="ACCEPT"]');
  await dlgSubmit();
  await dlgClosed();
  await asUser('P6RACC');
  await page.click('#uat-sign button[data-act="sign"][data-arg="accounting"]');
  await dlgOpen();
  await page.check('#dlg input[name="decision"][value="ACCEPT"]');
  await page.fill('#sg-note', 'ยอดตรงกับ Express ณ วันตัดยอด');
  await phone();
  await noOverflow('sign-off dialog 390');
  await desktop();
  await dlgSubmit();
  await dlgClosed();
  await waitText('สโตร์ QC และบัญชียอมรับครบแล้ว');
  const latest = await state((s) => {
    const out = {};
    for (const x of Object.values(s.tables.uat_signoffs)) if (!out[x.area] || x.at > out[x.area].at || (x.at === out[x.area].at && x.id > out[x.area].id)) out[x.area] = x;
    return { store: out.store.by, qc: out.qc.by, accounting: out.accounting.by, n: Object.keys(s.tables.uat_signoffs).length };
  });
  assert(latest.store === 'P6RDUAL' && latest.qc === 'P6RQCL' && latest.accounting === 'P6RACC', `ผู้ลงนามล่าสุดไม่ถูก: ${JSON.stringify(latest)}`);
  assert(await page.locator('#uat-sign-log tbody tr').count() === latest.n, 'ประวัติการลงนามต้องครบทุกครั้ง');
  await page.waitForFunction(() => /3\/3/.test(document.querySelector('#main .tabs button[data-arg="signoff"]').innerText));
  await phone();
  await reopen('uat');
  await noOverflow('uat sign-off 390');
  await shot('review-uat-signoff-phone');
  await desktop();
});

await step('backup: one verification is recorded once; a file name with HTML stays text', async () => {
  await asUser('P6RLEAD');
  await go('backup');
  assert(await page.locator('#bk-download').count() === 0, 'หัวหน้าสโตร์ต้องดาวน์โหลดไฟล์สำรองไม่ได้');
  await asUser('P6RACC');
  await page.click('#bk-download');
  await dlgOpen();
  const text = await page.$eval('#dlg textarea.copybox', (e) => e.value);
  await dlgSubmit();
  await dlgClosed();
  const f = path.join(tmp, `${EVIL}.json`);
  fs.writeFileSync(f, text);
  await page.setInputFiles('#bk-file', f);
  await page.click('form[data-form="verify"] button[type="submit"]');
  await waitIn('#bk-verify', 'ไฟล์นี้ใช้กู้ข้อมูลได้');
  await waitIn('#bk-verify', `${EVIL}.json`);
  await noImg('backup file name');
  const n0 = await state((s) => Object.keys(s.tables.backup_tests || {}).length);
  await page.click('#bk-record');
  await dlgOpen();
  await dlgSubmit();
  await dlgClosed();
  await waitState((s, R, n) => Object.keys(s.tables.backup_tests || {}).length === n + 1, n0, 'ผลทดสอบกู้คืน 1 รายการ');
  await waitIn('#bk-verify', 'บันทึกผลการตรวจครั้งนี้แล้ว');
  assert(await page.locator('#bk-record').count() === 0, 'บันทึกแล้วต้องไม่มีปุ่มบันทึกซ้ำของการตรวจเดิม');
  // a new verification can be recorded again
  await page.setInputFiles('#bk-file', f);
  await page.click('form[data-form="verify"] button[type="submit"]');
  await page.waitForSelector('#bk-record');
  await phone();
  await noOverflow('backup 390');
  await desktop();
});

await step('guide: system codes labelled, sign-off steps, training self / future refused', async () => {
  await asUser('P6RLEAD');
  await go('guide');
  await tab('problems');
  await waitText('รหัสในระบบ (สำหรับผู้ดูแล)');
  assert((await mainText()).indexOf('รหัสในข้อความ') < 0, 'ข้อความที่ผู้ใช้เห็นไม่มีรหัส – ต้องไม่บอกว่ารหัสอยู่ในข้อความ');
  await typeLive('#guide-q', 'หลายฝ่าย');
  await waitIn('#guide-problems', 'ผู้อนุมัติต้องเป็นคนอื่น');
  await tab('roles');
  await waitIn('#guide-store_lead', 'ลงนามยอมรับฝ่ายสโตร์');
  await waitIn('#guide-qc_lead', 'ลงนามยอมรับฝ่าย QC');
  await waitIn('#guide-accounting', 'ลงนามยอมรับฝ่ายบัญชี');
  // the store section lists people not trained yet: a name with HTML stays text
  await waitIn('#guide-store', 'สโตร์รีวิว ' + EVIL);
  await noImg('guide names');
  // training: the trainer is not in the list; a future date is refused and nothing is written
  await page.click('#guide-store_lead button[data-act="train"]');
  await dlgOpen();
  const people = await page.$$eval('#guide-train-user option', (o) => o.map((x) => x.value).filter(Boolean));
  assert(people.indexOf('P6RLEAD') < 0 && people.indexOf('P6RDUAL') >= 0, `ผู้อบรมต้องไม่อยู่ในรายชื่อผู้รับการอบรม: ${people}`);
  await page.selectOption('#guide-train-user', 'P6RDUAL');
  await page.fill('#dlg input[name="trainedOn"]', '2099-01-01');
  const t0 = await state((s) => Object.keys(s.tables.trainings || {}).length);
  await dlgSubmit();
  await dlgError('วันที่อบรมอยู่ในอนาคต');
  assert(await state((s, R, n) => Object.keys(s.tables.trainings || {}).length === n, t0), 'บันทึกไม่ได้ต้องไม่มีการอบรมเกิดขึ้น');
  await dlgClose();
  // the sign-off link opens the sign-off tab
  await page.click('#guide-store_lead a[data-go="uat"][data-view*="signoff"]');
  await page.waitForSelector('.page[data-page="uat"] .tabs button.on[data-arg="signoff"]');
});

await step('phone width: all five pages with data', async () => {
  await asUser('P6RACC');
  await phone();
  for (const id of ['reports', 'offcuts', 'uat', 'backup', 'guide']) {
    await reopen(id);
    await noOverflow(`${id} 390`);
    await noImg(`${id} 390`);
  }
  await desktop();
});

await browser.close();
if (problems.length) {
  console.log('PROBLEMS\n' + problems.join('\n'));
  process.exit(1);
}
console.log('p6-review ok');
