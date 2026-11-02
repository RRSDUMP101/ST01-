// Browser test of the Phase 6 screens: รายงาน (reports), เศษเหล็กใช้ซ้ำ (offcuts), ทดสอบรับงาน (UAT) (uat),
// สำรองและกู้คืน (backup) and คู่มือตามบทบาท (guide).
//   RRS_OUT=/tmp/stockqc-p6 node tests/e2e/p6.mjs [--shots dir]
// 1. empty states: the same page without the sample-data module (a copy of index.html without fixture.js) – every
//    screen and report tab says what will appear and how to add the first entry, also at phone width.
// 2. a clean demo page (sample data loaded), own master data (codes P6-…, warehouse P6W, users P6…) and the flows driven
//    through the UI: reports with filters / CSV / the daily check recorded by a store lead; offcuts registered from a plate
//    (wrong size and unknown heat refused, values kept), finder smallest-first with waste %, used with leftover pieces,
//    leftover added later, scrapped and undone, a quarantined heat left out; UAT results recorded (evidence required,
//    history kept, custom criterion), automatic checks run and shown apart from the people's results without touching
//    the data; backup downloaded, verified (same, older, tampered, not JSON), restore test recorded, the Google Drive
//    part in server mode (404 → ยังไม่ได้ตั้งค่า, status, run); the guide per role with working links, problems and a
//    training record; read-only users; user text never runs as code; many offcuts; phone width.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rrs-p6-'));

