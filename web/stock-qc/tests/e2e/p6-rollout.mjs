// Browser test of the screens added last: ทดลองใช้และขยายผล (rollout – pilot issues and rollout plans), voiding a
// mistyped PASS and retiring a QC plan from the QC screens, and the number-box check of forms and dialogs.
//   RRS_OUT=/tmp/stockqc-out node tests/e2e/p6-rollout.mjs [--shots dir]
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
await page.goto(file);
await ready();
await page.evaluate(() => localStorage.clear());
await page.reload();
await ready();

await step('setup', async () => {
  await must('warehouse.upsert', { code: 'ROW', name: 'คลังทดสอบขยายผล' });
  await must('bin.upsert', { wh: 'ROW', code: 'RO-1', name: 'ชั้นหนึ่ง' });
  await must('item.upsert', { code: 'RO-PART', name: 'ชิ้นส่วนทดสอบขยายผล', baseUnit: 'ชิ้น', type: 'RM', group: 'RO-GROUP', qcIncoming: true, drawingRev: 'A' });
  for (const [id, name, roles] of [['ROM1', 'ผู้จัดการหนึ่ง', ['manager']], ['ROM2', 'ผู้จัดการสอง', ['manager']], ['ROQC', 'คิวซีขยายผล', ['qc']],
    ['ROQL', 'หัวหน้าคิวซีขยายผล', ['qc_lead']], ['ROEN', 'วิศวกรขยายผล', ['engineering']], ['ROSL', 'หัวหน้าสโตร์ขยายผล', ['store_lead']]]) {
    await must('user.upsert', { id, name, roles });
  }
});

await step('pilot issues: report, separation of duties for CRITICAL, close', async () => {
  await asUser('ROQC');
  await go('rollout');
  await waitText('ขอบเขตทดลอง');
  await page.click('#pi-new');
  await dlgOpen();
  await page.check('#dlg input[name="severity"][value="CRITICAL"]');
  await page.fill('#pi-area', 'เบิกของ');
  await page.fill('#pi-desc', 'ยอดตัดซ้ำ ' + EVIL);
  await dlgSubmit();
  await dlgClosed();
  await waitIn('#pi-list', 'ยอดตัดซ้ำ');
  assert(Number(await kpi('ปัญหาร้ายแรงที่เปิดอยู่')) >= 1, 'KPI ปัญหาร้ายแรงไม่ขึ้น');
  await waitIn('#pi-list', 'ให้คนอื่นปิด');
  const id = await state((s) => Object.values(s.tables.pilot_issues).find((x) => x.description.indexOf('ยอดตัดซ้ำ') === 0).id);
  await asUser('ROM1');
  await go('rollout');
  await clickInRow('#pi-list tbody tr', id, 'button[data-act="resolve"]');
  await dlgOpen();
  await page.fill('#pi-res', 'แก้การตัดยอดแล้ว ทดสอบซ้ำผ่าน');
  await dlgSubmit();
  await dlgClosed();
  await waitState((s, R, x) => s.tables.pilot_issues[x].status === 'RESOLVED' && s.tables.pilot_issues[x].resolvedBy === 'ROM1', id, 'ปิดปัญหาแล้ว');
  await page.selectOption('#pi-st', 'all');
  await waitIn('#pi-list', 'ปิดแล้ว');
});

await step('rollout plan: propose, readiness, proposer cannot approve, reject', async () => {
  await asUser('ROM1');
  await go('rollout');
  await tab('plans');
  await page.click('#ro-new');
  await dlgOpen();
  await page.fill('#ro-title', 'ขยายไปคลังทดสอบ ' + EVIL);
  await page.check('#ro-whs input[value="ROW"]');
  await page.selectOption('#ro-owner', 'ROSL');
  await page.check('#ro-team input[value="ROSL"]');
  await dlgSubmit();
  await dlgError('แผนย้อนกลับ');
  await page.fill('#ro-rollback-plan', 'ถอดคลัง ROW ออกจากการทดลอง กู้ข้อมูลจากชุดสำรองล่าสุด');
  await dlgSubmit();
  await dlgClosed();
  await page.waitForSelector('#ro-detail');
  await waitIn('#ro-detail', 'ความพร้อม (ตรวจตอนนี้)');
  await waitIn('#ro-detail', 'ยังขยายผลไม่ได้');
  await waitIn('#ro-detail', 'ต้องให้ผู้จัดการคนอื่นอนุมัติ');
  assert(await page.isDisabled('#ro-approve'), 'ผู้เสนออนุมัติเองได้');
  const id = await state((s) => Object.values(s.tables.rollouts).find((x) => x.title.indexOf('ขยายไปคลังทดสอบ') === 0).id);
  await asUser('ROM2');
  await go('rollout');
  await tab('plans');
  await clickInRow('#ro-list tbody tr', id);
  await page.waitForSelector('#ro-detail');
  assert(await page.isDisabled('#ro-approve'), 'อนุมัติได้ทั้งที่ยังไม่พร้อม');
  await page.click('#ro-reject');
  await dlgOpen();
  await page.fill('#ro-reject-reason', 'ยังไม่ทดสอบกู้ข้อมูล');
  await dlgSubmit();
  await dlgClosed();
  await waitState((s, R, x) => s.tables.rollouts[x].status === 'REJECTED' && s.tables.rollouts[x].rejectedBy === 'ROM2', id, 'ไม่อนุมัติแล้ว');
  await waitIn('#ro-detail', 'ยังไม่ทดสอบกู้ข้อมูล');
  // the store lead cannot approve: no buttons, a note instead
  await asUser('ROQC');
  await go('rollout');
  await tab('plans');
  assert(!(await page.$('#ro-new')), 'QC เสนอแผนขยายผลได้');
});

