// Browser test of the Phase 0 screens (home, setup, warehouses, BOMs, users, dictionary, audit) in demo mode.
//   RRS_OUT=/tmp/stockqc-p0 node tests/e2e/p0.mjs [--shots dir]
// Starts from a clean page, creates the data it needs through the UI (or the ledger for setup), switches the acting
// user with #who-sel, and checks what people see after each step. Codes start with P0 so sample data cannot clash.
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

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
const problems = [];
page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|cdnjs|ERR_|net::/.test(m.text())) problems.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
// screens must never open alert/confirm/prompt (and an injected alert would land here too)
page.on('dialog', async (d) => { problems.push(`native dialog: ${d.message()}`); await d.dismiss().catch(() => {}); });
const XSS = '<img src=x onerror="window.__xss=1">';
/** No markup from user text got into the page, and no injected handler ran. */
async function noInjection(where) {
  const r = await page.evaluate(() => ({ img: document.querySelectorAll('#main img, #dlg img, #top img, #nav img').length, ran: !!window.__xss }));
  if (r.img || r.ran) throw new Error(`[${step}] user text became HTML on ${where} (img ${r.img}, handler ran ${r.ran})`);
}
/** A checkbox squeezed by a long label/hint shrinks to a dot – it must keep its normal size. */
const boxWidth = (sel) => page.$eval(sel, (el) => el.getBoundingClientRect().width);

let step = '';
const log = (s) => { step = s; console.log('· ' + s); };
async function waitFor(fn, arg, what, timeout = 10000) {
  try {
    await page.waitForFunction(fn, arg, { timeout });
  } catch (e) {
    throw new Error(`[${step}] timed out waiting for: ${what}`);
  }
}
const hasText = (sel, text, timeout) => waitFor(([s, x]) => Array.from(document.querySelectorAll(s)).some((e) => e.innerText.indexOf(x) >= 0), [sel, text], `"${text}" in ${sel}`, timeout);
const noText = async (sel, text) => {
  const found = await page.evaluate(([s, x]) => Array.from(document.querySelectorAll(s)).some((e) => e.innerText.indexOf(x) >= 0), [sel, text]);
  if (found) throw new Error(`[${step}] did not expect "${text}" in ${sel}`);
};
const count = (sel) => page.locator(sel).count();
const expect = (cond, msg) => { if (!cond) throw new Error(`[${step}] ${msg}`); };
const clearToasts = () => page.evaluate(() => { document.querySelector('#toasts').innerHTML = ''; });
const toast = (text) => hasText('#toasts .toast', text);
const btn = (text, scope = '#main') => page.locator(`${scope} button`, { hasText: text }).first();
async function click(text, scope) {
  await clearToasts();
  await btn(text, scope).click();
}
async function submit(form) {
  await clearToasts();
  await page.click(`#main form[data-form="${form}"] button[type=submit]`);
}
async function nav(id) {
  await page.click(`#nav a[data-go="${id}"]`);
  await page.waitForSelector(`.page[data-page="${id}"]`, { timeout: 10000 });
}
const dlgOpen = () => page.waitForSelector('#dlg:not([hidden]) .dlg-card', { timeout: 10000 });
async function dlgSubmit() {
  await clearToasts();
  await page.click('#dlg button[type=submit]');
}
const dlgClosed = () => waitFor(() => document.querySelector('#dlg').hidden, null, 'dialog to close');
async function asUser(id) {
  await page.selectOption('#who-sel', id);
  await waitFor((x) => document.querySelector('#who-sel') && document.querySelector('#who-sel').value === x && window.RRS.app.ledger, id, `acting user ${id}`);
}
/** Run a command directly on the page's ledger (setup only). */
async function run(kind, payload, ctx) {
  const r = await page.evaluate(async ([k, p, c]) => window.RRS.app.ledger.execute({ kind: k, payload: p }, c), [kind, payload, ctx || { user: 'ADMIN' }]);
  if (!r.ok) throw new Error(`[${step}] setup ${kind} failed: ${JSON.stringify(r.errors)}`);
  return r;
}
const state = (expr) => page.evaluate((e) => new Function('s', `return (${e});`)(window.RRS.app.ledger.state), expr);
const shot = async (name) => { if (shots) await page.screenshot({ path: path.join(shots, `p0-${name}.png`), fullPage: true }); };

