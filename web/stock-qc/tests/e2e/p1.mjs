// Browser test of the Phase 1 screens ยอดคงเหลือ (stock), ประวัติเคลื่อนไหว (history) and ย้ายยอดตั้งต้น (opening).
//   RRS_OUT=/tmp/stockqc-p1 node tests/e2e/p1.mjs [--shots dir]
// Starts from a clean demo page, creates its own master data (codes P1-…, warehouses P1A/P1B) and drives each flow
// through the UI: opening-balance import (check → one AJ → reconciliation), stock views/filters/detail and the quick
// issue/transfer drafts, history filters/totals/reversal marker/CSV, permissions per role and phone width.
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

/** Text as TIS-620 / windows-874 bytes (what Thai Excel writes when saving CSV). Thai letters U+0E01–U+0E5B -> 0xA1–0xFB. */
function tis620(text) {
  return Buffer.from(Array.from(text).map((ch) => {
    const c = ch.codePointAt(0);
    if (c >= 0x0e01 && c <= 0x0e5b) return c - 0x0e01 + 0xa1;
    if (c < 0x80) return c;
    throw new Error('ไม่มีใน TIS-620: ' + ch);
  }));
}
const problems = [];
let current = '';
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
// these steps expect a blank system: start the demo without the sample data (app.js pref 'demoEmpty')
await page.addInitScript(() => { try { localStorage.setItem('rrs-sq:demoEmpty', 'true'); } catch (e) { /* ignore */ } });
page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|cdnjs|ERR_|net::/.test(m.text())) problems.push(`console (${current}): ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`pageerror (${current}): ${e.message}`));
// an alert/confirm/prompt means user text ran as code (or a page used a browser dialog instead of ctx.dialog)
page.on('dialog', async (d) => { problems.push(`browser dialog (${current}): ${d.type()} ${d.message()}`); await d.dismiss().catch(() => {}); });

// ---- helpers ------------------------------------------------------------------------------------------------
const ready = () => page.waitForFunction(() => window.RRS && window.RRS.app && window.RRS.app.loading === false && window.RRS.app.ledger, null, { timeout: 60000 });
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
async function asUser(id) {
  await page.selectOption('#who-sel', id);
  await page.waitForFunction((x) => document.querySelector('#who-sel') && document.querySelector('#who-sel').value === x, id);
}
const mainText = () => page.locator('#main').innerText();
async function waitText(text, timeout) {
  await page.waitForFunction((x) => document.querySelector('#main').innerText.indexOf(x) >= 0, text, { timeout: timeout || 6000 })
    .catch(async () => { throw new Error(`ไม่พบข้อความ "${text}" ในหน้า\n---\n${(await mainText()).slice(0, 1500)}`); });
}
async function waitGone(text, timeout) {
  await page.waitForFunction((x) => document.querySelector('#main').innerText.indexOf(x) < 0, text, { timeout: timeout || 6000 })
    .catch(() => { throw new Error(`ข้อความ "${text}" ยังอยู่ในหน้า`); });
}
const kpi = (label) => page.evaluate((l) => {
  const k = Array.from(document.querySelectorAll('#main .kpi')).find((e) => e.querySelector('.kpi-l').textContent.trim() === l);
  return k ? k.querySelector('.kpi-v').textContent.trim() : null;
}, label);
const rowCells = (sel, text) => page.evaluate(([s, x]) => {
  const tr = Array.from(document.querySelectorAll(s)).find((r) => r.innerText.indexOf(x) >= 0);
  return tr ? Array.from(tr.children).map((td) => td.innerText.trim()) : null;
}, [sel, text]);
const state = (fn, arg) => page.evaluate(([src, a]) => (0, eval)(src)(window.RRS.app.ledger.state, window.RRS, a), [fn.toString(), arg === undefined ? null : arg]);
async function noOverflow(where) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert(!over, `${where}: หน้ากว้างเกินจอ`);
}
/** The opening check screen: step 1 while the file has problems, step 2 once it can be posted. */
async function checkedAs(n) {
  await waitText(`ขั้น ${n} · ผลตรวจ`, 15000);
  const active = await page.evaluate(() => {
    const s = Array.from(document.querySelectorAll('#main .step')).find((x) => x.innerText.indexOf('ทำอยู่') >= 0);
    return s ? s.querySelector('.step-n').innerText.replace(/\D+/g, ' ').trim() : '';
  });
  assert(active === String(n), `แถบขั้นตอนควรอยู่ที่ขั้น ${n} ได้ "${active}"`);
}
async function dlgOpen() {
  await page.waitForSelector('#dlg:not([hidden]) .dlg-card');
}
async function dlgError(text) {
  await page.waitForFunction((x) => document.querySelector('#dlg-err') && document.querySelector('#dlg-err').innerText.indexOf(x) >= 0, text, { timeout: 4000 })
    .catch(async () => { throw new Error(`หน้าต่างควรบอก "${text}" ได้ "${await page.locator('#dlg-err').innerText().catch(() => '')}"`); });
}
const toastText = () => page.locator('#toasts').innerText();
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

// ---- start from a clean page ------------------------------------------------------------------------------------
await page.goto(file);
await ready();
await page.evaluate(() => localStorage.clear());
await page.reload();
await ready();

const CUTOFF_ISO = '2026-11-01T10:00:00.000Z'; // 01/11/2569 17:00 Bangkok
const BAD_CSV = [
  'รหัสสินค้า,คลัง,ช่องเก็บ,ล็อต,จำนวน,หน่วย',
  'P1-001,P1A,A-01,,5,',
  'P1-999,P1A,A-01,,3,',
  'P1-001,P1A,Z-99,,2,',
  'P1-002,P1A,A-02,,2,ลัง',
  'P1-001,P1A,A-01,,5,',
  'p1 001,P1A,A-02,,1,',
  'P1-LOT,P1A,A-01,,4,',
].join('\n');
const GOOD_CSV = [
  'รหัสสินค้า,คลัง,ช่องเก็บ,ล็อต,จำนวน,หน่วย',
  'P1-001,P1A,A-01,,5,',
  'P1-001,P1B,B-01,,3,',
  'EX-P1-002,P1A,A-02,,2,กล่อง',
  'P1-LOT,P1A,A-01,H-778,4,',
  'P1-002,P1B,B-01,,0,',
].join('\n');
const EVIL = '<img src=x onerror=alert(1)>';
let openingDoc = '';
let qcDoc = '';

await step('empty states', async () => {
  const empty = await state((s) => !Object.keys(s.tables.balances || {}).length && !Object.keys(s.tables.movements || {}).length);
  if (!empty) return; // sample data present (fixture build) – the smoke test covers empty pages
  await go('stock');
  await waitText('ยังไม่มียอดคงเหลือ');
  await go('history');
  await waitText('ยังไม่มีการเคลื่อนไหว');
  await go('opening');
  await waitText('ขั้น 1 · วางหรือเลือกไฟล์ยอดนับ');
  await waitText('ยังไม่มีใบยอดตั้งต้น');
});

await step('setup master data and users', async () => {
  await must('warehouse.upsert', { code: 'P1A', name: 'คลังทดสอบ A' });
  await must('warehouse.upsert', { code: 'P1B', name: 'คลังทดสอบ B', requireBin: true });
  await must('bin.upsert', { wh: 'P1A', code: 'A-01', name: 'ชั้น 1' });
  await must('bin.upsert', { wh: 'P1A', code: 'A-02', name: 'ชั้น 2' });
  await must('bin.upsert', { wh: 'P1B', code: 'B-01', name: 'ชั้น 1' });
  await must('item.upsert', { code: 'P1-001', name: 'ทดสอบพีหนึ่ง ฝาข้าง', baseUnit: 'ชิ้น', type: 'PART', group: 'กลุ่มทดสอบพีหนึ่ง', minQty: 10, maxQty: 50 });
  await must('item.upsert', { code: 'P1-002', name: 'ทดสอบพีหนึ่ง น็อต', baseUnit: 'ตัว', type: 'BUY', expressCode: 'EX-P1-002' });
  await must('item.unit', { code: 'P1-002', unit: 'กล่อง', factor: 100 });
  await must('item.upsert', { code: 'P1-LOT', name: 'ทดสอบพีหนึ่ง แผ่นเหล็ก', baseUnit: 'แผ่น', type: 'RM', trackLot: 'heat' });
  await must('user.upsert', { id: 'P1STORE', name: 'สโตร์ทดสอบ', roles: ['store'] });
  await must('user.upsert', { id: 'P1LEAD', name: 'หัวหน้าสโตร์ทดสอบ', roles: ['store_lead'] });
  await must('user.upsert', { id: 'P1VIEW', name: 'ผู้ดูทดสอบ', roles: ['viewer'] });
  await must('item.upsert', { code: 'P1-SN', name: 'ทดสอบพีหนึ่ง เครื่องยนต์', baseUnit: 'เครื่อง', type: 'BUY', trackLot: 'serial' });
  await must('user.upsert', { id: 'P1LEADA', name: 'หัวหน้าสโตร์คลัง A', roles: ['store_lead'], warehouses: ['P1A'] });
  await must('user.upsert', { id: 'P1STOREA', name: 'สโตร์คลัง A', roles: ['store'], warehouses: ['P1A'] });
  await must('user.upsert', { id: 'P1PLAN', name: 'วางแผนทดสอบ', roles: ['planner'] });
  await must('settings.update', { patch: { cutoffAt: CUTOFF_ISO } });
});

await step('opening: check flags every problem, nothing posted', async () => {
  await asUser('P1LEAD');
  await go('opening');
  await waitText('เวลาตัดยอด 01/11/2569 17:00');
  await page.fill('#op-text', BAD_CSV);
  await page.click('form[data-form="read"] button[type="submit"]');
  await checkedAs(1);
  assert(await kpi('ต้องแก้') === '6', `ต้องแก้ ควรเป็น 6 ได้ ${await kpi('ต้องแก้')}`);
  assert(await kpi('คำเตือน') === '1', `คำเตือน ควรเป็น 1 ได้ ${await kpi('คำเตือน')}`);
  for (const s of ['ไม่พบรหัส P1-999 ในทะเบียนสินค้า', 'ไม่พบช่องเก็บ Z-99 ในคลัง P1A', 'หน่วย "ลัง" ของ P1-002 ยังไม่มีตัวคูณ', 'ซ้ำกับแถว 6', 'ซ้ำกับแถว 2', 'P1-LOT ต้องระบุHeat no.', 'บันทึกไม่ได้ – มี 6 แถวที่ต้องแก้']) await waitText(s);
  assert(await page.locator('#op-post').count() === 0, 'ไม่ควรมีปุ่มบันทึกเมื่อมีแถวผิด');
  await page.click('#main button[data-act="ftab"][data-arg="warn"]');
  await waitText('อ่านเป็น P1-001');
  await waitText('เขียนรหัสนี้ต่างกัน');
  await shot('desktop-opening-check-bad');
  const docs = await state((s) => Object.keys(s.tables.documents || {}).length);
  assert(docs === 0, 'ตรวจไฟล์ต้องไม่สร้างเอกสาร');
});

await step('opening: wrong input is named row by row, nothing changes', async () => {
  // still P1LEAD on the opening page, the bad file checked
  await page.click('#main button[data-act="restart"]');
  await page.waitForSelector('#op-text');
  await page.fill('#op-text', '');
  await page.click('form[data-form="read"] button[type="submit"]');
  await waitText('ยังไม่มีข้อมูล – เลือกไฟล์ หรือวางข้อมูลจาก Excel');
  await page.fill('#op-text', 'abc,def\n1,2');
  await page.click('form[data-form="read"] button[type="submit"]');
  await checkedAs(1);
  await waitText('ไม่พบหัวตาราง – แถวแรกต้องเป็นชื่อคอลัมน์');
  assert(await page.locator('#op-post').count() === 0, 'ไม่มีหัวตาราง ต้องไม่มีปุ่มบันทึก');
  await page.click('#main button[data-act="restart"]');
  await page.fill('#op-text', 'รหัสสินค้า,จำนวน\nP1-001,5');
  await page.click('form[data-form="read"] button[type="submit"]');
  await checkedAs(1);
  await waitText('ไม่พบคอลัมน์ คลัง');
  await page.click('#main button[data-act="restart"]');
  const WRONG = [
    'รหัสสินค้า,คลัง,ช่องเก็บ,ล็อต,จำนวน,หน่วย,สถานะ',
    'P1-001,P1A,A-01,,สิบ,,', // 2 letters
    'P1-001,P1A,A-02,,-3,,', // 3 minus
    'P1-002,P1A,A-01,L1,4,,', // 4 lot on an item without lots
    'P1-002,P1A,A-02,,,,', // 5 no quantity
    'P1-002,P1B,B-01,,1,,ดี', // 6 unknown status
    'P1-002,P1X,,,1,,', // 7 unknown warehouse
    'P1-002,P1B,,,1,,', // 8 bin required
    'P1-SN,P1A,A-01,SN-1,3,,', // 9 one serial, three units
    'P1-SN,P1A,A-02,SN-2,1,,', // 10 the same serial twice
    'P1-SN,P1B,B-01,SN-2,1,,', // 11
    'P1-002,TRANSIT,,,1,,', // 12 the system's in-transit place
    'P1-001,P1B,B-01,,2,,รอตรวจ', // 13 fine (status column)
  ].join('\n');
  await page.fill('#op-text', WRONG);
  await page.click('form[data-form="read"] button[type="submit"]');
  await checkedAs(1);
  assert(await kpi('ต้องแก้') === '11' && await kpi('ผ่าน') === '1', `ต้องแก้/ผ่าน ${await kpi('ต้องแก้')}/${await kpi('ผ่าน')}`);
  for (const x of ['จำนวน "สิบ" ไม่ใช่ตัวเลข', 'จำนวนติดลบ', 'P1-002 ไม่ได้ตั้งให้ติดตามล็อต', 'ไม่ได้กรอกจำนวน (ถ้าไม่มีของ ใส่ 0)', 'สถานะ "ดี" ไม่รู้จัก',
    'ไม่พบคลัง P1X', 'คลัง P1B ต้องระบุช่องเก็บ', 'P1-SN ติดตาม Serial – 1 แถวต่อ 1 Serial', 'Serial SN-2 ของ P1-SN อยู่ในแถว 11 ด้วย', 'TRANSIT ใช้ภายในระบบ']) await waitText(x);
  // the file column shows the quantity exactly as written, not a made-up 0
  const r2 = await page.locator('#op-check tr[data-row="2"]').innerText();
  const r3 = await page.locator('#op-check tr[data-row="3"]').innerText();
  assert(r2.indexOf('สิบ') >= 0 && r3.indexOf('-3') >= 0, `จำนวนในไฟล์ควรแสดงตามที่เขียน: ${r2} / ${r3}`);
  assert(await page.locator('#op-post').count() === 0, 'มีแถวผิดต้องไม่มีปุ่มบันทึก');
  // a lead limited to warehouse P1A: rows of P1B are refused with how to fix it
  await asUser('P1LEADA');
  await waitText('คุณไม่มีสิทธิ์ปรับยอดคลัง P1B – แยกแถวคลังนี้ออกจากไฟล์');
  await asUser('P1LEAD');
  // on a phone the reasons get the full width of the table
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.$eval('#op-check tr[data-row="2"] + tr td', (td) => td.colSpan) === 3, 'เหตุผลควรเต็มความกว้างตาราง');
  await noOverflow('opening ผลตรวจหลายข้อผิด');
  await shot('phone-opening-wrong');
  await page.setViewportSize({ width: 1366, height: 900 });
  // no cut-off time: the file can be checked but not posted, and the page says who sets it
  await must('settings.update', { patch: { cutoffAt: '' } });
  await page.click('#main button[data-act="restart"]');
  await page.fill('#op-text', 'รหัสสินค้า,คลัง,ช่องเก็บ,ล็อต,จำนวน,หน่วย\nP1-001,P1A,A-01,,5,');
  await page.click('form[data-form="read"] button[type="submit"]');
  await checkedAs(2);
  await waitText('ยังไม่ได้ตั้งเวลาตัดยอด – ให้ผู้ดูแลระบบ หรือ ผู้บริหาร');
  assert(await page.locator('#op-post').count() === 0, 'ไม่มีเวลาตัดยอดต้องบันทึกไม่ได้');
  await must('settings.update', { patch: { cutoffAt: CUTOFF_ISO } });
  await page.waitForSelector('#op-post');
  // picking files: a CSV saved by Thai Excel (TIS-620), then an Excel file
  await page.click('#main button[data-act="restart"]');
  await page.fill('#op-text', '');
  await page.setInputFiles('#op-file', { name: 'นับคลังA.csv', mimeType: 'text/csv', buffer: tis620('รหัสสินค้า,คลัง,ช่องเก็บ,ล็อต,จำนวน,หน่วย\r\nP1-001,P1A,A-01,,5,ชิ้น\r\n') });
  await page.click('form[data-form="read"] button[type="submit"]');
  await checkedAs(2);
  await waitText('ผลตรวจ นับคลังA.csv');
  assert(await kpi('ผ่าน') === '1', 'ไฟล์ TIS-620 ต้องอ่านหัวตารางและหน่วยภาษาไทยได้');
  await page.click('#main button[data-act="restart"]');
  const hasXlsx = await page.evaluate(() => !!window.XLSX);
  if (hasXlsx) {
    const bytes = await page.evaluate(() => {
      const ws = window.XLSX.utils.aoa_to_sheet([['รหัสสินค้า', 'คลัง', 'ช่องเก็บ', 'ล็อต', 'จำนวน', 'หน่วย'], ['P1-001', 'P1A', 'A-01', '', 5, '']]);
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, 'นับ');
      return Array.from(new Uint8Array(window.XLSX.write(wb, { type: 'array', bookType: 'xlsx' })));
    });
    await page.setInputFiles('#op-file', { name: 'นับ.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(bytes) });
    await page.click('form[data-form="read"] button[type="submit"]');
    await checkedAs(2);
    await waitText('ผลตรวจ นับ.xlsx');
    await page.click('#main button[data-act="restart"]');
  } else {
    // the Excel reader comes from cdnjs; offline it says what to do instead
    await page.setInputFiles('#op-file', { name: 'นับ.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from('PK\u0003\u0004 not really excel') });
    await page.click('form[data-form="read"] button[type="submit"]');
    await waitText('อ่านไฟล์ Excel ไม่ได้ (ตัวอ่าน Excel โหลดไม่สำเร็จ) – บันทึกเป็น CSV แล้วลองใหม่');
  }
  assert(await state((st) => Object.keys(st.tables.documents || {}).length) === 0, 'การตรวจไฟล์ต้องไม่สร้างเอกสาร');
  // leave the screen as the next step expects it: the bad file checked
  await page.fill('#op-text', BAD_CSV);
  await page.click('form[data-form="read"] button[type="submit"]');
  await checkedAs(1);
});

await step('opening: one AJ, all or nothing, then reconciliation', async () => {
  await page.click('#main button[data-act="restart"]');
  await page.waitForSelector('#op-text');
  assert((await page.inputValue('#op-text')).indexOf('P1-999') >= 0, 'ข้อความที่วางไว้ควรยังอยู่ให้แก้');
  await page.fill('#op-text', GOOD_CSV);
  await page.fill('#op-name', 'ใบนับ P1 ทดสอบ');
  await page.click('form[data-form="read"] button[type="submit"]');
  await checkedAs(2);
  assert(await kpi('ต้องแก้') === '0', 'ไม่ควรมีแถวต้องแก้');
  assert(await kpi('คำเตือน') === '1', 'EX-P1-002 ต้องเป็นคำเตือน');
  assert(await kpi('ข้าม (จำนวน 0)') === '1', 'แถวจำนวน 0 ต้องถูกข้าม');
  await waitText('อ่านเป็น P1-002');
  await waitText('จากรหัส Express');
  await waitText('= 200 ตัว');
  assert(await page.isDisabled('#op-post'), 'ต้องยืนยันคำเตือนก่อนบันทึก');
  await page.check('#op-ack');
  await page.waitForFunction(() => document.querySelector('#op-post') && !document.querySelector('#op-post').disabled);
  await page.click('#op-post');
  await page.waitForSelector('#dlg:not([hidden]) .dlg-card');
  assert((await page.locator('#dlg').innerText()).indexOf('AJ 1 ใบ 4 บรรทัด') >= 0, 'ยืนยันควรบอกจำนวนบรรทัด');
  await page.click('#dlg button[type="submit"]');
  await waitText('ขั้น 3 · กระทบยอด');
  await waitText('ยอดหลังบันทึกตรงกับไฟล์ทุกรายการ');
  await waitText('ทดสอบกู้คืน');
  const doc = await state((s) => Object.values(s.tables.documents).find((d) => d.type === 'AJ' && String(d.source || '').indexOf('opening:') === 0));
  assert(doc && doc.status === 'POSTED', 'ต้องมีใบ AJ ที่บันทึกแล้ว');
  openingDoc = doc.docNo;
  assert(doc.lines.length === 4, `ใบ AJ ควรมี 4 บรรทัด ได้ ${doc.lines.length}`);
  assert(doc.remark === 'ยอดตั้งต้น ณ 01/11/2569 17:00', `หมายเหตุ: ${doc.remark}`);
  assert(doc.ref === 'ใบนับ P1 ทดสอบ', `อ้างอิง: ${doc.ref}`);
  assert(doc.date === '2026-11-01', `วันที่เอกสาร: ${doc.date}`);
  const docsN = await state((s) => Object.values(s.tables.documents).filter((d) => d.type === 'AJ').length);
  assert(docsN === 1, 'ต้องเป็นใบเดียว');
  const q = await state((s, R) => [R.q.qty(s, { code: 'P1-001' }), R.q.qty(s, { code: 'P1-002' }), R.q.qty(s, { code: 'P1-LOT', lot: 'H-778' }), R.q.qty(s, { code: 'P1-001', wh: 'P1B', bin: 'B-01' })]);
  assert(JSON.stringify(q) === '[8,200,4,3]', `ยอดหลังบันทึก ${JSON.stringify(q)}`);
  const r1 = await rowCells('#op-recon tbody tr', 'P1-001');
  assert(r1 && r1[2] === '8' && r1[4] === '8' && r1[5] === '0' && r1[7] === 'ตรง', `กระทบยอด P1-001: ${r1}`);
  const r2 = await rowCells('#op-recon tbody tr', 'P1-002');
  assert(r2 && r2[2] === '200' && r2[4] === '200' && r2[7] === 'ตรง', `กระทบยอด P1-002: ${r2}`);
  await waitText(openingDoc);
  await shot('desktop-opening-reconcile');
});

await step('opening: the same file cannot be posted twice', async () => {
  await page.click('#main button[data-act="restart"]');
  await page.waitForSelector('#op-text');
  assert((await page.inputValue('#op-text')) === GOOD_CSV, 'ข้อความเดิมควรยังอยู่');
  await page.click('form[data-form="read"] button[type="submit"]');
  await waitText(`บันทึกเป็น ${openingDoc} แล้ว`);
  assert(await page.locator('#op-post').count() === 0, 'ไฟล์ซ้ำต้องบันทึกไม่ได้');
  await page.click(`#main tr[data-act="pickDoc"][data-arg="${openingDoc}"]`);
  await waitText(`กระทบยอด ${openingDoc}`);
});

