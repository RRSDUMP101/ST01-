// Browser test of the Phase 4 screens ผู้ขายและเงื่อนไขซื้อ (suppliers), แผนเติมสต็อก (replenish) and
// ขอซื้อ สั่งซื้อ และรับของ (purchasing).
//   RRS_OUT=/tmp/stockqc-p4 node tests/e2e/p4.mjs [--shots dir]
// Starts from a clean demo page, creates its own master data (codes P4-…, warehouses P4W/P4X, users P4…) and drives
// each flow through the UI: supplier + item terms + reorder rule, the plan → one PR, separation of duties on approval,
// PO from the PR (rounded to buy units) and by hand, receipts (partial, over-receipt approved by the lead, heat + cert
// into รอตรวจ), return with/without replacement, due date / cancel line / close / cancel, late PO lines with the jobs
// they hold up, permissions per role, phone width and a long list.
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
const addDays = (d, n) => new Date(Date.parse(d) + n * 86400e3).toISOString().slice(0, 10);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
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
async function waitText(text, timeout, where) {
  const sel = where || '#main';
  await page.waitForFunction(([s, x]) => document.querySelector(s) && document.querySelector(s).innerText.indexOf(x) >= 0, [sel, text], { timeout: timeout || 6000 })
    .catch(async () => { throw new Error(`ไม่พบข้อความ "${text}" ใน ${sel}\n---\n${(await page.locator(sel).innerText().catch(() => '')).slice(0, 1500)}`); });
}
async function waitGone(text, timeout, where) {
  const sel = where || '#main';
  await page.waitForFunction(([s, x]) => !document.querySelector(s) || document.querySelector(s).innerText.indexOf(x) < 0, [sel, text], { timeout: timeout || 6000 })
    .catch(() => { throw new Error(`ข้อความ "${text}" ยังอยู่ใน ${sel}`); });
}
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
  await page.waitForFunction(() => document.querySelector('#dlg').hidden, null, { timeout: 6000 })
    .catch(async () => { throw new Error(`หน้าต่างยังไม่ปิด: ${await page.locator('#dlg').innerText().catch(() => '')}`); });
}
async function dlgError(text) {
  await page.waitForFunction((x) => document.querySelector('#dlg-err') && document.querySelector('#dlg-err').innerText.indexOf(x) >= 0, text, { timeout: 4000 })
    .catch(async () => { throw new Error(`หน้าต่างควรบอก "${text}" ได้ "${await page.locator('#dlg-err').innerText().catch(() => '')}"`); });
}
async function toast(text) {
  await page.waitForFunction((x) => document.querySelector('#toasts').innerText.indexOf(x) >= 0, text, { timeout: 6000 })
    .catch(async () => { throw new Error(`ไม่พบข้อความแจ้ง "${text}" ได้ "${await page.locator('#toasts').innerText()}"`); });
}
const rowCells = (sel, text) => page.evaluate(([s, x]) => {
  const tr = Array.from(document.querySelectorAll(s)).find((r) => r.innerText.indexOf(x) >= 0);
  return tr ? Array.from(tr.children).map((td) => td.innerText.trim().replace(/\s+/g, ' ')) : null;
}, [sel, text]);
const tab = (id) => page.click(`#main .tabs button[data-arg="${id}"]`);
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

const today = await page.evaluate(() => window.RRS.util.bkkDate(new Date().toISOString()));
const EVIL = '<img src=x onerror=alert(1)>';
const ctxIds = {};

await step('empty states', async () => {
  const empty = await state((s) => !Object.keys(s.tables.suppliers || {}).length && !Object.keys(s.tables.prs || {}).length && !Object.keys(s.tables.pos || {}).length);
  if (!empty) return; // sample data present (fixture build) – the smoke test covers empty pages
  await go('suppliers');
  await waitText('ยังไม่มีผู้ขาย');
  await waitText('เพิ่มผู้ขายรายแรก');
  await tab('rules');
  await waitText('ยังไม่ได้ตั้งเงื่อนไขเติมสต็อก');
  await go('purchasing');
  await tab('pr');
  await waitText('ยังไม่มีใบขอซื้อ');
  await tab('po');
  await waitText('ยังไม่มีใบสั่งซื้อ');
  await tab('recv');
  await waitText('ไม่มีใบสั่งซื้อที่รอรับของ');
  await tab('rv');
  await waitText('ยังไม่มีของที่รับจากใบสั่งซื้อให้คืน');
  await go('replenish');
  const noItems = await state((s) => !Object.values(s.tables.items || {}).some((i) => i.active !== false));
  if (noItems) await waitText('ยังไม่มีสินค้า');
  await page.setViewportSize({ width: 390, height: 844 });
  for (const id of ['suppliers', 'purchasing', 'replenish']) {
    await go(id);
    await noOverflow(`${id} ว่าง`);
  }
  await page.setViewportSize({ width: 1366, height: 900 });
});

await step('setup master data and users', async () => {
  await must('warehouse.upsert', { code: 'P4W', name: 'คลังทดสอบพีสี่' });
  await must('warehouse.upsert', { code: 'P4X', name: 'คลังทดสอบพีสี่ สำรอง' });
  await must('bin.upsert', { wh: 'P4W', code: 'P4-01', name: 'ชั้น 1' });
  await must('bin.upsert', { wh: 'P4W', code: 'P4-02', name: 'ชั้น 2' });
  await must('item.upsert', { code: 'P4-BOLT', name: 'ทดสอบพีสี่ น็อตยึดพื้น', baseUnit: 'ตัว', type: 'BUY' });
  await must('item.upsert', { code: 'P4-PLATE', name: 'ทดสอบพีสี่ แผ่นเหล็ก 3 มม.', baseUnit: 'แผ่น', type: 'RM', trackLot: 'heat', certRequired: true, qcIncoming: true });
  await must('item.upsert', { code: 'P4-PAINT', name: 'ทดสอบพีสี่ สีรองพื้น', baseUnit: 'ลิตร', type: 'CONS', minQty: 10, maxQty: 40 });
  for (const [id, name, roles] of [['P4STORE', 'สโตร์พีสี่', ['store']], ['P4PUR', 'จัดซื้อพีสี่', ['purchasing']], ['P4LEAD', 'หัวหน้าจัดซื้อพีสี่', ['purchasing_lead']],
    ['P4PLAN', 'วางแผนพีสี่', ['planner']], ['P4VIEW', 'ผู้ดูพีสี่', ['viewer']]]) {
    await must('user.upsert', { id, name, roles });
  }
  await must('supplier.upsert', { id: 'P4-SUP2', name: 'สีไทยทดสอบ ' + EVIL, phone: '02-000-0000' });
});

