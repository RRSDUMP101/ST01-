// Browser test of the Phase 3 screens นำเข้าและกระทบยอด Express (express) and ตรวจนับ (counts).
//   RRS_OUT=/tmp/stockqc-p3 node tests/e2e/p3.mjs [--shots dir]
// Starts from a clean demo page, creates its own master data (codes P3-…, warehouses P3A/P3B, users P3…) and drives the
// flows through the UI: Express file → column mapping → required snapshot time → import (no stock change, a repeated
// file refused) → review with filters → explain / bulk explain / close (quantity owned by RRS) → adjust when Express owns
// the quantity → older file needs confirmOld → discard and re-import → documents waiting to be keyed; counts: open a
// session, blind phone entry, recount by another person (RECOUNT / DUPLICATE / RECOUNTED), a movement after counting,
// submit, approval with reasons + acknowledgement → one AJ, freeze mode refusing documents, cancel with a reason,
// permissions per role, escaped user text, lots of rows and phone width.
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
// an alert/confirm/prompt means user text ran as code (or a page used a browser dialog instead of ctx.dialog)
page.on('dialog', async (d) => { problems.push(`browser dialog (${current}): ${d.type()} ${d.message()}`); await d.dismiss().catch(() => {}); });

// ---- helpers ------------------------------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ready = () => page.waitForFunction(() => window.RRS && window.RRS.app && window.RRS.app.loading === false && window.RRS.app.ledger, null, { timeout: 60000 });
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
async function asUser(id) {
  await page.selectOption('#who-sel', id);
  await page.waitForFunction((x) => document.querySelector('#who-sel') && document.querySelector('#who-sel').value === x, id);
}
const mainText = () => page.locator('#main').innerText();
async function waitText(text, timeout) {
  await page.waitForFunction((x) => document.querySelector('#main').innerText.indexOf(x) >= 0, text, { timeout: timeout || 6000 })
    .catch(async () => { throw new Error(`ไม่พบข้อความ "${text}" ในหน้า\n---\n${(await mainText()).slice(0, 1500)}`); });
}
async function waitToast(text) {
  await page.waitForFunction((x) => document.querySelector('#toasts').innerText.indexOf(x) >= 0, text, { timeout: 6000 })
    .catch(async () => { throw new Error(`ไม่พบข้อความแจ้ง "${text}" – มี "${await page.locator('#toasts').innerText()}"`); });
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
async function dlgOpen() {
  await page.waitForSelector('#dlg:not([hidden]) .dlg-card');
}
async function dlgSubmit() {
  await page.click('#dlg .dlg-f button[type="submit"]');
}
async function dlgClosed() {
  await page.waitForSelector('#dlg[hidden]', { state: 'attached', timeout: 6000 });
}
async function dlgError(text) {
  await page.waitForFunction((x) => document.querySelector('#dlg-err') && document.querySelector('#dlg-err').innerText.indexOf(x) >= 0, text, { timeout: 4000 })
    .catch(async () => { throw new Error(`หน้าต่างควรบอก "${text}" ได้ "${await page.locator('#dlg-err').innerText().catch(() => '')}"`); });
}
/** Confirm box of ctx.confirm: wait, check its message, press the confirm button. */
async function confirmBox(text) {
  await dlgOpen();
  if (text) {
    const msg = await page.locator('#dlg .dlg-b').innerText();
    assert(msg.indexOf(text) >= 0, `หน้าต่างยืนยันควรบอก "${text}" ได้ "${msg}"`);
  }
  await dlgSubmit();
  await dlgClosed();
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
/** Now as the time of an Express file, typed the way the screen takes it (Thai time, seconds). */
const thaiNow = (offsetMs) => new Date(Date.now() + (offsetMs || 0) + 7 * 3600e3).toISOString().slice(0, 19);
const csvFile = (name, lines) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(lines.join('\r\n') + '\r\n', 'utf8') });
const qtyAt = (f) => state((s, R, a) => R.q.qty(s, a), f);
const batchOf = (fileName) => state((s, R, n) => Object.values(s.tables.express_batches || {}).filter((b) => b.fileName === n)
  .sort((a, b) => b.importedAt.localeCompare(a.importedAt))[0] || null, fileName);
const recRow = (batchId, key) => state((s, R, a) => (R.reconcile.reconcile(s, a[0]).rows.find((r) => r.key === a[1]) || null), [batchId, key]);
async function openBatch(id) {
  await go('express');
  if (await page.locator('#main .tabs button[data-arg="batches"]').count()) await page.click('#main .tabs button[data-arg="batches"]');
  await page.click(`#ex-batches tbody tr[data-arg="${id}"]`);
  await page.waitForSelector('#ex-review');
}
/** Pick a file on the import tab, wait for the mapping. */
async function pickFile(f) {
  await go('express');
  await page.click('#main .tabs button[data-arg="import"]');
  await page.waitForSelector('#ex-file');
  await page.setInputFiles('#ex-file', f);
  await page.waitForSelector('#ex-map');
}
async function importFile(f, snap) {
  await pickFile(f);
  await page.fill('#ex-snap', snap);
  await page.click('#ex-import');
  await confirmBox('ยอดคงเหลือไม่เปลี่ยน');
  await page.waitForSelector('#ex-review');
}
async function openSession(id) {
  await go('counts');
  if (await page.locator('#main .tabs button[data-arg="all"]').count()) await page.click('#main .tabs button[data-arg="all"]');
  await page.click(`#ct-list tbody tr[data-arg="${id}"]`);
  await page.waitForSelector('#ct-detail');
}
/** One line on the phone count form. */
async function countLine(code, bin, counted, lot) {
  await page.fill('#ce-code', code);
  // the code is looked up as it is typed (item name, lot field when the item tracks lots)
  await page.waitForFunction((c) => {
    const el = document.querySelector('#ce-code');
    const hint = el && el.closest('.fld').querySelector('.hint');
    return el && el.value === c && hint && hint.innerText.indexOf(c) >= 0;
  }, code, { timeout: 4000 });
  if (bin != null) await page.selectOption('#ce-bin', bin);
  if (lot != null) {
    await page.waitForSelector('#ce-lot');
    await page.fill('#ce-lot', lot);
  }
  await page.fill('#ce-qty', String(counted));
  await page.click('form[data-form="enter"] button[type="submit"]');
}

