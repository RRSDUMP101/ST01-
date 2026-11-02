// Review test of the Phase 4 screens (suppliers, purchasing, replenish) – used the way purchasing, store, planner,
// accounting, QC and a manager would, with wrong input on purpose.
//   RRS_OUT=/tmp/stockqc-p4-review node tests/e2e/p4-review.mjs [--shots dir]
// Covers what the first round missed: number boxes the browser cannot read (e.g. "5-") are refused instead of saved as
// "not set" or silently replaced by the supplier price; a "new" reorder rule never overwrites an existing one; money of
// 1,000 and more is shown; a PO can be made straight from ticked PRs; receipt / return messages use the PO line numbers
// shown on the cards; every late PO line is listed (also those no job needs) with the real shortage per job; stock
// waiting for QC is not called "ขอซื้อไว้แล้ว"; approvers see an estimated PR value from the supplier prices (or "ยังไม่มี
// ราคา" – never a guess); the supplier's delivery note number is in the PO's receipts; roles; user text never runs as
// markup; dialogs fit a 390 px phone. Own codes P4R-…, users P4R…
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
async function waitText(text, timeout, where) {
  const sel = where || '#main';
  await page.waitForFunction(([s, x]) => document.querySelector(s) && document.querySelector(s).innerText.indexOf(x) >= 0, [sel, text], { timeout: timeout || 6000 })
    .catch(async () => { throw new Error(`ไม่พบข้อความ "${text}" ใน ${sel}\n---\n${(await page.locator(sel).innerText().catch(() => '')).slice(0, 1500)}`); });
}
const state = (fn, arg) => page.evaluate(([src, a]) => (0, eval)(src)(window.RRS.app.ledger.state, window.RRS, a), [fn.toString(), arg === undefined ? null : arg]);
async function noOverflow(where) {
  const over = await page.evaluate(() => {
    const card = document.querySelector('#dlg:not([hidden]) .dlg-card');
    const r = card ? card.getBoundingClientRect() : null;
    return document.documentElement.scrollWidth > window.innerWidth + 1 || (r && (r.left < -1 || r.right > window.innerWidth + 1));
  });
  assert(!over, `${where}: กว้างเกินจอ`);
}
async function dlgOpen() {
  await page.waitForSelector('#dlg:not([hidden]) .dlg-card');
}
async function dlgSubmit() {
  await page.click('#dlg .dlg-f button[type="submit"]');
}
async function dlgCancel() {
  await page.click('#dlg .dlg-f .btn-ghost');
  await dlgClosed();
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
  await page.evaluate(() => { document.querySelector('#toasts').innerHTML = ''; });
}
/** Type into a number box the way a person would (fill() refuses text a number box cannot hold). */
async function typeNum(sel, text) {
  await page.fill(sel, '');
  await page.locator(sel).pressSequentially(text);
  const bad = await page.evaluate((s) => document.querySelector(s).validity.badInput, sel);
  assert(bad, `${sel} ควรอ่านค่า "${text}" ไม่ได้ (ทดสอบไม่ตรงกรณี)`);
}
const rowText = (sel, text) => page.evaluate(([s, x]) => {
  const tr = Array.from(document.querySelectorAll(s)).find((r) => r.innerText.indexOf(x) >= 0);
  return tr ? tr.innerText.replace(/\s+/g, ' ') : null;
}, [sel, text]);
const tab = (id) => page.click(`#main .tabs button[data-arg="${id}"]`);
const injected = () => page.evaluate(() => document.querySelectorAll('img[src="x"]').length);
async function shot(name) {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
}
async function step(name, fn) {
  current = name;
  try {
    await fn();
    assert(!(await injected()), 'ข้อความของผู้ใช้กลายเป็น HTML (มี <img src=x> ในหน้า)');
    console.log('ok  ', name);
  } catch (e) {
    problems.push(`${name}: ${e.message}`);
    console.log('FAIL', name, '\n     ', e.message.split('\n')[0]);
    if (shots) await page.screenshot({ path: path.join(shots, `fail-${name.replace(/[^\w]+/g, '_')}.png`), fullPage: true }).catch(() => {});
    await page.evaluate(() => { const d = document.querySelector('#dlg'); if (d && !d.hidden) d.querySelector('[data-dlg-close]').click(); }).catch(() => {});
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
const ids = {};

await step('setup: warehouse, items, users', async () => {
  await must('warehouse.upsert', { code: 'P4RW', name: 'คลังทดสอบรีวิวพีสี่' });
  await must('bin.upsert', { wh: 'P4RW', code: 'P4R-01', name: 'ชั้น 1' });
  await must('bin.upsert', { wh: 'P4RW', code: 'P4R-02', name: 'ชั้น 2' });
  await must('item.upsert', { code: 'P4R-NUT', name: 'ทดสอบรีวิว น็อต M12', baseUnit: 'ตัว', type: 'BUY' });
  await must('item.upsert', { code: 'P4R-HEAT', name: 'ทดสอบรีวิว แผ่นเหล็ก 6 มม.', baseUnit: 'แผ่น', type: 'RM', trackLot: 'heat', certRequired: true, qcIncoming: true });
  await must('item.upsert', { code: 'P4R-QCI', name: 'ทดสอบรีวิว ชุดบานพับ', baseUnit: 'ชุด', type: 'BUY', qcIncoming: true, minQty: 10, maxQty: 20 });
  await must('item.upsert', { code: 'P4R-LATE', name: 'ทดสอบรีวิว ยางกันกระแทก', baseUnit: 'ชิ้น', type: 'BUY' });
  await must('item.upsert', { code: 'P4R-JOB', name: 'ทดสอบรีวิว ขายึดไฟท้าย', baseUnit: 'ชิ้น', type: 'BUY' });
  await must('item.upsert', { code: 'P4R-PAINT', name: 'ทดสอบรีวิว สีกันสนิม', baseUnit: 'ลิตร', type: 'CONS', minQty: 5, maxQty: 15 });
  for (const [id, name, roles] of [['P4RPUR', 'จัดซื้อรีวิว', ['purchasing']], ['P4RLEAD', 'หัวหน้าจัดซื้อรีวิว', ['purchasing_lead']],
    ['P4RSTORE', 'สโตร์รีวิว', ['store']], ['P4RPLAN', 'วางแผนรีวิว', ['planner']], ['P4RACC', 'บัญชีรีวิว', ['accounting']],
    ['P4RMGR', 'ผู้บริหารรีวิว', ['manager']], ['P4RQC', 'QC รีวิว', ['qc']]]) {
    await must('user.upsert', { id, name, roles });
  }
  await must('supplier.upsert', { id: 'P4R-S2', name: 'ผู้ขายรีวิวสอง', create: true });
});

await step('suppliers: an unreadable number is refused – nothing saved, then saved when fixed', async () => {
  await asUser('P4RPUR');
  await go('suppliers');
  await tab('sup');
  await page.click('#main button[data-act="newSup"]');
  await page.fill('#sup-id', 'P4R-S1');
  await page.fill('#sup-name', 'ผู้ขายรีวิว ' + EVIL);
  await page.fill('#sup-contact', EVIL);
  await typeNum('#sup-lead', '5-');
  await page.click('form[data-form="saveSup"] button[type="submit"]');
  await toast('ช่อง "Lead time ปกติ (วัน)" อ่านเป็นตัวเลขไม่ได้');
  assert(!(await state((s) => !!(s.tables.suppliers || {})['P4R-S1'])), 'Lead time อ่านไม่ได้ต้องไม่บันทึกผู้ขาย');
  assert(await page.inputValue('#sup-name') === 'ผู้ขายรีวิว ' + EVIL, 'สิ่งที่พิมพ์ไว้ต้องยังอยู่ให้แก้');
  await page.fill('#sup-lead', '5');
  await page.click('form[data-form="saveSup"] button[type="submit"]');
  await toast('เพิ่มผู้ขาย P4R-S1 แล้ว');
  const s1 = await state((s) => s.tables.suppliers['P4R-S1']);
  assert(s1 && s1.leadDays === 5 && s1.contact === EVIL, `ผู้ขายที่บันทึก: ${JSON.stringify(s1)}`);
  await waitText('ผู้ขายรีวิว ' + EVIL, 4000, '#sup-list');
  // the engine also refuses a code that already exists when the screen asks to create one
  const dup = await exec('supplier.upsert', { id: 'P4R-S1', name: 'ซ้ำ', create: true }, 'P4RPUR');
  assert(!dup.ok && dup.errors[0].code === 'DUPLICATE', 'เพิ่มรหัสซ้ำต้องถูกปฏิเสธ');
});

await step('terms: unreadable price / MOQ refused, the saved terms unchanged', async () => {
  await tab('terms');
  await page.fill('#term-q', 'P4R-NUT');
  await page.waitForSelector('#main tr[data-act="pickItem"][data-arg="P4R-NUT"]');
  await page.click('#main tr[data-act="pickItem"][data-arg="P4R-NUT"]');
  await page.waitForSelector('form[data-form="addTerm"]');
  await page.selectOption('#term-sup', 'P4R-S1');
  await typeNum('#term-price', '1-');
  await page.fill('#term-unit', 'ลัง');
  await page.fill('#term-factor', '50');
  await page.click('form[data-form="addTerm"] button[type="submit"]');
  await toast('ช่อง "ราคาต่อหน่วยซื้อ (บาท)" อ่านเป็นตัวเลขไม่ได้');
  assert(!(await state((s) => !!(s.tables.item_suppliers || {})['P4R-NUT|P4R-S1'])), 'ราคาอ่านไม่ได้ต้องไม่บันทึก (ไม่ใช่บันทึกเป็น ยังไม่มีราคา)');
  await page.fill('#term-price', '1200');
  await page.click('form[data-form="addTerm"] button[type="submit"]');
  await toast('ตั้ง P4R-NUT กับผู้ขาย P4R-S1 แล้ว');
  await page.click('#term-detail button[data-act="editTerm"][data-arg="P4R-S1"]');
  await dlgOpen();
  await typeNum('#dlg input[name="moq"]', '2-');
  await dlgSubmit();
  await dlgError('ช่อง "สั่งขั้นต่ำ MOQ (หน่วยซื้อ)" อ่านเป็นตัวเลขไม่ได้');
  await dlgCancel();
  const l = await state((s) => s.tables.item_suppliers['P4R-NUT|P4R-S1']);
  assert(l.price === 1200 && l.buyUnit === 'ลัง' && l.factor === 50 && l.moq === 0, `เงื่อนไขซื้อต้องไม่เปลี่ยน: ${JSON.stringify(l)}`);
  for (const [code, price] of [['P4R-HEAT', 2500], ['P4R-QCI', 10], ['P4R-JOB', 7], ['P4R-PAINT', 300]]) {
    await must('itemSupplier.upsert', { code, supplier: 'P4R-S1', price, preferred: true }, 'P4RPUR');
  }
});

await step('reorder rule: "new" on an existing item/warehouse never overwrites it', async () => {
  await must('reorder.set', { code: 'P4R-NUT', wh: '', min: 100, max: 500, leadDays: 4 }, 'P4RPUR');
  await tab('rules');
  await page.click('#main button[data-act="newRule"]');
  await dlgOpen();
  await page.fill('#rule-code', 'p4r-nut');
  await page.fill('#rule-max', '300');
  await dlgSubmit();
  await dlgError('P4R-NUT มีเงื่อนไขทุกคลังอยู่แล้ว');
  let r = await state((s) => s.tables.reorder_rules['P4R-NUT|']);
  assert(r.min === 100 && r.max === 500 && r.leadDays === 4, `เงื่อนไขเดิมต้องไม่ถูกเขียนทับ: ${JSON.stringify(r)}`);
  // another warehouse is a separate rule and is saved
  await page.selectOption('#rule-wh-in', 'P4RW');
  await dlgSubmit();
  await dlgClosed();
  await toast('บันทึกเงื่อนไขเติมสต็อกแล้ว');
  r = await state((s) => s.tables.reorder_rules['P4R-NUT|P4RW']);
  assert(r && r.max === 300 && r.min == null, `เงื่อนไขของคลัง P4RW: ${JSON.stringify(r)}`);
  assert((await state((s) => s.tables.reorder_rules['P4R-NUT|'])).min === 100, 'เงื่อนไขทุกคลังยังเหมือนเดิม');
  // an unreadable Min while editing
  await page.click('#rule-list tr[data-arg="P4R-NUT|P4RW"]');
  await dlgOpen();
  await typeNum('#rule-min', '1-');
  await dlgSubmit();
  await dlgError('ช่อง "Min (ตัว)" อ่านเป็นตัวเลขไม่ได้');
  await dlgCancel();
  assert((await state((s) => s.tables.reorder_rules['P4R-NUT|P4RW'])).max === 300, 'แก้ไม่สำเร็จต้องไม่เปลี่ยน');
});

await step('PR: unreadable qty refused; the approver sees an estimate from the supplier prices', async () => {
  await asUser('P4RPLAN');
  await go('purchasing');
  await tab('pr');
  await page.click('#main button[data-act="newPr"]');
  await page.waitForSelector('#pr-lines');
  await page.fill('#pr-lines input[name="lines[0][code]"]', 'P4R-NUT');
  await typeNum('#pr-lines input[name="lines[0][qty]"]', '1-');
  await page.fill('#pr-lines input[name="lines[0][needDate]"]', addDays(today, 8));
  await page.selectOption('#pr-lines select[name="lines[0][wh]"]', 'P4RW');
  const before = await state((s) => Object.keys(s.tables.prs || {}).length);
  await page.click('form[data-form="prSave"] button[type="submit"]');
  await toast('บรรทัด 1 ช่อง "จำนวน (หน่วยหลัก)" อ่านเป็นตัวเลขไม่ได้');
  assert(await state((s) => Object.keys(s.tables.prs || {}).length) === before, 'ต้องไม่สร้างใบขอซื้อ');
  await page.fill('#pr-lines input[name="lines[0][qty]"]', '120');
  await page.fill('#pr-lines input[name="lines[0][reason]"]', 'งานกระบะ ' + EVIL);
  await page.fill('#pr-remark', EVIL);
  await page.click('#main button[data-act="prAdd"]');
  await page.waitForSelector('#pr-lines input[name="lines[1][code]"]');
  await page.fill('#pr-lines input[name="lines[1][code]"]', 'P4R-LATE');
  await page.fill('#pr-lines input[name="lines[1][qty]"]', '3');
  await page.selectOption('#pr-lines select[name="lines[1][supplier]"]', 'P4R-S2');
  await page.click('form[data-form="prSave"] button[type="submit"]');
  await toast('ขออนุมัติแล้ว');
  const pr = await state((s) => Object.values(s.tables.prs).find((x) => x.requestedBy === 'P4RPLAN' && x.lines.some((l) => l.code === 'P4R-NUT')));
  assert(pr && pr.status === 'SUBMITTED' && pr.remark === EVIL && pr.lines[1].supplier === 'P4R-S2', `ใบขอซื้อ: ${JSON.stringify(pr)}`);
  ids.pr = pr.prNo;
  // 120 ตัว = 3 ลัง (50 ตัว/ลัง) × 1,200 = 3,600; the line without a price says so
  await waitText('≈ 3,600.00 บาท · 1 บรรทัดยังไม่มีราคา', 4000, '#p4-detail');
  // accounting and QC read it, cannot create or approve
  for (const u of ['P4RACC', 'P4RQC']) {
    await asUser(u);
    await page.click(`#pr-list tr[data-arg="${ids.pr}"]`);
    await waitText('มูลค่าประมาณ', 4000, '#p4-detail');
    assert(!(await page.$('#main button[data-act="newPr"]')) && !(await page.$('#p4-detail button[data-act="prApprove"]')), `${u} ต้องสร้าง/อนุมัติใบขอซื้อไม่ได้`);
  }
  await asUser('P4RMGR');
  await page.click(`#pr-list tr[data-arg="${ids.pr}"]`);
  const row = await rowText('#p4-detail tbody tr', 'P4R-NUT');
  assert(row && row.indexOf('3,600.00') >= 0 && row.indexOf('3 ลัง') >= 0, `แถวมูลค่าประมาณ: ${row}`);
  assert((await rowText('#p4-detail tbody tr', 'P4R-LATE')).indexOf('ยังไม่มีราคา') >= 0, 'บรรทัดที่ไม่มีราคาต้องบอก ยังไม่มีราคา');
  await page.click('#p4-detail button[data-act="prApprove"]');
  await dlgOpen();
  await waitText('มูลค่าประมาณ ≈ 3,600.00 บาท', 3000, '#dlg');
  await shot('desktop-pr-approve-estimate');
  await dlgSubmit();
  await dlgClosed();
  assert(await state((s, R, k) => s.tables.prs[k].status === 'APPROVED' && s.tables.prs[k].approvedBy === 'P4RMGR', ids.pr), 'ผู้บริหารอนุมัติแล้ว');
});

await step('PO straight from a ticked PR (no pull), money of 1,000+ shown', async () => {
  await asUser('P4RPUR');
  await tab('po');
  await page.click('#main button[data-act="newPo"]');
  await page.selectOption('#po-sup', 'P4R-S1');
  await page.check(`#main input[name="prNos[]"][value="${ids.pr}"]`);
  await page.click('#main button[data-act="poCheck"]');
  await waitText('ตรวจแล้ว: สร้างร่างได้ · มูลค่ารวม 3,600.00 บาท', 4000, '#p4-detail');
  await waitText('ขอซื้อจากผู้ขาย P4R-S2', 4000, '#p4-detail'); // the other supplier's line is left out, and said so
  await page.click('form[data-form="poSave"] button[type="submit"]');
  await toast('สร้างร่าง PO');
  const po = await state((s, R, k) => Object.values(s.tables.pos).find((x) => (x.prNos || []).indexOf(k) >= 0), ids.pr);
  assert(po && po.lines.length === 1 && po.lines[0].qty === 3 && po.lines[0].unit === 'ลัง' && po.lines[0].base === 150 && po.total === 3600,
    `ใบสั่งซื้อจากใบขอซื้อ: ${JSON.stringify(po && po.lines)}`);
  ids.poNut = po.poNo;
  const line = await rowText('#po-lines-view tbody tr', 'P4R-NUT');
  assert(line.indexOf('1,200.00') >= 0 && line.indexOf('3,600.00') >= 0, `บรรทัดใบสั่งซื้อต้องแสดงราคาและมูลค่า: ${line}`);
  const listRow = await rowText('#po-list tbody tr', ids.poNut);
  assert(listRow.indexOf('3,600.00') >= 0, `รายการใบสั่งซื้อต้องแสดงมูลค่า: ${listRow}`);
  await page.click('#p4-detail button[data-act="poIssue"]');
  await dlgOpen();
  await dlgSubmit();
  await dlgClosed();
  // the supplier's own page shows the open PO with its value
  await go('suppliers');
  await tab('sup');
  await page.click('#main tr[data-act="pickSup"][data-arg="P4R-S1"]');
  const supPo = await rowText('#main .split tbody tr', ids.poNut);
  assert(supPo && supPo.indexOf('3,600.00') >= 0, `ใบสั่งซื้อค้างของผู้ขาย: ${supPo}`);
});

await step('receive: messages use the PO line numbers, missing heat, supplier delivery note kept', async () => {
  const po = await must('po.create', { supplier: 'P4R-S1', remark: EVIL, lines: [{ code: 'P4R-NUT', qty: 1, dueDate: addDays(today, 5), wh: 'P4RW' },
    { code: 'P4R-HEAT', qty: 4, dueDate: addDays(today, 5), wh: 'P4RW' }] }, 'P4RPUR');
  ids.po2 = po.result.poNo;
  await must('po.issue', { poNo: ids.po2 }, 'P4RPUR');
  await asUser('P4RSTORE');
  await go('purchasing');
  await tab('recv');
  await page.click(`#rcv-list tr[data-arg="${ids.po2}"]`);
  await page.waitForSelector('#rcv-qty-2');
  // only line 2 arrived, without its heat number
  await page.fill('#rcv-qty-2', '4');
  await page.fill('#rcv-bin-2', 'P4R-01');
  await page.click('form[data-form="recv"] button[type="submit"]');
  await waitText('บรรทัด 2: ใส่ Heat no. ของ P4R-HEAT', 4000, '#rcv-check');
  await page.fill('#rcv-lot-2', 'H-P4R-1');
  await page.fill('#rcv-bin-2', 'NOBIN');
  await page.click('form[data-form="recv"] button[type="submit"]');
  await waitText('บรรทัด 2: ไม่พบช่องเก็บ NOBIN', 4000, '#rcv-check'); // the engine counted it as line 1 of the receipt
  await typeNum('#rcv-qty-2', '4-');
  await page.fill('#rcv-bin-2', 'P4R-01');
  await page.click('form[data-form="recv"] button[type="submit"]');
  await toast('บรรทัด 2 ช่อง "รับครั้งนี้ (แผ่น)" อ่านเป็นตัวเลขไม่ได้');
  assert(await state((s, R, k) => s.tables.pos[k].lines.every((l) => !l.received), ids.po2), 'ยังไม่รับอะไร');
  await page.fill('#rcv-qty-2', '4');
  await page.fill('#rcv-sdoc', 'IV-77 ' + EVIL);
  await page.fill('#rcv-remark', EVIL);
  await page.fill('#rcv-cert-2', 'MC-P4R-1');
  await page.click('form[data-form="recv"] button[type="submit"]');
  await dlgOpen();
  await waitText('รอตรวจ', 3000, '#dlg');
  await dlgSubmit();
  await dlgClosed();
  await waitText('เข้าเป็น "รอตรวจ"', 6000, '#p4-done');
  const hold = await state((s) => (s.tables.balances || {})['P4R-HEAT|P4RW|P4R-01|QC_HOLD|H-P4R-1']);
  assert(hold && hold.qty === 4, `แผ่นเหล็กต้องเข้าเป็นรอตรวจ: ${JSON.stringify(hold)}`);
  // line 1 is still open and its typed values are kept per PO line
  await page.waitForSelector('#rcv-qty-1');
  assert(!(await page.$('#rcv-qty-2')), 'บรรทัด 2 รับครบแล้วต้องไม่ให้กรอกอีก');
  await page.fill('#rcv-qty-1', '1');
  await page.fill('#rcv-bin-1', 'P4R-02');
  await page.click('form[data-form="recv"] button[type="submit"]');
  await dlgOpen();
  await dlgSubmit();
  await dlgClosed();
  await waitText('รับเข้าแล้ว', 6000, '#p4-done');
  // accounting matches the supplier's invoice to the receipt on the PO
  await asUser('P4RACC');
  await tab('po');
  await page.click(`#po-list tr[data-arg="${ids.po2}"]`);
  await waitText('IV-77 ' + EVIL, 4000, '#p4-detail');
  assert(!(await page.$('#p4-detail button[data-act="poIssue"]')) && !(await page.$('#main button[data-act="newPo"]')), 'บัญชีต้องไม่ออก/สร้างใบสั่งซื้อ');
  await page.waitForSelector('#p4-detail button[data-act="poCsv"]');
  await shot('desktop-po-accounting');
});

await step('return: unreadable qty refused, nothing leaves the store', async () => {
  await asUser('P4RSTORE');
  await tab('rv');
  await page.click(`#rv-list tr[data-arg="${ids.po2}"]`);
  await page.waitForSelector('#rv-from-1');
  await waitText('มีของรอตรวจ 4', 4000, '#p4-detail'); // line 2 is waiting for QC: not returnable here
  await page.selectOption('#rv-from-1', 'P4R-NUT|P4RW|P4R-02|AVAILABLE|');
  await typeNum('#rv-qty-1', '1-');
  await page.fill('#rv-reason', 'เกลียวเสีย ' + EVIL);
  await page.check('#main input[name="lines[0][replace]"][value="1"]');
  await page.click('form[data-form="rv"] button[type="submit"]');
  await toast('บรรทัด 1 ช่อง "จำนวนคืน (ลัง)" อ่านเป็นตัวเลขไม่ได้');
  assert(await state((s) => !Object.values(s.tables.documents).some((d) => d.type === 'RV' && d.lines.some((l) => l.code === 'P4R-NUT'))), 'ต้องไม่มีใบคืน');
  await page.fill('#rv-qty-1', '2');
  await page.click('form[data-form="rv"] button[type="submit"]');
  await waitText('คืนผู้ขายเกินกว่าที่รับจากใบนี้ไม่ได้', 4000, '#rv-check');
  await page.fill('#rv-qty-1', '1');
  await page.click('form[data-form="rv"] button[type="submit"]');
  await dlgOpen();
  await dlgSubmit();
  await dlgClosed();
  await waitText('คืนผู้ขายแล้ว', 6000, '#p4-done');
  const l = await state((s, R, k) => s.tables.pos[k].lines[0], ids.po2);
  assert(l.returned === 50 && l.replaced === 50 && l.received === 0, `คืนแบบขอทดแทน: ${JSON.stringify(l)}`);
});

await step('late PO lines: also those no job needs, and the real shortage per job', async () => {
  const lt = await must('po.create', { supplier: 'P4R-S1', date: addDays(today, -20), lines: [{ code: 'P4R-LATE', qty: 6, price: 5, dueDate: addDays(today, -10), wh: 'P4RW' }] }, 'P4RPUR');
  await must('po.issue', { poNo: lt.result.poNo }, 'P4RPUR');
  ids.poLate = lt.result.poNo;
  const jb = await must('po.create', { supplier: 'P4R-S1', date: addDays(today, -20), lines: [{ code: 'P4R-JOB', qty: 30, dueDate: addDays(today, -5), wh: 'P4RW' }] }, 'P4RPUR');
  await must('po.issue', { poNo: jb.result.poNo }, 'P4RPUR');
  ids.poJob = jb.result.poNo;
  await must('doc.post', { type: 'AJ', remark: 'ยอดตั้งต้นทดสอบรีวิว', lines: [{ code: 'P4R-JOB', qty: 10, wh: 'P4RW', bin: 'P4R-01' }] });
  const ja = await must('job.create', { soNo: 'SO-P4R-1', dueDate: addDays(today, 3), lines: [{ code: 'P4R-JOB', qty: 5 }] }, 'P4RPLAN');
  const jbb = await must('job.create', { soNo: 'SO-P4R-2', dueDate: addDays(today, 6), lines: [{ code: 'P4R-JOB', qty: 20 }] }, 'P4RPLAN');
  await asUser('P4RPLAN');
  await go('replenish');
  await page.waitForSelector('#rp-late');
  const lateRow = await rowText('#rp-late tbody tr', ids.poLate);
  assert(lateRow && lateRow.indexOf('เลย 10 วัน') >= 0 && lateRow.indexOf('ไม่มีใบงานที่รอของนี้') >= 0, `PO เลยกำหนดที่ไม่มีงานรอต้องขึ้นด้วย: ${lateRow}`);
  const jobRow = await rowText('#rp-late tbody tr', ids.poJob);
  assert(jobRow && jobRow.indexOf(`${ja.result.jobNo}`) >= 0 && /ของในคลังพอ \(5\)/.test(jobRow), `ใบงานแรกใช้ของในคลังได้ ไม่ใช่ จองครบ: ${jobRow}`);
  assert(jobRow.indexOf(jbb.result.jobNo) >= 0 && jobRow.indexOf('ขาด 15') >= 0 && jobRow.indexOf('ขาด 20') < 0, `ใบงานที่สองขาดจริง 15 (หลังใช้ของในคลัง 5): ${jobRow}`);
  const nLate = await state((s, R, t) => R.purchasing.outstanding(s, { today: t }).filter((l) => l.late).length, today);
  const kpi = await page.evaluate(() => Array.from(document.querySelectorAll('.kpi')).find((k) => k.innerText.indexOf('PO เลยกำหนด') >= 0).querySelector('.kpi-v').innerText);
  assert(kpi.replace(/,/g, '') === String(nLate), `ตัวเลข PO เลยกำหนด ${kpi} ต้องเท่ากับบรรทัดที่เลยกำหนดทั้งหมด ${nLate}`);
  const withRes = await state((s, R, t) => R.purchasing.affectedJobs(s, { today: t }).some((l) => l.reservations.length), today);
  if (withRes) {
    await waitText('คงจอง', 3000, '#rp-late');
    assert(/คลัง \S+ คงจอง/.test(await page.locator('#rp-late').innerText()), 'การจองต้องบอกคลัง');
  }
  await shot('desktop-replenish-late');
});

await step('replenish: covered only by stock waiting for QC says รอผล QC; unreadable qty in the PR preview', async () => {
  const q = await must('po.create', { supplier: 'P4R-S1', lines: [{ code: 'P4R-QCI', qty: 20, dueDate: addDays(today, 2), wh: 'P4RW' }] }, 'P4RPUR');
  await must('po.issue', { poNo: q.result.poNo }, 'P4RPUR');
  await must('po.receive', { poNo: q.result.poNo, lines: [{ line: 1, qty: 20, bin: 'P4R-02' }] }, 'P4RSTORE');
  await go('replenish');
  await tab('near');
  await page.waitForSelector('#rp-list');
  const qci = await rowText('#rp-list tbody tr', 'P4R-QCI');
  assert(qci && qci.indexOf('รอผล QC') >= 0 && qci.indexOf('ขอซื้อไว้แล้ว') < 0, `ของรอตรวจครอบคลุม ต้องบอก รอผล QC: ${qci}`);
  await tab('order');
  await page.check('#rp-list input[data-act="pick"][data-arg="P4R-PAINT"]');
  await page.waitForFunction(() => document.querySelector('#rp-make').innerText.indexOf('(1)') >= 0);
  await page.click('#rp-make');
  await dlgOpen();
  await typeNum('#dlg input[name="lines[0][qty]"]', '3-');
  await page.selectOption('#dlg select[name="lines[0][wh]"]', 'P4RW');
  const before = await state((s) => Object.keys(s.tables.prs || {}).length);
  await dlgSubmit();
  await dlgError('ช่อง "จำนวน P4R-PAINT" อ่านเป็นตัวเลขไม่ได้');
  assert(await state((s) => Object.keys(s.tables.prs || {}).length) === before, 'ต้องไม่สร้างใบขอซื้อ');
  await page.fill('#dlg input[name="lines[0][qty]"]', '15');
  await dlgSubmit();
  await dlgClosed();
  await toast('สร้างใบขอซื้อ PR');
  const pr = await state((s) => Object.values(s.tables.prs).find((x) => x.lines.some((l) => l.code === 'P4R-PAINT')));
  assert(pr && pr.lines[0].qty === 15 && pr.lines[0].wh === 'P4RW' && pr.source === 'แผนเติมสต็อก', `ใบขอซื้อจากแผน: ${JSON.stringify(pr && pr.lines)}`);
});

await step('PO dialogs: unreadable cancel / over-receipt qty refused (would cancel everything)', async () => {
  await asUser('P4RLEAD');
  await go('purchasing');
  await tab('po');
  await page.click(`#po-list tr[data-arg="${ids.poLate}"]`);
  await page.click('#p4-detail button[data-act="poCancelLine"][data-arg="1"]');
  await dlgOpen();
  await typeNum('#dlg input[name="qty"]', '1-');
  await page.fill('#dlg input[name="reason"]', 'ลดจำนวน');
  await dlgSubmit();
  await dlgError('อ่านเป็นตัวเลขไม่ได้');
  await dlgCancel();
  await page.click('#p4-detail button[data-act="poOver"][data-arg="1"]');
  await dlgOpen();
  await typeNum('#dlg input[name="qty"]', '2-');
  await page.fill('#dlg input[name="reason"]', 'ส่งเต็มมัด');
  await dlgSubmit();
  await dlgError('อ่านเป็นตัวเลขไม่ได้');
  await dlgCancel();
  const l = await state((s, R, k) => s.tables.pos[k].lines[0], ids.poLate);
  assert(!l.cancelled && !l.overAllowed, `ยกเลิกไม่สำเร็จต้องไม่เปลี่ยน: ${JSON.stringify(l)}`);
});

await step('roles: accounting and QC read suppliers and terms only', async () => {
  for (const u of ['P4RACC', 'P4RQC']) {
    await asUser(u);
    await go('suppliers');
    await tab('sup');
    assert(!(await page.$('#main button[data-act="newSup"]')), `${u} ต้องไม่เห็นปุ่มเพิ่มผู้ขาย`);
    await page.click('#main tr[data-act="pickSup"][data-arg="P4R-S1"]');
    assert(!(await page.$('form[data-form="saveSup"]')), `${u} ต้องแก้ผู้ขายไม่ได้`);
    await waitText('ผู้ติดต่อ', 3000, '#main .split');
    await tab('rules');
    assert(!(await page.$('#main button[data-act="newRule"]')), `${u} ต้องตั้งเงื่อนไขเติมสต็อกไม่ได้`);
    await go('purchasing');
    await tab('recv');
    const any = await page.$(`#rcv-list tr[data-arg="${ids.poNut}"]`);
    if (any) {
      await any.click();
      assert(!(await page.$('form[data-form="recv"]')), `${u} ต้องไม่เห็นฟอร์มรับของ`);
    }
  }
});

await step('phone 390 px: dialogs and the PR view fit', async () => {
  await asUser('P4RMGR');
  await page.setViewportSize({ width: 390, height: 844 });
  await go('purchasing');
  await tab('pr');
  await page.click(`#pr-list tr[data-arg="${ids.pr}"]`);
  await waitText('มูลค่าประมาณ', 3000, '#p4-detail');
  await noOverflow('ใบขอซื้อพร้อมมูลค่าประมาณ');
  await asUser('P4RPLAN');
  await go('replenish');
  await tab('order');
  const pick = await page.evaluate(() => { const x = document.querySelector('#rp-list input[data-act="pick"]'); return x ? x.dataset.arg : null; });
  if (pick) {
    await page.check(`#rp-list input[data-act="pick"][data-arg="${pick}"]`);
    await page.waitForFunction(() => !document.querySelector('#rp-make').disabled);
    await page.click('#rp-make');
    await dlgOpen();
    await noOverflow('หน้าต่างสร้างใบขอซื้อจากแผน');
    await shot('phone-replenish-dialog');
    await dlgCancel();
  }
  await go('suppliers');
  await tab('rules');
  await page.click('#rule-list tr[data-arg="P4R-NUT|P4RW"]');
  await dlgOpen();
  await noOverflow('หน้าต่างเงื่อนไขเติมสต็อก');
  await dlgCancel();
  await asUser('P4RSTORE');
  await go('purchasing');
  await tab('recv');
  await page.click(`#rcv-list tr[data-arg="${ids.poNut}"]`);
  await page.waitForSelector('#rcv-qty-1');
  await page.fill('#rcv-qty-1', '1');
  await page.fill('#rcv-bin-1', 'P4R-01');
  await page.click('form[data-form="recv"] button[type="submit"]');
  await dlgOpen();
  await noOverflow('หน้าต่างยืนยันรับของ');
  await shot('phone-receive-confirm');
  await dlgCancel();
  await page.setViewportSize({ width: 1366, height: 900 });
});

await browser.close();
if (problems.length) {
  console.log('PROBLEMS\n' + problems.join('\n'));
  process.exit(1);
}
console.log('p4-review ok');
