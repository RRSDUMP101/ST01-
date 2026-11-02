// Browser test of the Phase 2 screens งาน/SO และการจอง (jobs), ใบจัดชุดและหยิบของ (picking) and
// สต็อก 6 ช่อง และความพร้อมผลิต (readiness).
//   RRS_OUT=/tmp/stockqc-p2 node tests/e2e/p2.mjs [--shots dir]
// Clean demo page, own master data (codes P2-…, warehouses P2A/P2B, users P2…), then through the UI: create jobs from
// an approved BOM and from own lines, reserve (dialog with free per warehouse, over-free error, partial), auto reserve,
// change / release, production record, the six boxes and per-job readiness, picking with scan/side mismatches and the
// PD it posts, returning leftovers (RT), the BOM revision stop, cancel / close jobs, a Sales Office job (read-only SO
// lines, blockers, map to BOM), permissions per role, a long list and phone width.
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

// ---- start from a clean page ------------------------------------------------------------------------------------
await page.goto(file);
await ready();
await page.evaluate(() => localStorage.clear());
await page.reload();
await ready();

const EVIL = '<img src=x onerror=alert(1)>';
const DUE = '2026-11-20';
let J1 = '';
let J2 = '';
let SJ = '';
let pdDoc = '';

await step('empty states', async () => {
  const none = await state((s) => !Object.keys(s.tables.jobs || {}).length);
  await go('jobs');
  if (none) await waitText('ยังไม่มีใบงาน');
  await go('picking');
  if (none) {
    await waitText('ยังไม่มีงานที่จะจัดชุด');
    await waitText('ไปหน้า งาน/SO และการจอง');
  }
  await go('readiness');
  await page.click('#main button.tab[data-arg="jobs"]');
  if (none) await waitText('ไม่มีใบงานที่ยังไม่ปิด');
  await page.click('#main button.tab[data-arg="six"]');
  await page.waitForFunction(() => document.querySelector('#main button.tab.on').dataset.arg === 'six');
  const items = await state((s) => Object.keys(s.tables.items || {}).length);
  if (!items) await waitText('ยังไม่มีสินค้า');
  await noOverflow('readiness ว่าง');
});

await step('setup master data and stock', async () => {
  await must('warehouse.upsert', { code: 'P2A', name: 'คลังทดสอบ P2 A' });
  await must('warehouse.upsert', { code: 'P2B', name: 'คลังทดสอบ P2 B' });
  for (const [wh, code] of [['P2A', 'A-01'], ['P2A', 'A-02'], ['P2B', 'B-01']]) await must('bin.upsert', { wh, code, name: 'ช่อง ' + code, active: true });
  await must('master.import', { items: [
    { code: 'P2-FG', name: 'ทดสอบพีสอง ตัวถังสำเร็จ', baseUnit: 'ชุด', type: 'FG' },
    { code: 'P2-PNL', name: 'ทดสอบพีสอง แผ่นข้าง', baseUnit: 'ชิ้น', type: 'PART' },
    { code: 'P2-BRK-L', name: 'ทดสอบพีสอง ขายึด ซ้าย', baseUnit: 'ชิ้น', type: 'PART', side: 'L', model: 'M1' },
    { code: 'P2-BRK-R', name: 'ทดสอบพีสอง ขายึด ขวา', baseUnit: 'ชิ้น', type: 'PART', side: 'R', model: 'M1' },
    { code: 'P2-BLT', name: 'ทดสอบพีสอง น็อต', baseUnit: 'ตัว', type: 'BUY', expressCode: 'EX-P2-BLT' },
  ] });
  await must('bom.upsert', { product: 'P2-FG', rev: 'A', lines: [{ code: 'P2-PNL', qty: 2 }, { code: 'P2-BRK-L', qty: 1 }, { code: 'P2-BRK-R', qty: 1 }, { code: 'P2-BLT', qty: 4 }] });
  await must('bom.approve', { product: 'P2-FG', rev: 'A' });
  // the older receipt first: A-01 is picked before A-02 (FIFO)
  await must('doc.post', { type: 'AJ', remark: 'ยอดทดสอบ P2', lines: [{ code: 'P2-PNL', qty: 10, wh: 'P2A', bin: 'A-01' }, { code: 'P2-BRK-L', qty: 3, wh: 'P2A', bin: 'A-01' }] });
  await page.waitForTimeout(20);
  await must('doc.post', { type: 'AJ', remark: 'ยอดทดสอบ P2', lines: [{ code: 'P2-PNL', qty: 4, wh: 'P2A', bin: 'A-02' }, { code: 'P2-BRK-R', qty: 3, wh: 'P2A', bin: 'A-02' },
    { code: 'P2-BLT', qty: 20, wh: 'P2B', bin: 'B-01' }, { code: 'P2-PNL', qty: 2, wh: 'P2A', bin: 'A-02', status: 'QC_HOLD' }] });
  for (const [id, name, roles] of [['P2PLAN', 'วางแผนทดสอบ P2', ['planner']], ['P2PLAN2', 'วางแผนคนที่สอง P2', ['planner']], ['P2STORE', 'สโตร์ทดสอบ P2', ['store']],
    ['P2PROD', 'ฝ่ายผลิตทดสอบ P2', ['production']], ['P2VIEW', 'ผู้ดูทดสอบ P2', ['viewer']]]) {
    await must('user.upsert', { id, name, roles });
  }
});