// ---- start from a clean page ------------------------------------------------------------------------------------
await page.goto(file);
await ready();
await page.evaluate(() => localStorage.clear());
await page.reload();
await ready();

const EVIL = '<img src=x onerror=alert(1)>';
const ADMIN = await state((s) => Object.values(s.tables.users || {}).find((u) => u.roles.indexOf('admin') >= 0 && u.active !== false).id);
let rrDoc = '';
let S1 = '';
let b1 = '';
let b2 = '';
let b3 = '';
let ct = '';
const FILE1 = [
  'รายงานสินค้าคงเหลือ แยกตามคลัง',
  'บริษัท ทดสอบ P3 จำกัด,,,,',
  'รหัสสินค้า,ชื่อสินค้า,คลัง,ยอดคงเหลือ,หน่วยนับ',
  'P3-001,ฝาข้าง,P3X,12,ชิ้น',
  'EXP3-002,แผ่นพื้น,P3X,5,',
  'P3-UNKNOWN,ไม่มีในทะเบียน,P3X,2,',
  'P3-001,ฝาข้าง,P3Y,4,ชิ้น',
  ',รวมทั้งสิ้น,,23,',
];

await step('empty states', async () => {
  const empty = await state((s) => !Object.keys(s.tables.express_batches || {}).length && !Object.keys(s.tables.count_sessions || {}).length);
  if (!empty) return; // sample data present (fixture build) – the smoke test covers those pages
  await go('express');
  await waitText('ยังไม่มีไฟล์ Express ที่นำเข้า');
  await waitText('การนำเข้าไม่เปลี่ยนยอดคงเหลือ');
  assert(await page.locator('#main button:has-text("นำเข้าไฟล์แรก")').count() === 1, 'ควรมีปุ่ม นำเข้าไฟล์แรก');
  await page.click('#main .tabs button[data-arg="pending"]');
  await waitText('เอกสารรอคีย์ Express');
  await go('counts');
  await waitText('ยังไม่มีรอบตรวจนับ');
  assert(await page.locator('#main button:has-text("เปิดรอบนับแรก")').count() === 1, 'ควรมีปุ่ม เปิดรอบนับแรก');
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow('counts ว่าง');
  await go('express');
  await noOverflow('express ว่าง');
  await page.setViewportSize({ width: 1366, height: 900 });
});

await step('setup data', async () => {
  for (const [id, name, roles] of [['P3LEAD', 'หัวหน้าสโตร์ P3', ['store_lead']], ['P3ACC', 'บัญชี P3', ['accounting']], ['P3S1', 'สโตร์หนึ่ง', ['store']],
    ['P3S2', 'สโตร์สอง', ['store']], ['P3VIEW', 'ผู้ดู P3', ['viewer']]]) await must('user.upsert', { id, name, roles });
  await must('warehouse.upsert', { code: 'P3A', name: 'คลังทดสอบ P3A', expressCode: 'P3X' });
  await must('warehouse.upsert', { code: 'P3B', name: 'คลังทดสอบ P3B', expressCode: 'P3Y' });
  for (const [wh, code] of [['P3A', 'A-01'], ['P3A', 'A-02'], ['P3B', 'B-01']]) await must('bin.upsert', { wh, code, name: 'ชั้น ' + code });
  await must('item.upsert', { code: 'P3-001', name: 'ฝาข้าง P3', baseUnit: 'ชิ้น', type: 'PART' });
  await must('item.upsert', { code: 'P3-002', name: 'แผ่นพื้น P3', baseUnit: 'แผ่น', type: 'PART', expressCode: 'EXP3-002' });
  await must('item.upsert', { code: 'P3-LOT', name: 'เหล็กแผ่น P3', baseUnit: 'แผ่น', type: 'RM', trackLot: 'lot' });
  await must('item.upsert', { code: 'P3-EVIL', name: 'ชิ้นส่วน ' + EVIL, baseUnit: 'ชิ้น', type: 'PART' });
  const rr = await must('doc.post', { type: 'RR', ref: 'P3-SETUP', lines: [
    { code: 'P3-001', qty: 10, wh: 'P3A', bin: 'A-01' }, { code: 'P3-002', qty: 5, wh: 'P3A', bin: 'A-02' },
    { code: 'P3-EVIL', qty: 3, wh: 'P3A', bin: 'A-01' }, { code: 'P3-LOT', qty: 2, wh: 'P3A', bin: 'A-02', lot: 'L-77' },
    { code: 'P3-001', qty: 4, wh: 'P3B', bin: 'B-01' }] });
  rrDoc = rr.result.docNo;
  assert(rrDoc, 'ไม่ได้เลขที่ใบรับ');
  await sleep(1200);
  S1 = thaiNow();
  await sleep(1200);
  await must('doc.post', { type: 'OU', remark: 'ใช้ภายในหลังเวลาไฟล์', lines: [{ code: 'P3-001', qty: 3, wh: 'P3A', bin: 'A-01' }] });
  assert(await qtyAt({ code: 'P3-001', wh: 'P3A' }) === 7, 'P3-001 คลัง P3A ควรเหลือ 7');
});