await step('suppliers: add a supplier through the form', async () => {
  await asUser('P4PUR');
  await go('suppliers');
  await tab('sup');
  await page.click('#main button[data-act="newSup"]');
  await page.fill('#sup-id', 'P4-SUP1');
  await page.fill('#sup-name', 'บริษัท เหล็กทดสอบพีสี่ จำกัด');
  await page.fill('#sup-tax', '12345');
  await page.fill('#sup-lead', '5');
  await page.click('form[data-form="saveSup"] button[type="submit"]');
  await toast('เลขประจำตัวผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก');
  assert(!(await state((s) => !!(s.tables.suppliers || {})['P4-SUP1'])), 'เลขภาษีผิดต้องไม่บันทึก');
  await page.fill('#sup-tax', '0105551234567');
  await page.click('form[data-form="saveSup"] button[type="submit"]');
  await toast('เพิ่มผู้ขาย P4-SUP1 แล้ว');
  const s1 = await state((s) => s.tables.suppliers['P4-SUP1']);
  assert(s1 && s1.leadDays === 5 && s1.taxId === '0105551234567' && s1.updatedBy === 'P4PUR', `ผู้ขายที่บันทึก: ${JSON.stringify(s1)}`);
  // the same code again is refused with how to fix it
  await page.click('#main button[data-act="newSup"]');
  await page.fill('#sup-id', 'p4-sup1');
  await page.fill('#sup-name', 'ซ้ำ');
  await page.click('form[data-form="saveSup"] button[type="submit"]');
  await toast('ผู้ขาย P4-SUP1 มีอยู่แล้ว');
  await page.click('#main tr[data-act="pickSup"][data-arg="P4-SUP2"]');
  await waitText('สีไทยทดสอบ ' + EVIL); // shown as text, never as markup
  await shot('desktop-suppliers');
});

await step('suppliers: price, buy unit, factor, MOQ, pack, preferred', async () => {
  await tab('terms');
  await waitText('ยังไม่มีผู้ขาย – แผนเติมสต็อกจะแนะนำเป็นหน่วยหลัก');
  await page.fill('#term-q', 'P4-BOLT');
  await page.waitForSelector('#main tr[data-act="pickItem"][data-arg="P4-BOLT"]');
  await page.click('#main tr[data-act="pickItem"][data-arg="P4-BOLT"]');
  await page.waitForSelector('form[data-form="addTerm"]');
  // an unknown buy unit without a factor is refused – the system does not guess
  await page.selectOption('#term-sup', 'P4-SUP1');
  await page.fill('#term-price', '250');
  await page.fill('#term-unit', 'ลัง');
  await page.click('form[data-form="addTerm"] button[type="submit"]');
  await toast('ไม่มีตัวคูณของหน่วย "ลัง"');
  await page.fill('#term-unit', 'กล่อง');
  await page.fill('#term-factor', '100');
  await page.fill('#term-moq', '2');
  await page.fill('#term-pack', '2');
  await page.fill('#term-lead', '3');
  assert(await page.isChecked('#term-pref'), 'ผู้ขายรายแรกควรติ๊กเป็นผู้ขายหลักไว้ให้');
  await page.click('form[data-form="addTerm"] button[type="submit"]');
  await toast('ตั้ง P4-BOLT กับผู้ขาย P4-SUP1 แล้ว');
  const l = await state((s) => s.tables.item_suppliers['P4-BOLT|P4-SUP1']);
  assert(l && l.price === 250 && l.buyUnit === 'กล่อง' && l.factor === 100 && l.moq === 2 && l.pack === 2 && l.leadDays === 3 && l.preferred === true,
    `ราคา/หน่วยซื้อที่บันทึก: ${JSON.stringify(l)}`);
  const cells = await rowCells('#term-detail tbody tr', 'P4-SUP1');
  assert(cells && cells.join(' ').indexOf('250.00 / กล่อง') >= 0 && cells.join(' ').indexOf('ผู้ขายหลัก') >= 0, `แถวผู้ขาย: ${cells}`);
  await waitText('1 กล่อง = 100 ตัว', 4000, '#term-detail');
  // a second supplier, then switch the preferred one and back
  await page.selectOption('#term-sup', 'P4-SUP2');
  await page.fill('#term-price', '2.75');
  await page.click('form[data-form="addTerm"] button[type="submit"]');
  await toast('ตั้ง P4-BOLT กับผู้ขาย P4-SUP2 แล้ว');
  await page.click('#term-detail button[data-act="prefTerm"][data-arg="P4-SUP2"]');
  await toast('ตั้ง P4-SUP2 เป็นผู้ขายหลักของ P4-BOLT แล้ว');
  assert(await state((s) => s.tables.item_suppliers['P4-BOLT|P4-SUP2'].preferred && !s.tables.item_suppliers['P4-BOLT|P4-SUP1'].preferred), 'ผู้ขายหลักต้องเหลือรายเดียว');
  await page.click('#term-detail button[data-act="editTerm"][data-arg="P4-SUP1"]');
  await dlgOpen();
  await page.check('#dlg input[name="preferred"]');
  await dlgSubmit();
  await dlgClosed();
  assert(await state((s) => s.tables.item_suppliers['P4-BOLT|P4-SUP1'].preferred && !s.tables.item_suppliers['P4-BOLT|P4-SUP2'].preferred), 'แก้ในหน้าต่างให้ P4-SUP1 เป็นผู้ขายหลักอีกครั้ง');
  await must('itemSupplier.upsert', { code: 'P4-PLATE', supplier: 'P4-SUP1', price: 3200, leadDays: 10, preferred: true }, 'P4PUR');
  await must('itemSupplier.upsert', { code: 'P4-PAINT', supplier: 'P4-SUP2', price: 900, buyUnit: 'ถัง', factor: 20, preferred: true }, 'P4PUR');
  await shot('desktop-suppliers-terms');
});

