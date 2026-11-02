// Review test of the Phase 2 screens งาน/SO และการจอง, ใบจัดชุดและหยิบของ and สต็อก 6 ช่อง และความพร้อมผลิต, used the
// way a planner, store lead (one warehouse only), store, production, accounting and a second person in another tab do:
//   RRS_OUT=/tmp/stockqc-p2-review node tests/e2e/p2-review.mjs [--shots dir]
// Covers what the first test (p2.mjs) does not: empty screens without sample data, everything missing in the create
// form listed at once (values kept, engine errors in the form), user text escaped, the reserve dialog telling a store
// lead where the stock is, the FR draft refusing more than is finished, QC waiting vs quarantine in readiness, a closed
// job showing nothing missing, the production buttons on a phone, the pick confirmation listing what will be posted,
// another person changing the pick list while the store is typing (values stay with their reservation, nothing wrong
// is posted), Domestic and Export Sales Office jobs never sharing a job, and BOM mapping blocked while reserved.
// Codes P2R-…, warehouses P2RA/P2RB, users P2R… (the demo may already hold sample data from RRS.fixture).
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
const mainCtx = await browser.newContext({ viewport: { width: 1366, height: 900 } }); // own context: a second tab plays another person
const page = await mainCtx.newPage();
page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|cdnjs|ERR_|net::/.test(m.text())) problems.push(`console (${current}): ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`pageerror (${current}): ${e.message}`));
// a browser alert/confirm/prompt means user text ran as code (or a page used a browser dialog instead of ctx.dialog)
page.on('dialog', async (d) => { problems.push(`browser dialog (${current}): ${d.type()} ${d.message()}`); await d.dismiss().catch(() => {}); });

// ---- helpers ------------------------------------------------------------------------------------------------
const ready = () => page.waitForFunction(() => window.RRS && window.RRS.app && window.RRS.app.loading === false && window.RRS.app.ledger, null, { timeout: 60000 });
async function exec(kind, payload, user, via) {
  return page.evaluate(async ([k, p, u, v]) => {
    const st = window.RRS.app.ledger.state;
    const admin = u || Object.values(st.tables.users || {}).find((x) => x.roles.indexOf('admin') >= 0 && x.active !== false).id;
    const r = await window.RRS.app.ledger.execute({ kind: k, payload: p }, { user: admin, via: v || '' });
    return { ok: r.ok, errors: r.errors || [], result: r.result || {} };
  }, [kind, payload, user || null, via || null]);
}
async function must(kind, payload, user, via) {
  const r = await exec(kind, payload, user, via);
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
async function waitGone(text, timeout) {
  await page.waitForFunction((x) => document.querySelector('#main').innerText.indexOf(x) < 0, text, { timeout: timeout || 6000 })
    .catch(() => { throw new Error(`ข้อความ "${text}" ยังอยู่ในหน้า`); });
}
const state = (fn, arg) => page.evaluate(([src, a]) => (0, eval)(src)(window.RRS.app.ledger.state, window.RRS, a), [fn.toString(), arg === undefined ? null : arg]);
const rowCells = (sel, text) => page.evaluate(([s, x]) => {
  const tr = Array.from(document.querySelectorAll(s)).find((r) => r.innerText.indexOf(x) >= 0);
  return tr ? Array.from(tr.children).map((td) => td.innerText.trim()) : null;
}, [sel, text]);
async function noOverflow(where) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert(!over, `${where}: หน้ากว้างเกินจอ`);
}
async function dlgOpen() {
  await page.waitForSelector('#dlg:not([hidden]) .dlg-card');
}
async function dlgSubmit() {
  await page.click('#dlg button[type="submit"]');
}
async function dlgClosed() {
  await page.waitForSelector('#dlg[hidden]', { state: 'attached', timeout: 6000 });
}
async function dlgError(text) {
  await page.waitForFunction((x) => document.querySelector('#dlg-err') && document.querySelector('#dlg-err').innerText.indexOf(x) >= 0, text, { timeout: 5000 })
    .catch(async () => { throw new Error(`หน้าต่างควรบอก "${text}" ได้ "${await page.locator('#dlg-err').innerText().catch(() => '')}"`); });
}
async function confirmOk() {
  await dlgOpen();
  await dlgSubmit();
  await dlgClosed();
}
const toastText = () => page.locator('#toasts').innerText();
async function waitToast(text) {
  await page.waitForFunction((x) => document.querySelector('#toasts').innerText.indexOf(x) >= 0, text, { timeout: 6000 })
    .catch(async () => { throw new Error(`ไม่พบข้อความแจ้ง "${text}" ได้ "${await toastText()}"`); });
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
const job = (no) => state((s, R, n) => s.tables.jobs[n] || null, no);
const lineOf = (j, code) => j.lines.find((l) => l.code === code && !l.output);
const resOf = (jobNo, code) => state((s, R, a) => Object.values(s.tables.reservations || {}).filter((r) => r.jobNo === a[0] && r.code === a[1]), [jobNo, code]);
async function pickJob(jobNo) {
  await page.click(`#jb-list tr[data-act="pick"][data-arg="${jobNo}"]`);
  await page.waitForSelector('#jb-detail');
  await waitText(jobNo, 4000, '#jb-detail');
}
/** The button of a job line (by item code) in the lines table of the open job. */
async function lineBtn(code, act) {
  const sel = await page.evaluate(([c, a]) => {
    const rows = Array.from(document.querySelectorAll('#jb-lines tbody tr'));
    const i = rows.findIndex((r) => r.children[1] && r.children[1].innerText.indexOf(c) === 0);
    if (i < 0) return null;
    return rows[i].querySelector(`button[data-act="${a}"]`) ? `#jb-lines tbody tr:nth-child(${i + 1}) button[data-act="${a}"]` : null;
  }, [code, act]);
  return sel;
}
async function clickLine(code, act) {
  const sel = await lineBtn(code, act);
  assert(sel, `ไม่พบปุ่ม ${act} ของ ${code}`);
  await page.click(sel);
}