let inspId = '';
let planId = '';
await step('QC: void a mistyped PASS from the inspection detail', async () => {
  const p = await must('qc.plan.save', { code: 'RO-PART', stage: 'INCOMING', drawingRev: 'A', sourceRef: 'WI-RO-1', chars: [{ name: 'ผิว', kind: 'check' }] }, 'ROEN');
  planId = p.result.id;
  await must('qc.plan.approve', { id: planId }, 'ROQL');
  const rr = await must('doc.post', { type: 'RR', lines: [{ code: 'RO-PART', qty: 5, wh: 'ROW', bin: 'RO-1' }] }, 'ROSL');
  const i = await must('qc.inspect', { stage: 'INCOMING', code: 'RO-PART', wh: 'ROW', bin: 'RO-1', qty: 5, planId, sourceDoc: rr.result.docNo,
    results: [{ char: 'ผิว', value: 'ผ่าน' }] }, 'ROQC');
  inspId = i.result.id;
  // the inspector sees no void button
  await asUser('ROQC');
  await page.evaluate((x) => { window.RRS.app.views.inspections = { tab: 'all', sel: x }; }, inspId);
  await reopen('inspections');
  await page.waitForSelector('#ins-detail');
  assert(!(await page.$('#ins-void-btn')), 'ผู้ตรวจยกเลิกผลของตัวเองได้');
  await asUser('ROQL');
  await page.evaluate((x) => { window.RRS.app.views.inspections = { tab: 'all', sel: x }; }, inspId);
  await reopen('inspections');
  await page.waitForSelector('#ins-void-btn');
  // a number box the browser cannot read is refused before anything is sent
  await page.click('#ins-release-btn');
  await dlgOpen();
  await page.fill('#rel-qty', '');
  await page.focus('#rel-qty');
  await page.keyboard.type('2e');
  await dlgSubmit();
  await dlgError('ช่อง "จำนวนที่ปล่อย (ชิ้น)" อ่านเป็นตัวเลขไม่ได้');
  await page.click('#dlg .dlg-f .btn-ghost');
  await dlgClosed();
  assert(await state((s, R, x) => s.tables.inspections[x].status === 'OPEN' && !s.tables.inspections[x].releasedQty, inspId), 'ปล่อยผ่านไปแล้วทั้งที่จำนวนอ่านไม่ได้');
  await page.click('#ins-void-btn');
  await dlgOpen();
  await dlgSubmit();
  await dlgError('เหตุผล');
  await page.fill('#void-reason', 'บันทึกผิดชิ้น');
  await dlgSubmit();
  await dlgClosed();
  await waitState((s, R, x) => s.tables.inspections[x].status === 'VOID' && s.tables.inspections[x].voidReason === 'บันทึกผิดชิ้น', inspId, 'ผลตรวจเป็นโมฆะ');
  assert(await state((s, R) => R.q.qty(s, { code: 'RO-PART', wh: 'ROW', bin: 'RO-1', status: 'QC_HOLD' }) === 5), 'ของไม่ได้อยู่รอตรวจ');
});

await step('QC: retire a plan without a replacement', async () => {
  await asUser('ROQL');
  await page.evaluate((x) => { window.RRS.app.views['qc-plans'] = { tab: 'all', sel: x }; }, planId);
  await reopen('qc-plans');
  await page.click('#plan-obsolete-btn');
  await dlgOpen();
  await page.fill('#plan-obsolete-reason', 'เลิกตรวจรับชิ้นนี้');
  await dlgSubmit();
  await dlgClosed();
  await waitState((s, R, x) => s.tables.qc_plans[x].status === 'OBSOLETE', planId, 'แผนเลิกใช้');
  await waitText('เลิกตรวจรับชิ้นนี้');
});

await step('home links open the right tab', async () => {
  const p = await must('qc.plan.save', { code: 'RO-PART', stage: 'INCOMING', drawingRev: 'A', sourceRef: 'WI-RO-2', chars: [{ name: 'ผิว', kind: 'check' }] }, 'ROEN');
  await asUser('ROQL');
  await go('home');
  await page.click('#main a[data-go="qc-plans"]:text("อนุมัติแผนตรวจ")');
  await page.waitForSelector('.page[data-page="qc-plans"]');
  await page.waitForSelector('#main .tabs button.on[data-arg="DRAFT"]');
  await must('qc.plan.approve', { id: p.result.id }, 'ROQL').catch(() => {}); // ROQL approves another person's draft (ROEN)
});

await step('phone width', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await asUser('ROM1');
  await go('rollout');
  await noOverflow('rollout issues phone');
  await tab('plans');
  await noOverflow('rollout plans phone');
  await go('reports');
  await noOverflow('reports phone (11 tabs)');
  const wraps = await page.evaluate(() => { const b = document.querySelector('#main .tabs'); return b && getComputedStyle(b).flexWrap === 'wrap'; });
  assert(wraps, 'แท็บไม่ขึ้นบรรทัดใหม่บนจอโทรศัพท์');
  await shot('phone-rollout');
  await page.setViewportSize({ width: 1366, height: 900 });
});

await browser.close();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* temp only */ }
if (problems.length) {
  console.log('PROBLEMS\n' + problems.join('\n'));
  process.exit(1);
}
console.log('p6-rollout ok');