await step('suppliers: reorder rule', async () => {
  await tab('rules');
  await waitText('ยังไม่ได้ตั้งเงื่อนไขเติมสต็อก');
  await page.click('#main button[data-act="newRule"]');
  await dlgOpen();
  await page.fill('#rule-code', 'P4-BOLT');
  await page.fill('#rule-min', '500');
  await page.fill('#rule-max', '100');
  await dlgSubmit();
  await dlgError('Min ต้องไม่มากกว่า Max');
  await page.fill('#rule-min', '300');
  await page.fill('#rule-max', '1000');
  await dlgSubmit();
  await dlgClosed();
  await toast('บันทึกเงื่อนไขเติมสต็อกแล้ว');
  const r = await state((s) => s.tables.reorder_rules['P4-BOLT|']);
  assert(r && r.min === 300 && r.max === 1000 && r.wh === '' && r.active === true, `เงื่อนไขที่บันทึก: ${JSON.stringify(r)}`);
  await page.waitForSelector('#rule-list tr[data-arg="P4-BOLT|"]');
  // editing shows what the plan uses now
  await page.click('#rule-list tr[data-arg="P4-BOLT|"]');
  await dlgOpen();
  await waitText('ตอนนี้แผนเติมสต็อกใช้: Min 300 / Max 1,000 ตัว', 4000, '#dlg');
  await page.click('#dlg .dlg-f .btn-ghost');
  await dlgClosed();
});

await step('replenish: every number with its reason, then one PR from the picked rows', async () => {
  await asUser('P4PLAN');
  await go('replenish');
  await tab('order');
  await page.waitForSelector('#rp-list');
  const bolt = await rowCells('#rp-list tbody tr', 'P4-BOLT');
  assert(bolt, 'P4-BOLT ต้องอยู่ในรายการต้องสั่ง');
  const b = bolt.join(' | ');
  assert(b.indexOf('300 / 1,000') >= 0 && b.indexOf('10 กล่อง') >= 0 && b.indexOf('= 1,000 ตัว') >= 0 && b.indexOf('2,500.00') >= 0 && b.indexOf('ต้องสั่ง') >= 0, `แถว P4-BOLT: ${b}`);
  const paint = (await rowCells('#rp-list tbody tr', 'P4-PAINT')).join(' | ');
  assert(paint.indexOf('10 / 40') >= 0 && paint.indexOf('2 ถัง') >= 0 && paint.indexOf('= 40 ลิตร') >= 0, `แถว P4-PAINT: ${paint}`);
  assert(!(await rowCells('#rp-list tbody tr', 'P4-PLATE')), 'P4-PLATE ไม่มี Min/Max และไม่มียอดใช้ ไม่ต้องสั่ง');
  await page.click('#rp-list button[data-act="why"][data-arg="P4-BOLT"]');
  await waitText('คาดการณ์คงเหลือ = ใช้ได้ 0', 4000, '#rp-list');
  await waitText('ปัดขึ้นเป็นหน่วยซื้อเต็ม, ขั้นต่ำ 2 กล่อง, แพ็กละ 2 กล่อง', 4000, '#rp-list');
  await waitText('Min 300 / Max 1000 (เงื่อนไขเติมสต็อกทุกคลัง)', 4000, '#rp-list');
  await tab('all');
  await page.waitForFunction(() => document.querySelector('#rp-list').innerText.indexOf('P4-PLATE') >= 0);
  await tab('order');
  await page.check('#rp-list input[data-act="pick"][data-arg="P4-BOLT"]');
  await page.waitForFunction(() => document.querySelector('#rp-make').innerText.indexOf('(1)') >= 0);
  await page.check('#rp-list input[data-act="pick"][data-arg="P4-PAINT"]');
  await page.waitForFunction(() => document.querySelector('#rp-make').innerText.indexOf('(2)') >= 0);
  await shot('desktop-replenish');
  await page.click('#rp-make');
  await dlgOpen();
  await waitText('สร้างใบขอซื้อจาก 2 รายการ', 4000, '#dlg');
  const whs = await page.$$eval('#dlg select[name$="[wh]"]', (els) => els.map((e) => e.value));
  if (whs.some((x) => !x)) {
    await dlgSubmit();
    await dlgError('ระบุคลัง'); // no default warehouse: the engine asks for one
  }
  for (let i = 0; i < 2; i++) await page.selectOption(`#dlg select[name="lines[${i}][wh]"]`, 'P4W');
  await dlgSubmit();
  await dlgClosed();
  await toast('สร้างใบขอซื้อ PR');
  const pr = await state((s) => Object.values(s.tables.prs).find((x) => x.requestedBy === 'P4PLAN'));
  assert(pr && pr.status === 'SUBMITTED' && pr.source === 'แผนเติมสต็อก' && pr.lines.length === 2, `ใบขอซื้อ: ${JSON.stringify(pr)}`);
  const lb = pr.lines.find((l) => l.code === 'P4-BOLT');
  const lp = pr.lines.find((l) => l.code === 'P4-PAINT');
  assert(lb.qty === 1000 && lb.wh === 'P4W' && lb.supplier === 'P4-SUP1' && lb.needDate === addDays(today, 3), `บรรทัด P4-BOLT: ${JSON.stringify(lb)}`);
  assert(lp.qty === 40 && lp.supplier === 'P4-SUP2' && lp.needDate === addDays(today, 7), `บรรทัด P4-PAINT: ${JSON.stringify(lp)}`);
  ctxIds.pr = pr.prNo;
  await waitText(`สร้างใบขอซื้อ ${pr.prNo} และส่งขออนุมัติแล้ว`);
  await page.waitForFunction(() => !document.querySelector('#rp-list') || document.querySelector('#rp-list').innerText.indexOf('P4-BOLT') < 0);
  await tab('near');
  await page.waitForSelector('#rp-list');
  const covered = (await rowCells('#rp-list tbody tr', 'P4-BOLT')).join(' | ');
  assert(covered.indexOf('ขอซื้อไว้แล้ว') >= 0 && covered.indexOf('1,000') >= 0, `หลังขอซื้อ P4-BOLT ควรเป็น ขอซื้อไว้แล้ว: ${covered}`);
});