await step('jobs: create from an approved BOM × sets', async () => {
  await asUser('P2PLAN');
  await go('jobs');
  await page.click('#main button[data-act="new"]');
  await page.waitForSelector('form[data-form="create"]');
  await page.fill('#jb-n-so', 'P2-SO-001');
  await page.fill('#jb-n-due', DUE);
  await page.selectOption('#jb-n-prio', '2');
  await page.selectOption('#jb-n-prod', 'P2-FG');
  await waitText('BOM P2-FG ฉบับ A');
  await page.fill('#jb-n-qty', '2');
  // the preview follows the sets as they are typed
  await page.waitForFunction(() => Array.from(document.querySelectorAll('#main table tbody tr')).some((r) => r.innerText.indexOf('P2-BLT') >= 0 && r.children[3].innerText.trim() === '8'));
  assert(await page.inputValue('#jb-n-so') === 'P2-SO-001', 'เลข SO ต้องยังอยู่หลังแสดงตัวอย่าง');
  assert(await page.evaluate(() => document.activeElement && document.activeElement.id === 'jb-n-qty'), 'ช่องจำนวนชุดต้องยังโฟกัสอยู่');
  await shot('jobs-create');
  await page.click('form[data-form="create"] button[type="submit"]');
  await page.waitForSelector('#jb-detail');
  J1 = await state((s) => Object.values(s.tables.jobs).find((j) => j.soNo === 'P2-SO-001').jobNo);
  const j = await job(J1);
  assert(j.product === 'P2-FG' && j.bomRev === 'A' && j.qty === 2 && j.priority === 2 && j.dueDate === DUE, `ใบงาน: ${JSON.stringify(j).slice(0, 200)}`);
  assert(lineOf(j, 'P2-PNL').required === 4 && lineOf(j, 'P2-BLT').required === 8, 'ต้องใช้ = BOM × ชุด');
  await waitText('สินค้าที่ผลิต', 4000, '#jb-detail');
  const c = await rowCells('#jb-lines tbody tr', 'P2-BLT');
  assert(c && c[2] === '4' && c[3] === '8', `บรรทัด P2-BLT: ${c}`);
});

await step('jobs: create with own lines (add / remove line)', async () => {
  await page.click('#main button[data-act="new"]');
  await page.waitForSelector('form[data-form="create"]');
  await page.fill('#jb-n-so', 'P2-SO-002');
  await page.fill('#jb-n-due', '2026-11-25');
  await page.check('form[data-form="create"] input[name="mode"][value="manual"]');
  await page.waitForSelector('form[data-form="create"] input[name="lines[0][code]"]');
  assert(await page.inputValue('#jb-n-so') === 'P2-SO-002', 'เปลี่ยนแบบรายการแล้วเลข SO ต้องยังอยู่');
  await page.fill('input[name="lines[0][code]"]', 'P2-PNL');
  await page.fill('input[name="lines[0][qty]"]', '12');
  await page.click('form[data-form="create"] button[data-act="addLine"]');
  await page.waitForSelector('input[name="lines[1][code]"]');
  assert(await page.inputValue('input[name="lines[0][qty]"]') === '12', 'เพิ่มบรรทัดแล้วบรรทัดเดิมต้องยังอยู่');
  await page.fill('input[name="lines[1][code]"]', 'P2-BLT');
  await page.fill('input[name="lines[1][qty]"]', '1');
  await page.click('form[data-form="create"] tbody tr:nth-child(2) button[data-act="removeLine"]');
  await page.waitForFunction(() => !document.querySelector('input[name="lines[1][code]"]'));
  await page.fill('#jb-n-qty', '1');
  await page.click('form[data-form="create"] button[type="submit"]');
  await page.waitForSelector('#jb-detail');
  J2 = await state((s) => Object.values(s.tables.jobs).find((j) => j.soNo === 'P2-SO-002').jobNo);
  const j = await job(J2);
  assert(!j.product && j.lines.length === 1 && j.lines[0].code === 'P2-PNL' && j.lines[0].required === 12, `ใบงานระบุรายการเอง: ${JSON.stringify(j.lines)}`);
  await waitText('ระบุรายการชิ้นส่วนเอง', 4000, '#jb-detail');
});

