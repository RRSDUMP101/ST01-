// Review test of the Phase 5 screens (lots, qc-plans, inspections, ncrs) with the wrong inputs real people make.
//   RRS_OUT=/tmp/stockqc-p5-review node tests/e2e/p5-review.mjs [--shots dir]
// Clean demo page, own master data (codes P5R-…, warehouse P5RW, users P5R…). Every wrong input must show a Thai
// reason and change nothing; user text is shown as text; the screens fit a 390 px phone. Covers what the first review
// found: an empty release quantity released everything, a REWORK NCR could be "closed" after part of it was
// re-inspected, "ยอมรับแบบมีเงื่อนไข" was offered for a quarantined lot, the person who opened an NCR was offered to
// decide it, results typed for one item stayed when the item changed, the certificate dialog promised to keep the old
// file when the number changed, a quarantined lot offered "กักกันซ้ำ" with nothing to quarantine, job status in English.
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

// ---- helpers (same conventions as p5.mjs) ------------------------------------------------------------------------
const ready = () => page.waitForFunction(() => window.RRS && window.RRS.app && window.RRS.app.loading === false && window.RRS.app.ledger, null, { timeout: 60000 });
let ADMIN = '';
async function exec(kind, payload, user) {
  return page.evaluate(async ([k, p, u]) => {
    const r = await window.RRS.app.ledger.execute({ kind: k, payload: p }, { user: u });
    return { ok: r.ok, errors: r.errors || [], result: r.result || {}, warnings: r.warnings || [] };
  }, [kind, payload, user || ADMIN]);
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
async function waitIn(sel, text, timeout) {
  await page.waitForFunction(([s, x]) => { const e = document.querySelector(s); return !!e && e.innerText.indexOf(x) >= 0; }, [sel, text], { timeout: timeout || 6000 })
    .catch(async () => { throw new Error(`ไม่พบ "${text}" ใน ${sel}: ${(await page.locator(sel).first().innerText().catch(() => '(ไม่มี)')).slice(0, 1500)}`); });
}
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
  for (let i = 0; i < 60; i++) {
    if (await state(fn, arg)) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`สถานะในระบบไม่เป็นไปตามที่คาด: ${what}`);
}
const qtyOf = (f) => state((s, R, x) => R.q.qty(s, x), f);
const seq = () => state((s) => s.seq);
async function noOverflow(where) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert(!over, `${where}: หน้ากว้างเกินจอ`);
}
async function cardFits(where) {
  const card = await page.evaluate(() => { const r = document.querySelector('#dlg .dlg-card').getBoundingClientRect(); return { l: r.left, r: r.right, w: window.innerWidth }; });
  assert(card.l >= 0 && card.r <= card.w + 1, `${where}: หน้าต่างต้องอยู่ในจอโทรศัพท์ ` + JSON.stringify(card));
  await noOverflow(where);
}
const dlgOpen = () => page.waitForSelector('#dlg:not([hidden]) .dlg-card');
const dlgSubmit = () => page.click('#dlg .dlg-f button[type="submit"]');
const dlgCancel = () => page.click('#dlg .dlg-f .btn-ghost');
async function dlgClosed() {
  await page.waitForSelector('#dlg[hidden]', { state: 'attached', timeout: 6000 })
    .catch(async () => { throw new Error(`หน้าต่างยังไม่ปิด: ${await page.locator('#dlg').innerText().catch(() => '')}`); });
}
async function dlgError(text) {
  await page.waitForFunction((x) => document.querySelector('#dlg-err') && document.querySelector('#dlg-err').innerText.indexOf(x) >= 0, text, { timeout: 4000 })
    .catch(async () => { throw new Error(`หน้าต่างควรบอก "${text}" ได้ "${await page.locator('#dlg-err').innerText().catch(() => '')}"`); });
}
/** The inline error box of the inspection / plan form. */
async function formError(sel, text) {
  await waitIn(`${sel} .note.n-bad`, text);
}
async function typeLive(sel, value) {
  await page.fill(sel, String(value));
  await page.waitForTimeout(450);
}
async function shot(name) {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
}
async function noScriptRan(where) {
  assert(await page.locator('#main img[src="x"], #dlg img[src="x"]').count() === 0, `${where}: ข้อความที่ผู้ใช้พิมพ์ต้องแสดงเป็นตัวอักษร`);
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

// ---- clean start --------------------------------------------------------------------------------------------------
await page.goto(file);
await ready();
await page.evaluate(() => localStorage.clear());
await page.reload();
await ready();
ADMIN = await state((s) => Object.values(s.tables.users || {}).find((u) => u.roles.indexOf('admin') >= 0 && u.active !== false).id);

const EVIL = '<img src=x onerror=alert(1)>';
const ids = {};
const PLATE = 'P5R-PLATE';

await step('setup master data and users', async () => {
  await must('warehouse.upsert', { code: 'P5RW', name: 'คลังทดสอบรีวิว' });
  await must('bin.upsert', { wh: 'P5RW', code: 'P5R-01', name: 'ชั้นเหล็ก' });
  await must('bin.upsert', { wh: 'P5RW', code: 'P5R-02', name: 'ชั้นนับสต็อก' });
  await must('item.upsert', { code: PLATE, name: 'แผ่นรีวิว ' + EVIL, baseUnit: 'แผ่น', type: 'RM', trackLot: 'heat', certRequired: true, qcIncoming: true, drawingRev: 'C' });
  await must('item.upsert', { code: 'P5R-FG', name: 'กระบะรีวิว', baseUnit: 'ชุด', type: 'FG', qcFinal: true, drawingRev: 'A' });
  for (const [id, name, roles] of [['P5RSTORE', 'สโตร์รีวิว ' + EVIL, ['store']], ['P5RQC', 'QC รีวิว', ['qc']], ['P5RLEAD', 'หัวหน้า QC รีวิว', ['qc_lead']],
    ['P5RLEAD2', 'หัวหน้า QC รีวิว คนที่สอง', ['qc_lead']], ['P5RENG', 'วิศวกรรีวิว', ['engineering']], ['P5RACC', 'บัญชีรีวิว', ['accounting']]]) {
    await must('user.upsert', { id, name, roles });
  }
  await page.reload();
  await ready();
});

await step('plans: wrong inputs show the reason and save nothing; typed values stay', async () => {
  await asUser('P5RENG');
  await go('qc-plans');
  const before = await state((s) => Object.keys(s.tables.qc_plans || {}).length);
  await page.click('#plan-new-btn');
  await page.waitForSelector('#plan-edit form[data-form="plan"]');
  await page.click('#plan-edit button[type="submit"]');
  await formError('#plan-edit', 'ไม่พบรหัส (ว่าง) ในทะเบียนสินค้า');
  await typeLive('#plan-code', 'P5R-NOPE');
  await page.click('#plan-edit button[type="submit"]');
  await formError('#plan-edit', 'ไม่พบรหัส P5R-NOPE ในทะเบียนสินค้า');
  await typeLive('#plan-code', PLATE);
  assert(await page.inputValue('#plan-rev') === 'C', 'เลือกสินค้าแล้วต้องเติมฉบับแบบที่อนุมัติ (C)');
  await page.fill('#plan-src', 'WI-P5R ' + EVIL);
  await page.fill('input[name="chars[0][name]"]', 'ความหนา ' + EVIL);
  await page.click('#plan-edit button[type="submit"]');
  await formError('#plan-edit', 'หัวข้อ 1: ระบุค่าต่ำสุดหรือสูงสุดที่ยอมรับ');
  await page.fill('input[name="chars[0][min]"]', '5');
  await page.fill('input[name="chars[0][max]"]', '3');
  await page.click('#plan-edit button[type="submit"]');
  await formError('#plan-edit', 'หัวข้อ 1: ค่าต่ำสุดมากกว่าค่าสูงสุด');
  await page.fill('input[name="chars[0][min]"]', '2.8');
  await page.fill('input[name="chars[0][max]"]', '3.2');
  await page.click('#plan-edit button[data-act="addChar"]');
  await page.waitForSelector('input[name="chars[1][name]"]');
  await page.fill('input[name="chars[1][name]"]', 'ความหนา ' + EVIL);
  await page.click('#plan-edit button[type="submit"]');
  await formError('#plan-edit', 'ซ้ำกับหัวข้อ 1');
  assert(await state((s) => Object.keys(s.tables.qc_plans || {}).length) === before, 'บันทึกไม่ผ่านต้องไม่มีแผนใหม่');
  // the stage select re-renders the form: what was typed stays
  await page.fill('input[name="chars[1][name]"]', 'ผิวและขอบ');
  await page.selectOption('select[name="chars[1][kind]"]', 'check');
  await page.selectOption('#plan-stage', 'FINAL');
  await page.waitForTimeout(200);
  await page.selectOption('#plan-stage', 'INCOMING');
  await page.waitForTimeout(200);
  assert(await page.inputValue('#plan-src') === 'WI-P5R ' + EVIL && await page.inputValue('input[name="chars[1][name]"]') === 'ผิวและขอบ', 'เปลี่ยนขั้นตอนแล้วค่าที่พิมพ์ต้องไม่หาย');
  await noScriptRan('plan editor');
  await page.click('#plan-edit button[type="submit"]');
  await waitState((s) => Object.values(s.tables.qc_plans || {}).some((p) => p.code === 'P5R-PLATE' && p.status === 'DRAFT'), null, 'ร่างแผน P5R-PLATE');
  ids.plan = await state((s) => Object.values(s.tables.qc_plans).find((p) => p.code === 'P5R-PLATE').id);
  await page.waitForSelector('#plan-detail');
  await waitIn('#plan-detail', 'ความหนา ' + EVIL);
  await noScriptRan('plan detail');
  // accounting can look but neither edit nor approve
  await asUser('P5RACC');
  await page.waitForSelector('#plan-detail');
  assert(await page.locator('#plan-approve-btn, #plan-edit-btn, #plan-new-btn').count() === 0, 'บัญชีต้องไม่เห็นปุ่มแก้/อนุมัติ/สร้างแผน');
  await asUser('P5RLEAD');
  await page.click('#plan-approve-btn');
  await dlgOpen();
  await dlgSubmit();
  await waitState((s, R, id) => s.tables.qc_plans[id].status === 'APPROVED', ids.plan, 'แผนอนุมัติ');
});

await step('certificate: empty number refused, user text escaped, a new number does not keep the old file', async () => {
  ids.rr1 = (await must('doc.post', { type: 'RR', lines: [{ code: PLATE, qty: 5, wh: 'P5RW', bin: 'P5R-01', lot: 'P5R-H1' }] }, 'P5RSTORE')).result.docNo;
  await asUser('P5RSTORE');
  await go('lots');
  await clickInRow('#lots-list tbody tr', 'P5R-H1');
  await page.waitForSelector('#lot-detail');
  await page.click('#lot-cert-btn');
  await dlgOpen();
  const s0 = await seq();
  await dlgSubmit();
  await dlgError('ใส่เลขที่ใบรับรองตามที่พิมพ์บนเอกสาร');
  assert(await seq() === s0, 'ไม่มีเลขที่ใบรับรองต้องไม่บันทึกอะไร');
  await page.fill('#cert-no', 'MTC ' + EVIL);
  await page.fill('#cert-link', 'https://files.example.invalid/mtc-p5r.pdf');
  await page.fill('#cert-note', 'หมายเหตุ ' + EVIL);
  await dlgSubmit();
  await dlgClosed();
  await waitState((s) => { const l = s.tables.lots['P5R-PLATE|P5R-H1']; return l.cert.no === 'MTC <img src=x onerror=alert(1)>' && l.cert.file === 'https://files.example.invalid/mtc-p5r.pdf'; }, null, 'บันทึกใบรับรอง');
  await waitIn('#lot-detail', 'หมายเหตุ ' + EVIL);
  await waitIn('#lot-detail', 'สโตร์รีวิว ' + EVIL);
  await noScriptRan('lot detail');
  // a new certificate number: the dialog says the old file is not used for it – and it is not
  await page.click('#lot-cert-btn');
  await dlgOpen();
  await waitIn('#dlg', 'ถ้าแก้เลขที่ใบรับรอง ระบบจะไม่ใช้ไฟล์เดิม');
  await page.fill('#cert-no', 'MTC-P5R-002');
  await dlgSubmit();
  await dlgClosed();
  await waitState((s) => { const c = s.tables.lots['P5R-PLATE|P5R-H1'].cert; return c.no === 'MTC-P5R-002' && c.file === ''; }, null, 'เลขที่ใหม่ ไม่ใช้ไฟล์เดิม');
});

await step('quarantine: a reason too short is refused and the lot stays usable', async () => {
  await asUser('P5RQC');
  await page.waitForSelector('#lot-quar-btn');
  await page.click('#lot-quar-btn');
  await dlgOpen();
  const s0 = await seq();
  await page.fill('#quar-reason', 'ab');
  await dlgSubmit();
  await dlgError('ระบุเหตุผลการกักกันให้ชัดเจน');
  assert(await seq() === s0 && await state((s) => s.tables.lots['P5R-PLATE|P5R-H1'].status) === 'ACTIVE', 'เหตุผลสั้นเกินต้องไม่กักกัน');
  await dlgCancel();
  await dlgClosed();
});

await step('inspection: wrong inputs refused inline; results of another item are not carried over', async () => {
  await asUser('P5RQC');
  await go('inspections');
  const n0 = await state((s) => Object.keys(s.tables.inspections || {}).length);
  await page.click('#ins-new-btn');
  await page.waitForSelector('#ins-form form[data-form="ins"]');
  await page.click('#ins-form button[type="submit"]');
  await formError('#ins-form', 'ไม่พบรหัส (ว่าง) ในทะเบียนสินค้า');
  await typeLive('#ins-code', 'P5R-NOPE');
  await page.click('#ins-form button[type="submit"]');
  await formError('#ins-form', 'ไม่พบรหัส P5R-NOPE');
  await typeLive('#ins-code', PLATE);
  await page.selectOption('#ins-wh', 'P5RW');
  await page.waitForTimeout(200);
  await typeLive('#ins-bin', 'P5R-01');
  await typeLive('#ins-lot', 'P5R-H1');
  await typeLive('#ins-qty', '99');
  await waitIn('#ins-form', 'ตรวจได้ไม่เกิน 5');
  await typeLive('#ins-res-C1', '3');
  await page.check('input[name="res[C2]"][value="ผ่าน"]');
  await page.click('#ins-form button[type="submit"]');
  await formError('#ins-form', 'ตรวจได้ไม่เกิน 5');
  await typeLive('#ins-qty', '0');
  await page.click('#ins-form button[type="submit"]');
  await formError('#ins-form', 'จำนวนที่ตรวจต้องเป็นตัวเลขมากกว่า 0');
  await typeLive('#ins-qty', '5');
  await page.fill('#ins-src', 'RR-P5R-NOPE');
  await page.click('#ins-form button[type="submit"]');
  await formError('#ins-form', 'ไม่พบเอกสาร RR-P5R-NOPE');
  assert(await state((s) => Object.keys(s.tables.inspections || {}).length) === n0, 'บันทึกไม่ผ่านต้องไม่มีผลตรวจใหม่');
  // another item → its own plan (none here): the measurement typed for P5R-PLATE is dropped
  await typeLive('#ins-code', 'P5R-FG');
  await waitIn('#ins-form', 'ยังไม่มีแผนตรวจที่อนุมัติของ P5R-FG');
  await typeLive('#ins-code', PLATE);
  await page.waitForSelector('#ins-res-C1');
  assert(await page.inputValue('#ins-res-C1') === '', 'เปลี่ยนสินค้าแล้วผลที่กรอกของสินค้าเดิมต้องไม่ติดมา');
  assert(!(await page.isChecked('input[name="res[C2]"][value="ผ่าน"]')), 'ผลผ่าน/ไม่ผ่านของสินค้าเดิมต้องไม่ติดมา');
  await waitIn('#ins-overall', 'กรอกแล้ว 0/2 หัวข้อ');
  // a correct inspection now
  await page.fill('#ins-src', ids.rr1);
  await typeLive('#ins-res-C1', '3.0');
  await page.check('input[name="res[C2]"][value="ผ่าน"]');
  await waitIn('#ins-overall', 'ผลรวม: ผ่าน');
  await page.click('#ins-form button[type="submit"]');
  await dlgOpen();
  await dlgSubmit();
  await waitState((s) => Object.values(s.tables.inspections || {}).some((i) => i.code === 'P5R-PLATE' && i.result === 'PASS' && i.qty === 5), null, 'ผลตรวจผ่าน 5');
  ids.pass = await state((s) => Object.values(s.tables.inspections).find((i) => i.code === 'P5R-PLATE' && i.result === 'PASS').id);
});

await step('release: certificate not checked is named; empty or too much refused; part of it released', async () => {
  await asUser('P5RLEAD');
  await go('inspections');
  await page.click('#main button[data-act="tab"][data-arg="release"]');
  await waitIn('#qc-release', ids.pass);
  let cells = await rowCells('#qc-release tbody tr', ids.pass);
  assert(cells[5].indexOf('ยังไม่ได้ตรวจสอบ') >= 0 && cells[5].indexOf('MTC-P5R-002') >= 0, 'ต้องบอกว่าใบรับรองยังไม่ได้ตรวจ: ' + cells[5]);
  await must('lot.verifyCert', { code: PLATE, lot: 'P5R-H1' }, 'P5RQC');
  await page.waitForSelector('#qc-release button[data-act="release"]');
  await clickInRow('#qc-release tbody tr', ids.pass, 'button[data-act="release"]');
  await dlgOpen();
  const s0 = await seq();
  await page.fill('#rel-qty', '');
  await dlgSubmit();
  await dlgError('ใส่จำนวนที่ปล่อย (ไม่เกิน 5 แผ่น)');
  assert(await seq() === s0, 'ช่องจำนวนว่างต้องไม่ปล่อยอะไร (เดิมปล่อยทั้งหมด)');
  await page.fill('#rel-qty', '9');
  await dlgSubmit();
  await dlgError('ปล่อยได้ไม่เกิน 5');
  await page.fill('#rel-qty', '0');
  await dlgSubmit();
  await dlgError('มากกว่า 0');
  assert(await seq() === s0, 'จำนวนผิดต้องไม่ปล่อยอะไร');
  await page.fill('#rel-qty', '2');
  await dlgSubmit();
  await dlgClosed();
  await waitState((s, R, id) => s.tables.inspections[id].releasedQty === 2 && s.tables.inspections[id].status === 'OPEN', ids.pass, 'ปล่อยบางส่วน 2');
  assert(await qtyOf({ code: PLATE, lot: 'P5R-H1', status: 'AVAILABLE' }) === 2 && await qtyOf({ code: PLATE, lot: 'P5R-H1', status: 'QC_HOLD' }) === 3, 'ปล่อย 2 ใช้ได้ 2 ที่เหลือรอตรวจ 3');
  await waitIn('#toasts', 'ที่เหลือยังรอปล่อย');
  await waitIn('#qc-release', ids.pass);
  cells = await rowCells('#qc-release tbody tr', ids.pass);
  assert(cells[3].indexOf('3') === 0, 'แถวรอปล่อยต้องเหลือ 3: ' + cells[3]);
});

await step('the person who posted the receipt cannot inspect it', async () => {
  ids.rr3 = (await must('doc.post', { type: 'RR', lines: [{ code: PLATE, qty: 3, wh: 'P5RW', bin: 'P5R-01', lot: 'P5R-H3' }] }, ADMIN)).result.docNo;
  await asUser(ADMIN);
  await go('inspections');
  await page.click('#main button[data-act="tab"][data-arg="queue"]');
  await clickInRow('#qc-queue tbody tr', 'P5R-H3', 'button[data-act="startIns"]');
  await page.waitForSelector('#ins-form form[data-form="ins"]');
  assert(await page.inputValue('#ins-src') === ids.rr3, 'เอกสารต้นทางต้องเป็นใบรับที่ทำให้ของเข้ารอตรวจ');
  await waitIn('#ins-form', 'คุณบันทึกเอง จึงตรวจไม่ได้');
  await typeLive('#ins-res-C1', '3');
  await page.check('input[name="res[C2]"][value="ผ่าน"]');
  const n0 = await state((s) => Object.keys(s.tables.inspections).length);
  await page.click('#ins-form button[type="submit"]');
  await formError('#ins-form', 'คนละคน');
  assert(await state((s) => Object.keys(s.tables.inspections).length) === n0, 'ผู้รับของต้องตรวจเองไม่ได้');
  await page.click('#ins-form button[data-act="insClose"]');
});

await step('NCR: use as is is closed for a quarantined lot; REWORK closes only after the whole quantity is re-inspected', async () => {
  ids.rr2 = (await must('doc.post', { type: 'RR', lines: [{ code: PLATE, qty: 4, wh: 'P5RW', bin: 'P5R-01', lot: 'P5R-H2' }] }, 'P5RSTORE')).result.docNo;
  await must('lot.update', { code: PLATE, lot: 'P5R-H2', cert: { no: 'MTC-P5R-H2' } }, 'P5RSTORE');
  await must('lot.verifyCert', { code: PLATE, lot: 'P5R-H2' }, 'P5RQC');
  const f = await must('qc.inspect', { stage: 'INCOMING', code: PLATE, wh: 'P5RW', bin: 'P5R-01', lot: 'P5R-H2', qty: 4, sourceDoc: ids.rr2, planId: ids.plan,
    results: [{ char: 'C1', value: 3.6 }, { char: 'C2', value: 'ผ่าน' }], note: 'ขอบหนาเกิน ' + EVIL }, 'P5RQC');
  ids.failH2 = f.result.id;
  ids.ncrA = f.result.ncrNo;
  await must('lot.quarantine', { code: PLATE, lot: 'P5R-H2', reason: 'สงสัยทั้งล็อต' }, 'P5RQC');
  await asUser('P5RLEAD');
  await go('ncrs');
  await clickInRow('#ncr-list tbody tr', ids.ncrA);
  await page.waitForSelector('#ncr-decide-btn:not([disabled])');
  await waitIn('#ncr-detail', 'กักกันอยู่ 4 แผ่น');
  await page.click('#ncr-decide-btn');
  await dlgOpen();
  assert(await page.locator('#dlg input[name="disposition"][value="USE_AS_IS"]').isDisabled(), 'ล็อตถูกกักกันทั้งล็อต – ยอมรับแบบมีเงื่อนไขต้องเลือกไม่ได้');
  await waitIn('#dlg', 'เลือกไม่ได้: ' + PLATE + ' ล็อต P5R-H2 ถูกกักกันทั้งล็อต – ปลดกักกันล็อตก่อน');
  assert(await page.locator('#dlg input[name="disposition"][value="REWORK"]').isEnabled(), 'แก้ไขงานต้องเลือกได้');
  const s0 = await seq();
  await page.check('#dlg input[name="disposition"][value="REWORK"]');
  await dlgSubmit();
  await dlgError('ระบุเหตุผลการตัดสินให้ชัดเจน');
  assert(await seq() === s0, 'ไม่มีเหตุผลต้องไม่ตัดสิน');
  await page.fill('#disp-reason', 'เจียรขอบให้ได้ความหนา');
  await dlgSubmit();
  await dlgClosed();
  await waitState((s, R, no) => s.tables.ncrs[no].disposition === 'REWORK', ids.ncrA, 'ตัดสินแก้ไขงาน');
  await must('lot.release', { code: PLATE, lot: 'P5R-H2', reason: 'ผู้ขายยืนยันใบรับรอง' }, 'P5RLEAD2');
  // re-inspect 2 of the 4 pieces: the NCR is not done yet
  await must('qc.inspect', { stage: 'INCOMING', code: PLATE, wh: 'P5RW', bin: 'P5R-01', lot: 'P5R-H2', qty: 2, fromStatus: 'REWORK', reinspectionOf: ids.failH2, planId: ids.plan,
    results: [{ char: 'C1', value: 3 }, { char: 'C2', value: 'ผ่าน' }] }, 'P5RQC');
  await page.waitForSelector('#ncr-close-btn');
  assert(await page.locator('#ncr-close-btn').isDisabled(), 'ตรวจซ้ำแล้ว 2 จาก 4 – ต้องยังปิด NCR ไม่ได้');
  await waitIn('#ncr-detail', 'ตรวจซ้ำแล้ว 2 จาก 4');
  await waitIn('#ncr-detail', 'รอแก้ไข 2 แผ่น');
  await waitIn('#ncr-detail', 'ขอบหนาเกิน ' + EVIL);
  await noScriptRan('ncr detail');
  // the failed result offers the re-inspection of what is left
  await asUser('P5RQC');
  await go('inspections');
  await page.click('#main button[data-act="tab"][data-arg="all"]');
  await clickInRow('#qc-all tbody tr', ids.failH2);
  await page.waitForSelector('#ins-re-btn');
  await waitIn('#ins-detail', 'เหลือ 2 แผ่น');
  await page.click('#ins-re-btn');
  await page.waitForSelector('#ins-form form[data-form="ins"]');
  assert(await page.inputValue('#ins-qty') === '2' && await page.inputValue('#ins-reof') === ids.failH2 && await page.inputValue('#ins-from') === 'REWORK', 'ตรวจซ้ำต้องเติมจำนวนที่เหลือ 2 และอ้างผลเดิม');
  await typeLive('#ins-res-C1', '3.1');
  await page.check('input[name="res[C2]"][value="ผ่าน"]');
  await page.click('#ins-form button[type="submit"]');
  await dlgOpen();
  await dlgSubmit();
  await waitState((s, R, no) => Object.values(s.tables.inspections).filter((i) => i.reinspectionNcr === no).length === 2, ids.ncrA, 'ตรวจซ้ำครบ 2 ครั้ง');
  await waitIn('#ins-detail', 'รอหัวหน้า QC');
  await asUser('P5RLEAD');
  await go('ncrs');
  await page.click('#main button[data-act="tab"][data-arg="disp"]');
  await clickInRow('#ncr-list tbody tr', ids.ncrA);
  await page.waitForSelector('#ncr-close-btn:not([disabled])');
  await waitIn('#ncr-detail', 'ตรวจซ้ำครบ 4 แผ่น แล้ว');
  await page.click('#ncr-close-btn');
  await dlgOpen();
  await dlgSubmit();
  await dlgClosed();
  await waitState((s, R, no) => s.tables.ncrs[no].status === 'CLOSED', ids.ncrA, 'ปิด NCR หลังตรวจซ้ำครบ');
});

await step('NCR: the person who opened it cannot decide it; another QC lead scraps', async () => {
  await must('lot.quarantine', { code: PLATE, lot: 'P5R-H3', reason: 'แผ่นบิด ' + EVIL }, 'P5RQC');
  await asUser('P5RQC');
  await go('lots');
  await page.click('#main button[data-act="tab"][data-arg="list"]');
  await clickInRow('#lots-list tbody tr', 'P5R-H3');
  await waitIn('#lot-detail', 'กักกันทั้งล็อต');
  assert(await page.locator('#lot-quar-btn, #lot-requar-btn').count() === 0, 'ล็อตกักกันแล้วและไม่มีของเหลือให้กักกัน – ต้องไม่มีปุ่มกักกันซ้ำ');
  await noScriptRan('quarantined lot');
  await asUser('P5RLEAD');
  await go('ncrs');
  await page.click('#main button[data-act="tab"][data-arg="held"]');
  await clickInRow('#ncr-held tbody tr', 'P5R-H3', 'button[data-act="openNcr"]');
  await dlgOpen();
  assert(await page.inputValue('#open-qty') === '3', 'จำนวนต้องเติมยอดกักกันที่ยังไม่มี NCR (3)');
  await page.fill('#open-qty', '9');
  await dlgSubmit();
  await dlgError('เปิด NCR ได้ไม่เกิน 3');
  await page.fill('#open-qty', '1');
  await page.fill('#open-defect', '');
  await dlgSubmit();
  await dlgError('ระบุข้อบกพร่อง');
  await page.fill('#open-defect', 'แผ่นบิดงอ ' + EVIL);
  await dlgSubmit();
  await dlgClosed();
  await waitState((s) => Object.values(s.tables.ncrs).some((n) => n.lot === 'P5R-H3' && n.createdBy === 'P5RLEAD' && n.qty === 1), null, 'เปิด NCR ของกักกัน 1');
  ids.ncrB = await state((s) => Object.values(s.tables.ncrs).find((n) => n.lot === 'P5R-H3').ncrNo);
  await page.waitForSelector('#ncr-decide-btn');
  assert(await page.locator('#ncr-decide-btn').isDisabled(), 'ผู้เปิด NCR ต้องตัดสินเองไม่ได้');
  await waitIn('#ncr-detail', 'คุณเป็นผู้เปิด');
  await noScriptRan('ncr opened from quarantine');
  await asUser('P5RLEAD2');
  await page.waitForSelector('#ncr-decide-btn:not([disabled])');
  await page.click('#ncr-decide-btn');
  await dlgOpen();
  await page.check('#dlg input[name="disposition"][value="SCRAP"]');
  await page.fill('#disp-reason', 'บิดงอเกินแก้');
  await dlgSubmit();
  await dlgClosed();
  await waitState((s, R, no) => s.tables.ncrs[no].docType === 'SC' && s.tables.ncrs[no].dispositionBy === 'P5RLEAD2', ids.ncrB, 'ตัดทิ้งโดยหัวหน้า QC อีกคน');
  await waitIn('#ncr-detail', 'ตัดทิ้งแล้ว 1 แผ่น');
  assert(await qtyOf({ code: PLATE, lot: 'P5R-H3', status: 'QUARANTINE' }) === 2, 'ตัดทิ้ง 1 เหลือกักกัน 2');
});

await step('quarantined lot: what a count freeze kept usable can be quarantined afterwards (and only then)', async () => {
  ids.rr5 = (await must('doc.post', { type: 'RR', lines: [{ code: PLATE, qty: 2, wh: 'P5RW', bin: 'P5R-02', lot: 'P5R-H5' }] }, 'P5RSTORE')).result.docNo;
  const ct = await must('count.create', { wh: 'P5RW', bins: ['P5R-02'], mode: 'freeze' }, ADMIN);
  const q = await must('lot.quarantine', { code: PLATE, lot: 'P5R-H5', reason: 'สงสัยทั้งล็อต' }, 'P5RQC');
  assert(q.result.moved === 0 && q.result.skipped.length === 1, 'ช่องที่อยู่ระหว่างนับต้องยังไม่ย้ายเป็นกักกัน');
  await must('count.cancel', { id: ct.result.id, reason: 'ยกเลิกรอบนับทดสอบ' }, ADMIN);
  await asUser('P5RQC');
  await go('lots');
  await page.click('#main button[data-act="tab"][data-arg="list"]');
  await clickInRow('#lots-list tbody tr', 'P5R-H5');
  await page.waitForSelector('#lot-requar-btn');
  await waitIn('#lot-requar-btn', '2 แผ่น');
  await waitIn('#lot-detail', 'ยังเป็น "ใช้ได้/รอตรวจ"');
  await page.click('#lot-requar-btn');
  await dlgOpen();
  await waitIn('#dlg', 'P5RW/P5R-02');
  await page.fill('#quar-reason', 'กักกันส่วนที่เหลือหลังยกเลิกรอบนับ');
  await dlgSubmit();
  await dlgClosed();
  await waitState((s, R) => R.q.qty(s, { code: 'P5R-PLATE', lot: 'P5R-H5', status: 'QUARANTINE' }) === 2, null, 'กักกันส่วนที่เหลือ 2');
  await page.waitForSelector('#lot-detail');
  assert(await page.locator('#lot-requar-btn').count() === 0, 'กักกันครบแล้วต้องไม่มีปุ่มกักกันซ้ำ');
});

await step('job trace shows the job status in Thai', async () => {
  const job = await state((s, R) => { const j = Object.values(s.tables.jobs || {})[0]; return j ? { no: j.jobNo, label: (R.planning && R.planning.JOB_STATUS || {})[j.status] || '' } : null; });
  if (!job) return;
  await asUser('P5RACC');
  await go('lots');
  await page.click('#main button[data-act="tab"][data-arg="job"]');
  await page.fill('#lots-jq', job.no);
  await page.click('form[data-form="jtrace"] button[type="submit"]');
  await waitIn('#main', 'สถานะใบงาน');
  const txt = await mainText();
  assert(job.label && txt.indexOf(job.label) >= 0 && !/สถานะใบงาน\s*\n\s*(OPEN|IN_PROGRESS|DONE|DELIVERED|CANCELLED)\b/.test(txt), 'สถานะใบงานต้องเป็นภาษาไทย');
});

await step('phone width: decision, release and open-NCR dialogs fit the screen', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  // a fresh FAIL to decide
  ids.rr4 = (await must('doc.post', { type: 'RR', lines: [{ code: PLATE, qty: 2, wh: 'P5RW', bin: 'P5R-01', lot: 'P5R-H4' }] }, 'P5RSTORE')).result.docNo;
  const f = await must('qc.inspect', { stage: 'INCOMING', code: PLATE, wh: 'P5RW', bin: 'P5R-01', lot: 'P5R-H4', qty: 2, sourceDoc: ids.rr4, planId: ids.plan,
    results: [{ char: 'C1', value: 2 }, { char: 'C2', value: 'ไม่ผ่าน' }] }, 'P5RQC');
  await asUser('P5RLEAD');
  await go('ncrs');
  await page.click('#main button[data-act="tab"][data-arg="open"]');
  await clickInRow('#ncr-list tbody tr', f.result.ncrNo);
  await page.waitForSelector('#ncr-detail');
  await noOverflow('ncr detail');
  await page.click('#ncr-decide-btn');
  await dlgOpen();
  await cardFits('decision dialog');
  await shot('phone-decide');
  await dlgCancel();
  await dlgClosed();
  await page.click('#main button[data-act="tab"][data-arg="held"]');
  await clickInRow('#ncr-held tbody tr', 'P5R-H3', 'button[data-act="openNcr"]');
  await dlgOpen();
  await cardFits('open NCR dialog');
  await dlgCancel();
  await dlgClosed();
  await go('inspections');
  await page.click('#main button[data-act="tab"][data-arg="release"]');
  await noOverflow('release tab');
  await clickInRow('#qc-release tbody tr', ids.pass, 'button[data-act="release"]');
  await dlgOpen();
  await cardFits('release dialog');
  await shot('phone-release');
  await dlgCancel();
  await dlgClosed();
  await go('lots');
  await page.click('#main button[data-act="tab"][data-arg="list"]');
  await clickInRow('#lots-list tbody tr', 'P5R-H1');
  await page.waitForSelector('#lot-detail');
  await noOverflow('lot detail');
  await page.click('#lot-quar-btn');
  await dlgOpen();
  await cardFits('quarantine dialog');
  await dlgCancel();
  await dlgClosed();
  await page.setViewportSize({ width: 1366, height: 900 });
});

await step('engine state stays consistent', async () => {
  const bad = await state((s, R) => R.inventory.verifyBalances(s));
  assert(!bad.length, 'ยอดคงเหลือไม่ตรงกับประวัติ ' + JSON.stringify(bad.slice(0, 3)));
});

await browser.close();
if (problems.length) {
  console.log('\nPROBLEMS\n' + problems.join('\n'));
  process.exit(1);
}
console.log('\np5-review ok');