await step('PR: written by hand, checked, and the requester cannot approve it', async () => {
  await asUser('ADMIN');
  await go('purchasing');
  await tab('pr');
  await page.click('#main button[data-act="newPr"]');
  await page.waitForSelector('#pr-lines');
  await page.fill('#pr-lines input[name="lines[0][code]"]', 'P4-PAINT');
  await page.fill('#pr-lines input[name="lines[0][qty]"]', '5');
  await page.selectOption('#pr-lines select[name="lines[0][wh]"]', 'P4W');
  await page.click('#main button[data-act="prAdd"]');
  await page.waitForSelector('#pr-lines input[name="lines[1][code]"]');
  assert(await page.inputValue('#pr-lines input[name="lines[0][code]"]') === 'P4-PAINT', 'เพิ่มบรรทัดแล้วบรรทัดเดิมต้องยังอยู่');
  await page.click('#main button[data-act="prRemove"][data-arg="1"]');
  await page.waitForFunction(() => !document.querySelector('#pr-lines input[name="lines[1][code]"]'));
  await page.click('#main button[data-act="prCheck"]');
  await waitText('บรรทัด 1: ระบุวันต้องใช้');
  await page.fill('#pr-lines input[name="lines[0][needDate]"]', addDays(today, 10));
  await page.fill('#pr-lines input[name="lines[0][reason]"]', 'ทดสอบแยกหน้าที่');
  await page.click('form[data-form="prSave"] button[type="submit"]');
  await toast('ขออนุมัติแล้ว');
  const mine = await state((s) => Object.values(s.tables.prs).find((x) => x.requestedBy === 'ADMIN'));
  assert(mine && mine.status === 'SUBMITTED', 'ใบของผู้ดูแลต้องรออนุมัติ');
  ctxIds.prAdmin = mine.prNo;
  await waitText('คุณเป็นผู้ขอใบนี้ – อนุมัติหรือไม่อนุมัติเองไม่ได้');
  assert(await page.isDisabled('#p4-detail .form-actions button:text-is("อนุมัติ")'), 'ปุ่มอนุมัติของผู้ขอต้องกดไม่ได้');
  const r = await exec('pr.approve', { prNo: mine.prNo }, 'ADMIN');
  assert(!r.ok && r.errors.some((e) => e.code === 'SAME_PERSON'), 'ระบบต้องไม่ให้ผู้ขออนุมัติเอง');
  await shot('desktop-pr-sod');
});

await step('PR: another person approves one and rejects the other', async () => {
  await asUser('P4LEAD');
  await go('purchasing');
  await tab('pr');
  await page.click(`#pr-list tr[data-arg="${ctxIds.pr}"]`);
  await page.click('#p4-detail button[data-act="prApprove"]');
  await dlgOpen();
  await dlgSubmit();
  await dlgClosed();
  await toast(`อนุมัติ ${ctxIds.pr} แล้ว`);
  const a = await state((s, R, k) => s.tables.prs[k], ctxIds.pr);
  assert(a.status === 'APPROVED' && a.approvedBy === 'P4LEAD', `อนุมัติ: ${a.status} ${a.approvedBy}`);
  await waitText(`ผู้ขอ`, 3000, '#p4-detail');
  await page.click(`#pr-list tr[data-arg="${ctxIds.prAdmin}"]`);
  await page.click('#p4-detail button[data-act="prReject"]');
  await dlgOpen();
  await dlgSubmit();
  await dlgError('ระบุเหตุผลให้ชัดเจน');
  await page.fill('#dlg input[name="reason"]', 'ซ้ำกับใบขอซื้อจากแผนเติมสต็อก');
  await dlgSubmit();
  await dlgClosed();
  const rj = await state((s, R, k) => s.tables.prs[k], ctxIds.prAdmin);
  assert(rj.status === 'REJECTED' && rj.rejectedBy === 'P4LEAD' && rj.rejectReason.indexOf('ซ้ำ') >= 0, `ไม่อนุมัติ: ${JSON.stringify(rj.status)}`);
  await waitText('ไม่อนุมัติโดย', 3000, '#p4-detail');
  // a purchasing lead cannot create POs from it? (po.manage) – the lead can: the button is there
  await page.click(`#pr-list tr[data-arg="${ctxIds.pr}"]`);
  await page.waitForSelector('#p4-detail button[data-act="prToPo"]');
});

await step('PO from the approved PR, rounded to buy units, issued', async () => {
  await asUser('P4PUR');
  await go('purchasing');
  await tab('po');
  await waitText('ยังไม่มีใบสั่งซื้อ');
  await page.click('#main button[data-act="newPo"]');
  await page.selectOption('#po-sup', 'P4-SUP1');
  await page.check(`#main input[name="prNos[]"][value="${ctxIds.pr}"]`);
  await page.click('#main button[data-act="poPull"]');
  await page.waitForFunction(() => document.querySelector('#po-lines input[name="lines[0][code]"]').value === 'P4-BOLT');
  assert(await page.inputValue('#po-lines input[name="lines[0][qty]"]') === '10', 'ดึงจากใบขอซื้อ 1000 ตัว = 10 กล่อง');
  assert(await page.inputValue('#po-lines input[name="lines[0][unit]"]') === 'กล่อง', 'หน่วยซื้อตามที่ตั้งไว้');
  assert(await page.inputValue('#po-lines input[name="lines[0][price]"]') === '250', 'ราคาตามที่ตั้งไว้');
  assert(await page.inputValue('#po-lines input[name="lines[0][prNo]"]') === ctxIds.pr, 'บรรทัดต้องอ้างใบขอซื้อ');
  assert(!(await page.$('#po-lines input[name="lines[1][code]"]')), 'บรรทัดของผู้ขายอื่นต้องไม่ถูกดึง');
  await waitText('ใบขอซื้อระบุผู้ขาย P4-SUP2');
  await page.click('#main button[data-act="poCheck"]');
  await waitText('ตรวจแล้ว: สร้างร่างได้ · มูลค่ารวม 2,500.00 บาท');
  await page.click('form[data-form="poSave"] button[type="submit"]');
  await toast('สร้างร่าง PO');
  const po = await state((s) => Object.values(s.tables.pos).find((x) => x.supplier === 'P4-SUP1'));
  assert(po && po.status === 'DRAFT' && po.lines[0].base === 1000 && po.lines[0].prNo === ctxIds.pr && po.total === 2500, `ใบสั่งซื้อ: ${JSON.stringify(po && po.lines)}`);
  ctxIds.poBolt = po.poNo;
  assert(await state((s, R, k) => s.tables.prs[k].status === 'CONVERTED', ctxIds.pr), 'ใบขอซื้อต้องเป็น ออก PO แล้ว');
  await waitText('ร่าง: ผู้ขายยังไม่ได้รับ');
  await page.click('#p4-detail button[data-act="poIssue"]');
  await dlgOpen();
  await waitText('ระบบไม่ได้ส่งอีเมลหรือข้อความให้ผู้ขาย', 3000, '#dlg');
  await dlgSubmit();
  await dlgClosed();
  assert(await state((s, R, k) => s.tables.pos[k].status === 'ISSUED' && s.tables.pos[k].issuedBy === 'P4PUR', ctxIds.poBolt), 'ใบสั่งซื้อต้องเป็น ส่งผู้ขายแล้ว');
});