const EVIL = '<img src=x onerror=alert(1)>';
const DUE = '2026-11-20';
const count = (sel) => page.locator(sel).count();
const docsOf = (jobNo, type) => state((s, R, a) => Object.values(s.tables.documents || {}).filter((d) => d.type === a[1] && d.job === a[0]), [jobNo, type]);

// ---- empty screens without sample data (own browser context: the sample loader is switched off) -----------------
await step('empty screens say what will appear and how to start (no sample data)', async () => {
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx2.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => { if (window.RRS) window.RRS.fixture = null; }, { once: true });
  });
  const p = await ctx2.newPage();
  p.on('pageerror', (e) => problems.push(`pageerror (empty): ${e.message}`));
  p.on('dialog', async (d) => { problems.push(`browser dialog (empty): ${d.message()}`); await d.dismiss().catch(() => {}); });
  await p.goto(file);
  await p.waitForFunction(() => window.RRS && window.RRS.app && window.RRS.app.loading === false && window.RRS.app.ledger, null, { timeout: 60000 });
  await p.evaluate(() => localStorage.clear());
  await p.reload();
  await p.waitForFunction(() => window.RRS && window.RRS.app && window.RRS.app.loading === false && window.RRS.app.ledger, null, { timeout: 60000 });
  const jobs = await p.evaluate(() => Object.keys(window.RRS.app.ledger.state.tables.jobs || {}).length);
  assert(jobs === 0, `ไม่ควรมีใบงานตัวอย่าง (${jobs})`);
  const see = async (id, texts) => {
    await p.evaluate((x) => { location.hash = x; }, id);
    await p.waitForSelector(`.page[data-page="${id}"]`);
    for (const x of texts) {
      await p.waitForFunction((y) => document.querySelector('#main').innerText.indexOf(y) >= 0, x, { timeout: 5000 })
        .catch(async () => { throw new Error(`${id}: ไม่พบ "${x}"\n${(await p.locator('#main').innerText()).slice(0, 600)}`); });
    }
    assert(!(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), `${id} ว่าง: หน้ากว้างเกินจอ`);
  };
  await see('jobs', ['ยังไม่มีใบงาน', 'สร้างใบงานแรก']);
  await see('picking', ['ยังไม่มีงานที่จะจัดชุด', 'ไปหน้า งาน/SO และการจอง']);
  await see('readiness', ['ยังไม่มีสินค้า', 'ไปทะเบียนสินค้า']);
  await p.click('#main button.tab[data-arg="jobs"]');
  await see('readiness', ['ไม่มีใบงานที่ยังไม่ปิด']);
  // an item without stock, jobs or POs: the six boxes say when rows will appear
  await p.evaluate(async () => {
    const st = window.RRS.app.ledger.state;
    const admin = Object.values(st.tables.users).find((u) => u.roles.indexOf('admin') >= 0).id;
    await window.RRS.app.ledger.execute({ kind: 'master.import', payload: { items: [{ code: 'P2R-EMPTY', name: 'ทดสอบว่าง', baseUnit: 'ชิ้น', type: 'PART' }] } }, { user: admin });
  });
  await p.click('#main button.tab[data-arg="six"]');
  await see('readiness', ['ยังไม่มีของ งาน หรือ PO ที่เกี่ยวข้อง', 'แสดงทุกสินค้า']);
  if (shots) await p.screenshot({ path: path.join(shots, 'empty-readiness-phone.png'), fullPage: true });
  await ctx2.close();
});