const problems = [];
let current = '';
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
page.on('console', (m) => {
  if (m.type() !== 'error' || /fonts\.g|cdnjs|ERR_|net::/.test(m.text())) return;
  if (/Google Drive part/.test(current) && /Failed to load resource/.test(m.text())) return; // the 404 / 409 answers of the fake server
  problems.push(`console (${current}): ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`pageerror (${current}): ${e.message}`));
// an alert/confirm/prompt means user text ran as code (or a page used a browser dialog instead of ctx.dialog)
page.on('dialog', async (d) => { problems.push(`browser dialog (${current}): ${d.type()} ${d.message()}`); await d.dismiss().catch(() => {}); });

// ---- helpers ------------------------------------------------------------------------------------------------
const ready = () => page.waitForFunction(() => window.RRS && window.RRS.app && window.RRS.app.loading === false && window.RRS.app.ledger, null, { timeout: 120000 });
async function exec(kind, payload, user) {
  return page.evaluate(async ([k, p, u]) => {
    const st = window.RRS.app.ledger.state;
    const admin = u || Object.values(st.tables.users || {}).find((x) => x.roles.indexOf('admin') >= 0 && x.active !== false).id;
    const r = await window.RRS.app.ledger.execute({ kind: k, payload: p }, { user: admin });
    return { ok: r.ok, errors: r.errors || [], result: r.result || {}, warnings: r.warnings || [] };
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
    .catch(async () => { throw new Error(`ไม่พบข้อความ "${text}" ในหน้า\n---\n${(await mainText()).slice(0, 2500)}`); });
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
const rowCells = (sel, text) => page.evaluate(([s, x]) => {
  const tr = Array.from(document.querySelectorAll(s)).find((r) => r.innerText.indexOf(x) >= 0);
  return tr ? Array.from(tr.children).map((td) => td.innerText.trim()) : null;
}, [sel, text]);
async function clickInRow(rowSel, text, sel) {
  const ok = await page.evaluate(([rs, x, s]) => {
    const tr = Array.from(document.querySelectorAll(rs)).find((r) => r.innerText.indexOf(x) >= 0);
    const el = tr && (s ? tr.querySelector(s) : tr);
    if (!el) return false;
    el.click();
    return true;
  }, [rowSel, text, sel || null]);
  assert(ok, `ไม่พบแถว "${text}"${sel ? ' / ' + sel : ''} ใน ${rowSel}`);
}
const state = (fn, arg) => page.evaluate(([src, a]) => (0, eval)(src)(window.RRS.app.ledger.state, window.RRS, a), [fn.toString(), arg === undefined ? null : arg]);
async function waitState(fn, arg, what) {
  for (let i = 0; i < 80; i++) {
    if (await state(fn, arg)) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`สถานะในระบบไม่เป็นไปตามที่คาด: ${what}`);
}
async function noOverflow(where) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert(!over, `${where}: หน้ากว้างเกินจอ`);
}
async function noBroken(where) {
  const t = await mainText();
  assert(!/หน้านี้แสดงไม่ได้|คำนวณรายงานไม่สำเร็จ/.test(t), `${where}: หน้าแสดงไม่ได้\n${t.slice(0, 600)}`);
}
async function dlgOpen() {
  await page.waitForSelector('#dlg:not([hidden]) .dlg-card');
}
async function dlgSubmit() {
  await page.click('#dlg .dlg-f button[type="submit"]');
}
async function dlgClosed() {
  await page.waitForSelector('#dlg[hidden]', { state: 'attached', timeout: 8000 })
    .catch(async () => { throw new Error(`หน้าต่างยังไม่ปิด: ${await page.locator('#dlg').innerText().catch(() => '')}`); });
}
async function dlgError(text) {
  await page.waitForFunction((x) => document.querySelector('#dlg-err') && document.querySelector('#dlg-err').innerText.indexOf(x) >= 0, text, { timeout: 5000 })
    .catch(async () => { throw new Error(`หน้าต่างควรบอก "${text}" ได้ "${await page.locator('#dlg-err').innerText().catch(() => '')}"`); });
}
async function waitToast(text, timeout) {
  await page.waitForFunction((x) => document.querySelector('#toasts').innerText.indexOf(x) >= 0, text, { timeout: timeout || 6000 })
    .catch(async () => { throw new Error(`ไม่พบข้อความแจ้ง "${text}" ได้ "${await page.locator('#toasts').innerText().catch(() => '')}"`); });
}
/** The text of a download when the page has no file-save capability (the copy dialog), then close it. */
async function copiedText() {
  await dlgOpen();
  await page.waitForSelector('#dlg textarea.copybox');
  const text = await page.$eval('#dlg textarea.copybox', (e) => e.value);
  await dlgSubmit();
  await dlgClosed();
  return text;
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
    await page.evaluate(() => { const b = document.querySelector('#dlg'); if (b && !b.hidden) { const c = b.querySelector('[data-dlg-close]'); if (c) c.click(); } }).catch(() => {});
  }
}

const EVIL = '<img src=x onerror=alert(1)>';
const PAGES = ['reports', 'offcuts', 'uat', 'backup', 'guide'];
const REPORT_TABS = ['stockByLocation', 'shortageExcess', 'nonMoving', 'aging', 'countAccuracy', 'qcPending', 'fpy', 'qcWait', 'repeatIssues', 'kpiActuals', 'dailyCheck'];

// ---- 1. empty states (no sample data) ----------------------------------------------------------------------------
const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
const noFixture = html.replace(/<script>\/\* src\/engine\/fixture\.js \*\/[\s\S]*?<\/script>/, '');
const emptyFile = path.join(tmp, 'index-p6-empty.html');
fs.writeFileSync(emptyFile, noFixture);

await step('empty states', async () => {
  await page.goto('file://' + emptyFile);
  await ready();
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await ready();
  const empty = await state((s) => !Object.keys(s.tables.balances || {}).length && !Object.keys(s.tables.offcuts || {}).length);
  assert(empty, 'หน้าที่ไม่มีข้อมูลตัวอย่างควรเริ่มว่าง');
  for (const vp of [{ width: 1366, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(vp);
    await reopen('reports');
    const want = { stockByLocation: 'ยังไม่มียอดคงเหลือ', shortageExcess: 'ยังไม่มีสินค้า', nonMoving: 'ไม่มีของค้างนาน', aging: 'ไม่มีของคงเหลือตามตัวกรอง',
      countAccuracy: 'ยังไม่มีรอบนับที่อนุมัติในช่วงนี้', qcPending: 'ไม่มีของรอ QC', fpy: 'ยังไม่มีผลตรวจครั้งแรกในช่วงนี้', qcWait: 'ยังไม่มีผลตรวจในช่วงนี้',
      repeatIssues: 'ยังไม่มี NCR ในช่วงนี้', kpiActuals: 'ยังวัดไม่ได้', dailyCheck: 'ยังไม่เคยบันทึกผลตรวจประจำวัน' };
    for (const t of REPORT_TABS) {
      await tab(t);
      await waitText(want[t]);
      await noBroken(`reports/${t}`);
      await noOverflow(`reports/${t} ว่าง ${vp.width}`);
    }
    await tab('dailyCheck');
    await waitText('ผ่านทุกหัวข้อ');
    await reopen('offcuts');
    await tab('list');
    await waitText('ยังไม่มีเศษเหล็กในทะเบียน');
    await page.click('#oc-new');
    await waitText('ยังไม่มีแผ่นเหล็กในทะเบียนสินค้า');
    await page.click('#main button[data-act="cancelReg"]');
    await tab('find');
    await waitText('กรอกขนาดชิ้นที่ต้องตัด');
    await noOverflow(`offcuts ว่าง ${vp.width}`);
    await reopen('uat');
    await waitText('ยังไม่มีผลทดสอบที่บันทึก');
    assert(await kpi('เกณฑ์ทั้งหมด') === '33', `เกณฑ์ทั้งหมด ควรเป็น 33 ได้ ${await kpi('เกณฑ์ทั้งหมด')}`);
    await noOverflow(`uat ว่าง ${vp.width}`);
    await reopen('backup');
    await waitText('ยังไม่เคยบันทึกผลทดสอบกู้คืน');
    await waitText('ยังไม่ได้ตรวจไฟล์');
    await waitText('ยังไม่ได้เชื่อมเซิร์ฟเวอร์');
    await noOverflow(`backup ว่าง ${vp.width}`);
    await reopen('guide');
    assert(await page.locator('#main section.sec[id^="guide-"]').count() === 11, 'คู่มือต้องมี 11 บทบาท');
    await noOverflow(`guide ว่าง ${vp.width}`);
    if (vp.width === 390) await shot('empty-phone-offcuts');
  }
  await page.setViewportSize({ width: 1366, height: 900 });
});

// ---- 2. a clean demo page with the sample data -----------------------------------------------------------------------
await page.goto(file);
await ready();
await page.evaluate(() => localStorage.clear());
await page.reload();
await ready();
const today = await page.evaluate(() => window.RRS.util.bkkDate(new Date().toISOString()));
const ids = {};

await step('setup', async () => {
  await must('warehouse.upsert', { code: 'P6W', name: 'คลังทดสอบพีหก' });
  await must('bin.upsert', { wh: 'P6W', code: 'P6-A1', name: 'ชั้นแผ่นเหล็ก' });
  await must('bin.upsert', { wh: 'P6W', code: 'P6-OFF', name: 'แร็คเศษ' });
  await must('item.upsert', { code: 'P6-PL10', name: 'แผ่นเหล็กทดสอบพีหก หนา 10', baseUnit: 'แผ่น', type: 'RM', trackLot: 'heat', material: 'P6-MAT', thickness: 10,
    width: 1500, length: 3000, unitCost: 5000 });
  await must('item.upsert', { code: 'P6-PART', name: 'ชิ้นส่วนทดสอบพีหก', baseUnit: 'ชิ้น', type: 'PART', minQty: 20, unitCost: 100 });
  for (const [id, name, roles, extra] of [['P6STORE', 'สโตร์พีหก', ['store']], ['P6LEAD', 'หัวหน้าสโตร์พีหก', ['store_lead']], ['P6QCL', 'หัวหน้าQCพีหก', ['qc_lead']],
    ['P6ACC', 'บัญชีพีหก', ['accounting']], ['P6VIEW', 'ผู้ดูพีหก', ['viewer']], ['P6PROD', 'ผลิตพีหก', ['production']],
    ['P6SRV', 'บัญชีเซิร์ฟเวอร์พีหก', ['accounting'], { accountId: 'p6-srv' }]]) {
    await must('user.upsert', Object.assign({ id, name, roles }, extra || {}));
  }
  await must('doc.post', { type: 'AJ', remark: 'ยอดตั้งต้นทดสอบพีหก', lines: [
    { code: 'P6-PL10', qty: 3, wh: 'P6W', bin: 'P6-A1', lot: 'P6-H1' }, { code: 'P6-PL10', qty: 1, wh: 'P6W', bin: 'P6-A1', lot: 'P6-H2' },
    { code: 'P6-PART', qty: 5, wh: 'P6W', bin: 'P6-A1' }] });
  await page.waitForFunction(() => document.querySelector('#who-sel') && Array.from(document.querySelector('#who-sel').options).some((o) => o.value === 'P6SRV'));
});

await step('reports: stock by location, filters, value note and CSV', async () => {
  await go('reports');
  await tab('stockByLocation');
  await page.selectOption('#rp-stockByLocation-wh', 'P6W');
  await page.waitForFunction(() => document.querySelectorAll('#rp-list tbody tr').length === 3);
  assert(await kpi('มูลค่าอ้างอิงรวม') === '20,500.00', `มูลค่าอ้างอิงรวม ควรเป็น 20,500.00 ได้ ${await kpi('มูลค่าอ้างอิงรวม')}`);
  await waitText('ไม่ใช่มูลค่าทางบัญชี');
  await waitText('ข้อตกลงกับบัญชี');
  const h1 = await rowCells('#rp-list tbody tr', 'P6-H1');
  assert(h1 && h1.indexOf('15,000.00') >= 0 && h1.indexOf('ใช้ได้') >= 0, `แถว P6-H1 ควรมีมูลค่า 15,000.00 และสถานะใช้ได้: ${h1}`);
  await typeLive('#rp-stockByLocation-q', 'P6-PART');
  await page.waitForFunction(() => document.querySelectorAll('#rp-list tbody tr').length === 1);
  assert(await kpi('มูลค่าอ้างอิงรวม') === '500.00', 'ค้นหาแล้วมูลค่ารวมต้องตามตัวกรอง');
  await page.click('#main .toolbar button[data-act="csv"]');
  const csv = await copiedText();
  assert(csv.charCodeAt(0) === 0xfeff, 'CSV ต้องขึ้นต้นด้วย BOM');
  assert(/^﻿คลัง,ช่องเก็บ,รหัสสินค้า/.test(csv) && csv.indexOf('P6-PART') > 0 && csv.indexOf('P6-PL10') < 0, `CSV ต้องตามตัวกรอง: ${csv.slice(0, 200)}`);
  await page.click('#main .toolbar button[data-act="clear"]');
  await page.waitForFunction(() => document.querySelectorAll('#rp-list tbody tr').length > 3);
  await shot('reports-stock');
});

await step('reports: shortage, non-moving, aging and the QC / KPI tabs match the engine', async () => {
  await go('reports');
  await tab('shortageExcess');
  await typeLive('#rp-shortageExcess-q', 'P6-PART');
  const row = await rowCells('#rp-list tbody tr', 'P6-PART');
  assert(row && row.indexOf('ต่ำกว่า Min') >= 0, `P6-PART ควรเป็น ต่ำกว่า Min: ${row}`);
  const se = await state((s, R) => R.reports.shortageExcess(s, { onlyProblems: true }).totals);
  assert(await kpi('ต่ำกว่า Min') === String(se.belowMin) && await kpi('ขาด') === String(se.short), 'ตัวเลขของขาด/ต่ำกว่า Min ต้องตรงกับระบบ');

  await tab('nonMoving');
  await typeLive('#rp-nonMoving-days', '0');
  await waitIn('#rp-list', 'P6-PART');
  await typeLive('#rp-nonMoving-days', '99999');
  await waitText('ไม่มีของค้างนาน 99,999 วันขึ้นไป');
  await typeLive('#rp-nonMoving-days', '');

  await tab('aging');
  const ag = await state((s, R, d) => R.reports.aging(s, { today: d }).totals.buckets['0-30'].rows, today);
  assert(await kpi('อายุ 0-30 วัน') === String(ag), `อายุ 0-30 วัน ควรเป็น ${ag}`);
  await page.selectOption('#rp-aging-wh', 'P6W');
  await page.waitForFunction(() => document.querySelectorAll('#rp-list tbody tr').length === 3);

  await tab('qcPending');
  const qp = await state((s, R, d) => R.reports.qcPending(s, { today: d }).totals, today);
  assert(await kpi('รอตรวจ') === String(qp.qcHold) && await kpi('NCR ที่ยังไม่ปิด') === String(qp.openNcrs), 'งานรอ QC ต้องตรงกับระบบ');
  await tab('fpy');
  const fp = await state((s, R) => R.reports.fpy(s, {}).totals.fpy);
  const fpyText = await kpi('ผ่าน QC ครั้งแรก (FPY)');
  assert(fp == null ? fpyText === 'ยังวัดไม่ได้' : fpyText.indexOf('%') > 0, `FPY ไม่ตรง: ${fpyText} / ${fp}`);
  for (const t of ['countAccuracy', 'qcWait', 'repeatIssues', 'kpiActuals']) {
    await tab(t);
    await noBroken(t);
  }
  await tab('kpiActuals');
  await waitText('ค่าก่อนเริ่มและเป้าหมายมาจากที่ตกลงใน Phase 0');
  await page.click('#main .toolbar button[data-act="csv"]');
  const csv = await copiedText();
  assert(csv.indexOf('ตัวชี้วัด') > 0 && csv.indexOf('ความแม่นยำการนับ') > 0, 'CSV ตัวชี้วัดต้องมีหัวตารางและรายการ');
});

await step('reports: daily check summary and record (store lead), viewer cannot record', async () => {
  await asUser('P6VIEW');
  await go('reports');
  await tab('dailyCheck');
  const chk = await state((s, R) => R.reports.dailyCheck(s));
  await waitText(chk.ok ? 'ผ่านทุกหัวข้อ' : `พบปัญหา ${chk.problems.length} ข้อ`);
  assert(await page.locator('#rp-record-check').count() === 0, 'ผู้ดูอย่างเดียวต้องไม่เห็นปุ่มบันทึกผลตรวจ');
  const rows = await page.locator('#main section.sec').first().locator('tbody tr').count();
  assert(rows === chk.checks.length, `หัวข้อตรวจ ${rows} ไม่ตรงกับระบบ ${chk.checks.length}`);
  await asUser('P6LEAD');
  await page.click('#rp-record-check');
  await dlgOpen();
  await page.fill('#rp-check-note', 'P6 ตรวจหลังปิดงาน');
  await dlgSubmit();
  await dlgClosed();
  await waitState((s) => Object.values(s.tables.daily_checks || {}).some((d) => d.by === 'P6LEAD' && d.note === 'P6 ตรวจหลังปิดงาน'), null, 'ผลตรวจประจำวันของ P6LEAD');
  await waitText('วันนี้บันทึกแล้ว');
  await waitToast('บันทึกผลตรวจ DC-');
});

await step('offcuts: register from a plate (wrong size and unknown heat refused, values kept)', async () => {
  await asUser('P6VIEW');
  await go('offcuts');
  assert(await page.locator('#oc-new').count() === 0, 'ผู้ดูอย่างเดียวต้องไม่เห็นปุ่มบันทึกเศษ');
  await asUser('P6PROD');
  await page.click('#oc-new');
  await page.waitForSelector('#oc-reg-code');
  await page.selectOption('#oc-reg-code', 'P6-PL10');
  await page.waitForFunction(() => document.querySelector('#oc-reg-mat') && document.querySelector('#oc-reg-mat').value === 'P6-MAT');
  assert(await page.$eval('#oc-reg-thk', (e) => e.value) === '10' && await page.$eval('#oc-reg-mat', (e) => e.readOnly), 'วัสดุ/ความหนาต้องมาจากแผ่นและแก้ไม่ได้');
  await page.selectOption('#oc-reg-wh', 'P6W');
  await page.waitForFunction(() => document.querySelector('#oc-reg-bin option[value="P6-OFF"]'));
  await page.selectOption('#oc-reg-bin', 'P6-OFF');
  await page.fill('#oc-reg-w', '2000');
  await page.fill('#oc-reg-l', '4000');
  await page.fill('#oc-reg-lot', 'P6-H1');
  await page.fill('#oc-reg-from', 'P6 ตัดงานทดสอบ');
  await page.click('form[data-form="reg"] button[type="submit"]');
  await waitToast('ใหญ่กว่าแผ่น P6-PL10');
  assert(await page.$eval('#oc-reg-w', (e) => e.value) === '2000' && await page.$eval('#oc-reg-bin', (e) => e.value) === 'P6-OFF', 'ค่าที่กรอกต้องไม่หายเมื่อบันทึกไม่ได้');
  await page.fill('#oc-reg-w', '800');
  await page.fill('#oc-reg-l', '1200');
  await page.fill('#oc-reg-lot', 'P6-NOPE');
  await page.click('form[data-form="reg"] button[type="submit"]');
  await waitToast('P6-NOPE');
  assert(await state((s) => !Object.values(s.tables.offcuts || {}).some((o) => o.code === 'P6-PL10')), 'บันทึกไม่ได้ต้องไม่มีเศษเกิดขึ้น');
  await page.fill('#oc-reg-lot', 'P6-H1');
  await page.click('form[data-form="reg"] button[type="submit"]');
  await waitToast('เขียนรหัสนี้บนชิ้นเศษ');
  await waitState((s) => Object.values(s.tables.offcuts || {}).some((o) => o.code === 'P6-PL10' && o.width === 800), null, 'บันทึกเศษ 800 × 1200');
  ids.ocA = await state((s) => (Object.values(s.tables.offcuts || {}).find((o) => o.code === 'P6-PL10' && o.width === 800) || {}).id);
  assert(ids.ocA, 'ต้องมีเศษ 800 × 1200');
  const a = await state((s, R, id) => s.tables.offcuts[id], ids.ocA);
  assert(a.status === 'AVAILABLE' && a.wh === 'P6W' && a.bin === 'P6-OFF' && a.sourceLot === 'P6-H1' && a.createdBy === 'P6PROD' && a.material === 'P6-MAT' && a.thickness === 10,
    `ข้อมูลเศษไม่ถูก: ${JSON.stringify(a)}`);
  await page.waitForSelector('#oc-detail');
  assert((await page.$eval('#oc-detail .tag', (e) => e.innerText.trim())) === ids.ocA, 'ป้ายต้องแสดงรหัสเศษ');
  // a second piece from the other heat, with text that must stay text
  await page.click('#oc-new');
  await page.waitForSelector('#oc-reg-code');
  await page.selectOption('#oc-reg-code', 'P6-PL10');
  await page.waitForFunction(() => document.querySelector('#oc-reg-mat').value === 'P6-MAT');
  await page.selectOption('#oc-reg-wh', 'P6W');
  await page.waitForFunction(() => document.querySelector('#oc-reg-bin option[value="P6-OFF"]'));
  await page.selectOption('#oc-reg-bin', 'P6-OFF');
  await page.fill('#oc-reg-w', '400');
  await page.fill('#oc-reg-l', '500');
  await page.fill('#oc-reg-lot', 'P6-H2');
  await page.fill('#oc-reg-from', EVIL);
  await page.click('form[data-form="reg"] button[type="submit"]');
  await waitToast('เขียนรหัสนี้บนชิ้นเศษ');
  // the toast of the first piece may still be on screen: wait for the record itself
  await waitState((s) => Object.values(s.tables.offcuts || {}).some((o) => o.code === 'P6-PL10' && o.width === 400), null, 'บันทึกเศษ 400 × 500');
  ids.ocB = await state((s) => (Object.values(s.tables.offcuts || {}).find((o) => o.code === 'P6-PL10' && o.width === 400) || {}).id);
  assert(ids.ocB, 'ต้องมีเศษ 400 × 500');
  await waitIn('#oc-detail', EVIL);
  assert(await page.locator('#main img[src="x"]').count() === 0, 'ข้อความผู้ใช้ต้องไม่กลายเป็น HTML');
  await typeLive('#oc-q', 'P6-PL10');
  await page.waitForFunction(() => document.querySelectorAll('#oc-list tbody tr').length === 2);
  await page.click('#main .toolbar button[data-act="csv"]');
  const csv = await copiedText();
  assert(csv.indexOf('รหัสเศษ (QR)') > 0 && csv.indexOf(ids.ocA) > 0 && csv.indexOf(ids.ocB) > 0, 'CSV ทะเบียนเศษต้องมีรหัสเศษ');
  await page.click('#oc-tags');
  await page.waitForFunction((x) => Array.from(document.querySelectorAll('#main .steps .tag')).some((e) => e.innerText.trim() === x), ids.ocA); // the open detail is ocB
  await page.click('#oc-tags');
  await shot('offcuts-list');
});

await step('offcuts: find smallest first with waste %, use with leftover pieces', async () => {
  await go('offcuts');
  await tab('find');
  await page.fill('#oc-f-mat', 'P6-MAT');
  await page.fill('#oc-f-thk', '10');
  await page.fill('#oc-f-w', '350');
  await page.fill('#oc-f-l', '450');
  await page.fill('#oc-f-for', 'P6 งานทดสอบ');
  await page.click('form[data-form="find"] button[type="submit"]');
  await page.waitForSelector('#oc-fit tbody tr');
  const sug = await state((s, R) => R.reports.suggestOffcuts(s, { material: 'P6-MAT', thickness: 10, width: 350, length: 450 }));
  assert(sug.rows.length === 2 && sug.rows[0].id === ids.ocB && sug.rows[1].id === ids.ocA, `ระบบควรแนะนำ ${ids.ocB} ก่อน ${ids.ocA}: ${sug.rows.map((r) => r.id)}`);
  const first = await page.$$eval('#oc-fit tbody tr', (trs) => trs.map((tr) => Array.from(tr.children).map((td) => td.innerText.trim())));
  assert(first[0][1] === ids.ocB && first[1][1] === ids.ocA, `ตารางต้องเรียงเล็กสุดก่อน: ${first.map((r) => r[1])}`);
  const waste = await page.evaluate((n) => new Intl.NumberFormat('th-TH', { maximumFractionDigits: 1 }).format(n), sug.rows[0].wastePct);
  assert(first[0][4] === waste, `เศษทิ้ง % ต้องตรงกับระบบ ${waste} ได้ ${first[0][4]}`);
  await waitText(`ใช้เศษ ${ids.ocB} ก่อนแผ่นใหม่`);
  // rotation
  await page.fill('#oc-f-w', '1100');
  await page.fill('#oc-f-l', '700');
  await page.click('form[data-form="find"] button[type="submit"]');
  await page.waitForFunction(() => document.querySelectorAll('#oc-fit tbody tr').length === 1);
  await waitIn('#oc-fit', 'หมุน 90°');
  // use the big piece: a leftover bigger than the piece is refused in the dialog, then two leftovers
  await clickInRow('#oc-fit tbody tr', ids.ocA, 'button[data-act="use"]');
  await dlgOpen();
  assert(await page.$eval('#oc-use-for', (e) => e.value) === 'P6 งานทดสอบ', 'ใช้กับงาน ต้องเติมจากที่กรอกตอนหา');
  await page.click('#dlg button[data-act="pieceAdd"]');
  await page.waitForFunction(() => document.querySelector('#dlg input[name="pieces[1][width]"]'));
  assert(await page.$eval('#oc-use-for', (e) => e.value) === 'P6 งานทดสอบ', 'เพิ่มบรรทัดแล้วค่าที่กรอกต้องไม่หาย');
  await page.fill('#dlg input[name="pieces[0][width]"]', '900');
  await page.fill('#dlg input[name="pieces[0][length]"]', '1300');
  await dlgSubmit();
  await dlgError('ใหญ่กว่าเศษ');
  await page.fill('#dlg input[name="pieces[0][width]"]', '300');
  await page.fill('#dlg input[name="pieces[0][length]"]', '400');
  await page.selectOption('#dlg select[name="pieces[0][bin]"]', 'P6-OFF');
  await page.fill('#dlg input[name="pieces[1][width]"]', '200');
  await page.fill('#dlg input[name="pieces[1][length]"]', '200');
  await dlgSubmit();
  await dlgClosed();
  await waitToast('เขียนรหัสใหม่บนชิ้นที่เหลือ');
  const a = await state((s, R, id) => s.tables.offcuts[id], ids.ocA);
  assert(a.status === 'USED' && a.usedFor === 'P6 งานทดสอบ' && a.usedBy === 'P6PROD' && a.children.length === 2, `เศษที่ใช้ไม่ถูก: ${JSON.stringify(a)}`);
  ids.kids = a.children;
  const kids = await state((s, R, list) => list.map((k) => s.tables.offcuts[k]), a.children);
  assert(kids.every((k) => k.status === 'AVAILABLE' && k.parent === ids.ocA && k.sourceLot === 'P6-H1' && k.wh === 'P6W'), 'ชิ้นที่เหลือต้องพร้อมใช้และอ้างเศษเดิม');
  await page.waitForSelector('#oc-detail');
  await waitIn('#oc-detail', 'ใช้กับ');
  for (const k of a.children) await waitIn('#oc-detail', k);
});

await step('offcuts: leftover added later, scrap and undo', async () => {
  await page.click('#oc-child-btn');
  await page.waitForSelector('#oc-reg-code-ro');
  assert(await page.$eval('#oc-reg-code-ro', (e) => e.value) === 'P6-PL10' && await page.$eval('#oc-reg-lot', (e) => e.value) === 'P6-H1', 'ชิ้นที่เหลือต้องตามเศษต้นทาง');
  await page.fill('#oc-reg-w', '100');
  await page.fill('#oc-reg-l', '100');
  await page.click('form[data-form="reg"] button[type="submit"]');
  await waitToast('เขียนรหัสนี้บนชิ้นเศษ');
  await waitState((s, R, id) => s.tables.offcuts[id].children.length === 3, ids.ocA, 'เศษต้นทางมีชิ้นที่เหลือ 3 ชิ้น');
  const later = await state((s, R, id) => s.tables.offcuts[id].children[2], ids.ocA);
  ids.kids.push(later);
  assert(await state((s, R, x) => s.tables.offcuts[x[0]].parent === x[1], [later, ids.ocA]), 'ชิ้นที่บันทึกภายหลังต้องอ้างเศษต้นทาง');
  // scrap the small piece (a reason is required), then undo it
  await tab('list');
  await clickInRow('#oc-list tbody tr', ids.ocB);
  await page.waitForSelector('#oc-scrap-btn');
  await page.click('#oc-scrap-btn');
  await dlgOpen();
  await dlgSubmit();
  await dlgError('ระบุเหตุผลที่ทิ้ง');
  await page.fill('#oc-scrap-reason', 'P6 ขอบเสียหาย');
  await dlgSubmit();
  await dlgClosed();
  await waitState((s, R, id) => s.tables.offcuts[id].status === 'SCRAPPED' && s.tables.offcuts[id].scrapReason === 'P6 ขอบเสียหาย', ids.ocB, 'เศษถูกทิ้ง');
  await waitIn('#oc-detail', 'ทิ้งเพราะ');
  await page.click('#oc-undo-btn');
  await dlgOpen();
  await page.fill('#oc-undo-reason', 'P6 เลือกผิดชิ้น');
  await dlgSubmit();
  await dlgClosed();
  await waitState((s, R, id) => s.tables.offcuts[id].status === 'AVAILABLE', ids.ocB, 'ยกเลิกการทิ้งแล้วกลับเป็นพร้อมใช้');
  await waitIn('#oc-detail', 'ยกเลิกการทิ้ง');
});

await step('offcuts: a quarantined heat is never offered', async () => {
  await must('lot.quarantine', { code: 'P6-PL10', lot: 'P6-H1', reason: 'P6 สงสัยใบรับรอง' }, 'P6QCL');
  await go('offcuts');
  await tab('find');
  await page.fill('#oc-f-mat', 'P6-MAT');
  await page.fill('#oc-f-thk', '10');
  await page.fill('#oc-f-w', '150');
  await page.fill('#oc-f-l', '150');
  await page.click('form[data-form="find"] button[type="submit"]');
  await waitText('ไม่แนะนำเพราะล็อตต้นทางถูกกักกัน');
  const shown = await page.$$eval('#oc-fit tbody tr', (trs) => trs.map((tr) => tr.children[1].innerText.trim()));
  assert(shown.length === 1 && shown[0] === ids.ocB, `ต้องแนะนำเฉพาะเศษจาก Heat ที่ไม่ถูกกักกัน ได้ ${shown}`);
  // the leftovers of the quarantined heat that would fit (300 × 400, 200 × 200) are named as left out; 100 × 100 does not fit
  await waitText(ids.kids[0]);
  await waitText(ids.kids[1]);
  await noOverflow('offcuts find');
});

await step('uat: viewer read-only; record with evidence, history, custom criterion', async () => {
  await asUser('P6VIEW');
  await go('uat');
  assert(await page.locator('#main button[data-act="record"]').count() === 0, 'ผู้ดูอย่างเดียวต้องไม่เห็นปุ่มบันทึกผล');
  await waitText('คุณดูผลได้อย่างเดียว');
  await asUser('P6LEAD');
  await page.click('#main button[data-act="record"][data-arg="P4-3"]');
  await dlgOpen();
  await waitIn('#dlg', 'หัวหน้าสโตร์พีหก (ระบบบันทึกให้)');
  await dlgSubmit();
  await dlgError('เลือกผลการทดสอบ');
  await page.check('#dlg input[name="status"][value="PASS"]');
  await dlgSubmit();
  await dlgError('หลักฐาน');
  await page.fill('#uat-evidence', 'P6-ทดสอบ PO รับบางส่วน');
  await dlgSubmit();
  await dlgClosed();
  await waitState((s, R, d) => { const u = (s.tables.uat || {})['P4-3']; return u && u.status === 'PASS' && u.tester === 'P6LEAD' && u.testedOn === d; }, today, 'P4-3 ผ่านโดย P6LEAD วันนี้');
  const row = await rowCells('#uat-ph-4 tbody tr', 'P4-3');
  assert(row && row[0].indexOf('P4-3') >= 0 && row[1].indexOf('ผ่าน') >= 0 && row[2].indexOf('หัวหน้าสโตร์พีหก') >= 0 && row[2].indexOf('P6-ทดสอบ PO รับบางส่วน') >= 0, `แถว P4-3: ${row}`);
  const bp = await state((s, R) => R.reports.uatSummary(s).byPhase[4]);
  const meter = await page.$eval('#uat-ph-4 .meter', (e) => Number(e.getAttribute('aria-valuenow')));
  assert(meter === Math.round((bp.PASS / bp.total) * 100), `ความคืบหน้า Phase 4 ${meter} ไม่ตรง ${bp.PASS}/${bp.total}`);
  // a failed retest keeps the earlier result in the history
  await page.click('#main button[data-act="record"][data-arg="P4-3"]');
  await dlgOpen();
  await page.check('#dlg input[name="status"][value="FAIL"]');
  await page.fill('#uat-note', EVIL);
  await dlgSubmit();
  await dlgClosed();
  await waitState((s) => s.tables.uat['P4-3'].status === 'FAIL' && s.tables.uat['P4-3'].history.length === 1, null, 'P4-3 ไม่ผ่านและเก็บผลเดิม');
  await page.click('#main button[data-act="history"][data-arg="P4-3"]');
  await dlgOpen();
  await waitIn('#dlg', 'P6-ทดสอบ PO รับบางส่วน');
  await waitIn('#dlg', EVIL);
  assert(await page.locator('#dlg img[src="x"]').count() === 0, 'หมายเหตุต้องไม่กลายเป็น HTML');
  await dlgSubmit();
  await dlgClosed();
  // custom criterion
  await page.click('#uat-add');
  await dlgOpen();
  await page.fill('#uat-new-id', 'P6-X1');
  await page.selectOption('#uat-new-phase', '6');
  await page.fill('#uat-new-text', 'P6 เกณฑ์เพิ่มทดสอบ');
  await dlgSubmit();
  await dlgClosed();
  await waitState((s) => { const u = (s.tables.uat || {})['P6-X1']; return u && u.phase === 6 && u.status === 'NOT_RUN'; }, null, 'เกณฑ์เพิ่ม P6-X1');
  await waitIn('#uat-ph-6', 'P6 เกณฑ์เพิ่มทดสอบ');
  await waitIn('#uat-ph-6', 'เกณฑ์เพิ่ม');
  await page.click('#uat-add');
  await dlgOpen();
  await page.fill('#uat-new-id', 'P6-X1');
  await page.selectOption('#uat-new-phase', '6');
  await page.fill('#uat-new-text', 'ซ้ำ');
  await dlgSubmit();
  await dlgError('มีเกณฑ์ P6-X1 แล้ว');
  await page.click('#dlg .dlg-h [data-dlg-close]');
  await dlgClosed();
  await page.selectOption('#uat-phase', '4');
  await page.waitForFunction(() => document.querySelectorAll('#main section.sec[id^="uat-ph-"]').length === 1);
  await page.click('#main .toolbar button[data-act="csv"]');
  const csv = await copiedText();
  assert(csv.indexOf('P4-3') > 0 && csv.indexOf('P1-1') < 0 && csv.indexOf('ไม่ผ่าน') > 0, 'CSV UAT ต้องตามตัวกรอง');
  await page.click('#main .toolbar button[data-act="clear"]');
});

await step('uat: automatic checks shown apart and never written as UAT results', async () => {
  const before = await state((s) => ({ seq: s.seq, uat: JSON.stringify(s.tables.uat || {}) }));
  const has = await page.evaluate(() => !!(window.RRS.selftest && window.RRS.selftest.run));
  await go('uat');
  if (!has) {
    assert(await page.isDisabled('#uat-run'), 'ไม่มีชุดตรวจอัตโนมัติ ปุ่มต้องกดไม่ได้');
    return;
  }
  await waitIn('#uat-auto', 'ไม่ใช่การยอมรับของผู้ใช้');
  await page.click('#uat-run');
  await waitIn('#uat-auto', 'รันเมื่อ', 300000);
  const after = await state((s) => ({ seq: s.seq, uat: JSON.stringify(s.tables.uat || {}) }));
  assert(after.seq === before.seq && after.uat === before.uat, 'ตรวจอัตโนมัติต้องไม่เปลี่ยนข้อมูลหรือผล UAT');
  await waitText('ตรวจอัตโนมัติ (ข้อมูลทดสอบ)');
  const note = await page.locator('#uat-auto').innerText();
  const m = /ผ่าน (\d+) · ไม่ผ่าน (\d+)/.exec(note);
  assert(m, `สรุปผลอัตโนมัติไม่ครบ: ${note}`);
  const badges = await page.$$eval('#main section.sec[id^="uat-ph-"] .badge', (bs) => bs.map((b) => b.innerText.trim()));
  assert(badges.filter((b) => b === 'อัตโนมัติ: ผ่าน').length === Number(m[1]), `จำนวน อัตโนมัติ: ผ่าน ไม่ตรงกับสรุป ${m[1]}`);
  assert(badges.filter((b) => b === 'อัตโนมัติ: ไม่ผ่าน').length === Number(m[2]), `จำนวน อัตโนมัติ: ไม่ผ่าน ไม่ตรงกับสรุป ${m[2]}`);
  const p43 = await rowCells('#uat-ph-4 tbody tr', 'P4-3');
  assert(p43[1].indexOf('ไม่ผ่าน') >= 0, 'ผลรับงานของคนต้องยังเป็นผลที่บันทึก ไม่ใช่ผลอัตโนมัติ');
  console.log(`      ตรวจอัตโนมัติ: ผ่าน ${m[1]} ไม่ผ่าน ${m[2]}`);
  await shot('uat-auto');
});

let backupJson = null;
await step('backup: download, verify (same / older / tampered / not JSON) and record', async () => {
  await asUser('P6VIEW');
  await go('backup');
  assert(await page.locator('#bk-download').count() === 0, 'ผู้ดูอย่างเดียวต้องดาวน์โหลดไฟล์สำรองไม่ได้');
  await waitText('ดาวน์โหลดไฟล์สำรองได้เฉพาะ');
  await asUser('P6ACC');
  await page.click('#bk-download');
  const text = await copiedText();
  backupJson = JSON.parse(text);
  const live = await state((s) => ({ seq: s.seq, head: s.head }));
  assert(backupJson.format === 'rrs-stockqc-backup' && backupJson.count === live.seq && backupJson.head === live.head && backupJson.commits.length === live.seq,
    `ไฟล์สำรองไม่ครบ: ${backupJson.count}/${live.seq}`);
  await waitToast('ไฟล์สำรอง');
  const good = path.join(tmp, 'p6-backup.json');
  fs.writeFileSync(good, text);
  await page.setInputFiles('#bk-file', good);
  await page.click('form[data-form="verify"] button[type="submit"]');
  await waitIn('#bk-verify', 'ไฟล์นี้ใช้กู้ข้อมูลได้');
  await waitIn('#bk-verify', 'ตรงกับข้อมูลในระบบนี้ทุกตาราง');
  await page.click('#bk-record');
  await dlgOpen();
  await page.fill('#bk-note', 'P6 เก็บในไดรฟ์บริษัท');
  await dlgSubmit();
  await dlgClosed();
  await waitState((s, R, n) => Object.values(s.tables.backup_tests || {}).some((b) => b.by === 'P6ACC' && b.result === 'OK' && b.commits === n && b.note === 'P6 เก็บในไดรฟ์บริษัท'),
    live.seq, 'ผลทดสอบกู้คืน OK');
  await waitIn('#bk-tests', 'P6 เก็บในไดรฟ์บริษัท');
  const k = await page.evaluate(() => (Array.from(document.querySelectorAll('#main .kpi')).find((x) => x.querySelector('.kpi-l').textContent.trim() === 'ทดสอบกู้คืนล่าสุด') || {}).innerText || '');
  assert(k.indexOf('ผ่าน · 0 วันที่แล้ว') >= 0, `KPI ทดสอบกู้คืนล่าสุดต้องบอกผ่านวันนี้: ${k}`);
  // the same file again: the system has moved on (the recorded test) – still restorable, older than the data
  await page.setInputFiles('#bk-file', good);
  await page.click('form[data-form="verify"] button[type="submit"]');
  await waitIn('#bk-verify', 'ระบบมีรายการใหม่กว่าไฟล์อีก 1 รายการ');
  // tampered
  const bad = JSON.parse(text);
  const c = bad.commits.find((x) => x.effects.some((e) => e.t === 'balances' && e.v));
  const e = c.effects.find((x) => x.t === 'balances' && x.v);
  e.v.qty += 1;
  const badFile = path.join(tmp, 'p6-tampered.json');
  fs.writeFileSync(badFile, JSON.stringify(bad));
  await page.setInputFiles('#bk-file', badFile);
  await page.click('form[data-form="verify"] button[type="submit"]');
  await waitIn('#bk-verify', 'ไฟล์นี้ใช้กู้ข้อมูลไม่ได้');
  await waitIn('#bk-verify', `commit ลำดับ ${c.seq} ลายนิ้วมือไม่ตรง`);
  await page.click('#bk-record');
  await dlgOpen();
  await dlgSubmit();
  await dlgClosed();
  await waitState((s) => Object.values(s.tables.backup_tests || {}).some((b) => b.by === 'P6ACC' && b.result === 'FAIL' && b.problems.length > 0), null, 'ผลทดสอบกู้คืน FAIL');
  // not JSON
  const junk = path.join(tmp, 'p6-junk.json');
  fs.writeFileSync(junk, 'not json at all');
  await page.setInputFiles('#bk-file', junk);
  await page.click('form[data-form="verify"] button[type="submit"]');
  await waitIn('#bk-verify', 'อ่านไม่ได้หรือผิดรูปแบบ');
  await waitIn('#bk-plan', 'ห้ามกู้ไฟล์สำรองเก่าทับข้อมูลที่ใหม่กว่า');
  await shot('backup');
});

await step('backup: Google Drive part in server mode (404, status, run)', async () => {
  let statusMode = '404';
  let runMode = 'ok';
  const posts = [];
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
  await page.route('http://p6.test/**', async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (url.endsWith('/api/backup/status')) {
      if (statusMode === '404') return route.fulfill({ status: 404, headers: cors, contentType: 'application/json', body: JSON.stringify({ error: 'not found' }) });
      return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ ok: true, enabled: true, configured: true, missing: [], invalid: [],
        schedule: { cron: '40 18 * * *', time: '01:40', timezone: 'Asia/Bangkok', active: true }, running: false,
        lastOk: { id: 'run-1', trigger: 'scheduled', day: today, status: 'ok', fromSeq: 1, toSeq: 5, head: 'a'.repeat(64), commits: 5, parts: 1, bytes: 4096,
          requestedBy: 'cron', folderUrl: 'https://drive.google.com/drive/folders/abc', error: null, message: null, startedAt: '2026-11-01T18:40:00.000Z', finishedAt: '2026-11-01T18:41:00.000Z' },
        runs: [{ id: 'run-1', trigger: 'scheduled', day: today, status: 'ok', commits: 5, parts: 1, bytes: 4096, requestedBy: 'cron', startedAt: '2026-11-01T18:40:00.000Z', message: null }] }) });
    }
    if (url.endsWith('/api/backup/run')) {
      posts.push(req.postData());
      if (runMode === 'ok') return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ ok: true, run: { id: 'run-2', status: 'ok', commits: 321 } }) });
      return route.fulfill({ status: 409, headers: cors, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'DISABLED', message: 'ปิดการสำรองข้อมูลไป Google Drive อยู่ (ทดสอบพีหก)' }) });
    }
    return route.fulfill({ status: 404, headers: cors, body: '' });
  });
  try {
    await page.evaluate(() => {
      const a = window.RRS.app;
      a.mode = 'server';
      a.api = 'http://p6.test/api';
      a.account = 'p6-srv';
      if (a.views.backup) a.views.backup.drive = null;
    });
    await reopen('backup');
    await waitIn('#bk-drive', 'ยังไม่ได้ตั้งค่า', 10000);
    statusMode = 'ok';
    await page.click('#bk-drive button[data-act="driveRefresh"]');
    await waitIn('#bk-drive', 'เปิดใช้แล้ว', 10000);
    await waitIn('#bk-drive', 'เปิดโฟลเดอร์ใน Google Drive');
    assert(!(await page.isDisabled('#bk-drive-run')), 'ตั้งค่าครบแล้วต้องกด สำรองตอนนี้ ได้');
    await page.click('#bk-drive-run');
    await dlgOpen();
    await dlgSubmit();
    await waitToast('สำรองไป Google Drive แล้ว · 321 รายการ', 10000);
    assert(posts.length === 1 && posts[0] === '{}', `ต้องส่งคำสั่งสำรอง 1 ครั้ง: ${posts}`);
    runMode = 'disabled';
    await page.waitForSelector('#bk-drive-run:not([disabled])', { timeout: 10000 });
    await page.click('#bk-drive-run');
    await dlgOpen();
    await dlgSubmit();
    await waitToast('ปิดการสำรองข้อมูลไป Google Drive อยู่ (ทดสอบพีหก)', 10000);
    await noOverflow('backup server');
  } finally {
    await page.evaluate(() => {
      const a = window.RRS.app;
      a.mode = 'demo';
      a.api = undefined;
      a.account = null;
      if (a.views.backup) a.views.backup.drive = null;
    });
    await page.unroute('http://p6.test/**');
    await reopen('backup');
  }
  await waitIn('#bk-drive', 'ยังไม่ได้เชื่อมเซิร์ฟเวอร์');
});

await step('guide: one section per role, working links, problems, training', async () => {
  await asUser('P6STORE');
  await go('guide');
  const secs = await page.$$eval('#main section.sec[id^="guide-"]', (s) => s.map((x) => x.id));
  assert(secs.length === 11, `ต้องมี 11 บทบาท ได้ ${secs.length}`);
  for (const r of ['store', 'store_lead', 'planner', 'production', 'engineering', 'purchasing', 'accounting', 'qc', 'qc_lead', 'manager', 'admin']) {
    assert(secs.indexOf('guide-' + r) >= 0, `ไม่มีคู่มือบทบาท ${r}`);
  }
  assert(secs[0] === 'guide-store', 'บทบาทของผู้ใช้ต้องอยู่บนสุด');
  await waitIn('#guide-store', 'บทบาทของคุณ');
  const links = await page.$$eval('#main a[data-go]', (as) => as.map((a) => a.dataset.go));
  const pages = await page.evaluate(() => Object.keys(window.RRS.ui.pages));
  const missing = links.filter((l) => pages.indexOf(l) < 0);
  assert(!missing.length, `ลิงก์ไปหน้าที่ไม่มี: ${missing}`);
  assert((await mainText()).indexOf('หน้าจอยังไม่เปิดใช้') < 0, 'ทุกลิงก์ในคู่มือต้องเปิดได้');
  await page.selectOption('#guide-role', 'mine');
  await page.waitForFunction(() => document.querySelectorAll('#main section.sec[id^="guide-"]').length === 1 && document.querySelector('#guide-store'));
  await page.selectOption('#guide-role', '');
  await page.waitForFunction(() => document.querySelectorAll('#main section.sec[id^="guide-"]').length === 11);
  await page.click('#guide-production a[data-go="offcuts"]');
  await page.waitForSelector('.page[data-page="offcuts"] form[data-form="find"]');
  // problems
  await go('guide');
  await tab('problems');
  for (const x of ['ยอดไม่พอ', 'ล็อตถูกกัก', 'ผู้อนุมัติต้องเป็นคนอื่น', 'ไฟล์ Express ซ้ำ', 'ยกเลิกเอกสารไม่ได้']) await waitIn('#guide-problems', x);
  const all = await page.evaluate(() => window.RRS.reports.ERROR_GUIDE.length);
  assert(await page.locator('#guide-errors tbody tr').count() === all, 'ตารางรหัสข้อผิดพลาดต้องครบ');
  await typeLive('#guide-q', 'SAME_PERSON');
  await page.waitForFunction(() => document.querySelectorAll('#guide-problems .step').length === 1);
  await waitIn('#guide-problems', 'ผู้อนุมัติต้องเป็นคนอื่น');
  assert(await page.locator('#guide-errors tbody tr').count() >= 1, 'ค้นรหัสแล้วต้องพบในตาราง');
  await typeLive('#guide-q', '');
  await tab('roles');
  // training record (store lead records the store user's training)
  await asUser('P6LEAD');
  await go('guide');
  await page.click('#guide-store button[data-act="train"]');
  await dlgOpen();
  await page.selectOption('#guide-train-user', 'P6STORE');
  await dlgSubmit();
  await dlgClosed();
  await waitState((s) => Object.values(s.tables.trainings || {}).some((x) => x.userId === 'P6STORE' && x.role === 'store' && x.trainer === 'P6LEAD'), null, 'บันทึกการอบรม P6STORE');
  await waitIn('#guide-store', 'อบรมแล้ว');
  const line = ((await page.locator('#guide-store').innerText()).match(/ยังไม่อบรม: ([^\n]*)/) || [])[1] || '';
  assert(line.split(', ').indexOf('สโตร์พีหก') < 0, `ผู้ที่อบรมแล้วต้องไม่อยู่ในรายชื่อยังไม่อบรม: ${line}`);
});

await step('many offcuts and phone width', async () => {
  for (let i = 0; i < 60; i++) {
    await must('offcut.add', { code: 'P6-PL10', width: 100 + i, length: 120, wh: 'P6W', bin: 'P6-OFF', sourceLot: 'P6-H2', createdFrom: `P6 ชุดใหญ่ ${i}` }, 'P6PROD');
  }
  await asUser('P6PROD');
  await go('offcuts');
  await tab('list');
  await typeLive('#oc-q', 'ชุดใหญ่');
  await page.waitForFunction(() => document.querySelectorAll('#oc-list tbody tr').length === 60);
  const box = await page.evaluate(() => { const b = document.querySelector('#oc-list'); return [b.scrollHeight, b.clientHeight]; });
  assert(box[0] > box[1] + 50, `ตารางต้องเลื่อนในกรอบของตัวเอง ${box}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow('offcuts many');
  await page.click('#oc-tags');
  await noOverflow('offcuts tags');
  await page.click('#oc-tags');
  await clickInRow('#oc-list tbody tr', 'ชุดใหญ่ 5');
  await page.waitForSelector('#oc-detail');
  await noOverflow('offcuts detail');
  await page.click('#oc-new');
  await page.waitForSelector('#oc-reg-code');
  await noOverflow('offcuts register');
  await page.click('#main button[data-act="cancelReg"]');
  await shot('phone-offcuts');
  await go('reports');
  for (const t of REPORT_TABS) {
    await tab(t);
    await noBroken(t);
    await noOverflow(`reports/${t} phone`);
  }
  for (const id of ['uat', 'backup', 'guide']) {
    await go(id);
    await noBroken(id);
    await noOverflow(`${id} phone`);
  }
  await go('guide');
  await tab('problems');
  await noOverflow('guide problems phone');
  await go('backup');
  await page.setInputFiles('#bk-file', path.join(tmp, 'p6-backup.json'));
  await page.click('form[data-form="verify"] button[type="submit"]');
  await waitIn('#bk-verify', 'ไฟล์นี้ใช้กู้ข้อมูลได้');
  await noOverflow('backup check phone');
  await shot('phone-backup');
  await page.setViewportSize({ width: 1366, height: 900 });
});

await browser.close();
try {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(emptyFile, { force: true });
} catch (e) { /* temp files only */ }
if (problems.length) {
  console.log('PROBLEMS\n' + problems.join('\n'));
  process.exit(1);
}
console.log('p6 ok');