try {
  log('clean start');
  await page.goto(file);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await waitFor(() => window.RRS && window.RRS.app && window.RRS.app.loading === false && window.RRS.app.ledger, null, 'app loaded', 60000);
  await page.waitForSelector('.page[data-page="home"]');

  // ---------------------------------------------------------------------------------------------- home (start)
  log('home: tiles, my work, phase strip');
  expect((await count('#main .kpi')) >= 7, 'home shows at least 7 KPI tiles');
  await hasText('#main .sec h2', 'งานที่รอคุณ');
  await hasText('#main .sec h2', 'ความคืบหน้า Phase 0–6');
  for (const p of [0, 1, 2, 3, 4, 5, 6]) await hasText('#main .step-n', `PHASE ${p}`);
  const openDecisions = await state("11 - Object.values(s.tables.decisions || {}).filter((d) => d.status === 'decided').length");
  if (openDecisions > 0) await hasText('#main .tbl', 'ข้อตกลง Phase 0 ที่ยังไม่ตัดสิน');
  await shot('home-start');

  // ---------------------------------------------------------------------------------------------- setup
  log('setup: scope');
  await nav('setup');
  await hasText('#main .tab.on', 'ขอบเขตทดลอง');
  await page.fill('#main input[name=company]', 'บริษัททดสอบ P0');
  await page.fill('#main input[name=cutoffAt]', '2026-11-01T08:00');
  await page.fill('#main input[name=moreGroups]', 'ฝาข้าง P0, พื้นกระบะ P0');
  await page.fill('#main textarea[name=note]', 'ทดลองกลุ่มฝาข้างในคลัง P0 หนึ่งเดือน');
  await click('บันทึกขอบเขต');
  await toast('บันทึกขอบเขตทดลองแล้ว');
  await hasText('#main .dl', 'ฝาข้าง P0, พื้นกระบะ P0');
  await hasText('#main .dl', '01/11/2569 08:00');
  expect(await state("s.tables.settings.main.cutoffAt === '2026-11-01T01:00:00.000Z'"), 'cutoff stored as Bangkok 08:00 = 01:00 UTC');

  log('setup: data ownership');
  await page.click('#main .tab:has-text("เจ้าของข้อมูล")');
  await page.check('#main input[type=radio][name=qty][value=Express]');
  await click('บันทึกเจ้าของข้อมูล');
  await toast('บันทึกเจ้าของข้อมูลแล้ว');
  expect(await state("s.tables.settings.main.ownership.qty === 'Express' && s.tables.settings.main.ownership.cost === 'Express'"), 'qty owned by Express, cost unchanged');
  expect(await page.isChecked('#main input[type=radio][name=qty][value=Express]'), 'Express stays selected after saving');
  await hasText('#main .sec', 'การปรับยอดมาจาก Express');

  log('setup: policies (and a wrong number)');
  await page.click('#main .tab:has-text("นโยบาย")');
  await page.selectOption('#main select[name=negativeStock]', 'approve');
  await page.fill('#main input[name=overReceivePct]', '5');
  await page.fill('#main input[name=recountQty]', '');
  await click('บันทึกนโยบาย');
  await toast('ต้องเป็นตัวเลข');
  expect(await state("s.tables.settings.main.policies.negativeStock === 'block'"), 'nothing saved while a number is missing');
  const seqBefore = await state('s.seq');
  await page.fill('#main input[name=recountQty]', '-3');
  await click('บันทึกนโยบาย');
  await toast('ช่อง "ผลต่างเกิน (หน่วย)" ต้องเป็นตัวเลข 0 ขึ้นไป');
  expect((await state('s.seq')) === seqBefore, 'a negative number is refused and nothing saved');
  expect((await boxWidth('#main input[name=sod]')) >= 12, 'the separation-of-duties checkbox keeps its size next to its hint');
  expect((await boxWidth('#main input[name=lateIsUncertain]')) >= 12, 'the late-PO checkbox keeps its size next to its hint');
  await page.fill('#main input[name=recountQty]', '2');
  await click('บันทึกนโยบาย');
  await toast('บันทึกนโยบายแล้ว');
  expect(await state("s.tables.settings.main.policies.negativeStock === 'approve' && s.tables.settings.main.policies.overReceivePct === 5 && s.tables.settings.main.policies.recountQty === 2"), 'policies stored');

  log('setup: decisions (record, reopen, record)');
  await page.click('#main .tab:has-text("ข้อตกลง")');
  const decidedNow = () => state("Object.values(s.tables.decisions || {}).filter((d) => d.status === 'decided').length");
  await page.click('#main [data-act=decide][data-arg=Q02]');
  await dlgOpen();
  await page.fill('#dlg textarea[name=answer]', '');
  await page.fill('#dlg input[name=decidedBy]', 'ผู้จัดการโรงงาน');
  await dlgSubmit();
  await hasText('#dlg-err', 'กรอกข้อสรุป');
  await page.click('#dlg button:has-text("ใช้ข้อเสนอนี้เป็นข้อสรุป")');
  expect((await page.inputValue('#dlg textarea[name=answer]')).indexOf('Cloudflare') >= 0, 'proposal copied into the answer');
  await dlgSubmit();
  await toast('บันทึกข้อสรุป ค-2 แล้ว');
  await dlgClosed();
  await hasText('#main .sec', 'ตัดสินโดย ผู้จัดการโรงงาน');
  expect(await state("s.tables.decisions.Q02.status === 'decided' && s.tables.decisions.Q02.recordedBy === 'ADMIN'"), 'ค-2 decided by the acting user');
  const withQ02 = await decidedNow();
  await hasText('#main .kpi', `${withQ02}/11`);
  await clearToasts();
  await page.click('#main [data-act=reopen][data-arg=Q02]');
  await dlgOpen();
  await dlgSubmit();
  await toast('ค-2 กลับเป็นรอตัดสินแล้ว');
  expect((await decidedNow()) === withQ02 - 1, 'reopen takes ค-2 back to open');
  await page.click('#main [data-act=decide][data-arg=Q02]');
  await dlgOpen();
  await page.fill('#dlg textarea[name=answer]', 'เว็บบน Cloudflare ผู้ใช้ 10–20 คน เก็บลง Google Sheet ใน Google Drive');
  await page.fill('#dlg input[name=decidedBy]', 'เจ้าของโครงการ');
  await page.fill('#dlg input[name=decidedOn]', '2026-11-02');
  await dlgSubmit();
  await toast('บันทึกข้อสรุป ค-2 แล้ว');
  await dlgClosed();
  const after = await decidedNow();
  await hasText('#main .sec', 'ตัดสินโดย เจ้าของโครงการ · 02/11/2569');
  await page.click('#main .tab:has-text("ยังไม่ตัดสิน")');
  await noText('#main .sec h2', 'ค-2 ');
  await page.click('#main .tab:has-text("ตัดสินแล้ว")');
  await hasText('#main .sec h2', 'ค-2 ');

  log('setup: KPIs');
  await page.click('#main .tab:has-text("ตัวชี้วัดตั้งต้น")');
  await page.click('#main [data-act=kpi][data-arg=count_accuracy]');
  await dlgOpen();
  await page.fill('#dlg input[name=baseline]', '92.5');
  await page.fill('#dlg input[name=target]', '99');
  await page.fill('#dlg textarea[name=note]', 'สุ่มนับ 50 รายการ');
  await dlgSubmit();
  await toast('บันทึกตัวชี้วัดแล้ว');
  await dlgClosed();
  await hasText('#main .tbl', '92.5');
  await page.click('#main button:has-text("+ เพิ่มตัวชี้วัด")');
  await dlgOpen();
  await page.fill('#dlg input[name=label]', 'เวลาค้นหาของเฉลี่ย P0');
  await page.fill('#dlg input[name=unit]', 'นาที');
  await page.fill('#dlg input[name=baseline]', '12');
  await dlgSubmit();
  await dlgClosed();
  await hasText('#main .tbl', 'เวลาค้นหาของเฉลี่ย P0');
  log('setup: KPI without a name is refused, a KPI not measured yet has no measured date');
  const kpiId = await state("Object.values(s.tables.kpis).find((k) => k.label === 'เวลาค้นหาของเฉลี่ย P0').id");
  await page.click(`#main [data-act=kpi][data-arg="${kpiId}"]`);
  await dlgOpen();
  await page.fill('#dlg input[name=label]', '');
  await page.fill('#dlg input[name=target]', '5');
  await dlgSubmit();
  await hasText('#dlg-err', 'กรอกชื่อตัวชี้วัด');
  expect(await state(`s.tables.kpis['${kpiId}'].label === 'เวลาค้นหาของเฉลี่ย P0' && s.tables.kpis['${kpiId}'].target == null`), 'nothing saved while the name is empty');
  await page.click('#dlg .dlg-f .btn-ghost');
  await dlgClosed();
  await page.click('#main button:has-text("+ เพิ่มตัวชี้วัด")');
  await dlgOpen();
  await page.fill('#dlg input[name=label]', 'เป้าเวลาจ่ายของ P0');
  await page.fill('#dlg input[name=target]', '15');
  await dlgSubmit();
  await toast('บันทึกตัวชี้วัดแล้ว');
  await dlgClosed();
  expect(await state("(() => { const k = Object.values(s.tables.kpis).find((x) => x.label === 'เป้าเวลาจ่ายของ P0'); return k && k.target === 15 && k.baseline == null && k.measuredOn === ''; })()"), 'target saved; no baseline -> no measured date');
  await hasText('#main .tbl', 'ยังไม่วัด');
  await shot('setup-kpis');

  // ---------------------------------------------------------------------------------------------- warehouses
  log('warehouses: add a warehouse');
  await nav('warehouses');
  await page.locator('#main [data-act=new]').first().click();
  await page.fill('#main input[name=code]', 'p0wh');
  await page.fill('#main input[name=name]', 'คลังทดสอบ P0');
  await page.fill('#main input[name=expressCode]', 'EX-P0');
  await page.check('#main input[name=requireBin]');
  await submit('saveWh');
  await toast('เพิ่มคลัง P0WH แล้ว');
  await hasText('#main .tbl', 'คลังทดสอบ P0');
  await hasText('#main .sec h2', 'P0WH');
  await hasText('#main .sec h2', 'ช่องเก็บ (0)');
  expect((await boxWidth('#main input[name=requireBin]')) >= 12, 'the require-bin checkbox keeps its size next to its hint');

  log('warehouses: "add" with a code that exists is refused (no silent overwrite)');
  await page.locator('#main .tb-r [data-act=new]').click();
  await page.fill('#main input[name=code]', 'p0wh');
  await page.fill('#main input[name=name]', 'ทับคลังเดิม');
  await submit('saveWh');
  await toast('คลัง P0WH มีอยู่แล้ว (คลังทดสอบ P0)');
  expect(await state("s.tables.warehouses.P0WH.name === 'คลังทดสอบ P0' && s.tables.warehouses.P0WH.expressCode === 'EX-P0'"), 'existing warehouse unchanged');
  await page.click('#main [data-act=close]');
  await page.click('#main tr[data-arg="P0WH"]');
  await hasText('#main .sec h2', 'ช่องเก็บ (0)');

  log('warehouses: bins one by one, duplicates refused');
  await page.fill('#main form[data-form=addBin] input[name=code]', 'A 09');
  await click('เพิ่มช่องเก็บ');
  await toast('ไม่มีเว้นวรรค');
  expect(await state("!(s.tables.bins || {})['P0WH|A 09']"), 'a bin code with a space is refused');
  await page.fill('#main form[data-form=addBin] input[name=code]', 'a-01');
  await page.fill('#main form[data-form=addBin] input[name=name]', 'ชั้น 1');
  await click('เพิ่มช่องเก็บ');
  await toast('เพิ่มช่อง A-01 แล้ว');
  await page.fill('#main form[data-form=addBin] input[name=code]', 'A-01');
  await click('เพิ่มช่องเก็บ');
  await toast('มีอยู่แล้ว');

  log('warehouses: paste several bins');
  await click('วางหลายช่อง');
  await dlgOpen();
  await page.fill('#dlg textarea[name=text]', 'A-02 ชั้น 2\nA-03 ชั้น 3\nA-02 ซ้ำ');
  await dlgSubmit();
  await hasText('#dlg-err', 'ซ้ำกับแถว 1');
  await page.fill('#dlg textarea[name=text]', 'ช่องเก็บ,คำอธิบาย\n,ลืมใส่รหัส\nA-02,ชั้น 2');
  await dlgSubmit();
  await hasText('#dlg-err', 'แถว 2: ไม่มีรหัสช่องเก็บ');
  expect(await state("Object.values(s.tables.bins).filter((b) => b.wh === 'P0WH').length === 1"), 'a row without a code stops the whole paste');
  await page.fill('#dlg textarea[name=text]', 'ช่องเก็บ,คำอธิบาย\nA-02,"ชั้น 2, ฝั่งซ้าย"\nA-03,ชั้น 3');
  await dlgSubmit();
  await toast('เพิ่มช่องเก็บ 2 ช่อง');
  await dlgClosed();
  await hasText('#main .sec h2', 'ช่องเก็บ (3)');
  await hasText('#main .tbl', 'ชั้น 2, ฝั่งซ้าย');
  const tags = await page.$$eval('#main .tag', (els) => els.map((e) => e.textContent.trim()));
  expect(tags.join(',') === 'A-01,A-02,A-03', `stock tags A-01..A-03 (got ${tags})`);

  log('warehouses: deactivate a bin');
  await clearToasts();
  await page.click('#main [data-act=binOff][data-arg=A-03]');
  await dlgOpen();
  await dlgSubmit();
  await toast('ปิดใช้งานช่อง A-03 แล้ว');
  await hasText('#main .sec h2', 'ช่องเก็บ (2)');
  expect((await count('#main .tag')) === 2, 'inactive bin has no tag');
  await page.click('#main button:has-text("แสดงช่องที่ปิดใช้งาน")');
  await hasText('#main .tbl .badge', 'ปิดใช้งาน');
  await shot('warehouses');

  // ---------------------------------------------------------------------------------------------- users
  log('users: add users, missing role refused');
  await nav('users');
  await page.click('#main [data-act=new]');
  await page.fill('#main input[name=id]', 'STORE-P0');
  await page.fill('#main input[name=name]', 'สโตร์ทดสอบ P0');
  await submit('saveUser');
  await toast('เลือกอย่างน้อย 1 บทบาท');
  await page.check('#main input[name="roles[]"][value=store]');
  await page.check('#main input[name="warehouses[]"][value=P0WH]');
  await submit('saveUser');
  await toast('บันทึกผู้ใช้ สโตร์ทดสอบ P0 แล้ว');
  await hasText('#main .tbl', 'สโตร์ทดสอบ P0');
  await hasText('#main .sec', 'บันทึกเอกสาร (เปลี่ยนยอด)');
  await hasText('#main .sec', 'เฉพาะคลัง P0WH');
  await page.click('#main [data-act=new]');
  await page.fill('#main input[name=id]', 'ENG-P0');
  await page.fill('#main input[name=name]', 'วิศวกรทดสอบ P0');
  await page.check('#main input[name="roles[]"][value=engineering]');
  await submit('saveUser');
  await toast('บันทึกผู้ใช้ วิศวกรทดสอบ P0 แล้ว');

  log('users: "add" with an id that exists is refused; ids have no spaces; names stay text');
  await page.click('#main .tb-r [data-act=new]');
  await page.fill('#main input[name=id]', 'admin');
  await page.fill('#main input[name=name]', 'ทับผู้ดูแล');
  await page.check('#main input[name="roles[]"][value=viewer]');
  await submit('saveUser');
  await toast('รหัสผู้ใช้ ADMIN มีอยู่แล้ว');
  expect(await state("s.tables.users.ADMIN.name !== 'ทับผู้ดูแล' && s.tables.users.ADMIN.roles.indexOf('admin') >= 0"), 'the admin user was not overwritten');
  await page.fill('#main input[name=id]', 'VIEW P0');
  await submit('saveUser');
  await toast('ไม่มีเว้นวรรค');
  await page.fill('#main input[name=id]', 'VIEW-P0');
  await page.fill('#main input[name=name]', `ผู้ดู P0 ${XSS}`);
  await submit('saveUser');
  await toast('บันทึกผู้ใช้ ผู้ดู P0');
  await hasText('#main .tbl', 'ผู้ดู P0 <img');
  await noInjection('users');

  log('users: access request -> add as user');
  await run('user.requestAccess', { name: 'สมหญิง ขอใช้ P0', note: 'QC ตรวจรับ' }, { via: 'acct-p0-123' });
  await page.click('#main .tab:has-text("คำขอใช้งาน")');
  await hasText('#main .tbl', 'สมหญิง ขอใช้ P0');
  await page.click('#main [data-act=grant][data-arg="acct-p0-123"]');
  await hasText('#main .sec h2', 'เพิ่มผู้ใช้จากคำขอของ สมหญิง ขอใช้ P0');
  expect((await page.inputValue('#main input[name=accountId]')) === 'acct-p0-123', 'account prefilled');
  expect((await page.inputValue('#main input[name=name]')) === 'สมหญิง ขอใช้ P0', 'name prefilled');
  await page.fill('#main input[name=id]', 'QC-P0');
  await page.check('#main input[name="roles[]"][value=qc]');
  await submit('saveUser');
  await toast('บันทึกผู้ใช้ สมหญิง ขอใช้ P0 แล้ว');
  expect(await state("s.tables.access_requests['acct-p0-123'].status === 'DONE' && s.tables.users['QC-P0'].accountId === 'acct-p0-123'"), 'request done and account linked');
  await page.click('#main .tab:has-text("คำขอใช้งาน")');
  await hasText('#main .tbl', 'เพิ่มแล้ว');

  log('users: role × permission matrix');
  await page.click('#main .tab:has-text("สิทธิ์ตามบทบาท")');
  await hasText('#main .tbl', 'บันทึกเอกสาร (เปลี่ยนยอด)');
  await hasText('#main .tbl', 'สโตร์ทดสอบ P0');
  const colsAll = await count('#main .tbl thead th');
  await page.check('#mx-used');
  await waitFor((n) => document.querySelectorAll('#main .tbl thead th').length < n, colsAll, 'fewer role columns');
  const groupCells = await page.$$eval('#main .tbl tbody tr td:first-child', (tds) => tds.map((td) => td.innerText.trim()));
  expect(groupCells[0] === 'ระบบ' && groupCells[1] === '' && groupCells.filter(Boolean).length <= 9, `group name only on the first row of each group (got ${groupCells.slice(0, 3)})`);
  await shot('users-matrix');

  // ---------------------------------------------------------------------------------------------- BOMs
  log('boms: items for the BOM (setup through the ledger)');
  await run('master.import', {
    items: [
      { code: 'P0-FG', name: 'กระบะทดสอบ P0', baseUnit: 'ชุด', type: 'FG', group: 'ฝาข้าง P0' },
      { code: 'P0-PART1', name: 'ฝาข้างซ้าย P0', baseUnit: 'ชิ้น', type: 'PART', group: 'ฝาข้าง P0' },
      { code: 'P0-PART2', name: 'สกรู P0', baseUnit: 'ชิ้น', type: 'BUY' },
    ],
    units: [{ code: 'P0-PART2', unit: 'โหล', factor: 12 }],
  });
  await nav('boms');
  await page.locator('#main [data-act=new]').first().click();
  await page.fill('#main input[name=product]', 'P0-FG');
  await page.fill('#main input[name=rev]', 'a');
  await page.fill('#main input[name=drawingNo]', 'DWG-P0');
  await page.fill('#main input[name="lines[0][code]"]', 'P0-PART1');
  await page.fill('#main input[name="lines[0][qty]"]', '2');
  await page.click('#main button:has-text("+ เพิ่มบรรทัด")');
  await page.waitForSelector('#main input[name="lines[1][code]"]');
  expect((await page.inputValue('#main input[name=product]')) === 'P0-FG', 'header kept after adding a line');
  expect((await page.inputValue('#main input[name="lines[0][qty]"]')) === '2', 'first line kept after adding a line');
  await page.fill('#main input[name="lines[1][code]"]', 'NOPE-P0');
  await page.fill('#main input[name="lines[1][qty]"]', '1');
  await page.click('#main button:has-text("ตรวจก่อนบันทึก")');
  await hasText('#main .note', 'ไม่พบสินค้า NOPE-P0');
  await page.fill('#main input[name="lines[1][code]"]', '');
  await page.click('#main button:has-text("ตรวจก่อนบันทึก")');
  await hasText('#main .note', 'บรรทัด 2: ใส่รหัสชิ้นส่วน');
  await page.fill('#main input[name="lines[1][code]"]', 'P0-PART2');
  await page.fill('#main input[name="lines[1][unit]"]', 'โหล');
  await page.click('#main button:has-text("ตรวจก่อนบันทึก")');
  await hasText('#main .note', 'ตรวจแล้ว: บันทึกได้ทุกบรรทัด');
  await click('บันทึกเป็นร่าง');
  await toast('บันทึกร่าง BOM แล้ว');
  await hasText('#main .sec h2', 'ฉบับ A');
  await hasText('#main .sec-s', 'ร่าง – รออนุมัติ');
  expect((await page.inputValue('#main input[name="lines[1][qty]"]')) === '12', '1 โหล stored as 12 ชิ้น');

  log('boms: a new BOM with a product + revision that exists is refused (the draft is not overwritten)');
  await page.locator('#main .tb-r [data-act=new]').click();
  await page.fill('#main input[name=product]', 'P0-FG');
  await page.fill('#main input[name=rev]', 'A');
  await page.fill('#main input[name="lines[0][code]"]', 'P0-PART1');
  await page.fill('#main input[name="lines[0][qty]"]', '9');
  await click('บันทึกเป็นร่าง');
  await hasText('#main .note', 'P0-FG ฉบับ A มีอยู่แล้ว');
  await hasText('#main .note', 'ใช้ฉบับ B');
  expect(await state("s.tables.boms['P0-FG|A'].lines[0].qty === 2 && s.tables.boms['P0-FG|A'].lines.length === 2"), 'draft A unchanged');
  await page.click('#main [data-act=close]');

  log('boms: store sees a read-only BOM');
  await asUser('STORE-P0');
  await nav('boms');
  await page.click('#main tr[data-arg="P0-FG|A"]');
  await hasText('#main .sec h2', 'ฉบับ A');
  expect((await count('#main form[data-form=bom]')) === 0, 'no BOM editor for the store');
  expect((await count('#main [data-act=approve]')) === 0, 'no approve button for the store');
  expect((await count('#main [data-act=new]')) === 0, 'no new BOM button for the store');

  log('boms: engineering cancels an approval – nothing is saved');
  await asUser('ENG-P0');
  await page.click('#main tr[data-arg="P0-FG|A"]');
  await page.fill('#main input[name="lines[0][qty]"]', '7');
  await click('อนุมัติฉบับนี้');
  await dlgOpen();
  await hasText('#dlg', '2 บรรทัด ตามที่แสดงอยู่');
  await page.click('#dlg .dlg-f .btn-ghost');
  await dlgClosed();
  expect(await state("s.tables.boms['P0-FG|A'].status === 'DRAFT' && s.tables.boms['P0-FG|A'].lines[0].qty === 2"), 'cancelled approval saved nothing');

  log('boms: engineering approves A');
  await page.fill('#main input[name="lines[0][qty]"]', '2');
  await click('อนุมัติฉบับนี้');
  await dlgOpen();
  await hasText('#dlg', 'จาก (ว่าง) เป็น A');
  await dlgSubmit();
  await toast('อนุมัติ P0-FG ฉบับ A แล้ว');
  await hasText('#main .sec-s', 'อนุมัติแล้ว (ใช้อยู่)');
  await hasText('#main .sec-s', 'ทะเบียนสินค้าใช้ฉบับแบบ A');
  expect(await state("s.tables.items['P0-FG'].drawingRev === 'A' && s.tables.items['P0-FG'].drawingNo === 'DWG-P0'"), 'item drawing revision set');

  log('boms: new revision B from A, approve -> A obsolete');
  await page.click('#main button:has-text("สร้างฉบับใหม่จากฉบับนี้")');
  expect((await page.inputValue('#main input[name=rev]')) === 'B', 'next revision suggested');
  expect((await page.inputValue('#main input[name="lines[1][code]"]')) === 'P0-PART2', 'lines copied');
  await page.fill('#main input[name="lines[0][qty]"]', '3');
  await click('บันทึกเป็นร่าง');
  await toast('บันทึกร่าง BOM แล้ว');
  await click('อนุมัติฉบับนี้');
  await dlgOpen();
  await hasText('#dlg', 'ฉบับที่ใช้อยู่ (A) จะเป็น เลิกใช้');
  await dlgSubmit();
  await toast('อนุมัติ P0-FG ฉบับ B แล้ว');
  expect(await state("s.tables.boms['P0-FG|A'].status === 'OBSOLETE' && s.tables.boms['P0-FG|B'].status === 'APPROVED' && s.tables.items['P0-FG'].drawingRev === 'B'"), 'A obsolete, B approved');
  await hasText('#main tr[data-arg="P0-FG|A"]', 'เลิกใช้');
  await shot('boms');

  // ---------------------------------------------------------------------------------------------- read-only setup + home for the store
  log('store: setup and users are read-only');
  await asUser('STORE-P0');
  await nav('setup');
  await page.click('#main .tab:has-text("ขอบเขตทดลอง")');
  await hasText('#main .note', 'ดูอย่างเดียว');
  expect((await count('#main form[data-form=scope]')) === 0, 'no scope form for the store');
  await hasText('#main .dl', 'ฝาข้าง P0, พื้นกระบะ P0');
  await page.click('#main .tab:has-text("ข้อตกลง")');
  expect((await count('#main [data-act=decide]')) === 0, 'no decision buttons for the store');
  await nav('users');
  await page.click('#main .tab:has-text("ผู้ใช้")');
  await hasText('#main .note', 'ดูอย่างเดียว');
  expect((await count('#main [data-act=new]')) === 0, 'no add-user button for the store');

  log('store: home lists the store\'s own draft');
  await run('doc.saveDraft', { type: 'PD', lines: [] }, { user: 'STORE-P0' });
  await nav('home');
  await hasText('#main .tbl', 'ร่างเอกสารของคุณ');
  await noText('#main .tbl', 'ข้อตกลง Phase 0 ที่ยังไม่ตัดสิน');
  await page.click('#main a:has-text("ร่างเอกสารของคุณ")');
  await page.waitForSelector('.page[data-page="docs"]');
  await hasText('#main .tab.on', 'ร่าง');

  log('viewer: every Phase 0 screen is read-only, nothing to do on home');
  await asUser('VIEW-P0');
  await nav('home');
  await hasText('#main .empty', 'ไม่มีงานค้างสำหรับบทบาทของคุณ');
  await nav('setup');
  for (const tab of ['ขอบเขตทดลอง', 'เจ้าของข้อมูล', 'นโยบาย', 'ข้อตกลง', 'ตัวชี้วัดตั้งต้น']) {
    await page.click(`#main .tab:has-text("${tab}")`);
    await hasText('#main .tab.on', tab);
    expect((await count('#main form, #main input[type=radio], #main [data-act=decide], #main [data-act=kpi]')) === 0, `setup/${tab}: nothing editable for a viewer`);
    await hasText('#main .note', 'ดูอย่างเดียว');
  }
  await nav('warehouses');
  await page.click('#main tr[data-arg="P0WH"]');
  await hasText('#main .sec h2', 'P0WH');
  expect((await count('#main form, #main [data-act=new], #main [data-act=binOff], #main [data-act=editBin], #main [data-act=bulk]')) === 0, 'warehouses: nothing editable for a viewer');
  await nav('boms');
  await page.click('#main tr[data-arg="P0-FG|B"]');
  expect((await count('#main form, #main [data-act=new], #main [data-act=approve], #main [data-act=copy]')) === 0, 'boms: nothing editable for a viewer');
  await nav('users');
  await page.click('#main .tab:has-text("ผู้ใช้")');
  await page.click('#main tr[data-arg="STORE-P0"]');
  await hasText('#main .sec', 'สิ่งที่ผู้ใช้นี้ทำได้');
  expect((await count('#main form, #main [data-act=new]')) === 0, 'users: nothing editable for a viewer');
  await nav('dictionary');
  await page.click('#main [data-act=dataCsv][data-arg=users]');
  await dlgOpen();
  const usersCsv = await page.inputValue('#dlg textarea');
  expect(usersCsv.indexOf('acct-p0-123') < 0 && usersCsv.indexOf('(ซ่อน)') >= 0, 'sign-in accounts hidden from a viewer in the data CSV');
  await page.click('#dlg button[type=submit]');
  await dlgClosed();
  await noInjection('viewer screens');

  // ---------------------------------------------------------------------------------------------- stock in a bin
  log('warehouses: a bin with stock cannot be closed');
  await asUser('ADMIN');
  const aj = await run('doc.saveDraft', { type: 'AJ', lines: [{ code: 'P0-PART1', qty: 5, wh: 'P0WH', bin: 'A-01' }] });
  await run('doc.post', { docNo: aj.result.docNo });
  await nav('warehouses');
  await page.click('#main tr[data-arg="P0WH"]');
  await clearToasts();
  await page.click('#main [data-act=binOff][data-arg=A-01]');
  await toast('ยังมีของ');
  expect(await state("s.tables.bins['P0WH|A-01'].active !== false"), 'bin with stock stays active');

  log('home: numbers after the work');
  await nav('home');
  await hasText('#main .kpi', 'ตำแหน่งที่มีของ');
  expect(await page.evaluate(() => Number(Array.from(document.querySelectorAll('#main .kpi')).find((k) => k.innerText.indexOf('ตำแหน่งที่มีของ') >= 0).querySelector('.kpi-v').innerText.replace(/,/g, '')) >= 1), 'stock locations ≥ 1');
  await hasText('#main .tbl', 'บันทึกเลขที่ Express');
  await hasText('#main .step', `ข้อตกลง ${after}/11`);
  await shot('home-after');

  // ---------------------------------------------------------------------------------------------- dictionary
  log('dictionary: tables and downloads');
  await nav('dictionary');
  await hasText('#main .sec h2', 'ทะเบียนสินค้า');
  await click('โครงสร้างทุกแท็บ (JSON)');
  await dlgOpen();
  const layout = JSON.parse(await page.inputValue('#dlg textarea'));
  expect(Array.isArray(layout.items) && layout.items.indexOf('drawingRev') >= 0 && layout.warehouses.indexOf('expressCode') >= 0, 'layout JSON has a header list per tab');
  expect(Object.keys(layout).length === (await page.evaluate(() => Object.keys(window.RRS.schema.tables).length)), 'one tab per table');
  await page.click('#dlg button[type=submit]');
  await dlgClosed();
  await page.selectOption('#dict-data', 'warehouses');
  await click('ดาวน์โหลดข้อมูล (CSV)');
  await dlgOpen();
  const csv = await page.inputValue('#dlg textarea');
  expect(csv.indexOf('code,name,expressCode,requireBin,active') >= 0 && csv.indexOf('P0WH,คลังทดสอบ P0,EX-P0,true,true') >= 0, 'warehouse data as CSV');
  await page.click('#dlg button[type=submit]');
  await dlgClosed();
  await page.click('#main [data-act=dataCsv][data-arg=boms]');
  await dlgOpen();
  expect((await page.inputValue('#dlg textarea')).indexOf('""code"":""P0-PART1""') >= 0, 'JSON field stringified inside the CSV');
  await page.click('#dlg button[type=submit]');
  await dlgClosed();
  await page.fill('#dict-q', 'drawingRev');
  await hasText('#main .note', 'ผลค้น');
  await hasText('#main .sec h2', 'ทะเบียนสินค้า');
  await shot('dictionary');

  // ---------------------------------------------------------------------------------------------- audit
  log('audit: filters and details');
  await nav('audit');
  expect((await count('#main .tbl tbody tr')) >= 10, 'audit rows listed');
  const firstSeq = await page.$eval('#main .tbl tbody tr td', (td) => Number(td.innerText.replace(/,/g, '')));
  expect(firstSeq === (await state('s.seq')), 'newest first');
  await page.selectOption('#aud-kind', 'warehouse.upsert');
  await hasText('#main .tbl', 'บันทึกคลัง P0WH');
  await page.selectOption('#aud-kind', '');
  await page.selectOption('#aud-by', 'ENG-P0');
  await waitFor(() => Array.from(document.querySelectorAll('#main .tbl tbody tr')).every((tr) => tr.innerText.indexOf('วิศวกรทดสอบ P0') >= 0), null, 'only ENG-P0 rows');
  await hasText('#main .tbl', 'อนุมัติ BOM P0-FG ฉบับ B');
  await page.click('#main .tbl tbody tr:has-text("อนุมัติ BOM P0-FG ฉบับ B")');
  await dlgOpen();
  await hasText('#dlg', 'ข้อมูลที่รายการนี้เปลี่ยน');
  await hasText('#dlg', 'ตรงกับข้อมูล');
  await hasText('#dlg .tbl', 'BOM / ฉบับแบบ');
  await page.click('#dlg button[type=submit]');
  await dlgClosed();
  await click('ล้างตัวกรอง');
  await page.fill('#aud-q', 'P0WH');
  await waitFor(() => Array.from(document.querySelectorAll('#main .tbl tbody tr')).length >= 2 && Array.from(document.querySelectorAll('#main .tbl tbody tr')).every((tr) => tr.innerText.indexOf('P0WH') >= 0), null, 'text filter');
  await click('ล้างตัวกรอง');

  log('audit: fingerprint check passes');
  await click('ตรวจลายนิ้วมือข้อมูล');
  await hasText('#main .note', 'ข้อมูลถูกต้อง');
  await toast('ตรวจแล้ว ข้อมูลถูกต้อง');

  // ---------------------------------------------------------------------------------------------- user text stays text
  log('user text stays text on every screen; CSV cells are not formulas');
  await nav('warehouses');
  await page.locator('#main .tb-r [data-act=new]').click();
  await page.fill('#main input[name=code]', 'P0X');
  await page.fill('#main input[name=name]', `คลัง ${XSS}`);
  await submit('saveWh');
  await toast('เพิ่มคลัง P0X แล้ว');
  for (const [code, name] of [['X-01', '=HYPERLINK("http://example.invalid","x")'], ['X-02', XSS]]) {
    await page.fill('#main form[data-form=addBin] input[name=code]', code);
    await page.fill('#main form[data-form=addBin] input[name=name]', name);
    await click('เพิ่มช่องเก็บ');
    await toast(`เพิ่มช่อง ${code} แล้ว`);
  }
  await hasText('#main .tbl', XSS);
  await click('ดาวน์โหลดรายการป้าย (CSV)');
  await dlgOpen();
  const tagCsv = await page.inputValue('#dlg textarea');
  expect(tagCsv.indexOf(`"'=HYPERLINK(""http://example.invalid"",""x"")"`) >= 0, 'a formula in a description is kept as text in the tag CSV');
  await page.click('#dlg button[type=submit]');
  await dlgClosed();
  await noInjection('warehouses');
  await run('master.import', { items: [{ code: 'P0-XSS', name: `ชิ้นส่วน ${XSS}`, baseUnit: 'ชิ้น', type: 'PART', group: XSS }] });
  await run('bom.upsert', { product: 'P0-XSS', rev: 'A', drawingNo: XSS, lines: [{ code: 'P0-PART1', qty: 1, note: XSS }] });
  await nav('setup');
  await page.click('#main .tab:has-text("ข้อตกลง")');
  await page.click('#main [data-act=dq][data-arg=all]');
  await page.click('#main [data-act=decide][data-arg=Q03]');
  await dlgOpen();
  await page.fill('#dlg textarea[name=answer]', `คลัง P0WH ${XSS}`);
  await page.fill('#dlg input[name=decidedBy]', XSS);
  await dlgSubmit();
  await toast('บันทึกข้อสรุป ค-3 แล้ว');
  await dlgClosed();
  await hasText('#main .sec', `ตัดสินโดย ${XSS}`);
  await noInjection('setup decisions');
  await page.click('#main .tab:has-text("ขอบเขตทดลอง")');
  await hasText('#main .fld', XSS); // the group from the item register is offered as a choice, as text
  await noInjection('setup scope');
  await nav('boms');
  await page.click('#main tr[data-arg="P0-XSS|A"]');
  await hasText('#main .sec-s', `ชิ้นส่วน ${XSS}`);
  await noInjection('boms');
  for (const id of ['home', 'users', 'audit', 'dictionary']) {
    await nav(id);
    await noInjection(id);
  }
  await page.click('#main [data-act=dataCsv][data-arg=items]');
  await dlgOpen();
  expect((await page.inputValue('#dlg textarea')).indexOf('P0-XSS,"ชิ้นส่วน <img src=x onerror=""window.__xss=1"">"') >= 0, 'item names exported as plain (quoted) text');
  await page.click('#dlg button[type=submit]');
  await dlgClosed();

  // ---------------------------------------------------------------------------------------------- phone width with lots of data
  log('lots of data at phone width');
  const bins = [];
  for (let i = 1; i <= 160; i++) bins.push({ wh: 'P0WH', code: `BULK-${String(i).padStart(3, '0')}`, name: `ชั้นทดสอบจำนวนมาก ${i} ฝั่งซ้ายสุดของอาคารสอง` });
  const items = [];
  for (let i = 1; i <= 120; i++) items.push({ code: `P0-BULK-${String(i).padStart(3, '0')}`, name: `ชิ้นส่วนทดสอบจำนวนมากชื่อยาวมาก ${i}`, baseUnit: 'ชิ้น', type: 'PART', group: `กลุ่มทดสอบ ${i % 9}` });
  await run('master.import', { bins, items });
  for (let i = 0; i < 40; i++) await run('kpi.record', { id: `p0_bulk_${i}`, label: `ตัวชี้วัดทดสอบจำนวนมาก ${i}`, unit: '%', baseline: i, target: 100 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400); // the menu slides away when the screen gets narrow
  await page.evaluate(() => {
    const v = window.RRS.app.views;
    v.warehouses = Object.assign(v.warehouses || {}, { sel: 'P0WH' });
    v.users = Object.assign(v.users || {}, { tab: 'matrix', usedOnly: false });
    v.setup = Object.assign(v.setup || {}, { tab: 'kpis' });
    v.dictionary = Object.assign(v.dictionary || {}, { q: '' });
  });
  for (const id of ['home', 'setup', 'warehouses', 'boms', 'users', 'dictionary', 'audit']) {
    await page.evaluate((x) => { location.hash = x; }, id);
    await page.waitForSelector(`.page[data-page="${id}"]`);
    await clearToasts();
    const bad = await page.evaluate(() => ({ over: document.documentElement.scrollWidth > window.innerWidth + 1, broken: /หน้านี้แสดงไม่ได้/.test(document.querySelector('#main').innerText) }));
    expect(!bad.over, `${id}: wider than the phone screen`);
    expect(!bad.broken, `${id}: page broken`);
    if (shots) await page.screenshot({ path: path.join(shots, `p0-phone-${id}.png`) });
  }

  log('phone: the audit row dialog fits the screen');
  await page.selectOption('#aud-kind', 'doc.post');
  await page.click('#main .tbl tbody tr');
  await dlgOpen();
  await hasText('#dlg', 'ข้อมูลที่รายการนี้เปลี่ยน');
  const fits = await page.evaluate(() => {
    const card = document.querySelector('#dlg .dlg-card').getBoundingClientRect();
    const close = document.querySelector('#dlg button[type=submit]').getBoundingClientRect();
    return card.left >= -1 && card.right <= window.innerWidth + 1 && close.right <= window.innerWidth + 1;
  });
  expect(fits, 'audit row dialog (with a long balance key) is no wider than the phone and its close button is on screen');
  if (shots) await page.screenshot({ path: path.join(shots, 'p0-phone-audit-dialog.png') });
  await page.click('#dlg button[type=submit]');
  await dlgClosed();
  await page.selectOption('#aud-kind', '');

  log('phone: 160 bins – the list and the tags stop at 40 until "show all"');
  await page.evaluate(() => { location.hash = 'warehouses'; });
  await page.waitForSelector('.page[data-page="warehouses"]');
  await hasText('#main .sec h2', 'P0WH');
  expect((await count('#main .tag')) === 40, `40 tags before "show all" (got ${await count('#main .tag')})`);
  await hasText('#main .hint', 'แสดง 40 จาก');
  await btn('แสดงทั้งหมด').click();
  const activeBins = await state("Object.values(s.tables.bins).filter((b) => b.wh === 'P0WH' && b.active !== false).length");
  await waitFor((n) => document.querySelectorAll('#main .tag').length === n, activeBins, `all ${activeBins} tags after "show all"`);
  expect(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), 'warehouses with every bin shown: no wider than the phone');
  await page.setViewportSize({ width: 1366, height: 860 });

  log('audit: tampered data is found');
  await page.evaluate(() => {
    const k = 'rrs-stockqc-demo-v1';
    const list = JSON.parse(localStorage.getItem(k));
    list[1].summary = 'แก้ไขย้อนหลัง';
    localStorage.setItem(k, JSON.stringify(list));
  });
  await nav('audit');
  await click('ตรวจลายนิ้วมือข้อมูล');
  await hasText('#main .note', 'พบปัญหา');
  await hasText('#main .note', 'ลำดับ 2 (แก้ไขย้อนหลัง): ลายนิ้วมือไม่ตรง');
  await shot('audit-tampered');
} catch (e) {
  problems.push(e.message);
  if (shots) await page.screenshot({ path: path.join(shots, 'p0-failure.png'), fullPage: true }).catch(() => {});
}
await browser.close();
if (problems.length) {
  console.log(`PROBLEMS (at step: ${step})\n` + problems.join('\n'));
  process.exit(1);
}
console.log('p0 ok');