// ---- the main page: sample data + own data -----------------------------------------------------------------------
await page.goto(file);
await ready();
await page.evaluate(() => localStorage.clear());
await page.reload();
await ready();

let JA = '';
let JM = '';
let JQ = '';

await step('setup: own warehouses, items, stock and users', async () => {
  await must('warehouse.upsert', { code: 'P2RA', name: 'คลังทบทวน P2R A' });
  await must('warehouse.upsert', { code: 'P2RB', name: 'คลังทบทวน P2R B' });
  for (const [wh, code] of [['P2RA', 'R-01'], ['P2RA', 'R-02'], ['P2RB', 'S-01']]) await must('bin.upsert', { wh, code, name: 'ช่อง ' + code, active: true });
  await must('master.import', { items: [
    { code: 'P2R-FG', name: 'ตัวถังทบทวน ' + EVIL, baseUnit: 'ชุด', type: 'FG', qcFinal: true },
    { code: 'P2R-PNL', name: 'แผ่นทบทวน', baseUnit: 'ชิ้น', type: 'PART' },
    { code: 'P2R-BLT', name: 'น็อตทบทวน', baseUnit: 'ตัว', type: 'BUY' },
    { code: 'P2R-ROD', name: 'แกนทบทวน (ไม่มีของ)', baseUnit: 'เส้น', type: 'PART' },
  ] });
  await must('bom.upsert', { product: 'P2R-FG', rev: 'A', lines: [{ code: 'P2R-PNL', qty: 2 }, { code: 'P2R-BLT', qty: 4 }, { code: 'P2R-ROD', qty: 1 }] });
  await must('bom.approve', { product: 'P2R-FG', rev: 'A' });
  await must('doc.post', { type: 'AJ', remark: 'ยอดทบทวน P2R', lines: [
    { code: 'P2R-PNL', qty: 10, wh: 'P2RA', bin: 'R-01' }, { code: 'P2R-PNL', qty: 2, wh: 'P2RA', bin: 'R-02', status: 'QC_HOLD' },
    { code: 'P2R-PNL', qty: 3, wh: 'P2RA', bin: 'R-02', status: 'QUARANTINE' }, { code: 'P2R-BLT', qty: 20, wh: 'P2RB', bin: 'S-01' }] });
  for (const [id, name, roles, whs] of [['P2RPLAN', 'วางแผนทบทวน', ['planner']], ['P2RPLAN2', 'วางแผนคนที่สองทบทวน', ['planner']], ['P2RLEAD', 'หัวหน้าสโตร์ทบทวน (คลัง A)', ['store_lead'], ['P2RA']],
    ['P2RSTORE', 'สโตร์ทบทวน', ['store']], ['P2RPROD', 'ฝ่ายผลิตทบทวน', ['production']], ['P2RACC', 'บัญชีทบทวน', ['accounting']]]) {
    await must('user.upsert', { id, name, roles, warehouses: whs || [] });
  }
});