await step('PO for the other supplier (dated earlier, so it is late) and one by hand', async () => {
  await page.click('#main button[data-act="newPo"]');
  await page.fill('#po-date', addDays(today, -30));
  await page.selectOption('#po-sup', 'P4-SUP2');
  await page.check(`#main input[name="prNos[]"][value="${ctxIds.pr}"]`);
  await page.click('#main button[data-act="poPull"]');
  await page.waitForFunction(() => document.querySelector('#po-lines input[name="lines[0][code]"]').value === 'P4-PAINT');
  assert(await page.inputValue('#po-lines input[name="lines[0][qty]"]') === '2' && await page.inputValue('#po-lines input[name="lines[0][unit]"]') === 'ถัง', '40 ลิตร = 2 ถัง');
  await page.fill('#po-lines input[name="lines[0][dueDate]"]', addDays(today, -20));
  await page.click('form[data-form="poSave"] button[type="submit"]');
  await toast('สร้างร่าง PO');
  const paintPo = await state((s) => Object.values(s.tables.pos).find((x) => x.supplier === 'P4-SUP2'));
  ctxIds.poPaint = paintPo.poNo;
  await page.click('#p4-detail button[data-act="poIssue"]');
  await dlgOpen();
  await dlgSubmit();
  await dlgClosed();
  await waitText('เลยกำหนด 20 วัน', 4000, '#p4-detail');
  // by hand: no price set with that supplier → refused, the system does not guess the price
  await page.click('#main button[data-act="newPo"]');
  await page.selectOption('#po-sup', 'P4-SUP2');
  await page.check('#main input[name="mode"][value="hand"]');
  await page.waitForFunction(() => !document.querySelector('#main input[name="prNos[]"]'));
  await page.fill('#po-lines input[name="lines[0][code]"]', 'P4-PLATE');
  await page.fill('#po-lines input[name="lines[0][qty]"]', '1');
  await page.fill('#po-lines input[name="lines[0][dueDate]"]', addDays(today, 5));
  await page.selectOption('#po-lines select[name="lines[0][wh]"]', 'P4W');
  await page.click('#main button[data-act="poCheck"]');
  await waitText('ระบบไม่เดาราคา');
  await page.selectOption('#po-sup', 'P4-SUP1');
  await page.fill('#po-lines input[name="lines[0][qty]"]', '5');
  await page.fill('#po-lines input[name="lines[0][dueDate]"]', addDays(today, 10));
  await page.click('form[data-form="poSave"] button[type="submit"]');
  await toast('สร้างร่าง PO');
  const plate = await state((s) => Object.values(s.tables.pos).find((x) => x.lines[0].code === 'P4-PLATE'));
  assert(plate && plate.lines[0].price === 3200 && plate.lines[0].unit === 'แผ่น' && plate.lines[0].prNo === '' && plate.total === 16000, `ใบสั่งซื้อแผ่นเหล็ก: ${JSON.stringify(plate && plate.lines)}`);
  ctxIds.poPlate = plate.poNo;
  await page.click('#p4-detail button[data-act="poIssue"]');
  await dlgOpen();
  await dlgSubmit();
  await dlgClosed();
  await shot('desktop-po');
});

await step('receive: partial, then over-receipt only after the lead approves', async () => {
  await asUser('P4STORE');
  await go('purchasing');
  await tab('recv');
  await waitText('ยังเบิก จอง หรือใช้ไม่ได้จนกว่า QC ตรวจและปล่อยผ่าน');
  assert(!(await page.$('#main button[data-act="newPo"]')), 'สโตร์ต้องไม่เห็นปุ่มสร้างใบสั่งซื้อ');
  await page.click(`#rcv-list tr[data-arg="${ctxIds.poBolt}"]`);
  await page.waitForSelector('#rcv-qty-1');
  await waitText('ค้างรับ 10 กล่อง (= 1,000 ตัว)', 4000, '#p4-detail');
  await page.fill('#rcv-qty-1', '4');
  await page.fill('#rcv-bin-1', 'P4-01');
  await page.fill('#rcv-sdoc', 'IV-TEST-01');
  await page.click('form[data-form="recv"] button[type="submit"]');
  await dlgOpen();
  await waitText('= 400 ตัว', 3000, '#dlg');
  await dlgSubmit();
  await dlgClosed();
  await waitText('รับเข้าแล้ว', 6000, '#p4-done');
  const s1 = await state((s, R, k) => ({ po: s.tables.pos[k], bal: (s.tables.balances || {})['P4-BOLT|P4W|P4-01|AVAILABLE|'] }), ctxIds.poBolt);
  assert(s1.po.status === 'PARTIAL' && s1.po.lines[0].received === 400 && s1.bal && s1.bal.qty === 400, `หลังรับบางส่วน: ${s1.po.status} ${s1.po.lines[0].received} ${JSON.stringify(s1.bal)}`);
  const rr = await state((s, R, k) => Object.values(s.tables.documents).find((d) => d.type === 'RR' && d.ref === k), ctxIds.poBolt);
  assert(rr && rr.supplierDoc === 'IV-TEST-01' && rr.status === 'POSTED', 'ใบรับต้องเก็บเลขใบส่งของผู้ขาย');
  await waitText('ค้างรับ 6 กล่อง (= 600 ตัว)', 4000, '#p4-detail');
  // 7 boxes > 6 outstanding: refused before anything changes, the screen says who can allow it
  await page.fill('#rcv-qty-1', '7');
  await page.fill('#rcv-bin-1', 'P4-01');
  await page.click('form[data-form="recv"] button[type="submit"]');
  await waitText('ให้หัวหน้าจัดซื้ออนุมัติรับเกินก่อน', 4000, '#rcv-check');
  assert(await state((s, R, k) => s.tables.pos[k].lines[0].received === 400, ctxIds.poBolt), 'รับเกินต้องไม่เปลี่ยนยอด');
  await asUser('P4LEAD');
  await tab('po');
  await page.click(`#po-list tr[data-arg="${ctxIds.poBolt}"]`);
  await page.click('#p4-detail button[data-act="poOver"][data-arg="1"]');
  await dlgOpen();
  await page.fill('#dlg input[name="qty"]', '1');
  await page.fill('#dlg input[name="reason"]', 'ผู้ขายส่งเต็มมัด');
  await dlgSubmit();
  await dlgClosed();
  assert(await state((s, R, k) => s.tables.pos[k].lines[0].overAllowed === 100, ctxIds.poBolt), 'อนุมัติรับเกิน 1 กล่อง = 100 ตัว');
  await asUser('P4STORE');
  await tab('recv');
  await page.click(`#rcv-list tr[data-arg="${ctxIds.poBolt}"]`);
  await waitText('อนุมัติรับเกินได้อีก 1 กล่อง', 4000, '#p4-detail');
  await page.click('#main button[data-act="recvFill"]');
  await page.waitForFunction(() => document.querySelector('#rcv-qty-1').value === '6');
  await page.fill('#rcv-qty-1', '7');
  await page.fill('#rcv-bin-1', 'P4-01');
  await page.click('form[data-form="recv"] button[type="submit"]');
  await dlgOpen();
  await dlgSubmit();
  await dlgClosed();
  await waitText('รับเข้าแล้ว', 6000, '#p4-done');
  const s2 = await state((s, R, k) => s.tables.pos[k], ctxIds.poBolt);
  assert(s2.status === 'RECEIVED' && s2.lines[0].received === 1100 && s2.lines[0].overAllowed === 0, `หลังรับเกิน: ${s2.status} ${s2.lines[0].received} ${s2.lines[0].overAllowed}`);
});