await step('opening: hidden and read-only without permission', async () => {
  await asUser('P1STORE');
  assert(await page.locator('#nav a[data-go="opening"]').count() === 0, 'สโตร์ไม่ควรเห็นเมนูย้ายยอดตั้งต้น');
  await go('opening');
  await waitText('หน้านี้ใช้ได้เฉพาะผู้มีสิทธิ์บันทึกปรับปรุงยอด');
  assert(await page.locator('#op-text').count() === 0, 'ไม่ควรมีช่องวางไฟล์');
  await waitText(openingDoc);
});

await step('stock: per item with statuses, Min badge and filters', async () => {
  const r = await must('doc.post', { type: 'AJ', remark: 'ทดสอบของรอตรวจ', lines: [{ code: 'P1-001', qty: 2, wh: 'P1A', bin: 'A-02', status: 'QC_HOLD' }] });
  qcDoc = r.result.docNo;
  await asUser('P1STORE');
  await go('stock');
  await page.waitForSelector('#stk-list');
  const c = await rowCells('#stk-list tbody tr', 'P1-001');
  assert(c, 'ต้องมีแถว P1-001');
  assert(c[2] === '8' && c[3] === '2' && c[7] === '10' && c[8] === 'ชิ้น' && c[9] === '10 / 50' && c[10] === 'ต่ำกว่า Min', `แถว P1-001: ${c.join(' | ')}`);
  const low = Number(await kpi('ต่ำกว่า Min'));
  assert(low >= 1, 'KPI ต่ำกว่า Min ต้องนับ P1-001');
  await waitText('เบิกและโอนได้เฉพาะของสถานะ "ใช้ได้"');
  await page.selectOption('#stk-wh', 'P1B');
  await page.waitForFunction(() => document.querySelector('#stk-wh').value === 'P1B');
  const b = await rowCells('#stk-list tbody tr', 'P1-001');
  assert(b && b[2] === '3' && b[7] === '3', `P1-001 ในคลัง P1B: ${b}`);
  assert(!(await rowCells('#stk-list tbody tr', 'P1-LOT')), 'P1-LOT ไม่อยู่ในคลัง P1B');
  await page.click('#main button[data-act="clear"]');
  await page.fill('#stk-q', 'ทดสอบพีหนึ่ง แผ่น');
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('#stk-list tbody tr')).some((r) => r.innerText.indexOf('P1-001') >= 0));
  assert(await rowCells('#stk-list tbody tr', 'P1-LOT'), 'ค้นหาชื่อต้องพบ P1-LOT');
  assert(await page.evaluate(() => document.activeElement && document.activeElement.id === 'stk-q'), 'ช่องค้นหาต้องยังโฟกัสอยู่หลังกรอง');
  await page.click('#main button[data-act="clear"]');
  await page.check('#stk-low');
  await page.waitForFunction(() => document.querySelector('#stk-low').checked);
  assert(await rowCells('#stk-list tbody tr', 'P1-001'), 'ต่ำกว่า Min ต้องมี P1-001');
  assert(!(await rowCells('#stk-list tbody tr', 'P1-002')), 'P1-002 ไม่ได้ต่ำกว่า Min');
  await page.click('#main button[data-act="clear"]');
});