await step('create: everything missing is listed at once in the form, values kept, engine errors in the form', async () => {
  await asUser('P2RPLAN');
  await go('jobs');
  await page.click('#main button[data-act="new"]');
  await page.waitForSelector('form[data-form="create"]');
  const before = await state((s) => Object.keys(s.tables.jobs || {}).length);
  await page.fill('#jb-n-remark', 'หมายเหตุทบทวน ' + EVIL);
  await page.click('form[data-form="create"] button[type="submit"]');
  await page.waitForSelector('#jb-n-errs');
  for (const x of ['ยังสร้างใบงานไม่ได้', 'ใส่เลขที่ SO', 'เลือกวันต้องใช้ / กำหนดเสร็จ', 'เลือกสินค้าที่ผลิต', 'ใส่จำนวนชุดเป็นตัวเลขมากกว่า 0']) await waitText(x, 3000, '#jb-n-errs');
  assert(await page.inputValue('#jb-n-remark') === 'หมายเหตุทบทวน ' + EVIL, 'หมายเหตุที่พิมพ์ต้องยังอยู่');
  await page.fill('#jb-n-so', 'P2R-SO-1 ' + EVIL);
  await page.selectOption('#jb-n-prod', 'P2R-FG');
  await page.fill('#jb-n-qty', '2');
  await page.fill('#jb-n-due', DUE);
  await page.fill('#jb-n-no', 'bad no!');
  await page.click('form[data-form="create"] button[type="submit"]');
  await waitText('เลขที่ใบงานใช้ A-Z 0-9', 4000, '#jb-n-errs');
  assert(await page.inputValue('#jb-n-so') === 'P2R-SO-1 ' + EVIL && await page.inputValue('#jb-n-qty') === '2', 'ค่าที่กรอกต้องยังอยู่หลังบันทึกไม่ได้');
  assert(await state((s) => Object.keys(s.tables.jobs || {}).length) === before, 'บันทึกไม่ได้ต้องไม่เกิดใบงาน');
  await page.fill('#jb-n-no', '');
  await page.click('form[data-form="create"] button[type="submit"]');
  await page.waitForSelector('#jb-detail');
  JA = await state((s) => Object.values(s.tables.jobs).find((j) => j.soNo.indexOf('P2R-SO-1') === 0).jobNo);
  const j = await job(JA);
  assert(j.product === 'P2R-FG' && j.qty === 2 && j.remark === 'หมายเหตุทบทวน ' + EVIL, `ใบงาน: ${JSON.stringify(j).slice(0, 200)}`);
  await waitText('P2R-SO-1 <IMG SRC=X ONERROR=ALERT(1)>', 4000, '#jb-detail');
  await waitText('หมายเหตุทบทวน ' + EVIL, 4000, '#jb-detail');
  assert(await count('#main img') === 0, 'ข้อความที่พิมพ์ต้องไม่กลายเป็น HTML');
  // readiness % counts every line the same: PNL and BLT covered, ROD (no stock) missing → 2 of 3 lines (by quantity it was 86%)
  const row = await rowCells('#jb-list tbody tr', JA);
  assert(row && /67%/.test(row[7]) && /ขาด 1 รายการ/.test(row[7]), `ความพร้อมของ ${JA}: ${row && row[7]}`);
});

await step('create with own lines: unknown code and unit shown in the form; sets default to 1', async () => {
  await page.click('#main button[data-act="new"]');
  await page.waitForSelector('form[data-form="create"]');
  await page.fill('#jb-n-so', 'P2R-SO-2');
  await page.fill('#jb-n-due', DUE);
  await page.check('form[data-form="create"] input[name="mode"][value="manual"]');
  await page.waitForSelector('input[name="lines[0][code]"]');
  assert(await page.inputValue('#jb-n-qty') === '1', 'แบบระบุรายการเอง จำนวนชุดตั้งต้น 1');
  await page.fill('input[name="lines[0][code]"]', 'P2R-NOPE');
  await page.fill('input[name="lines[0][qty]"]', '1');
  await page.click('form[data-form="create"] button[type="submit"]');
  await waitText('ไม่พบรหัส P2R-NOPE', 4000, '#jb-n-errs');
  await page.fill('input[name="lines[0][code]"]', 'p2r-pnl');
  await page.fill('input[name="lines[0][unit]"]', 'กล่อง');
  await page.click('form[data-form="create"] button[type="submit"]');
  await waitText('ไม่มีตัวคูณของหน่วย "กล่อง"', 4000, '#jb-n-errs');
  assert(await page.inputValue('#jb-n-so') === 'P2R-SO-2', 'เลข SO ต้องยังอยู่');
  await page.fill('input[name="lines[0][unit]"]', '');
  await page.click('form[data-form="create"] button[type="submit"]');
  await page.waitForSelector('#jb-detail');
  JM = await state((s) => Object.values(s.tables.jobs).find((j) => j.soNo === 'P2R-SO-2').jobNo);
  const j = await job(JM);
  assert(j.lines.length === 1 && j.lines[0].code === 'P2R-PNL' && j.lines[0].required === 1, `ใบงานระบุรายการเอง: ${JSON.stringify(j.lines)}`);
  assert(await count('#jb-n-errs') === 0, 'สร้างได้แล้วไม่ควรมีกล่องข้อผิดพลาด');
});