await step('receive: heat number and certificate, incoming QC lands in รอตรวจ', async () => {
  await page.click(`#rcv-list tr[data-arg="${ctxIds.poPlate}"]`);
  await page.waitForSelector('#rcv-qty-1');
  for (const x of ['ต้องตรวจรับ → เข้าเป็น รอตรวจ', 'ต้องระบุ Heat no.', 'ต้องมีใบรับรองวัสดุ']) await waitText(x, 4000, '#p4-detail');
  await page.fill('#rcv-qty-1', '5');
  await page.fill('#rcv-bin-1', 'P4-02');
  await page.click('form[data-form="recv"] button[type="submit"]');
  await waitText('P4-PLATE ต้องระบุHeat no.', 4000, '#rcv-check');
  await page.fill('#rcv-lot-1', 'H-P4-77');
  await page.fill('#rcv-cert-1', 'MC-2026-001');
  await page.click('form[data-form="recv"] button[type="submit"]');
  await dlgOpen();
  await waitText('รอตรวจ', 3000, '#dlg');
  await dlgSubmit();
  await dlgClosed();
  await waitText('เข้าเป็น "รอตรวจ"', 6000, '#p4-done');
  await waitText('บันทึกใบรับรอง MC-2026-001', 6000, '#p4-done');
  const s3 = await state((s) => ({ hold: (s.tables.balances || {})['P4-PLATE|P4W|P4-02|QC_HOLD|H-P4-77'], avail: (s.tables.balances || {})['P4-PLATE|P4W|P4-02|AVAILABLE|H-P4-77'],
    lot: (s.tables.lots || {})['P4-PLATE|H-P4-77'] }));
  assert(s3.hold && s3.hold.qty === 5 && !s3.avail, `แผ่นเหล็กต้องเข้าเป็นรอตรวจ: ${JSON.stringify(s3)}`);
  assert(s3.lot && s3.lot.cert && s3.lot.cert.no === 'MC-2026-001' && s3.lot.poNo === ctxIds.poPlate && s3.lot.cert.verified === false, `ล็อต/ใบรับรอง: ${JSON.stringify(s3.lot)}`);
  assert(await state((s, R, k) => s.tables.pos[k].status === 'RECEIVED', ctxIds.poPlate), 'ใบสั่งซื้อแผ่นเหล็กรับครบ');
  await shot('desktop-receive');
});

await step('return to supplier with and without replacement', async () => {
  await tab('rv');
  await page.click(`#rv-list tr[data-arg="${ctxIds.poBolt}"]`);
  await page.waitForSelector('#rv-from-1');
  await page.selectOption('#rv-from-1', 'P4-BOLT|P4W|P4-01|AVAILABLE|');
  await page.fill('#rv-qty-1', '2');
  await page.fill('#rv-reason', 'ผิวเป็นสนิม');
  await page.click('form[data-form="rv"] button[type="submit"]');
  await waitText('บรรทัด 1: เลือกว่าขอของทดแทนหรือไม่', 4000, '#rv-check');
  await page.check('#main input[name="lines[0][replace]"][value="1"]');
  await page.click('form[data-form="rv"] button[type="submit"]');
  await dlgOpen();
  await waitText('ขอของทดแทน – ยอดกลับเป็นค้างรับ', 3000, '#dlg');
  await dlgSubmit();
  await dlgClosed();
  await waitText('คืนผู้ขายแล้ว', 6000, '#p4-done');
  const a = await state((s, R, k) => ({ po: s.tables.pos[k], bal: s.tables.balances['P4-BOLT|P4W|P4-01|AVAILABLE|'] }), ctxIds.poBolt);
  const l = a.po.lines[0];
  assert(l.returned === 200 && l.replaced === 200 && l.received === 900 && a.po.status === 'PARTIAL' && a.bal.qty === 900,
    `คืนแบบขอทดแทน: ${a.po.status} รับ ${l.received} คืน ${l.returned} ทดแทน ${l.replaced} คงเหลือ ${a.bal.qty}`);
  // without replacement: the outstanding qty stays as it is
  await page.selectOption('#rv-from-1', 'P4-BOLT|P4W|P4-01|AVAILABLE|');
  await page.fill('#rv-qty-1', '1');
  await page.fill('#rv-reason', 'ขนาดไม่ตรงแบบ ลดหนี้');
  await page.check('#main input[name="lines[0][replace]"][value="0"]');
  await page.click('form[data-form="rv"] button[type="submit"]');
  await dlgOpen();
  await waitText('ไม่ขอ – ลดหนี้/คืนเงิน', 3000, '#dlg');
  await dlgSubmit();
  await dlgClosed();
  await waitText('คืนผู้ขายแล้ว', 6000, '#p4-done');
  const b = await state((s, R, k) => s.tables.pos[k].lines[0], ctxIds.poBolt);
  assert(b.returned === 300 && b.replaced === 200 && b.received === 900 && R0(b) === 100, `คืนแบบลดหนี้: ${JSON.stringify(b)}`);
  const rvs = await state((s, R, k) => Object.values(s.tables.documents).filter((d) => d.type === 'RV' && d.ref === k).length, ctxIds.poBolt);
  assert(rvs === 2, `ต้องมีใบคืนผู้ขาย 2 ใบ ได้ ${rvs}`);
  // the replacement brought the PO back to the receiving list
  await tab('recv');
  await page.waitForSelector(`#rcv-list tr[data-arg="${ctxIds.poBolt}"]`);
});
function R0(l) {
  return Math.round((l.base - l.received - l.cancelled) * 1e6) / 1e6;
}