await step('express: pick file, mapping, snapshot required, import changes no stock', async () => {
  await asUser('P3LEAD');
  await pickFile(csvFile('express-stock-P3.csv', FILE1));
  await waitText('2 · ตรวจไฟล์ express-stock-P3.csv');
  const sel = await page.evaluate(() => ['code', 'wh', 'qty', 'unit'].map((k) => document.querySelector('#ex-map-' + k).value));
  assert(sel.join(',') === '0,2,3,4', `จับคู่คอลัมน์ควรเป็น A,C,D,E ได้ ${sel}`);
  assert(await page.inputValue('#ex-head') === '2', 'แถวหัวตารางควรเป็นแถว 3');
  assert(await kpi('แถวที่จะนำเข้า') === '4', `แถวที่จะนำเข้า ควรเป็น 4 ได้ ${await kpi('แถวที่จะนำเข้า')}`);
  assert(await kpi('ไม่รู้จักรหัส') === '1', 'ไม่รู้จักรหัส ควรเป็น 1');
  assert(await kpi('ข้าม (ไม่มีรหัส)') === '1', 'ข้าม ควรเป็น 1 (แถวรวม)');
  const prev = await rowCells('#ex-preview tbody tr', 'EXP3-002');
  assert(prev && prev.join(' ').indexOf('P3-002') >= 0 && prev.join(' ').indexOf('P3A') >= 0, `แถว EXP3-002 ควรอ่านเป็น P3-002 คลัง P3A ได้ ${prev}`);
  // a wrong column is visible at once and can be changed back
  await page.selectOption('#ex-map-qty', '1');
  await waitText('ไม่ใช่ตัวเลข');
  assert(await page.isDisabled('#ex-import'), 'ยอดไม่ใช่ตัวเลขต้องนำเข้าไม่ได้');
  await page.selectOption('#ex-map-qty', '3');
  await page.waitForFunction(() => !document.querySelector('#ex-import').disabled);
  const before = await state((s) => JSON.stringify(s.tables.balances));
  // the time of the data is required
  await page.click('#ex-import');
  await waitText('ใส่วันเวลาของข้อมูลในไฟล์ก่อน');
  assert(!(await batchOf('express-stock-P3.csv')), 'ยังไม่ใส่เวลาต้องไม่นำเข้า');
  await page.fill('#ex-snap', S1);
  await page.click('#ex-import');
  await confirmBox('ยอดคงเหลือไม่เปลี่ยน');
  await page.waitForSelector('#ex-review');
  await waitToast('ยอดคงเหลือไม่เปลี่ยน');
  const b = await batchOf('express-stock-P3.csv');
  assert(b && b.status === 'REVIEW' && b.rows.length === 4, 'ควรมีรอบนำเข้า 4 แถว สถานะรอตรวจ');
  b1 = b.id;
  assert(Math.abs(Date.parse(b.snapshotAt) - Date.parse(S1 + '+07:00')) < 1000, `เวลาของข้อมูลควรเป็น ${S1} ได้ ${b.snapshotAt}`);
  assert(await state((s) => JSON.stringify(s.tables.balances)) === before, 'การนำเข้าต้องไม่เปลี่ยนยอดคงเหลือ');
  await shot('express-review');
});

await step('express: review shows Express / RRS at the snapshot / RRS now, filters and pending documents', async () => {
  await waitText(`รอบ ${b1}`);
  const facts = await page.locator('#ex-review .dl').innerText();
  assert(/แถวในไฟล์\s*4/.test(facts), `หัวรอบควรบอกแถวในไฟล์ 4 ได้ ${facts}`);
  // default filter: not decided yet
  const r1 = await rowCells('#ex-rec tbody tr', 'P3-001');
  assert(r1, 'ไม่พบแถว P3-001');
  const txt = r1.join(' | ');
  assert(/12/.test(r1[2]) && /10/.test(r1[3]) && /7/.test(r1[4]) && /\+2/.test(r1[5]), `P3-001: Express 12, ณ เวลาไฟล์ 10, ตอนนี้ 7, ต่าง +2 ได้ ${txt}`);
  assert(txt.indexOf('ยอดต่าง') >= 0 && txt.indexOf(rrDoc) >= 0, `P3-001 ควรเป็น ยอดต่าง และมีเอกสารยังไม่คีย์ ${rrDoc}: ${txt}`);
  await waitText('P3-UNKNOWN');
  await waitText('มีเฉพาะใน RRS');
  assert(await kpi('ยังไม่ตัดสิน') === '4', `ยังไม่ตัดสิน ควรเป็น 4 ได้ ${await kpi('ยังไม่ตัดสิน')}`);
  assert(await kpi('ตรงกัน') === '2', 'ตรงกัน ควรเป็น 2');
  await page.click('#main .tabs button[data-arg="MATCH"]');
  await page.waitForFunction(() => document.querySelectorAll('#ex-rec tbody tr').length === 2);
  assert((await mainText()).indexOf('EXP3-002') >= 0, 'แถวตรงกันควรบอกรหัสในไฟล์ EXP3-002');
  await page.click('#main .tabs button[data-arg="UNKNOWN_CODE"]');
  await page.waitForFunction(() => document.querySelectorAll('#ex-rec tbody tr').length === 1);
  await page.click('#main .tabs button[data-arg="all"]');
  await page.waitForFunction(() => document.querySelectorAll('#ex-rec tbody tr').length === 6);
  // user text is shown as text
  await waitText(EVIL);
  // search inside the batch
  await page.fill('#ex-rq', 'p3-lot');
  await page.waitForFunction(() => document.querySelectorAll('#ex-rec tbody tr').length === 1);
  await page.fill('#ex-rq', '');
  await page.waitForFunction(() => document.querySelectorAll('#ex-rec tbody tr').length === 6);
  // store lead imports but does not decide differences
  assert(await page.locator('#ex-rec button[data-act="resolve"]').count() === 0, 'หัวหน้าสโตร์ไม่มีสิทธิ์ตัดสินผลต่าง – ไม่ควรเห็นปุ่ม');
  assert(await page.locator('#ex-close').count() === 0, 'หัวหน้าสโตร์ไม่ควรเห็นปุ่มปิดรอบ');
});