await step('reserve: a store lead of one warehouse is told where the stock is; nothing free is explained', async () => {
  await asUser('P2RLEAD');
  await go('jobs');
  await pickJob(JA);
  assert(await count('#main button[data-act="new"]') === 0 && await count('#jb-detail button[data-act="cancel"]') === 0, 'หัวหน้าสโตร์ไม่สร้าง/ยกเลิกใบงาน');
  await clickLine('P2R-BLT', 'reserve');
  await dlgOpen();
  await waitText('มีของพร้อมเบิกที่คลัง P2RB (20) แต่คุณจองได้เฉพาะคลัง P2RA', 4000, '#dlg');
  assert(!(await page.locator('#dlg select[name="wh"] option[value="P2RB"]').count()), 'คลังที่ไม่มีสิทธิ์ต้องไม่อยู่ในตัวเลือก');
  await dlgSubmit();
  await dlgError('ระบุคลัง');
  await page.click('#dlg .dlg-f button[data-dlg-close]');
  await dlgClosed();
  assert((await resOf(JA, 'P2R-BLT')).length === 0, 'ต้องไม่เกิดใบจอง');
  await clickLine('P2R-ROD', 'reserve');
  await dlgOpen();
  await waitText('ตอนนี้ไม่มีของพร้อมเบิกให้จองในคลังใดเลย', 4000, '#dlg');
  await page.click('#dlg .dlg-f button[data-dlg-close]');
  await dlgClosed();
});

await step('readiness: QC waiting and quarantine are told apart; a closed job shows nothing missing', async () => {
  await asUser('P2RPLAN');
  const r = await must('job.create', { soNo: 'P2R-SO-Q', dueDate: '2026-11-10', priority: 1, lines: [{ code: 'P2R-PNL', qty: 13 }] }, 'P2RPLAN');
  JQ = r.result.jobNo;
  await go('readiness');
  await page.click('#main button.tab[data-arg="jobs"]');
  await waitText('ความพร้อมรายใบงาน');
  await page.click(`#rd-jobs tr[data-arg="${JQ}"]`);
  await page.waitForSelector('#rd-job');
  await waitText('รอตรวจ 2 (QC ต้องตรวจปล่อยก่อน)', 4000, '#rd-job');
  await waitText('กักกัน/รอแก้ไข 3 (อาจใช้ไม่ได้', 4000, '#rd-job');
  const rd = await state((s, R, n) => R.planning.readiness(s, n, { today: '2026-11-02' }).lines[0], JQ);
  assert(rd.missing === 3 && rd.qcWaiting === 2 && rd.qcHold === 5, `readiness(): ${JSON.stringify(rd)}`);
  // ROD has nowhere to come from
  await page.click(`#rd-jobs tr[data-arg="${JA}"]`);
  await waitText('ไม่มีที่ไหนเลย – ต้องขอซื้อหรือตั้งผลิตเพิ่ม', 4000, '#rd-job');
  await page.click(`#rd-jobs tr[data-arg="${JQ}"]`);
  await waitText('P2R-SO-Q', 4000, '#rd-job');
  await must('job.status', { jobNo: JQ, status: 'DONE' }, 'P2RPLAN');
  await waitText('ความพร้อมผลิตคิดเฉพาะงานที่ยังไม่ปิด', 4000, '#rd-job');
  const t = await page.locator('#rd-job').innerText();
  assert(t.indexOf('ยังขาด') < 0 && t.indexOf('ขาด 1 รายการ') < 0, `งานที่ปิดแล้วต้องไม่ขึ้นว่าขาด: ${t.slice(0, 300)}`);
  await go('jobs');
  await page.selectOption('#jb-st', 'all');
  await pickJob(JQ);
  assert(await count('#jb-detail a[data-go="readiness"]') === 0, 'งานที่ปิดแล้วไม่ต้องมีลิงก์ความพร้อมผลิต');
  await page.selectOption('#jb-st', 'open');
});