await step('late PO line with the job it holds up', async () => {
  const job = await must('job.create', { soNo: 'SO-P4-001', dueDate: addDays(today, 3), lines: [{ code: 'P4-PAINT', qty: 30 }] }, 'P4PLAN');
  ctxIds.job = job.result.jobNo;
  await asUser('P4PLAN');
  await go('replenish');
  await page.waitForSelector('#rp-late');
  const row = (await rowCells('#rp-late tbody tr', ctxIds.poPaint)).join(' | ');
  assert(row.indexOf('เลย 20 วัน') >= 0 && row.indexOf(ctxIds.job) >= 0 && row.indexOf('ขาด 30') >= 0, `แถว PO เลยกำหนด: ${row}`);
  // demand 30 not reserved, the late 40 not counted → order again
  await tab('order');
  await page.click('#rp-list button[data-act="why"][data-arg="P4-PAINT"]');
  await waitText('ไม่นับ (นโยบาย: ของล่าช้าไม่แน่นอน)', 4000, '#rp-list');
  await waitText('ใบงานเปิดยังต้องใช้ 30 ลิตร', 4000, '#rp-list');
  await shot('desktop-replenish-late');
});

await step('PO: new due date, cancel part of a line, close, cancel a draft', async () => {
  await asUser('P4PUR');
  await go('purchasing');
  await tab('po');
  await page.click(`#po-list tr[data-arg="${ctxIds.poPaint}"]`);
  await page.click('#p4-detail button[data-act="poDue"][data-arg="1"]');
  await dlgOpen();
  await page.fill('#dlg input[name="dueDate"]', addDays(today, 5));
  await page.fill('#dlg input[name="reason"]', 'ผู้ขายแจ้งของเข้าช้า');
  await dlgSubmit();
  await dlgClosed();
  const d = await state((s, R, k) => s.tables.pos[k].lines[0], ctxIds.poPaint);
  assert(d.dueDate === addDays(today, 5) && d.originalDue === addDays(today, -20), `กำหนดเข้าใหม่: ${d.dueDate} เดิม ${d.originalDue}`);
  await waitText('เดิม', 3000, '#po-lines-view');
  await page.click('#p4-detail button[data-act="poCancelLine"][data-arg="1"]');
  await dlgOpen();
  await page.fill('#dlg input[name="qty"]', '1');
  await page.fill('#dlg input[name="reason"]', 'ลดจำนวนตามงานจริง');
  await dlgSubmit();
  await dlgClosed();
  const c = await state((s, R, k) => s.tables.pos[k], ctxIds.poPaint);
  assert(c.lines[0].cancelled === 20 && c.status === 'ISSUED', `ยกเลิกยอดค้าง 1 ถัง: ${c.lines[0].cancelled} ${c.status}`);
  assert(!(await page.$('#p4-detail button[data-act="poCloseOut"]')), 'จัดซื้อทั่วไปต้องไม่เห็นปุ่มปิดยอดค้าง');
  await waitText('ปิดยอดค้าง (ผู้ขายส่งไม่ครบและไม่ส่งอีก) ทำได้โดย หัวหน้าจัดซื้อ', 3000, '#p4-detail');
  // after the new due date the line is not late any more – it shows only as "arrives after the job needs it"
  await asUser('P4PLAN');
  await go('replenish');
  await page.waitForSelector('#rp-late');
  assert(!(await rowCells('#rp-late tbody tr', ctxIds.poPaint)), 'เลื่อนกำหนดแล้วต้องไม่เป็น PO เลยกำหนด');
  await page.check('#rp-atrisk');
  await page.waitForFunction((k) => document.querySelector('#rp-late').innerText.indexOf(k) >= 0, ctxIds.poPaint);
  await waitText('เข้าหลังวันต้องใช้ของงาน', 4000, '#rp-late');
  // the lead closes what is left of the bolt PO
  await asUser('P4LEAD');
  await go('purchasing');
  await tab('po');
  await page.click(`#po-list tr[data-arg="${ctxIds.poBolt}"]`);
  await page.click('#p4-detail button[data-act="poCloseOut"]');
  await dlgOpen();
  await waitText('ยอดที่จะถูกปิด', 3000, '#dlg');
  await page.fill('#dlg input[name="reason"]', 'ผู้ขายแจ้งของหมด');
  await dlgSubmit();
  await dlgClosed();
  const cl = await state((s, R, k) => s.tables.pos[k], ctxIds.poBolt);
  assert(cl.status === 'CLOSED' && cl.closedBy === 'P4LEAD' && cl.lines[0].cancelled === 100, `ปิดยอดค้าง: ${cl.status} ${cl.lines[0].cancelled}`);
  // a draft cancelled with a reason; the PR line it used is free again
  const dr = await must('po.create', { supplier: 'P4-SUP1', lines: [{ code: 'P4-PLATE', qty: 2, dueDate: addDays(today, 9), wh: 'P4W' }] }, 'P4PUR');
  await asUser('P4PUR');
  await tab('po');
  await page.click(`#po-list tr[data-arg="${dr.result.poNo}"]`);
  await page.click('#p4-detail button[data-act="poCancel"]');
  await dlgOpen();
  await page.fill('#dlg input[name="reason"]', 'สั่งซ้ำ');
  await dlgSubmit();
  await dlgClosed();
  assert(await state((s, R, k) => s.tables.pos[k].status === 'CANCELLED' && s.tables.pos[k].cancelledBy === 'P4PUR', dr.result.poNo), 'ร่างที่ยกเลิกต้องเป็น ยกเลิก');
  await page.selectOption('#po-st', 'CANCELLED');
  await page.waitForSelector(`#po-list tr[data-arg="${dr.result.poNo}"]`);
  await page.selectOption('#po-st', '');
});