await step('reserve: dialog shows free per warehouse, reserves', async () => {
  await pickJob(J1);
  await clickLine('P2-PNL', 'reserve');
  await dlgOpen();
  await waitText('พร้อมเบิก = ใช้ได้ − จองให้งานอื่น − งานนี้จองแล้ว', 4000, '#dlg');
  const w = await rowCells('#dlg table tbody tr', 'P2A');
  assert(w && w[1] === '14' && w[2] === '0' && w[3] === '0' && w[4] === '14', `ตารางพร้อมเบิกคลัง P2A: ${w}`);
  assert(await page.inputValue('#dlg input[name="qty"]') === '4', 'จำนวนตั้งต้นควรเป็นที่ยังต้องจอง (4)');
  await dlgSubmit();
  await dlgClosed();
  await waitToast('จอง RS-');
  const rs = await resOf(J1, 'P2-PNL');
  assert(rs.length === 1 && rs[0].qty === 4 && rs[0].wh === 'P2A' && rs[0].status === 'OPEN', `ใบจอง: ${JSON.stringify(rs)}`);
  const c = await rowCells('#jb-res tbody tr', 'P2-PNL');
  assert(c && c[5] === '4', `ตารางใบจอง: ${c}`);
  await waitText('พร้อมเบิก = ของสถานะ "ใช้ได้" − ที่จองให้งานอื่น');
});

await step('reserve: over free is refused with the reason, then partial', async () => {
  await pickJob(J2);
  await clickLine('P2-PNL', 'reserve');
  await dlgOpen();
  const w = await rowCells('#dlg table tbody tr', 'P2A');
  assert(w && w[1] === '14' && w[2] === '4' && w[4] === '10', `อีกงานต้องเห็นของที่งานแรกจองแล้ว: ${w}`);
  await page.fill('#dlg input[name="qty"]', '12');
  await dlgSubmit();
  await dlgError('พร้อมเบิก (หักที่จองให้งานอื่นแล้ว) 10');
  assert((await resOf(J2, 'P2-PNL')).length === 0, 'จองเกินต้องไม่เกิดใบจอง');
  await page.check('#dlg input[name="allowPartial"]');
  await dlgSubmit();
  await dlgClosed();
  await waitToast('ยังขาด 2');
  const rs = await resOf(J2, 'P2-PNL');
  assert(rs.length === 1 && rs[0].qty === 10 && rs[0].requested === 12, `จองบางส่วน: ${JSON.stringify(rs)}`);
});

await step('reserve: auto for one job, change and release', async () => {
  await pickJob(J1);
  await page.click('#jb-detail button[data-act="auto"]');
  await confirmOk();
  await waitText('จองอัตโนมัติ 3 ใบ', 6000, '#jb-detail');
  const blt = await resOf(J1, 'P2-BLT');
  assert(blt.length === 1 && blt[0].qty === 8 && blt[0].wh === 'P2B' && blt[0].auto, `จองอัตโนมัติ P2-BLT: ${JSON.stringify(blt)}`);
  // change 8 -> 6
  await page.click(`#jb-res button[data-act="resChange"][data-arg="${blt[0].id}"]`);
  await dlgOpen();
  await page.fill('#dlg input[name="qty"]', '6');
  await page.fill('#dlg input[name="reason"]', 'ใช้น็อตสต็อกเก่าแทน');
  await dlgSubmit();
  await dlgClosed();
  const after = (await resOf(J1, 'P2-BLT'))[0];
  assert(after.qty === 6 && after.changes.length === 1 && after.changes[0].reason === 'ใช้น็อตสต็อกเก่าแทน', `เปลี่ยนจอง: ${JSON.stringify(after)}`);
  // release the partial reservation of the other job: reason required
  await pickJob(J2);
  const r2 = (await resOf(J2, 'P2-PNL'))[0];
  await page.click(`#jb-res button[data-act="resRelease"][data-arg="${r2.id}"]`);
  await dlgOpen();
  await waitText('งานอื่นจองได้ทันที', 4000, '#dlg');
  await dlgSubmit();
  await page.waitForTimeout(200);
  assert((await page.locator('#dlg').isHidden()) === false, 'ไม่ใส่เหตุผลต้องยังไม่ปล่อย');
  await page.fill('#dlg textarea[name="reason"], #dlg input[name="reason"]', 'งานเลื่อน');
  await dlgSubmit();
  await dlgClosed();
  const rel = (await resOf(J2, 'P2-PNL'))[0];
  assert(rel.status === 'RELEASED' && rel.reason === 'งานเลื่อน' && rel.releasedBy === 'P2PLAN', `ปล่อยจอง: ${JSON.stringify(rel)}`);
  await waitText('ไม่มีของที่ยังจองค้าง', 4000, '#jb-resv');
  await page.click('#jb-detail button[data-act="resAll"]');
  await waitText('งานเลื่อน', 4000, '#jb-resv');
});