await step('production on a phone: buttons in view; FR draft refuses more than is finished', async () => {
  await asUser('P2RPROD');
  await page.setViewportSize({ width: 390, height: 844 });
  await go('jobs');
  await pickJob(JA);
  const where = await page.evaluate(() => {
    const b = document.querySelector('#jb-lines button[data-act="record"]');
    if (!b) return null;
    window.scrollTo(0, b.getBoundingClientRect().top + window.scrollY - 200);
    const r = b.getBoundingClientRect();
    return { right: r.right, w: window.innerWidth, sl: b.closest('.tbl-wrap').scrollLeft };
  });
  assert(where && where.sl === 0 && where.right <= where.w, `ปุ่มบันทึกผลิตเสร็จต้องเห็นบนมือถือโดยไม่เลื่อนข้าง: ${JSON.stringify(where)}`);
  await noOverflow('jobs (ฝ่ายผลิต มือถือ)');
  await shot('review-production-phone');
  await clickLine('P2R-FG', 'record');
  await dlgOpen();
  await page.fill('#dlg input[name="qty"]', '1');
  await dlgSubmit();
  await dlgClosed();
  await clickLine('P2R-FG', 'fr');
  await dlgOpen();
  await waitText('รับเข้าแล้วเป็น รอตรวจ', 4000, '#dlg');
  await noOverflow('FR dialog (มือถือ)');
  await page.selectOption('#dlg select[name="wh"]', 'P2RA');
  await page.fill('#dlg input[name="qty"]', '3');
  await dlgSubmit();
  await dlgError('รับเข้าได้ไม่เกิน 1');
  assert((await docsOf(JA, 'FR')).length === 0, 'รับเกินต้องไม่เกิดร่าง FR');
  await page.fill('#dlg input[name="qty"]', '1');
  await page.fill('#dlg input[name="bin"]', 'R-01');
  await dlgSubmit();
  await page.waitForSelector('.page[data-page="docs"]');
  const fr = await docsOf(JA, 'FR');
  assert(fr.length === 1 && fr[0].status === 'DRAFT' && Number(fr[0].lines[0].qty) === 1, `ร่าง FR: ${JSON.stringify(fr)}`);
  await page.setViewportSize({ width: 1366, height: 900 });
});

await step('picking: the confirmation lists what will be posted and warns about rows not scanned', async () => {
  await must('reserve.auto', { jobNo: JA }, 'P2RPLAN');
  await asUser('P2RSTORE');
  await page.setViewportSize({ width: 390, height: 844 });
  await go('picking');
  await page.selectOption('#pk-job', JA);
  await page.waitForSelector('form[data-form="pick"]');
  await page.click('#pk-submit');
  await dlgOpen();
  await page.waitForSelector('#pk-confirm');
  for (const x of ['P2R-PNL 4 ชิ้น จาก P2RA/R-01 · ยังไม่สแกน', 'P2R-BLT 8 ตัว จาก P2RB/S-01', 'ยังไม่สแกน 2 แถว']) await waitText(x, 3000, '#pk-confirm');
  await noOverflow('ยืนยันหยิบ (มือถือ)');
  await shot('review-pick-confirm-phone');
  await page.click('#dlg .dlg-f button[data-dlg-close]');
  await dlgClosed();
  assert((await docsOf(JA, 'PD')).length === 0, 'กดยกเลิกแล้วต้องไม่เกิดใบ PD');
  await page.setViewportSize({ width: 1366, height: 900 });
});