await step('express: the same file again is refused', async () => {
  await pickFile(csvFile('สำเนา-express.csv', FILE1));
  await waitText('ไฟล์นี้นำเข้าแล้ว');
  await waitText(b1);
  assert(await page.isDisabled('#ex-import'), 'ไฟล์ซ้ำต้องกดนำเข้าไม่ได้');
  const hash = await state((s, R, id) => s.tables.express_batches[id].fileHash, b1);
  const again = await exec('express.import', { fileName: 'x.csv', fileHash: hash, snapshotAt: S1 + '+07:00', rows: [{ code: 'P3-001', wh: 'P3X', qty: 1 }] }, 'P3LEAD');
  assert(!again.ok && again.errors[0].code === 'DUPLICATE_FILE', 'เครื่องมือต้องปฏิเสธไฟล์ซ้ำ');
  await page.click('#main button[data-act="dropFile"]');
  await page.waitForSelector('#ex-map', { state: 'detached' });
});

await step('express: explain one difference (quantity owned by RRS), bulk explain, close', async () => {
  await asUser('P3ACC');
  await openBatch(b1);
  await page.click('#ex-rec tbody tr:has-text("P3-001") button[data-act="resolve"]');
  await dlgOpen();
  const body = await page.locator('#dlg .dlg-b').innerText();
  assert(body.indexOf('ปรับยอดจากไฟล์ไม่ได้') >= 0 && body.indexOf('ค-1') >= 0, `ควรบอกว่าปรับยอดไม่ได้เพราะข้อตกลง ค-1: ${body.slice(0, 300)}`);
  assert(await page.locator('#dlg input[name="action"][value="adjust"]').count() === 0, 'ยอดเป็นของ RRS – ต้องไม่มีตัวเลือกปรับยอด');
  await dlgSubmit();
  await dlgError('ใส่เหตุผล');
  await page.fill('#res-reason', `ใบรับ ${rrDoc} ยังไม่คีย์ Express`);
  await dlgSubmit();
  await dlgClosed();
  await waitToast('บันทึกคำอธิบายผลต่างแล้ว');
  const res = (await recRow(b1, 'P3-001|P3A')).resolution;
  assert(res && res.action === 'explain' && res.by === 'P3ACC', 'ควรบันทึกการอธิบายของ P3-001');
  assert(await page.isDisabled('#ex-close'), 'ยังมีรายการไม่ตัดสิน – ปิดรอบไม่ได้');
  await page.click('#main button[data-act="pickAll"]');
  await page.waitForSelector('#ex-bulk');
  assert((await page.locator('#ex-bulk').innerText()).indexOf('(3)') >= 0, 'ควรเลือกได้ 3 รายการที่เหลือ');
  await page.click('#ex-bulk');
  await dlgOpen();
  await page.fill('#bulk-reason', 'ตรวจแล้ว ต่างเพราะเวลาคีย์ Express');
  await dlgSubmit();
  await dlgClosed();
  await waitToast('บันทึกคำอธิบาย 3 รายการแล้ว');
  await page.waitForFunction(() => !document.querySelector('#ex-close').disabled);
  const stockBefore = await qtyAt({ code: 'P3-001' });
  await page.click('#ex-close');
  await confirmBox('หลังปิดแก้การตัดสินไม่ได้');
  await waitToast(`ปิดรอบ ${b1} แล้ว`);
  assert((await batchOf('express-stock-P3.csv')).status === 'CLOSED', 'รอบควรปิดแล้ว');
  assert(await qtyAt({ code: 'P3-001' }) === stockBefore, 'อธิบายผลต่างต้องไม่เปลี่ยนยอด');
  await waitText('ปิดรอบแล้วโดย');
});