await step('readiness: six boxes with legend, item detail', async () => {
  await go('readiness');
  await page.click('#main button.tab[data-arg="six"]');
  await waitText('ไม่นับเป็นของพร้อมเบิกเด็ดขาด');
  await page.click('#main details summary');
  await waitText('ต้องใช้ − จองแล้ว − พร้อมเบิก');
  await page.fill('#rd-q', 'P2-');
  await page.waitForFunction(() => document.querySelector('#rd-six') && document.querySelector('#rd-six').innerText.indexOf('P2-PNL') >= 0);
  const c = await rowCells('#rd-six tbody tr', 'P2-PNL');
  // รหัส | มีจริง | รอตรวจ/กักกัน | จองแล้ว | พร้อมเบิก | กำลังผลิต | จะเข้า | ต้องใช้ | ขาด
  assert(c && c[1] === '16' && c[2] === '2' && c[3] === '4' && c[4] === '10' && c[7] === '16' && c[8] === '2', `สต็อก 6 ช่อง P2-PNL: ${c.join(' | ')}`);
  const six = await state((s, R) => R.planning.six(s, { code: 'P2-PNL', today: '2026-11-02' })[0]);
  assert(six.free === 10 && six.short === 2 && six.qcHold === 2, `six(): ${JSON.stringify(six)}`);
  const fg = await rowCells('#rd-six tbody tr', 'P2-FG');
  assert(fg && fg[5].indexOf('2') === 0, `P2-FG กำลังผลิต 2 (ตั้งผลิตของงาน): ${fg}`);
  assert(fg[4] === '–', 'ของที่กำลังผลิตต้องไม่ถูกนับเป็นพร้อมเบิก');
  await page.check('#rd-short');
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('#rd-six tbody tr')).some((r) => r.innerText.indexOf('P2-BLT') >= 0));
  assert(await rowCells('#rd-six tbody tr', 'P2-PNL'), 'เฉพาะที่ขาดต้องมี P2-PNL');
  await page.click('#rd-six tbody tr[data-arg="P2-PNL"]');
  await page.waitForSelector('#rd-detail');
  await waitText('รอตรวจ / กักกัน อยู่ที่', 4000, '#rd-detail');
  await waitText('P2A/A-02', 4000, '#rd-detail');
  await waitText(J2, 4000, '#rd-detail');
  await shot('readiness-six');
  await page.click('#main button[data-act="clear"]');
});

await step('readiness: per job – what is missing and where', async () => {
  await page.click('#main button.tab[data-arg="jobs"]');
  await page.waitForSelector('#rd-jobs');
  await page.click(`#rd-jobs tr[data-arg="${J2}"]`);
  await page.waitForSelector('#rd-job');
  await waitText('ขาด 1 รายการ', 4000, '#rd-job');
  await waitText('รอตรวจ/กักกัน 2 (ต้องให้ QC ปล่อยก่อน)', 4000, '#rd-job');
  const l = await rowCells('#rd-lines tbody tr', 'P2-PNL');
  // รายการ | ต้องใช้ | เบิกแล้ว | จองไว้ | ยังไม่จอง | พร้อมเบิกตอนนี้ | จัดให้งานนี้ได้ | ขาด
  assert(l && l[1] === '12' && l[4] === '12' && l[6] === '10' && l[7] === '2' && l[9] === 'รอตรวจ', `ความพร้อม ${J2}: ${l}`);
  await page.click(`#rd-jobs tr[data-arg="${J1}"]`);
  await waitText('พร้อมผลิต', 4000, '#rd-job');
  await waitText('ทุกรายการพร้อม', 4000, '#rd-job');
});

await step('production: record finished (production user), no planning buttons', async () => {
  await asUser('P2PROD');
  await go('jobs');
  await pickJob(J1);
  assert(await page.locator('#main button[data-act="new"]').count() === 0, 'ฝ่ายผลิตไม่ควรเห็นปุ่มสร้างใบงาน');
  assert(!(await lineBtn('P2-PNL', 'reserve')), 'ฝ่ายผลิตไม่ควรเห็นปุ่มจอง');
  assert(await page.locator('#jb-detail button[data-act="cancel"]').count() === 0, 'ฝ่ายผลิตไม่ควรเห็นปุ่มยกเลิกใบงาน');
  await clickLine('P2-FG', 'record');
  await dlgOpen();
  await page.fill('#dlg input[name="qty"]', '1');
  await dlgSubmit();
  await dlgClosed();
  await waitToast('รวม 1/2');
  const j = await job(J1);
  assert(j.lines.find((l) => l.output).finished === 1 && j.status === 'IN_PROGRESS', `บันทึกผลิต: ${JSON.stringify(j.lines[0])} ${j.status}`);
});