await step('stock: per location, status filter, item detail', async () => {
  await page.click('#main button.tab[data-arg="loc"]');
  await page.waitForFunction(() => document.querySelector('#main button.tab.on').dataset.arg === 'loc');
  const lot = await rowCells('#stk-list tbody tr', 'H-778');
  assert(lot && lot[0] === 'P1A' && lot[1] === 'A-01' && lot[2] === 'P1-LOT' && lot[6].indexOf('4') === 0, `แถวล็อต H-778: ${lot}`);
  await page.selectOption('#stk-status', 'QC_HOLD');
  await page.waitForFunction(() => document.querySelector('#stk-status').value === 'QC_HOLD');
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll('#stk-list tbody tr')).map((r) => r.children[4].innerText.trim()));
  assert(rows.length >= 1 && rows.every((x) => x === 'รอตรวจ'), `กรองรอตรวจ: ${rows}`);
  await page.click('#main button[data-act="clear"]');
  await page.click('#stk-list tbody tr[data-arg="P1-001"] >> nth=0');
  await page.waitForSelector('#stk-detail');
  const d = await page.locator('#stk-detail').innerText();
  assert(d.indexOf('P1-001') >= 0 && d.indexOf('ยอดตามตำแหน่ง') >= 0 && d.indexOf('เคลื่อนไหวล่าสุด') >= 0, 'รายละเอียดสินค้า');
  assert(d.indexOf('เบิกหรือโอนไม่ได้จนกว่า QC') >= 0, 'ต้องอธิบายว่าของรอตรวจเบิกไม่ได้');
  assert(await page.locator(`#stk-detail a[data-go="docs"]`, { hasText: openingDoc }).count() >= 1, 'ต้องมีลิงก์ไปเอกสารยอดตั้งต้น');
  const held = page.locator('#stk-detail tr', { hasText: 'P1A/A-02' }).filter({ hasText: 'รอตรวจ' });
  assert(await held.locator('button[data-act="issue"]').isDisabled(), 'ของรอตรวจต้องกดเบิกไม่ได้');
  assert(await held.locator('button[data-act="move"]').isDisabled(), 'ของรอตรวจต้องกดโอนไม่ได้');
  const free = page.locator('#stk-detail tr', { hasText: 'P1A/A-01' });
  assert(!(await free.locator('button[data-act="issue"]').isDisabled()), 'ของใช้ได้ต้องกดเบิกได้');
  await shot('desktop-stock-loc-detail');
});