await step('permissions per role', async () => {
  await asUser('P4VIEW');
  await go('suppliers');
  await tab('sup');
  assert(!(await page.$('#main button[data-act="newSup"]')), 'ผู้ดูต้องไม่เห็นปุ่มเพิ่มผู้ขาย');
  await waitText('เพิ่ม/แก้ผู้ขายได้เฉพาะ');
  await tab('terms');
  await page.fill('#term-q', 'P4-BOLT');
  await page.waitForSelector('#main tr[data-act="pickItem"][data-arg="P4-BOLT"]');
  await page.click('#main tr[data-act="pickItem"][data-arg="P4-BOLT"]');
  await page.waitForSelector('#term-detail');
  assert(!(await page.$('form[data-form="addTerm"]')) && !(await page.$('#term-detail button[data-act="editTerm"]')), 'ผู้ดูต้องแก้ราคาไม่ได้');
  await go('purchasing');
  await tab('pr');
  assert(!(await page.$('#main button[data-act="newPr"]')), 'ผู้ดูต้องไม่เห็นปุ่มสร้างใบขอซื้อ');
  await tab('recv');
  const anyOpen = await page.$('#rcv-list tbody tr[data-arg]');
  if (anyOpen) {
    await anyOpen.click();
    await waitText('รับของได้เฉพาะ', 4000, '#p4-detail');
    assert(!(await page.$('form[data-form="recv"]')), 'ผู้ดูต้องไม่เห็นฟอร์มรับของ');
  }
  await go('replenish');
  assert(!(await page.$('#rp-make')) && !(await page.$('#rp-list input[data-act="pick"]')), 'ผู้ดูต้องสร้างใบขอซื้อจากแผนไม่ได้');
  await asUser('P4STORE');
  await go('purchasing');
  await tab('po');
  assert(!(await page.$('#main button[data-act="newPo"]')), 'สโตร์ต้องไม่เห็นปุ่มสร้างใบสั่งซื้อ');
  await page.click(`#po-list tr[data-arg="${ctxIds.poPaint}"]`);
  assert(!(await page.$('#p4-detail button[data-act="poDue"]')), 'สโตร์ต้องเลื่อนกำหนดเข้าไม่ได้');
  await page.waitForSelector('#p4-detail button[data-act="toRecv"]');
});

await step('phone width', async () => {
  await asUser('ADMIN');
  await page.setViewportSize({ width: 390, height: 844 });
  await go('suppliers');
  for (const x of ['sup', 'terms', 'rules']) {
    await tab(x);
    await noOverflow(`suppliers ${x}`);
  }
  await go('purchasing');
  for (const x of ['pr', 'po', 'recv', 'rv']) {
    await tab(x);
    await noOverflow(`purchasing ${x}`);
  }
  await tab('po');
  await page.click(`#po-list tr[data-arg="${ctxIds.poPaint}"]`);
  await noOverflow('purchasing ใบสั่งซื้อที่เลือก');
  await page.click('#main button[data-act="newPo"]');
  await noOverflow('purchasing สร้างใบสั่งซื้อ');
  await tab('recv');
  await page.click(`#rcv-list tr[data-arg="${ctxIds.poPaint}"]`);
  await page.waitForSelector('#rcv-qty-1');
  await noOverflow('purchasing รับของ');
  await shot('phone-receive');
  await go('replenish');
  await tab('all');
  await noOverflow('replenish');
  await shot('phone-replenish');
  await page.setViewportSize({ width: 1366, height: 900 });
});

await step('lots of data: the lists scroll in their own box', async () => {
  const N = 420;
  const items = [];
  for (let i = 1; i <= N; i++) items.push({ code: `P4-M-${String(i).padStart(4, '0')}`, name: `ทดสอบพีสี่ รายการจำนวนมาก ${i}`, baseUnit: 'ชิ้น', type: 'PART', minQty: 5, maxQty: 20 });
  await must('master.import', { items });
  await go('replenish');
  await tab('order');
  await page.waitForSelector('#rp-list');
  const rows = await page.locator('#rp-list tbody tr:not(.detail-row)').count();
  assert(rows === 300, `แสดงทีละ 300 แถว ได้ ${rows}`);
  await waitText('แสดง 300 จาก');
  const box = await page.evaluate(() => { const b = document.querySelector('#rp-list'); return [b.scrollHeight, b.clientHeight]; });
  assert(box[0] > box[1] + 50, `ตารางต้องเลื่อนในกรอบของตัวเอง ${box}`);
  await page.click('#main button[data-act="more"]');
  await page.waitForFunction(() => document.querySelectorAll('#rp-list tbody tr:not(.detail-row)').length > 300);
  // picking a row far down keeps the box where it was
  await page.evaluate(() => document.querySelector('#rp-list input[data-arg="P4-M-0200"]').scrollIntoView({ block: 'center' }));
  const before = await page.evaluate(() => document.querySelector('#rp-list').scrollTop);
  await page.check('#rp-list input[data-act="pick"][data-arg="P4-M-0200"]');
  await page.waitForFunction(() => document.querySelector('#rp-make').innerText.indexOf('(1)') >= 0);
  const after = await page.evaluate(() => document.querySelector('#rp-list').scrollTop);
  assert(Math.abs(after - before) < 5, `ตำแหน่งเลื่อนต้องคงเดิม ${before} → ${after}`);
  await go('suppliers');
  await tab('terms');
  await page.fill('#term-q', '');
  await page.waitForSelector('#term-list');
  const box2 = await page.evaluate(() => { const b = document.querySelector('#term-list'); return [b.scrollHeight, b.clientHeight]; });
  assert(box2[0] > box2[1] + 50, `ตารางสินค้า–ผู้ขายต้องเลื่อนในกรอบ ${box2}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow('suppliers ข้อมูลมาก');
  await go('replenish');
  await noOverflow('replenish ข้อมูลมาก');
  await page.setViewportSize({ width: 1366, height: 900 });
});

await browser.close();
if (problems.length) {
  console.log('PROBLEMS\n' + problems.join('\n'));
  process.exit(1);
}
console.log('p4 ok');