await step('picking: phone-friendly list with FIFO bins and live scan check', async () => {
  await asUser('P2STORE');
  await go('picking');
  await page.selectOption('#pk-job', J1);
  await page.waitForSelector('form[data-form="pick"]');
  const rs = await state((s, R, n) => Object.fromEntries(Object.values(s.tables.reservations).filter((r) => r.jobNo === n && R.planning.isOpen(r)).map((r) => [r.code, r.id])), J1);
  const card = (code) => `#pk-card-${rs[code]}`;
  await waitText('ต้องหยิบ 4', 4000, card('P2-PNL'));
  // FIFO: A-01 (older receipt) is suggested first
  const bin = await page.evaluate((sel) => document.querySelector(`${sel} select[name$="[binlot]"]`).value, card('P2-PNL'));
  assert(bin === 'A-01|', `ช่องที่แนะนำ P2-PNL: ${bin}`);
  const scanL = `${card('P2-BRK-L')} input[data-scan]`;
  await page.fill(scanL, 'P2-BRK-R');
  await waitText('ไม่ตรง: สแกนได้ P2-BRK-R', 3000, card('P2-BRK-L'));
  await page.fill(scanL, 'p2-brk-l');
  await waitText('ตรงกับใบจอง P2-BRK-L', 3000, card('P2-BRK-L'));
  // Enter from a scanner moves to the next field and does not save
  await page.focus(scanL);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  assert(await page.locator('#dlg').isHidden(), 'Enter จากเครื่องสแกนต้องไม่บันทึก');
  await shot('picking-form');
});

await step('picking: wrong item and wrong side are shown on their row, nothing posted', async () => {
  const rs = await state((s, R, n) => Object.fromEntries(Object.values(s.tables.reservations).filter((r) => r.jobNo === n && R.planning.isOpen(r)).map((r) => [r.code, r.id])), J1);
  const card = (code) => `#pk-card-${rs[code]}`;
  const docsBefore = await state((s) => Object.keys(s.tables.documents || {}).length);
  await page.fill(`${card('P2-BRK-L')} input[data-scan]`, 'P2-BRK-R');
  await page.click('#pk-submit');
  await waitText('บันทึกหยิบไม่ได้ – ยังไม่มีอะไรเปลี่ยน');
  await waitText(`P2-BRK-L (ใบจอง ${rs['P2-BRK-L']}): สแกนได้ P2-BRK-R`, 4000, card('P2-BRK-L'));
  assert(await page.locator(`${card('P2-BRK-L')} [data-err="1"]`).count() === 1, 'แถวที่ผิดต้องถูกทำเครื่องหมาย');
  assert(await page.inputValue(`${card('P2-BRK-L')} input[data-scan]`) === 'P2-BRK-R', 'ค่าที่กรอกต้องยังอยู่ให้แก้');
  await page.fill(`${card('P2-BRK-L')} input[data-scan]`, 'P2-BRK-L');
  await page.selectOption(`${card('P2-BRK-L')} select[name$="[side]"]`, 'R');
  await page.click('#pk-submit');
  await waitText('ข้างไม่ตรง', 4000, card('P2-BRK-L'));
  assert(await state((s) => Object.keys(s.tables.documents || {}).length) === docsBefore, 'หยิบผิดต้องไม่เกิดเอกสาร');
  assert(await page.locator('#dlg').isHidden(), 'ผิดแล้วต้องไม่ถามยืนยัน');
});

await step('picking: post the pick as one PD, reservations and job follow', async () => {
  const rs = await state((s, R, n) => Object.fromEntries(Object.values(s.tables.reservations).filter((r) => r.jobNo === n && R.planning.isOpen(r)).map((r) => [r.code, r.id])), J1);
  const card = (code) => `#pk-card-${rs[code]}`;
  await page.selectOption(`${card('P2-BRK-L')} select[name$="[side]"]`, 'L');
  await page.fill(`${card('P2-BLT')} input[data-scan]`, 'EX-P2-BLT'); // the Express code scans as the item
  await waitText('ตรงกับใบจอง P2-BLT', 3000, card('P2-BLT'));
  await page.fill('#pk-remark', 'จัดชุดทดสอบ ' + EVIL);
  await page.click('#pk-submit');
  await dlgOpen();
  await waitText('ใบจ่ายเพื่อผลิต (PD) 1 ใบ', 4000, '#dlg');
  await dlgSubmit();
  await dlgClosed();
  await waitText('บันทึกหยิบแล้วเป็น');
  const doc = await state((s) => Object.values(s.tables.documents).find((d) => d.type === 'PD' && d.source === 'pick'));
  assert(doc && doc.status === 'POSTED' && doc.lines.length === 4, `ใบ PD: ${doc && doc.lines.length}`);
  pdDoc = doc.docNo;
  const j = await job(J1);
  assert(lineOf(j, 'P2-PNL').issued === 4 && lineOf(j, 'P2-BRK-L').issued === 2 && lineOf(j, 'P2-BLT').issued === 6, 'ยอดเบิกของงาน');
  const q = await state((s, R) => [R.q.qty(s, { code: 'P2-PNL', wh: 'P2A', bin: 'A-01' }), R.q.qty(s, { code: 'P2-BLT' })]);
  assert(q[0] === 6 && q[1] === 14, `ยอดคงเหลือหลังหยิบ ${q}`);
  const filled = await state((s, R, n) => Object.values(s.tables.reservations).filter((r) => r.jobNo === n).every((r) => r.status === 'FILLED'), J1);
  assert(filled, 'ใบจองที่หยิบครบต้องเป็น เบิกครบ');
  await waitText('ไม่มีของค้างหยิบ');
  await waitText(pdDoc);
});