await step('express: adjust to Express when it owns the quantity', async () => {
  await must('settings.update', { patch: { ownership: { qty: 'Express' } } });
  await sleep(1200);
  const snap = thaiNow();
  await asUser('P3LEAD');
  await importFile(csvFile('express-2.csv', ['รหัสสินค้า,คลัง,ยอดคงเหลือ', 'P3-001,P3X,9', 'P3-002,P3X,5']), snap);
  b2 = (await batchOf('express-2.csv')).id;
  assert(await page.inputValue('#ex-rq').catch(() => '') === '', 'ช่องค้นหาของรอบใหม่ควรว่าง');
  await asUser('P3ACC');
  await openBatch(b2);
  await waitText('ยอดจำนวนยึด Express');
  await page.click('#ex-rec tbody tr:has-text("P3-001") button[data-act="resolve"]');
  await dlgOpen();
  assert(await page.locator('#dlg input[name="action"][value="adjust"]').count() === 1, 'Express เป็นเจ้าของยอด – ต้องมีตัวเลือกปรับยอด');
  assert(await page.inputValue('#res-bin') === 'A-01', 'ช่องเก็บเริ่มต้นควรเป็นช่องที่มีของ A-01');
  await page.check('#dlg input[name="action"][value="adjust"]');
  await page.fill('#res-reason', 'ยึดยอด Express ตามข้อตกลง ค-1');
  await dlgSubmit();
  await dlgClosed();
  await waitToast('ปรับยอดแล้ว – ใบปรับยอด');
  assert(await qtyAt({ code: 'P3-001', wh: 'P3A' }) === 9, 'P3-001 คลัง P3A ควรเป็น 9 หลังปรับ');
  const res = (await recRow(b2, 'P3-001|P3A')).resolution;
  assert(res && res.action === 'adjust' && res.docNo, 'ควรมีใบปรับยอดในการตัดสิน');
  const doc = await state((s, R, no) => s.tables.documents[no], res.docNo);
  assert(doc.type === 'AJ' && doc.expressStatus === 'N/A' && doc.lines[0].bin === 'A-01', 'ใบ AJ ตาม Express ต้องไม่ต้องคีย์ซ้ำ และลงช่อง A-01');
  // the decided row leaves the 'not decided' filter; the batch header and the row (filter ตัดสินแล้ว) link to the AJ
  await waitText('ใบปรับยอดจากรอบนี้');
  await page.click('#main .tabs button[data-arg="resolved"]');
  await page.waitForSelector(`#ex-rec a[data-go="docs"]:has-text("${res.docNo}")`);
  await page.click(`#ex-review .dl a[data-go="docs"]:has-text("${res.docNo}")`);
  await page.waitForSelector('.page[data-page="docs"]');
  await waitText(res.docNo);
  // the batch with an adjustment cannot be discarded
  await openBatch(b2);
  await page.click('#ex-discard');
  await waitToast('ยกเลิกใบปรับยอดที่หน้าเอกสารก่อน');
});

await step('express: a file older than the newest closed batch needs confirmation', async () => {
  const old = new Date(Date.parse(S1 + 'Z') - 2 * 3600e3).toISOString().slice(0, 19);
  await asUser('P3LEAD');
  await importFile(csvFile('express-old.csv', ['รหัสสินค้า,คลัง,ยอดคงเหลือ', 'P3-002,P3X,6']), old);
  b3 = (await batchOf('express-old.csv')).id;
  await waitToast('เก่ากว่ารอบที่ปิดล่าสุด');
  await asUser('P3ACC');
  await openBatch(b3);
  await waitText('ไฟล์นี้เก่ากว่ารอบที่ปิดล่าสุด');
  await page.click('#ex-rec tbody tr:has-text("P3-002") button[data-act="resolve"]');
  await dlgOpen();
  await page.check('#dlg input[name="action"][value="adjust"]');
  await page.fill('#res-reason', 'ตรวจแล้ว ไฟล์เก่ายังถูกสำหรับรหัสนี้');
  await dlgSubmit();
  await dlgError('ยืนยันใช้ไฟล์ที่เก่ากว่า');
  await page.check('#res-old');
  await dlgSubmit();
  await dlgClosed();
  const res = (await recRow(b3, 'P3-002|P3A')).resolution;
  assert(res && res.action === 'adjust' && res.confirmOld === true, 'การปรับจากไฟล์เก่าต้องบันทึกการยืนยัน');
  assert(await qtyAt({ code: 'P3-002', wh: 'P3A' }) === 11, `P3-002 ควรเป็น 11 ได้ ${await qtyAt({ code: 'P3-002', wh: 'P3A' })}`);
  await waitText('ยืนยันใช้ไฟล์เก่า');
});

await step('express: discard a batch, then the same file can be imported again', async () => {
  const f4 = csvFile('express-P3Y.csv', ['รหัสสินค้า,คลัง,ยอดคงเหลือ', 'P3-001,P3Y,4']);
  await asUser('P3LEAD');
  await importFile(f4, thaiNow());
  const b4 = (await batchOf('express-P3Y.csv')).id;
  await page.click('#ex-discard');
  await dlgOpen();
  await dlgSubmit();
  await dlgError('ใส่เหตุผล');
  await page.fill('#discard-reason', 'เลือกไฟล์ผิดคลัง');
  await dlgSubmit();
  await dlgClosed();
  await waitText('ยกเลิกรอบโดย');
  assert((await state((s, R, id) => s.tables.express_batches[id].status, b4)) === 'DISCARDED', 'รอบควรถูกยกเลิก');
  await pickFile(f4);
  await waitText('แล้วยกเลิกรอบ – นำเข้าใหม่ได้');
  await page.fill('#ex-snap', thaiNow());
  await page.click('#ex-import');
  await confirmBox();
  await page.waitForSelector('#ex-review');
  const n = await state((s) => Object.values(s.tables.express_batches).filter((b) => b.fileName === 'express-P3Y.csv').length);
  assert(n === 2, 'ไฟล์ที่ยกเลิกรอบแล้วต้องนำเข้าใหม่ได้');
});