await step('stock: quick issue creates a PD draft and opens it', async () => {
  await page.locator('#stk-detail tr', { hasText: 'P1A/A-01' }).locator('button[data-act="issue"]').click();
  await page.waitForSelector('#dlg:not([hidden]) .dlg-card');
  assert((await page.locator('#dlg h2').innerText()).indexOf('สร้างร่างใบเบิก P1-001') >= 0, 'หัวข้อหน้าต่างเบิก');
  await page.fill('#dlg input[name="qty"]', '99');
  await page.click('#dlg button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('#dlg-err') && document.querySelector('#dlg-err').innerText.indexOf('ใส่ไม่เกินนี้') >= 0);
  await page.fill('#dlg input[name="qty"]', '2');
  await page.fill('#dlg input[name="job"]', 'JOB-P1');
  await page.click('#dlg button[type="submit"]');
  await page.waitForSelector('.page[data-page="docs"]');
  const dr = await state((s) => Object.values(s.tables.documents).find((d) => d.type === 'PD' && d.status === 'DRAFT'));
  assert(dr, 'ต้องมีร่าง PD');
  const l = dr.lines[0];
  assert(dr.lines.length === 1 && l.code === 'P1-001' && Number(l.qty) === 2 && l.wh === 'P1A' && l.bin === 'A-01' && l.status === 'AVAILABLE' && dr.job === 'JOB-P1', `ร่าง PD: ${JSON.stringify(dr)}`);
  await page.waitForFunction((no) => Array.from(document.querySelectorAll('#main h2')).some((x) => x.innerText.indexOf(no) >= 0), dr.docNo);
  const q = await state((s, R) => R.q.qty(s, { code: 'P1-001', wh: 'P1A', bin: 'A-01' }));
  assert(q === 5, 'ร่างต้องยังไม่ตัดยอด');
});

await step('stock: quick transfer checks the destination and creates a TR draft', async () => {
  await go('stock');
  await page.waitForSelector('#stk-detail');
  await page.locator('#stk-detail tr', { hasText: 'P1A/A-01' }).locator('button[data-act="move"]').click();
  await page.waitForSelector('#dlg:not([hidden]) .dlg-card');
  await page.selectOption('#dlg select[name="toWh"]', 'P1B');
  await page.fill('#dlg input[name="toBin"]', 'B-99');
  await page.fill('#dlg input[name="qty"]', '1');
  await page.click('#dlg button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('#dlg-err').innerText.indexOf('ไม่พบช่องเก็บ B-99 ในคลัง P1B') >= 0);
  await page.fill('#dlg input[name="toBin"]', '');
  await page.click('#dlg button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('#dlg-err').innerText.indexOf('คลัง P1B ต้องระบุช่องเก็บปลายทาง') >= 0);
  await page.fill('#dlg input[name="toBin"]', 'B-01');
  await page.click('#dlg button[type="submit"]');
  await page.waitForSelector('.page[data-page="docs"]');
  const tr = await state((s) => Object.values(s.tables.documents).find((d) => d.type === 'TR' && d.status === 'DRAFT'));
  assert(tr && tr.lines[0].toWh === 'P1B' && tr.lines[0].toBin === 'B-01' && Number(tr.lines[0].qty) === 1 && tr.lines[0].bin === 'A-01', `ร่าง TR: ${JSON.stringify(tr)}`);
});

await step('stock: wrong quantities are refused in the dialog, nothing is created', async () => {
  await asUser('P1STORE');
  await go('stock');
  await page.waitForSelector('#stk-detail');
  const before = await state((st) => Object.keys(st.tables.documents).length);
  const clearErr = () => page.evaluate(() => { document.querySelector('#dlg-err').innerHTML = ''; });
  await page.locator('#stk-detail tr', { hasText: 'P1A/A-01' }).locator('button[data-act="issue"]').click();
  await dlgOpen();
  await page.click('#dlg button[type="submit"]');
  await dlgError('ใส่จำนวนเป็นตัวเลขมากกว่า 0');
  for (const q of ['0', '-2']) {
    await clearErr();
    await page.fill('#dlg input[name="qty"]', q);
    await page.click('#dlg button[type="submit"]');
    await dlgError('ใส่จำนวนเป็นตัวเลขมากกว่า 0');
  }
  // letters: browsers that let people type them into a number box send them as they are
  await clearErr();
  await page.evaluate(() => { const i = document.querySelector('#dlg input[name="qty"]'); i.type = 'text'; i.value = 'สิบ'; });
  await page.click('#dlg button[type="submit"]');
  await dlgError('ใส่จำนวนเป็นตัวเลขมากกว่า 0');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#dlg', { state: 'hidden' });
  await page.locator('#stk-detail tr', { hasText: 'P1A/A-01' }).locator('button[data-act="move"]').click();
  await dlgOpen();
  await page.fill('#dlg input[name="qty"]', '1');
  await page.fill('#dlg input[name="toBin"]', 'a-01');
  await page.click('#dlg button[type="submit"]');
  await dlgError('ปลายทางเป็นที่เดียวกับต้นทาง');
  await clearErr();
  await page.selectOption('#dlg select[name="toWh"]', '');
  await page.click('#dlg button[type="submit"]');
  await dlgError('เลือกคลังปลายทาง');
  await page.click('#dlg .dlg-f .btn-ghost');
  await page.waitForSelector('#dlg', { state: 'hidden' });
  assert(await state((st) => Object.keys(st.tables.documents).length) === before, 'ข้อมูลผิดต้องไม่สร้างเอกสาร');
  assert(await state((st, R) => R.q.qty(st, { code: 'P1-001', wh: 'P1A', bin: 'A-01' })) === 5, 'ยอดต้องไม่เปลี่ยน');
});

await step('stock: draft buttons follow the person: warehouse limits and draft-only roles', async () => {
  await asUser('P1STOREA');
  await go('stock');
  await page.waitForSelector('#stk-detail');
  const other = page.locator('#stk-detail tr', { hasText: 'P1B/B-01' });
  assert(await other.locator('button[data-act="issue"]').isDisabled(), 'สโตร์คลัง A ต้องกดเบิกคลัง P1B ไม่ได้');
  assert((await other.locator('button[data-act="issue"]').getAttribute('title')).indexOf('ไม่มีสิทธิ์ทำเอกสารคลัง P1B') >= 0, 'ต้องบอกเหตุผลที่กดไม่ได้');
  assert(!(await page.locator('#stk-detail tr', { hasText: 'P1A/A-01' }).locator('button[data-act="issue"]').isDisabled()), 'คลัง A ต้องกดเบิกได้');
  // a planner may start an issue draft but not post it: the screen says who posts it
  await asUser('P1PLAN');
  await go('stock');
  await page.waitForSelector('#stk-detail');
  await waitText('คุณสร้างร่างได้ แต่ตัดยอดไม่ได้');
  await page.locator('#stk-detail tr', { hasText: 'P1A/A-01' }).locator('button[data-act="issue"]').click();
  await dlgOpen();
  await page.fill('#dlg input[name="qty"]', '1');
  await page.click('#dlg button[type="submit"]');
  await page.waitForSelector('.page[data-page="docs"]');
  await page.waitForFunction(() => document.querySelector('#toasts').innerText.indexOf('แจ้งสโตร์ / หัวหน้าสโตร์ให้ตรวจและกด บันทึก') >= 0);
  assert(await page.locator('#main button[data-act="post"]').count() === 0, 'ผู้วางแผนต้องไม่มีปุ่มบันทึกเปลี่ยนยอด');
  assert(await state((st, R) => R.q.qty(st, { code: 'P1-001', wh: 'P1A', bin: 'A-01' })) === 5, 'ร่างต้องยังไม่ตัดยอด');
});

await step('stock: viewer sees no draft buttons', async () => {
  await asUser('P1VIEW');
  await go('stock');
  await page.waitForSelector('#stk-detail');
  assert(await page.locator('#stk-detail button[data-act="issue"]').count() === 0, 'ผู้ดูอย่างเดียวต้องไม่เห็นปุ่มเบิก');
  assert(await page.locator('#stk-detail button[data-act="move"]').count() === 0, 'ผู้ดูอย่างเดียวต้องไม่เห็นปุ่มโอน');
});

await step('history: item card, totals, reversal marker', async () => {
  await must('doc.cancel', { docNo: qcDoc, reason: 'ทดสอบยกเลิกเอกสาร' });
  await asUser('P1LEAD');
  await go('history');
  await page.fill('#his-code', 'P1-001');
  await waitText('บัตรสินค้า P1-001');
  const foot = await page.evaluate(() => Array.from(document.querySelectorAll('#his-list tfoot td')).map((x) => x.innerText.trim()));
  assert(foot[0] === 'รวม 4 รายการ' && foot[6] === '10' && foot[7] === '2', `ยอดรวม: ${foot.join(' | ')}`);
  assert(await kpi('รวมรับเข้า') === '10' && await kpi('รวมจ่ายออก') === '2' && await kpi('สุทธิ (รับ − จ่าย)') === '+8', 'KPI รวมรับ/จ่าย');
  await waitText(`กลับรายการ`);
  await waitText(`${qcDoc} บรรทัด 1`);
  await waitText('ถูกกลับรายการแล้ว');
  const first = await page.evaluate(() => Array.from(document.querySelector('#his-list tbody tr').children).map((x) => x.innerText.trim()));
  assert(first[7] === '2' && first[11].indexOf('กลับรายการ') >= 0, `แถวล่าสุดควรเป็นรายการกลับ: ${first.join(' | ')}`);
  await page.fill('#his-doc', openingDoc);
  await page.waitForFunction(() => (document.querySelector('#his-list tfoot td') || {}).innerText === 'รวม 2 รายการ');
  await page.fill('#his-doc', '');
  await page.waitForFunction(() => (document.querySelector('#his-list tfoot td') || {}).innerText === 'รวม 4 รายการ');
  await shot('desktop-history-card');
});

await step('history: type and date filters, CSV of the filtered rows', async () => {
  await page.click('#main button[data-act="clear"]');
  await page.waitForFunction(() => document.querySelector('#his-code').value === '');
  await page.selectOption('#his-type', 'AJ');
  await page.fill('#his-from', '2026-11-01');
  await page.fill('#his-to', '2026-11-01');
  await page.waitForFunction(() => document.querySelector('#his-to').value === '2026-11-01' && document.querySelector('#his-from').value === '2026-11-01');
  const docs = await page.evaluate(() => Array.from(document.querySelectorAll('#his-list tbody tr')).map((r) => r.children[1].innerText));
  assert(docs.length === 4, `ช่วงวันที่ยอดตั้งต้นควรมี 4 รายการ ได้ ${docs.length}`);
  assert(docs.every((x) => x.indexOf(openingDoc) >= 0), 'ทุกแถวต้องเป็นใบยอดตั้งต้น');
  await page.click('#main button[data-act="csv"]');
  await page.waitForSelector('#dlg:not([hidden]) textarea');
  const csv = await page.inputValue('#dlg textarea');
  const lines = csv.replace(/^﻿/, '').trim().split(/\r?\n/);
  assert(lines[0].indexOf('วันที่ (พ.ศ.)') >= 0 && lines[0].indexOf('คงเหลือ ณ ตำแหน่ง') >= 0, 'หัว CSV');
  assert(lines.length === 5 && lines.slice(1).every((x) => x.indexOf(openingDoc) >= 0 && x.indexOf('01/11/2569') === 0), `CSV ต้องมีเฉพาะแถวตามตัวกรอง: ${lines.length}`);
  await page.click('#dlg button[type="submit"]');
  await page.waitForSelector('#dlg', { state: 'hidden' });
  await page.locator('#his-list tbody tr a[data-go="docs"]').first().click();
  await page.waitForSelector('.page[data-page="docs"]');
  await page.waitForFunction((no) => Array.from(document.querySelectorAll('#main h2')).some((x) => x.innerText.indexOf(no) >= 0), openingDoc);
});

await step('phone width with data', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await go('stock');
  await page.waitForSelector('#stk-list');
  await noOverflow('stock ตามตำแหน่ง');
  await page.click('#main button.tab[data-arg="item"]');
  await page.waitForSelector('#stk-detail');
  await noOverflow('stock ตามสินค้า + รายละเอียด');
  await shot('phone-stock-item');
  await go('history');
  await page.waitForSelector('#his-list');
  await noOverflow('history');
  await shot('phone-history');
  await go('opening');
  await waitText(' · ผลตรวจ'); // the screen keeps the file it checked last
  await noOverflow('opening ผลตรวจ (ไฟล์ซ้ำ)');
  await page.click('#main button[data-act="restart"]');
  await page.waitForSelector('#op-text');
  await page.fill('#op-text', BAD_CSV);
  await page.click('form[data-form="read"] button[type="submit"]');
  await checkedAs(1);
  await noOverflow('opening ผลตรวจ');
  await page.click(`#main tr[data-act="pickDoc"][data-arg="${openingDoc}"]`);
  await waitText(`กระทบยอด ${openingDoc}`);
  await noOverflow('opening กระทบยอด');
  if (shots) await page.screenshot({ path: path.join(shots, 'phone-opening-check.png'), fullPage: true });
});

await step('user text is shown as text, never as HTML', async () => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const evil = '<img id="p1xss" src="x" onerror="window.__p1xss=1">';
  await must('item.upsert', { code: 'P1-XSS', name: evil, baseUnit: 'ชิ้น', type: 'BUY', group: evil });
  await must('doc.post', { type: 'AJ', remark: evil, job: evil, lines: [{ code: 'P1-XSS', qty: 1, wh: 'P1A', bin: 'A-01', remark: evil }] });
  await asUser('P1LEAD');
  await go('stock');
  await page.fill('#stk-q', 'P1-XSS');
  await page.waitForFunction(() => document.querySelectorAll('#stk-list tbody tr').length === 1);
  await page.click('#stk-list tbody tr');
  await page.waitForSelector('#stk-detail');
  await waitText(evil);
  await page.click('#main button[data-act="clear"]');
  await go('history');
  await page.fill('#his-code', 'P1-XSS');
  await waitText('บัตรสินค้า P1-XSS');
  await waitText(evil);
  await go('opening');
  if (await page.locator('#main button[data-act="restart"]').count()) await page.click('#main button[data-act="restart"]');
  await page.waitForSelector('#op-text');
  await page.fill('#op-text', `รหัสสินค้า,คลัง,ช่องเก็บ,ล็อต,จำนวน,หน่วย\n"${evil.replace(/"/g, '""')}",P1A,A-01,,1,\nP1-XSS,P1A,A-01,,1,"${evil.replace(/"/g, '""')}"`);
  await page.fill('#op-name', evil);
  await page.click('form[data-form="read"] button[type="submit"]');
  await checkedAs(1);
  await waitText(`ไม่พบรหัส ${evil}`);
  await page.waitForTimeout(300);
  const hit = await page.evaluate(() => !!document.querySelector('#p1xss') || window.__p1xss === 1);
  assert(!hit, 'ข้อความผู้ใช้ถูกแปลงเป็น HTML');
  await page.click('#main button[data-act="restart"]');
  await page.fill('#op-name', '');
  await page.click('#stk-q').catch(() => {});
});

await step('opening: cancel with a reason, then the same file can be posted again', async () => {
  await asUser('P1LEAD');
  await go('opening');
  await page.click(`#main tr[data-act="pickDoc"][data-arg="${openingDoc}"]`);
  await waitText(`กระทบยอด ${openingDoc}`);
  await page.locator('#main a[data-go="docs"]', { hasText: openingDoc }).first().click();
  await page.waitForSelector('.page[data-page="docs"]');
  await page.click('#main button[data-act="cancel"]');
  await dlgOpen();
  await page.click('#dlg button[type="submit"]');
  await dlgError('ระบุเหตุผลการยกเลิก');
  assert(await state((st, _R, no) => st.tables.documents[no].status, openingDoc) === 'POSTED', 'ไม่มีเหตุผลต้องยังไม่ยกเลิก');
  await page.fill('#dlg input[name="reason"]', 'นับผิด ' + EVIL);
  await page.click('#dlg button[type="submit"]');
  await page.waitForSelector('#dlg', { state: 'hidden' });
  assert(await state((st, _R, no) => st.tables.documents[no].status, openingDoc) === 'CANCELLED', 'ต้องยกเลิกแล้ว');
  await go('opening');
  await page.click(`#main tr[data-act="pickDoc"][data-arg="${openingDoc}"]`);
  await waitText('ใบนี้ถูกยกเลิกแล้ว');
  await waitText('นับผิด ' + EVIL);
  const txt = await mainText();
  assert(txt.indexOf('ขั้นสุดท้ายก่อนเริ่มใช้งานจริง') < 0 && txt.indexOf('ยอดหลังบันทึกตรงกับไฟล์ทุกรายการ') < 0, 'ใบที่ยกเลิกต้องไม่ชวนให้ทดสอบกู้คืนหรือบอกว่ายอดตรง');
  // exactly the same content and reference as the cancelled one
  if (await page.locator('#main button[data-act="restart"]').count()) await page.click('#main button[data-act="restart"]');
  await page.fill('#op-text', GOOD_CSV);
  await page.fill('#op-name', 'ใบนับ P1 ทดสอบ');
  await page.click('form[data-form="read"] button[type="submit"]');
  await checkedAs(2);
  await page.check('#op-ack');
  await page.waitForFunction(() => document.querySelector('#op-post') && !document.querySelector('#op-post').disabled);
  await page.click('#op-post');
  await dlgOpen();
  await page.click('#dlg button[type="submit"]');
  await waitText('ขั้น 3 · กระทบยอด');
  await waitText('ยอดหลังบันทึกตรงกับไฟล์ทุกรายการ');
  const ajs = await state((st) => Object.values(st.tables.documents).filter((d) => String(d.source || '').indexOf('opening:') === 0).map((d) => [d.docNo, d.status]));
  const live = ajs.filter((x) => x[1] === 'POSTED');
  assert(ajs.length === 2 && live.length === 1 && live[0][0] !== openingDoc, `ต้องมีใบใหม่ 1 ใบ: ${JSON.stringify(ajs)}`);
  const q = await state((st, R) => [R.q.qty(st, { code: 'P1-001' }), R.q.qty(st, { code: 'P1-002' }), R.q.qty(st, { code: 'P1-LOT', lot: 'H-778' }), R.q.qty(st, { code: 'P1-001', wh: 'P1B', bin: 'B-01' })]);
  assert(JSON.stringify(q) === '[8,200,4,3]', `ยอดหลังบันทึกใหม่ ${JSON.stringify(q)}`);
  openingDoc = live[0][0];
  await waitText(`ขั้น 3 · กระทบยอด ${openingDoc}`);
});

await step('opening: a serial number already in stock cannot be counted again', async () => {
  await must('doc.post', { type: 'AJ', remark: 'ทดสอบ Serial', lines: [{ code: 'P1-SN', qty: 1, wh: 'P1A', bin: 'A-01', lot: 'SN-9' }] });
  await page.click('#main button[data-act="restart"]');
  await page.fill('#op-text', 'รหัสสินค้า,คลัง,ช่องเก็บ,ล็อต,จำนวน,หน่วย\nP1-SN,P1B,B-01,SN-9,1,\nP1-SN,P1A,A-01,SN-9,1,');
  await page.click('form[data-form="read"] button[type="submit"]');
  await checkedAs(1);
  await waitText('Serial SN-9 ของ P1-SN มีในระบบแล้วที่ P1A/A-01 – ตรวจว่าไม่ได้นับซ้ำ');
  assert(await kpi('ต้องแก้') === '2', `ต้องแก้ ${await kpi('ต้องแก้')}`);
  await page.click('#main button[data-act="restart"]');
});

await step('history: partial codes, swapped dates, transfers in the totals, user names as text', async () => {
  await must('user.upsert', { id: 'P1EVIL', name: 'หัวหน้า ' + EVIL, roles: ['store_lead'] });
  await must('doc.post', { type: 'TR', lines: [{ code: 'P1-001', qty: 1, wh: 'P1A', bin: 'A-01', toWh: 'P1B', toBin: 'B-01' }] }, 'P1EVIL');
  await asUser('P1LEAD');
  await go('history');
  if (await page.locator('#main .toolbar button[data-act="clear"]').count()) await page.click('#main .toolbar button[data-act="clear"]');
  await page.fill('#his-code', 'P1-00');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('#main .note.n-info')).some((n) => n.innerText.indexOf('ไม่พบรหัส "P1-00" ตรงตัว') >= 0));
  const codes = await page.evaluate(() => Array.from(new Set(Array.from(document.querySelectorAll('#his-list tbody tr')).map((r) => r.children[2].querySelector('.code').innerText))));
  assert(codes.indexOf('P1-001') >= 0 && codes.indexOf('P1-002') >= 0 && codes.indexOf('P1-LOT') < 0, `รหัสที่ขึ้นต้น P1-00: ${codes}`);
  await page.fill('#his-code', 'P1-001');
  await waitText('บัตรสินค้า P1-001');
  await waitText('รวมรับ/จ่ายนับการโอนย้ายและการเปลี่ยนสถานะคุณภาพ');
  await waitText('หัวหน้า ' + EVIL);
  await page.selectOption('#his-type', 'AJ');
  await waitGone('รวมรับ/จ่ายนับการโอนย้าย');
  await page.click('#main button[data-act="clear"]');
  await page.fill('#his-from', '2099-12-31');
  await page.fill('#his-to', '2026-11-01');
  await waitText('วันที่เริ่มอยู่หลังวันที่สิ้นสุด – แสดงช่วงที่สลับให้ถูกแล้ว');
  assert(await page.locator('#his-list tbody tr').count() > 0, 'ช่วงที่สลับแล้วต้องมีรายการ');
  await page.fill('#his-to', '2026-10-01');
  await page.fill('#his-from', '2026-10-01');
  await waitText('ไม่พบรายการตามตัวกรอง');
  assert(await page.locator('#main button[data-act="csv"]').isDisabled(), 'ไม่มีแถว ต้องกดดาวน์โหลดไม่ได้');
  await page.click('#main .empty button[data-act="clear"]');
  await page.waitForSelector('#his-list');
  await shot('desktop-history-notes');
});