await step('return leftovers (RT): over issued refused, then posted with the job', async () => {
  await page.waitForSelector('form[data-form="rt"]');
  const idx = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('form[data-form="rt"] [data-rt]'));
    const f = (c) => cards.find((x) => x.querySelector('input[type=hidden]').value === c).dataset.rt;
    return { pnl: f('P2-PNL'), brk: f('P2-BRK-L') };
  });
  assert(await page.inputValue(`#rt-wh-${idx.pnl}`) === 'P2A', 'คลังที่คืนตั้งต้นจากที่เบิกไป');
  await page.fill(`#rt-qty-${idx.brk}`, '5');
  await page.fill('#rt-reason', 'ของเหลือจากการผลิต');
  await page.click('#rt-submit');
  await waitText('คืนเกินกว่าที่เบิกไม่ได้', 4000, '#pk-rt');
  await page.fill(`#rt-qty-${idx.brk}`, '');
  await page.fill(`#rt-qty-${idx.pnl}`, '1');
  await page.click('#rt-submit');
  await confirmOk();
  await waitText('รับคืนแล้วเป็น', 4000, '#pk-rt');
  const rt = await state((s, R, n) => Object.values(s.tables.documents).find((d) => d.type === 'RT' && d.job === n), J1);
  assert(rt && rt.status === 'POSTED' && rt.lines.length === 1 && rt.remark === 'ของเหลือจากการผลิต', `ใบ RT: ${JSON.stringify(rt && rt.lines)}`);
  assert(lineOf(await job(J1), 'P2-PNL').issued === 3, 'คืนแล้วยอดเบิกของงานต้องลด');
});

await step('BOM revision changed: picking stops with the engine reason', async () => {
  await must('reserve.create', { jobNo: J1, code: 'P2-PNL', wh: 'P2A', qty: 1 });
  await must('bom.upsert', { product: 'P2-FG', rev: 'B', lines: [{ code: 'P2-PNL', qty: 3 }, { code: 'P2-BLT', qty: 4 }] });
  await must('bom.approve', { product: 'P2-FG', rev: 'B' });
  await go('jobs');
  await go('picking');
  await page.waitForSelector('#pk-submit');
  await waitText('BOM เปลี่ยนฉบับ');
  assert(await page.isDisabled('#pk-submit'), 'BOM เปลี่ยนฉบับแล้วต้องกดบันทึกหยิบไม่ได้');
  await asUser('P2PLAN');
  await go('jobs');
  await pickJob(J1);
  await waitText('เปลี่ยนเป็นฉบับ B แล้ว', 4000, '#jb-detail');
});

await step('cancel job: reason required, reservations released', async () => {
  await pickJob(J2);
  await page.click('#jb-detail button[data-act="auto"]');
  await confirmOk();
  const open = (await resOf(J2, 'P2-PNL')).filter((r) => r.status === 'OPEN');
  assert(open.length === 1, 'ต้องมีของจองก่อนยกเลิก');
  await page.click('#jb-detail button[data-act="cancel"]');
  await dlgOpen();
  await waitText('จะถูกปล่อยคืนให้งานอื่นจองได้ทันที', 4000, '#dlg');
  await dlgSubmit();
  await page.waitForTimeout(200);
  assert(!(await page.locator('#dlg').isHidden()), 'ไม่มีเหตุผลต้องยกเลิกไม่ได้');
  await page.fill('#dlg textarea[name="reason"]', 'ลูกค้ายกเลิก SO');
  await dlgSubmit();
  await dlgClosed();
  await waitToast('ปล่อยของจอง 1 ใบ');
  const j = await job(J2);
  assert(j.status === 'CANCELLED' && j.cancelReason === 'ลูกค้ายกเลิก SO', `ยกเลิกงาน: ${j.status}`);
  const r = (await resOf(J2, 'P2-PNL')).find((x) => x.id === open[0].id);
  assert(r.status === 'RELEASED' && /ยกเลิกงาน/.test(r.reason), `ใบจองหลังยกเลิกงาน: ${JSON.stringify(r)}`);
  // the list shows open work by default: the cancelled job is under "ทั้งหมด"
  assert(!(await page.locator(`#jb-list tr[data-arg="${J2}"]`).count()), 'งานที่ยกเลิกไม่ควรอยู่ในรายการงานที่ยังไม่ปิด');
  await page.selectOption('#jb-st', 'all');
  await page.waitForSelector(`#jb-list tr[data-arg="${J2}"]`);
  await page.selectOption('#jb-st', 'open');
});