await step('express: documents waiting to be keyed in Express', async () => {
  await asUser('P3ACC');
  await go('express');
  await page.click('#main .tabs button[data-arg="pending"]');
  await page.waitForSelector('#ex-pending');
  const row = await rowCells('#ex-pending tbody tr', rrDoc);
  assert(row && row.join(' ').indexOf('RR') >= 0, `ใบรับ ${rrDoc} ควรอยู่ในรายการรอคีย์`);
  await page.click(`#ex-pending tbody tr:has-text("${rrDoc}") button[data-act="markExpress"]`);
  await dlgOpen();
  await dlgSubmit();
  await dlgError('ใส่เลขที่');
  await page.fill('#mx-no', 'EXP-RR-001');
  await dlgSubmit();
  await dlgClosed();
  await page.waitForFunction((no) => !document.querySelector('#ex-pending') || document.querySelector('#ex-pending').innerText.indexOf(no) < 0, rrDoc);
  assert((await state((s, R, no) => s.tables.documents[no].expressStatus, rrDoc)) === 'KEYED', 'ควรบันทึกเลขที่ Express แล้ว');
  // the link goes to the documents page
  const other = await state((s) => (window.RRS.reconcile.pendingExpress(s).wait[0] || {}).docNo || '');
  if (other) {
    await page.click(`#ex-pending a[data-go="docs"]:has-text("${other}")`);
    await page.waitForSelector('.page[data-page="docs"]');
    await waitText(other);
  }
});

await step('counts: open a session for a warehouse and bins', async () => {
  await asUser('P3LEAD');
  await go('counts');
  await page.click('#main button[data-act="newOpen"]');
  await page.waitForSelector('#ct-wh');
  await waitText('รับ–จ่ายได้ตามปกติระหว่างนับ');
  await waitText('ห้ามบันทึกเอกสารหรือรับโอนเข้า–ออกช่องที่นับ');
  await page.selectOption('#ct-wh', 'P3A');
  await page.waitForSelector('#ct-bins input[value="A-01"]');
  await page.check('#ct-bins input[value="A-01"]');
  await page.check('#ct-bins input[value="A-02"]');
  await page.check('#ct-mode input[value="timestamp"]');
  await page.fill('#ct-note', 'นับทดสอบ P3');
  await page.click('form[data-form="create"] button[type="submit"]');
  await waitToast('เปิดรอบนับ');
  ct = await state((s) => Object.values(s.tables.count_sessions).find((x) => x.wh === 'P3A' && x.status === 'OPEN').id);
  const s = await state((st, R, id) => st.tables.count_sessions[id], ct);
  assert(s.bins.join(',') === 'A-01,A-02' && s.mode === 'timestamp' && s.note === 'นับทดสอบ P3', `รอบนับควรเป็น A-01,A-02 timestamp ได้ ${JSON.stringify(s)}`);
  await page.waitForSelector('#ct-detail');
  await waitText(`รอบนับ ${ct}`);
});

await step('counts: blind phone entry, recount flag says who must recount', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await asUser('P3S1');
  await openSession(ct);
  await page.waitForSelector('#ce-code');
  await countLine('P3-001', 'A-01', 9);
  await waitToast('บันทึก P3-001 ช่อง A-01 = 9');
  await countLine('P3-002', 'A-02', 8);
  await waitText('ต้องให้คนอื่น (ไม่ใช่คุณ) นับซ้ำ');
  await countLine('P3-LOT', 'A-02', 2, 'L-77');
  await waitToast('ล็อต L-77');
  await countLine('P3-EVIL', 'A-01', 3);
  await waitToast('บันทึก P3-EVIL');
  await waitText('รอนับซ้ำ (1)');
  await waitText('คนอื่นที่ไม่ใช่ สโตร์หนึ่ง');
  await waitText('สโตร์สอง');
  const t = await mainText();
  assert(t.indexOf('ระบบ ณ เวลานับ') < 0, 'ผู้นับต้องไม่เห็นยอดในระบบ');
  assert(await page.isDisabled('#ct-recount button[data-act="recount"]'), 'ผู้นับคนเดิมกดนับซ้ำไม่ได้');
  assert(await page.isDisabled('#ct-submit'), 'ยังมีบรรทัดรอนับซ้ำ – ส่งผลนับไม่ได้');
  await noOverflow('counts กรอกผลนับ (มือถือ)');
  await shot('counts-phone-entry');
  // a code that is not in the register is refused with the reason
  await page.fill('#ce-code', 'P3-NOPE');
  await page.fill('#ce-qty', '1');
  await page.click('form[data-form="enter"] button[type="submit"]');
  await waitText('บันทึกไม่ได้');
  assert((await state((s, R, id) => s.tables.count_sessions[id].lines.length, ct)) === 4, 'รหัสผิดต้องไม่บันทึก');
});