await step('lots of data: capped lists scroll in their box, size limit of one AJ', async () => {
  const N = 400;
  const code = (i) => `P1-BULK-${String(i).padStart(4, '0')}`;
  const items = [];
  for (let i = 1; i <= N; i++) items.push({ code: code(i), name: `ทดสอบจำนวนมาก ${i}`, baseUnit: 'ชิ้น', type: 'BUY', group: 'กลุ่มทดสอบจำนวนมาก' });
  await must('master.import', { items });
  const lines = [];
  for (let i = 1; i <= N; i++) lines.push({ code: code(i), qty: i, wh: 'P1A', bin: 'A-01' });
  await must('doc.post', { type: 'AJ', remark: 'ทดสอบข้อมูลจำนวนมาก', lines });
  await page.setViewportSize({ width: 1366, height: 900 });
  await asUser('P1LEAD');
  await go('stock');
  await page.click('#main button.tab[data-arg="item"]');
  await page.waitForFunction(() => document.querySelector('#main button.tab.on').dataset.arg === 'item');
  if (await page.locator('#stk-detail').count()) await page.click('#stk-detail button[data-act="close"]');
  await page.waitForSelector('#stk-list');
  assert(await page.locator('#stk-list tbody tr').count() === 300, 'รายการยาวต้องแสดงทีละ 300 แถว');
  await waitText('แสดง 300 จาก');
  const box = await page.evaluate(() => { const b = document.querySelector('#stk-list'); return [b.scrollHeight, b.clientHeight]; });
  assert(box[0] > box[1] + 50, `ตารางต้องเลื่อนในกรอบของตัวเอง ${box}`);
  await page.click('#main button[data-act="more"]');
  await page.waitForFunction(() => document.querySelectorAll('#stk-list tbody tr').length > 300);
  await go('history');
  if (await page.locator('#main .toolbar button[data-act="clear"]').count()) await page.click('#main .toolbar button[data-act="clear"]');
  await page.waitForFunction(() => document.querySelectorAll('#his-list tbody tr').length === 300);
  await waitText('แสดงเพิ่มอีก');
  await go('opening');
  if (await page.locator('#main button[data-act="restart"]').count()) await page.click('#main button[data-act="restart"]');
  await page.waitForSelector('#op-text');
  const csv = ['รหัสสินค้า,คลัง,ช่องเก็บ,ล็อต,จำนวน,หน่วย'];
  for (let i = 1; i <= N; i++) csv.push(`${code(i)},P1A,A-02,,${i},`);
  await page.fill('#op-text', csv.join('\n'));
  await page.fill('#op-name', 'ไฟล์ใหญ่');
  await page.click('form[data-form="read"] button[type="submit"]');
  await checkedAs(2);
  assert(await kpi('ผ่าน') === String(N), `ผ่าน ควรเป็น ${N}`);
  await waitText('ใหญ่เกินกว่าจะบันทึกเป็นใบเดียว');
  assert(await page.isDisabled('#op-post'), 'ไฟล์เกินขนาดต้องกดบันทึกไม่ได้');
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow('opening ไฟล์ใหญ่');
  await go('stock');
  await page.waitForSelector('#stk-list');
  await noOverflow('stock ข้อมูลมาก');
  await go('history');
  await page.waitForSelector('#his-list');
  await noOverflow('history ข้อมูลมาก');
});

await browser.close();
if (problems.length) {
  console.log('PROBLEMS\n' + problems.join('\n'));
  process.exit(1);
}
console.log('p1 ok');