await step('cancel with material out: the creator cannot force it; close as DONE', async () => {
  await pickJob(J1);
  await page.click('#jb-detail button[data-act="cancel"]');
  await dlgOpen();
  await waitText('ยังมีของที่เบิกไปและยังไม่คืน', 4000, '#dlg');
  await page.fill('#dlg textarea[name="reason"]', 'ทดสอบยกเลิกแบบบังคับ');
  await dlgSubmit();
  await dlgError('ยังมีของที่เบิกไปและยังไม่คืน');
  await page.check('#dlg input[name="force"]');
  await dlgSubmit();
  await dlgError('ต้องเป็นคนละคนกับผู้ทำรายการ');
  await page.click('#dlg .dlg-f button[data-dlg-close]');
  await dlgClosed();
  assert((await job(J1)).status === 'IN_PROGRESS', 'ยกเลิกไม่สำเร็จต้องไม่เปลี่ยนสถานะ');
  await page.click('#jb-detail button[data-act="done"]');
  await dlgOpen();
  await waitText('ยังเบิกไม่ครบ', 4000, '#dlg');
  await dlgSubmit();
  await dlgClosed();
  const j = await job(J1);
  assert(j.status === 'DONE' && j.doneBy === 'P2PLAN', `ปิดงาน: ${j.status}`);
  const open = await state((s, R, n) => Object.values(s.tables.reservations).filter((r) => r.jobNo === n && R.planning.isOpen(r)).length, J1);
  assert(open === 0, 'ปิดงานแล้วต้องไม่มีของจองค้าง');
});

await step('Sales Office job: read-only SO lines, blockers, map to BOM', async () => {
  const pl = { orderNumber: 'P2-SO-900', customerId: 'C-77', dealId: 'D-5', customerName: 'ลูกค้า ' + EVIL, vehicle: 'ISUZU ' + EVIL,
    items: [{ lineId: 'L1', description: EVIL + ' ตัวถังทดสอบ', qty: '2 ชุด', unit: 'ชุด', productId: 'SP-1' }], due: '2026-12-01', owner: 'sales-1',
    release: { allowed: false, blockers: ['รอมัดจำ ' + EVIL], drawingRevision: null, bomRevision: null, bomFingerprint: null }, cancelled: false };
  const hash = await page.evaluate((x) => window.RRS.util.sha256(JSON.stringify(x)), pl);
  const r = await must('sales.syncJob', { schemaVersion: 1, type: 'upsert_draft', workspace: 'domestic', commandId: 'p2-cmd-1', orderId: 'P2-ORD-1',
    productionJobId: 'P2-PJ-1', version: 1, payloadHash: hash, payload: pl }, null, 'sales-bridge:domestic');
  SJ = r.result.jobNo;
  await go('jobs');
  await page.waitForSelector(`#jb-list tr[data-arg="${SJ}"]`);
  const row = await rowCells('#jb-list tbody tr', SJ);
  assert(row && /Sales Office · Domestic/.test(row[0]) && /ยังไม่ผูก BOM/.test(row[2]), `แถวงานจาก SO: ${row}`);
  assert(/\d/.test(await page.locator('#nav a[data-go="jobs"] .nav-n').innerText()), 'เมนูควรบอกจำนวน SO ที่รอผูก BOM');
  await pickJob(SJ);
  await page.waitForSelector('#jb-sales');
  await waitText('ในประเทศ (Domestic)', 4000, '#jb-sales');
  for (const x of ['P2-ORD-1', 'P2-PJ-1', 'C-77', 'D-5', '2 ชุด', 'SP-1', EVIL + ' ตัวถังทดสอบ', 'รอมัดจำ', 'ยังไม่ได้ผูกใบงานกับสินค้าและ BOM ที่อนุมัติ']) await waitText(x, 4000, '#jb-sales');
  assert((await page.locator('#jb-sales').innerText()).indexOf('ลูกค้า ') < 0, 'ไม่แสดงชื่อลูกค้า');
  assert(await page.locator('#jb-sales img').count() === 0, 'ข้อความจาก SO ต้องไม่กลายเป็น HTML');
  assert(await page.locator('#jb-sales input').count() === 0, 'รายการ SO อ่านอย่างเดียว');
  await page.click('#jb-sales button[data-act="mapBom"]');
  await dlgOpen();
  assert(await page.inputValue('#dlg select[name="product"]') === '', 'ต้องไม่เลือกสินค้าให้จากชื่อ');
  assert(await page.inputValue('#dlg input[name="qty"]') === '', 'ต้องไม่เดาจำนวนชุดจาก SO');
  await page.selectOption('#dlg select[name="product"]', 'P2-FG');
  await dlgSubmit();
  await dlgError('ระบุจำนวนชุด');
  await page.fill('#dlg input[name="qty"]', '2');
  await dlgSubmit();
  await dlgClosed();
  const j = await job(SJ);
  assert(j.product === 'P2-FG' && j.bomRev === 'B' && j.qty === 2 && lineOf(j, 'P2-PNL').required === 6, `ผูก BOM: ${j.product} ${j.bomRev} ${j.qty}`);
  await waitGone('ยังไม่ได้ผูกใบงานกับสินค้าและ BOM ที่อนุมัติ');
  await waitText('P2-FG ฉบับ B × 2 ชุด', 4000, '#jb-sales');
  await waitText('รับจาก Sales Office', 4000, '#jb-detail');
  await shot('jobs-sales');
});