await step('picking: another person changes the pick list while typing – values stay with their reservation', async () => {
  const rs = await state((s, R, n) => Object.fromEntries(Object.values(s.tables.reservations).filter((r) => r.jobNo === n && R.planning.isOpen(r)).map((r) => [r.code, r.id])), JA);
  assert(rs['P2R-PNL'] && rs['P2R-BLT'], `ใบจองของงาน: ${JSON.stringify(rs)}`);
  const qtyIn = (code) => `#pk-card-${rs[code]} input[name$="[qty]"]`;
  // the first card on the list is BLT (earlier code): before the fix its values moved to PNL when BLT left the list
  await page.fill(qtyIn('P2R-BLT'), '5');
  await page.fill(qtyIn('P2R-PNL'), '3');
  const other = await page.context().newPage();
  await other.goto(file);
  await other.waitForFunction(() => window.RRS && window.RRS.app && window.RRS.app.loading === false && window.RRS.app.ledger, null, { timeout: 60000 });
  const rel = await other.evaluate(async (id) => {
    const r = await window.RRS.app.ledger.execute({ kind: 'reserve.release', payload: { id, reason: 'ย้ายไปงานด่วน' } }, { user: 'P2RPLAN' });
    return { ok: r.ok, errors: r.errors || [] };
  }, rs['P2R-BLT']);
  await other.close();
  assert(rel.ok, `อีกคนปล่อยการจอง: ${JSON.stringify(rel.errors)}`);
  await page.evaluate(() => window.RRS.app.ledger.catchUp());
  await waitText('มีข้อมูลใหม่จากผู้อื่น', 4000, '#banner');
  assert(await page.inputValue(qtyIn('P2R-PNL')) === '3', 'ข้อมูลใหม่จากผู้อื่นต้องไม่ล้างค่าที่กำลังพิมพ์');
  await page.click('#pk-submit');
  await waitText('ใบจัดชุดเปลี่ยนระหว่างที่กรอก', 4000, '#pk-list');
  assert(await count(`#pk-card-${rs['P2R-BLT']}`) === 0, 'ใบจองที่ถูกปล่อยต้องหายจากใบจัดชุด');
  assert(await page.inputValue(qtyIn('P2R-PNL')) === '3', 'ค่าที่กรอกของ P2R-PNL ต้องอยู่กับใบจองของมัน');
  assert((await docsOf(JA, 'PD')).length === 0, 'ใบจัดชุดเปลี่ยนแล้วต้องไม่บันทึก');
  await page.click('#pk-submit');
  await dlgOpen();
  await waitText('P2R-PNL 3 ชิ้น จาก P2RA/R-01', 3000, '#pk-confirm');
  assert((await page.locator('#pk-confirm').innerText()).indexOf('P2R-BLT') < 0, 'ยืนยันต้องไม่มีรายการที่ไม่ได้หยิบ');
  await dlgSubmit();
  await dlgClosed();
  await waitText('บันทึกหยิบแล้วเป็น');
  const pd = await docsOf(JA, 'PD');
  assert(pd.length === 1 && pd[0].lines.length === 1 && pd[0].lines[0].code === 'P2R-PNL' && pd[0].lines[0].qty === 3, `ใบ PD: ${JSON.stringify(pd.map((d) => d.lines))}`);
  assert(lineOf(await job(JA), 'P2R-PNL').issued === 3 && lineOf(await job(JA), 'P2R-BLT').issued === 0, 'ยอดเบิกของงาน');
});

await step('forced cancel by another planner with material out, then the store returns it (RT)', async () => {
  await asUser('P2RPLAN2');
  await go('jobs');
  await page.selectOption('#jb-src', '');
  await pickJob(JA);
  await page.click('#jb-detail button[data-act="cancel"]');
  await dlgOpen();
  await waitText('ยังมีของที่เบิกไปและยังไม่คืน: P2R-PNL 3', 4000, '#dlg');
  await page.fill('#dlg textarea[name="reason"]', 'ลูกค้าเลื่อนงาน ทบทวน ' + EVIL);
  await dlgSubmit();
  await dlgError('คืนของเหลือ (RT) ก่อน');
  await page.check('#dlg input[name="force"]');
  await dlgSubmit();
  await dlgClosed();
  const j = await job(JA);
  assert(j.status === 'CANCELLED' && j.forced && j.forced.by === 'P2RPLAN2', `ยกเลิกแบบบังคับ: ${j.status} ${JSON.stringify(j.forced)}`);
  await waitText('ของที่เบิกไปแล้วคืนเข้าคลังได้ที่หน้า ใบจัดชุดและหยิบของ', 4000, '#jb-detail');
  assert(await count('#jb-detail button[data-act="cancel"]') === 0 && await count('#jb-lines button[data-act="reserve"]') === 0, 'งานที่ยกเลิกแล้วไม่มีปุ่มยกเลิก/จอง');
  assert(await count('#main img') === 0, 'เหตุผลที่พิมพ์ต้องไม่กลายเป็น HTML');
  await asUser('P2RSTORE');
  await go('picking');
  const label = await page.evaluate((n) => { const o = document.querySelector(`#pk-job option[value="${n}"]`); return o ? o.textContent : ''; }, JA);
  assert(/ยกเลิก · คืนของได้/.test(label), `ตัวเลือกงานที่ยกเลิก: ${label}`);
  await page.selectOption('#pk-job', JA);
  await page.waitForSelector('form[data-form="rt"]');
  await waitText('หยิบ/เบิกเข้างานนี้ไม่ได้ คืนของเหลือได้ด้านล่าง');
  assert(await count('form[data-form="pick"]') === 0, 'งานที่ยกเลิกต้องไม่มีฟอร์มหยิบ');
  const i = await page.evaluate(() => Array.from(document.querySelectorAll('form[data-form="rt"] [data-rt]')).find((c) => c.querySelector('input[type=hidden]').value === 'P2R-PNL').dataset.rt);
  await page.fill(`#rt-qty-${i}`, '3');
  await page.selectOption(`#rt-wh-${i}`, 'P2RA');
  await page.fill(`#rt-bin-${i}`, 'R-01');
  await page.fill('#rt-reason', 'คืนของจากงานที่ยกเลิก');
  await page.click('#rt-submit');
  await confirmOk();
  await waitText('รับคืนแล้วเป็น', 4000, '#pk-rt');
  const rt = await docsOf(JA, 'RT');
  assert(rt.length === 1 && rt[0].status === 'POSTED', `ใบ RT: ${JSON.stringify(rt)}`);
  assert(lineOf(await job(JA), 'P2R-PNL').issued === 0, 'คืนครบแล้วยอดเบิกของงานต้องเป็น 0');
  await waitText('คืนของที่เบิกให้งานนี้ครบแล้ว', 4000, '#pk-rt');
  assert(await page.inputValue('#pk-job') === JA, 'งานที่แสดงอยู่ต้องยังเลือกอยู่ในรายการงาน');
});