await step('counts: recount by another person (disagree, then agree)', async () => {
  await asUser('P3S2');
  await openSession(ct);
  await page.click('#ct-recount tbody tr:has-text("P3-002") button[data-act="recount"]');
  await page.waitForFunction(() => document.querySelector('#ce-code') && document.querySelector('#ce-code').value === 'P3-002');
  assert(await page.inputValue('#ce-bin') === 'A-02', 'นับซ้ำควรเติมช่องเก็บให้');
  await page.fill('#ce-qty', '9');
  await page.click('form[data-form="enter"] button[type="submit"]');
  await waitText('ผลไม่ตรงกับการนับครั้งก่อน');
  // the same person cannot count the same line twice
  await countLine('P3-002', 'A-02', 8);
  await waitText('ต้องเป็นคนละคน');
  await asUser('P3LEAD');
  await openSession(ct);
  await page.click('#ct-recount tbody tr:has-text("P3-002") button[data-act="recount"]');
  await page.waitForFunction(() => document.querySelector('#ce-code').value === 'P3-002');
  await page.fill('#ce-qty', '8');
  await page.click('form[data-form="enter"] button[type="submit"]');
  await waitText('ตรงกับการนับก่อนหน้า ใช้ผลนี้');
  const l = await state((s, R, id) => s.tables.count_sessions[id].lines.find((x) => x.code === 'P3-002'), ct);
  assert(l.flags.indexOf('RECOUNTED') >= 0 && l.final && l.final.counted === 8, 'บรรทัด P3-002 ควรยืนยันด้วยการนับซ้ำ = 8');
  await page.waitForSelector('#ct-recount', { state: 'detached' });
  await page.setViewportSize({ width: 1366, height: 900 });
});

await step('counts: movement after counting, submit, approval needs reasons and acknowledgement', async () => {
  await must('doc.post', { type: 'RR', ref: 'หลังนับ', lines: [{ code: 'P3-001', qty: 2, wh: 'P3A', bin: 'A-01' }] });
  await asUser('P3S1');
  await openSession(ct);
  await page.waitForFunction(() => !document.querySelector('#ct-submit').disabled);
  await page.click('#ct-submit');
  await confirmBox('หลังส่งกรอกผลนับเพิ่มไม่ได้');
  await waitToast('รออนุมัติ');
  // someone who counted cannot approve
  await asUser('P3LEAD');
  await openSession(ct);
  await waitText('อนุมัติเองไม่ได้');
  assert(await page.locator('form[data-form="approve"]').count() === 0, 'ผู้นับต้องไม่เห็นฟอร์มอนุมัติ');
  await asUser('P3ACC');
  await openSession(ct);
  await page.waitForSelector('form[data-form="approve"]');
  assert(await kpi('ต้องปรับยอด') === '1', `ต้องปรับยอด ควรเป็น 1 ได้ ${await kpi('ต้องปรับยอด')}`);
  assert(await kpi('เคลื่อนไหวหลังนับ') === '1', 'เคลื่อนไหวหลังนับ ควรเป็น 1');
  const row = await rowCells('#ct-approve tbody tr', 'P3-002');
  assert(row && /11/.test(row[2]) && /8/.test(row[3]) && /-3/.test(row[4]), `P3-002: ระบบ 11 นับได้ 8 ปรับ -3 ได้ ${row}`);
  const moved = await rowCells('#ct-approve tbody tr', 'P3-001');
  assert(moved && moved.join(' ').indexOf('เคลื่อนไหวหลังนับ') >= 0, 'P3-001 ควรบอกว่าเคลื่อนไหวหลังนับ');
  await page.click('form[data-form="approve"] button[type="submit"]');
  await waitText('ใส่เหตุผล');
  await page.fill('#ct-r-0', 'แผ่นเสียหาย ทิ้งแล้วไม่ได้ตัดยอด');
  await page.click('form[data-form="approve"] button[type="submit"]');
  await waitToast('ติ๊ก รับทราบ');
  assert(await page.inputValue('#ct-r-0') === 'แผ่นเสียหาย ทิ้งแล้วไม่ได้ตัดยอด', 'เหตุผลที่พิมพ์ต้องไม่หาย');
  await page.check('#ct-ack');
  await page.click('form[data-form="approve"] button[type="submit"]');
  await confirmBox('ใบปรับยอด AJ 1 ใบ');
  await waitToast('สร้างใบปรับยอด');
  const s = await state((st, R, id) => st.tables.count_sessions[id], ct);
  assert(s.status === 'APPROVED' && s.docNo && s.approvedBy === 'P3ACC' && s.ack, 'รอบนับควรอนุมัติพร้อมใบ AJ และการรับทราบ');
  assert(await qtyAt({ code: 'P3-002', wh: 'P3A' }) === 8, 'P3-002 ควรเป็น 8 หลังอนุมัติ');
  assert(await qtyAt({ code: 'P3-001', wh: 'P3A' }) === 11, 'P3-001 ที่รับหลังนับต้องคงไว้ (11)');
  const doc = await state((st, R, no) => st.tables.documents[no], s.docNo);
  assert(doc.type === 'AJ' && doc.lines.length === 1 && doc.lines[0].remark.indexOf('แผ่นเสียหาย') >= 0, 'ใบ AJ ควรมี 1 บรรทัดพร้อมเหตุผล');
  await waitText('อนุมัติแล้วโดย บัญชี P3');
  await waitText('แผ่นเสียหาย ทิ้งแล้วไม่ได้ตัดยอด');
  await page.click(`#ct-detail a[data-go="docs"]:has-text("${s.docNo}")`);
  await page.waitForSelector('.page[data-page="docs"]');
  await waitText(s.docNo);
});