await step('permissions: viewer sees, cannot act; store sees the pick list', async () => {
  await asUser('P2VIEW');
  await go('jobs');
  await pickJob(SJ);
  for (const act of ['new', 'auto', 'cancel', 'done', 'edit', 'reserve', 'setMake', 'record']) {
    assert(await page.locator(`#main button[data-act="${act}"]`).count() === 0, `ผู้ดูไม่ควรเห็นปุ่ม ${act}`);
  }
  assert(await page.isDisabled('#jb-sales button[data-act="mapBom"]'), 'ผู้ดูจับคู่ BOM ไม่ได้');
  await must('reserve.auto', { jobNo: SJ });
  await go('picking');
  await page.selectOption('#pk-job', SJ);
  await waitText('ใบจัดชุด');
  assert(await page.locator('form[data-form="pick"]').count() === 0, 'ผู้ดูไม่ควรมีฟอร์มหยิบ');
  await waitText('สโตร์/หัวหน้าสโตร์เป็นผู้บันทึกหยิบ');
  await page.click('#main button[data-act="csv"]');
  await dlgOpen();
  assert((await page.inputValue('#dlg textarea')).indexOf('ใบจอง') >= 0, 'ใบจัดชุด CSV');
  await page.click('#dlg .dlg-f button[data-dlg-close]');
  await dlgClosed();
});

await step('long list scrolls in its own box; phone width', async () => {
  for (let i = 0; i < 40; i++) {
    await must('job.create', { soNo: `P2-BULK-${String(i).padStart(3, '0')}`, dueDate: '2026-12-15', priority: 1 + (i % 5), lines: [{ code: 'P2-BLT', qty: 1 }] });
  }
  await asUser('P2PLAN');
  await go('jobs');
  await page.waitForSelector('#jb-list');
  const box = await page.evaluate(() => { const b = document.querySelector('#jb-list'); return { cls: b.className, sh: b.scrollHeight, ch: b.clientHeight }; });
  assert(/scroll/.test(box.cls) && box.sh > box.ch, `รายการยาวต้องเลื่อนในกรอบของตัวเอง: ${JSON.stringify(box)}`);
  await page.click('#main button[data-act="csv"]');
  await dlgOpen();
  const csv = await page.inputValue('#dlg textarea');
  assert(csv.indexOf('P2-BULK-039') >= 0 && csv.indexOf('เลขที่ใบงาน') >= 0, 'CSV ใบงาน');
  await page.click('#dlg .dlg-f button[data-dlg-close]');
  await dlgClosed();
  await page.setViewportSize({ width: 390, height: 844 });
  await pickJob(SJ);
  await noOverflow('jobs (มือถือ)');
  await clickLine('P2-PNL', 'reserve').catch(() => {}); // fully reserved already: no button is fine
  if (!(await page.locator('#dlg').isHidden())) {
    await noOverflow('reserve dialog (มือถือ)');
    await page.click('#dlg .dlg-f button[data-dlg-close]');
  }
  await page.click('#main button[data-act="new"]');
  await page.waitForSelector('form[data-form="create"]');
  await noOverflow('create (มือถือ)');
  await page.click('form[data-form="create"] button[data-act="close"]');
  await asUser('P2STORE');
  await go('picking');
  await page.selectOption('#pk-job', SJ);
  await page.waitForSelector('form[data-form="pick"]');
  await noOverflow('picking (มือถือ)');
  await shot('phone-picking');
  await go('readiness');
  await page.click('#main button.tab[data-arg="six"]');
  await page.waitForSelector('#rd-six');
  await noOverflow('readiness six (มือถือ)');
  await page.click('#main button.tab[data-arg="jobs"]');
  await page.click(`#rd-jobs tr[data-arg="${SJ}"]`);
  await page.waitForSelector('#rd-job');
  await noOverflow('readiness jobs (มือถือ)');
  await page.setViewportSize({ width: 1366, height: 900 });
});

await browser.close();
if (problems.length) {
  console.log('\nPROBLEMS\n' + problems.join('\n'));
  process.exit(1);
}
console.log('\np2 ok');