await step('Sales Office: Domestic and Export never share a job; mapping is blocked while reserved', async () => {
  const keys = {};
  for (const ws of ['domestic', 'export']) {
    const pl = { orderNumber: 'P2R-SO-90' + (ws === 'export' ? 'E' : 'D'), customerId: 'C-1', dealId: 'D-1', customerName: 'ลูกค้า ' + EVIL, vehicle: 'ISUZU',
      items: [{ lineId: 'L1', description: 'ตัวถัง ' + EVIL, qty: '1 ชุด', unit: 'ชุด', productId: 'SP-1' }], due: '2026-12-01', owner: 'sales-1',
      release: { allowed: true, blockers: [], drawingRevision: null, bomRevision: null, bomFingerprint: null }, cancelled: false };
    const hash = await page.evaluate((x) => window.RRS.util.sha256(JSON.stringify(x)), pl);
    const r = await must('sales.syncJob', { schemaVersion: 1, type: 'upsert_draft', workspace: ws, commandId: 'p2r-' + ws, orderId: 'P2R-ORD-1',
      productionJobId: 'P2R-PJ-1', version: 1, payloadHash: hash, payload: pl }, null, 'sales-bridge:' + ws);
    keys[ws] = r.result.jobNo;
  }
  assert(keys.domestic !== keys.export, `Domestic/Export ต้องเป็นคนละใบงาน: ${JSON.stringify(keys)}`);
  await asUser('P2RPLAN');
  await go('jobs');
  await page.selectOption('#jb-src', 'export');
  await page.waitForSelector(`#jb-list tr[data-arg="${keys.export}"]`);
  assert(await count(`#jb-list tr[data-arg="${keys.domestic}"]`) === 0, 'ตัวกรอง Export ต้องไม่แสดงงาน Domestic');
  await pickJob(keys.export);
  await waitText('ต่างประเทศ (Export)', 4000, '#jb-sales');
  assert(await count('#jb-sales img') === 0, 'ข้อความจาก SO ต้องไม่กลายเป็น HTML');
  await page.click('#jb-sales button[data-act="mapBom"]');
  await dlgOpen();
  await page.selectOption('#dlg select[name="product"]', 'P2R-FG');
  await page.fill('#dlg input[name="qty"]', '1');
  await dlgSubmit();
  await dlgClosed();
  assert((await job(keys.export)).product === 'P2R-FG' && !(await job(keys.domestic)).product, 'ผูก BOM เฉพาะงาน Export');
  await must('reserve.auto', { jobNo: keys.export }, 'P2RPLAN');
  await waitText('ปล่อยการจองก่อนจับคู่ใหม่', 4000, '#jb-map-why');
  assert(await page.isDisabled('#jb-sales button[data-act="mapBom"]'), 'มีของจองอยู่ต้องจับคู่ใหม่ไม่ได้');
  await asUser('P2RACC');
  await waitText('ฝ่ายวางแผนเป็นผู้จับคู่กับ BOM', 4000, '#jb-map-why');
  for (const act of ['new', 'auto', 'cancel', 'reserve', 'resChange', 'resRelease']) assert(await count(`#main button[data-act="${act}"]`) === 0, `บัญชีไม่ควรเห็นปุ่ม ${act}`);
  await page.selectOption('#jb-src', '');
  await shot('review-sales-export');
});

await browser.close();
if (problems.length) {
  console.log('\nPROBLEMS\n' + problems.join('\n'));
  process.exit(1);
}
console.log('\np2-review ok');