await step('counts: freeze mode stops documents, cancel with a reason', async () => {
  await asUser('P3LEAD');
  await go('counts');
  await page.click('#main button[data-act="newOpen"]');
  await page.selectOption('#ct-wh', 'P3B');
  await page.waitForSelector('#ct-bins');
  await page.check('#ct-mode input[value="freeze"]');
  await page.click('form[data-form="create"] button[type="submit"]');
  await waitToast('หยุดรับ–จ่าย');
  const fz = await state((s) => Object.values(s.tables.count_sessions).find((x) => x.wh === 'P3B' && x.status === 'OPEN'));
  assert(fz && fz.mode === 'freeze' && fz.bins.length === 0, 'รอบนับ P3B ควรเป็นแบบหยุดเคลื่อนไหวทั้งคลัง');
  await waitText('หยุดเคลื่อนไหว');
  assert(await kpi('หยุดเคลื่อนไหวอยู่') === '1', 'ควรมีพื้นที่ที่หยุดเคลื่อนไหว 1');
  const blocked = await exec('doc.post', { type: 'RR', lines: [{ code: 'P3-001', qty: 1, wh: 'P3B', bin: 'B-01' }] });
  assert(!blocked.ok && blocked.errors.some((e) => e.code === 'COUNT_FREEZE'), 'ระหว่างหยุดเคลื่อนไหวต้องบันทึกเข้า P3B ไม่ได้');
  await page.click('#ct-cancel');
  await dlgOpen();
  await dlgSubmit();
  await dlgError('ใส่เหตุผล');
  await page.fill('#ct-cancel-reason', 'เปิดรอบผิดวัน');
  await dlgSubmit();
  await dlgClosed();
  await waitText('ยกเลิกโดย หัวหน้าสโตร์ P3');
  assert((await state((s, R, id) => s.tables.count_sessions[id].status, fz.id)) === 'CANCELLED', 'รอบควรถูกยกเลิก');
  const after = await exec('doc.post', { type: 'RR', lines: [{ code: 'P3-001', qty: 1, wh: 'P3B', bin: 'B-01' }] });
  assert(after.ok, 'ยกเลิกรอบแล้วต้องบันทึกได้อีก');
});

await step('permissions: viewer and store see only what they can use', async () => {
  await asUser('P3VIEW');
  await go('express');
  await waitText('คุณดูผลกระทบยอดได้อย่างเดียว');
  assert(await page.locator('#main .tabs button[data-arg="import"]').count() === 0, 'ผู้ดูไม่ควรเห็นแท็บนำเข้า');
  await openBatch(b2);
  assert(await page.locator('#ex-rec button[data-act="resolve"]').count() === 0 && await page.locator('#ex-discard').count() === 0, 'ผู้ดูไม่ควรเห็นปุ่มตัดสิน/ยกเลิกรอบ');
  await go('counts');
  await waitText('คุณดูได้อย่างเดียว');
  assert(await page.locator('#main button[data-act="newOpen"]').count() === 0, 'ผู้ดูไม่ควรเห็นปุ่มเปิดรอบนับ');
  await asUser('P3S1');
  await go('counts');
  assert(await page.locator('#main button[data-act="newOpen"]').count() === 0, 'สโตร์เปิดรอบนับไม่ได้ – ไม่ควรเห็นปุ่ม');
  await go('express');
  assert(await page.locator('#main .tabs button[data-arg="import"]').count() === 0, 'สโตร์นำเข้าไม่ได้ – ไม่ควรเห็นแท็บ');
});

await step('lots of rows: tables scroll in their own box, phone width', async () => {
  const N = 650;
  const rows = [];
  for (let i = 1; i <= N; i++) rows.push({ row: i + 1, code: `P3-BIG-${String(i).padStart(4, '0')}`, wh: 'P3X', qty: i });
  const hash = await page.evaluate((n) => window.RRS.util.sha256('p3-big-' + n + '-' + Date.now()), N);
  const r = await must('express.import', { fileName: 'express-big.csv', fileHash: hash, snapshotAt: new Date(Date.now() - 60000).toISOString(), rows }, 'P3LEAD');
  await asUser('P3ACC');
  await openBatch(r.result.batchId);
  await page.waitForFunction(() => document.querySelectorAll('#ex-rec tbody tr').length === 300);
  await waitText('แสดง 300 จาก');
  const box = await page.evaluate(() => { const b = document.querySelector('#ex-rec'); return [b.scrollHeight, b.clientHeight]; });
  assert(box[0] > box[1] + 50, `ตารางต้องเลื่อนในกรอบของตัวเอง ${box}`);
  await page.click('#ex-review button[data-act="more"]');
  await page.waitForFunction(() => document.querySelectorAll('#ex-rec tbody tr').length > 300);
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow('express รอบใหญ่ (มือถือ)');
  await page.click('#main .tabs button[data-arg="pending"]');
  await page.waitForSelector('#ex-pending');
  await noOverflow('express รอคีย์ (มือถือ)');
  await openSession(ct);
  await noOverflow('counts อนุมัติแล้ว (มือถือ)');
  await go('counts');
  await noOverflow('counts รายการ (มือถือ)');
  await shot('counts-phone-list');
  await page.setViewportSize({ width: 1366, height: 900 });
});

await step('engine state is consistent', async () => {
  const bad = await state((s, R) => R.inventory.verifyBalances(s));
  assert(!bad.length, 'ยอดคงเหลือไม่ตรงกับรายการเคลื่อนไหว: ' + JSON.stringify(bad).slice(0, 300));
});

await browser.close();
if (problems.length) {
  console.log('PROBLEMS\n' + problems.join('\n'));
  process.exit(1);
}
console.log('p3 ok');
