// Browser test of the Phase 5 screens: ล็อต/Heat และการสอบกลับ (lots), แผนการตรวจ QC (qc-plans),
// ตรวจ QC และปล่อยผ่าน (inspections) and ของไม่เป็นไปตามข้อกำหนด (NCR) (ncrs).
//   RRS_OUT=/tmp/stockqc-p5 node tests/e2e/p5.mjs [--shots dir]
// Starts from a clean demo page, creates its own master data (codes P5-…, warehouse P5W, users P5…) and drives the
// flows through the UI: plan with the wrong drawing revision → fixed → approved by another person → new version
// obsoletes it; certificate recorded by store and verified by QC (a photo of it previewed in this tab); inspection with
// live pass/fail and a photo; PASS released by a QC lead (not the inspector); FAIL → NCR → return to supplier; finished
// goods held until QC → rework → re-inspection → release → delivery; trace from a heat and from a job; lot quarantine
// blocks issues, NCR for quarantined stock → scrap, release back to รอตรวจ; use as is (QC lead only, with conditions);
// read-only viewer; many lots; phone width.
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
    .catch(async () => { throw new Error(`ไม่พบข้อความ "${text}" ในหน้า\n---\n${(await mainText()).slice(0, 2500)}`); });
}
async function waitIn(sel, text, timeout) {
  await page.waitForFunction(([s, x]) => { const e = document.querySelector(s); return !!e && e.innerText.indexOf(x) >= 0; }, [sel, text], { timeout: timeout || 6000 })
    .catch(async () => { throw new Error(`ไม่พบ "${text}" ใน ${sel}: ${(await page.locator(sel).first().innerText().catch(() => '(ไม่มี)')).slice(0, 1200)}`); });
}
const kpi = (label) => page.evaluate((l) => {
  const k = Array.from(document.querySelectorAll('#main .kpi')).find((e) => e.querySelector('.kpi-l').textContent.trim() === l);
  return k ? k.querySelector('.kpi-v').textContent.trim() : null;
}, label);
const rowCells = (sel, text) => page.evaluate(([s, x]) => {
  const tr = Array.from(document.querySelectorAll(s)).find((r) => r.innerText.indexOf(x) >= 0);
  return tr ? Array.from(tr.children).map((td) => td.innerText.trim()) : null;
}, [sel, text]);
/** Click the first element matching `sel` inside the table row that contains `text`. */
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
  await page.waitForSelector('#dlg[hidden]', { state: 'attached', timeout: 6000 })
    .catch(async () => { throw new Error(`หน้าต่างยังไม่ปิด: ${await page.locator('#dlg').innerText().catch(() => '')}`); });
}
async function dlgError(text) {
  await page.waitForFunction((x) => document.querySelector('#dlg-err') && document.querySelector('#dlg-err').innerText.indexOf(x) >= 0, text, { timeout: 4000 })
    .catch(async () => { throw new Error(`หน้าต่างควรบอก "${text}" ได้ "${await page.locator('#dlg-err').innerText().catch(() => '')}"`); });
}
/** Type into a live field and wait for the debounced re-render (the field keeps focus). */
async function typeLive(sel, value) {
  await page.fill(sel, String(value));
  await page.waitForTimeout(450);
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

// ---- start from a clean page ------------------------------------------------------------------------------------
await page.goto(file);
await ready();
await page.evaluate(() => localStorage.clear());
await page.reload();
await ready();

const EVIL = '<img src=x onerror=alert(1)>';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8DwnwEJMDIwMDAwAAAvAgP/WbkeqQAAAABJRU5ErkJggg==', 'base64');
const ids = {};

await step('empty states', async () => {
  const s = await state((st) => ({ lots: Object.keys(st.tables.lots || {}).length, ncrs: Object.keys(st.tables.ncrs || {}).length,
    plans: Object.keys(st.tables.qc_plans || {}).length, hold: Object.values(st.tables.balances || {}).filter((b) => b.status !== 'AVAILABLE' && b.qty > 0).length,
    qcItems: Object.values(st.tables.items || {}).filter((i) => i.qcIncoming || i.qcFinal).length, insp: Object.keys(st.tables.inspections || {}).length }));
  if (!s.lots) {
    await go('lots');
    await waitText('ยังไม่มีล็อต/Heat');
    await waitText('ล็อตจะขึ้นที่นี่อัตโนมัติเมื่อบันทึกรับเข้า');
    await page.click('#main button[data-act="tab"][data-arg="trace"]');
    await waitText('พิมพ์ Heat no. หรือเลขล็อต แล้วกด สอบกลับ');
    await page.click('#main button[data-act="tab"][data-arg="job"]');
    await waitText('พิมพ์เลขที่ใบงาน แล้วกด สอบกลับจากใบงาน');
    await page.click('#main button[data-act="tab"][data-arg="list"]');
  }
  if (!s.plans && !s.qcItems) {
    await go('qc-plans');
    await waitText('ยังไม่มีแผนตรวจ');
  }
  if (!s.hold) {
    await go('inspections');
    await waitText('ไม่มีของรอตรวจ กักกัน หรือรอแก้ไข');
    await waitText('ผลิตเสร็จยังไม่เท่ากับผ่าน QC');
    if (!s.insp) {
      await page.click('#main button[data-act="tab"][data-arg="all"]');
      await waitText('ยังไม่มีผลตรวจ');
      await page.click('#main button[data-act="tab"][data-arg="queue"]');
    }
  }
  if (!s.ncrs) {
    await go('ncrs');
    await waitText('ยังไม่มี NCR');
    await page.click('#main button[data-act="tab"][data-arg="held"]');
    await waitText('ไม่มีของกักกันที่ยังไม่มี NCR');
    await page.click('#main button[data-act="tab"][data-arg="open"]');
  }
});

await step('setup master data and users', async () => {
  await must('warehouse.upsert', { code: 'P5W', name: 'คลังทดสอบพีห้า' });
  await must('bin.upsert', { wh: 'P5W', code: 'P5-01', name: 'ชั้นเหล็ก' });
  await must('bin.upsert', { wh: 'P5W', code: 'P5-02', name: 'ชั้นสินค้าสำเร็จ' });
  await must('item.upsert', { code: 'P5-PLATE', name: 'แผ่นเหล็กทดสอบพีห้า 3 มม.', baseUnit: 'แผ่น', type: 'RM', trackLot: 'heat', certRequired: true, qcIncoming: true, drawingNo: 'DWG-P5-01', drawingRev: 'B' });
  await must('item.upsert', { code: 'P5-FG', name: 'กระบะทดสอบพีห้า', baseUnit: 'ชุด', type: 'FG', qcFinal: true, drawingRev: 'A' });
  await must('supplier.upsert', { id: 'P5-SUP', name: 'ผู้ขายเหล็กทดสอบพีห้า' });
  for (const [id, name, roles] of [['P5STORE', 'หัวหน้าสโตร์พีห้า', ['store_lead']], ['P5QC', 'QC พีห้า', ['qc']], ['P5LEAD', 'หัวหน้า QC พีห้า', ['qc_lead']],
    ['P5LEAD2', 'หัวหน้า QC พีห้า คนที่สอง', ['qc_lead']], ['P5ENG', 'วิศวกรพีห้า', ['engineering']], ['P5VIEW', 'ผู้ดูพีห้า', ['viewer']]]) {
    await must('user.upsert', { id, name, roles });
  }
  await page.reload();
  await ready();
});

await step('plans: a draft on the wrong drawing revision cannot be approved', async () => {
  await asUser('P5ENG');
  await go('qc-plans');
  await page.click('#plan-new-btn');
  await page.waitForSelector('#plan-edit form[data-form="plan"]');
  await typeLive('#plan-code', 'P5-PLATE');
  assert(await page.inputValue('#plan-rev') === 'B', 'เลือกสินค้าแล้วควรเติมฉบับแบบที่อนุมัติ (B) ให้');
  await waitText('แผ่นเหล็กทดสอบพีห้า 3 มม.');
  await typeLive('#plan-rev', 'A');
  await waitText('ไม่ตรงกับฉบับแบบที่อนุมัติของ P5-PLATE ("B")');
  await page.fill('#plan-src', 'WI-P5-01');
  await page.fill('#plan-sampling', '100%');
  await page.fill('input[name="chars[0][name]"]', 'ความหนา');
  await page.selectOption('select[name="chars[0][kind]"]', 'measure');
  await page.fill('input[name="chars[0][nominal]"]', '3');
  await page.fill('input[name="chars[0][min]"]', '2.8');
  await page.fill('input[name="chars[0][max]"]', '3.2');
  await page.fill('input[name="chars[0][unit]"]', 'มม.');
  await page.fill('input[name="chars[0][method]"]', 'ไมโครมิเตอร์');
  await page.click('#plan-edit button[data-act="addChar"]');
  await page.waitForSelector('input[name="chars[1][name]"]');
  assert(await page.inputValue('input[name="chars[0][max]"]') === '3.2', 'เพิ่มบรรทัดแล้วค่าที่กรอกไว้ต้องไม่หาย');
  await page.fill('input[name="chars[1][name]"]', 'ผิวและขอบ');
  await page.selectOption('select[name="chars[1][kind]"]', 'check');
  await page.fill('input[name="chars[1][method]"]', 'ดูด้วยตา');
  await page.click('#plan-edit button[type="submit"]');
  await waitState((s) => Object.values(s.tables.qc_plans || {}).some((p) => p.code === 'P5-PLATE' && p.status === 'DRAFT'), null, 'มีร่างแผน P5-PLATE');
  ids.plan1 = await state((s) => Object.values(s.tables.qc_plans).find((p) => p.code === 'P5-PLATE').id);
  const p = await state((s, R, id) => s.tables.qc_plans[id], ids.plan1);
  assert(p.drawingRev === 'A' && p.sourceRef === 'WI-P5-01' && p.chars.length === 2 && p.chars[0].min === 2.8 && p.chars[1].kind === 'check', 'ร่างแผนบันทึกไม่ครบ ' + JSON.stringify(p));
  await page.waitForSelector('#plan-detail');
  // the maker holds the approve right too (engineering) – the engine refuses: another person must approve
  assert(await page.locator('#plan-approve-btn').isDisabled(), 'ผู้จัดทำต้องอนุมัติแผนตัวเองไม่ได้');
  await waitIn('#plan-detail', 'ต้องเป็นคนละคน');
  await asUser('P5LEAD');
  await page.waitForSelector('#plan-detail');
  assert(await page.locator('#plan-approve-btn').isDisabled(), 'แผนฉบับแบบไม่ตรงต้องอนุมัติไม่ได้');
  await waitIn('#plan-detail', 'ฉบับแบบที่อนุมัติของ P5-PLATE คือ "B"');
  await shot('desktop-plan-rev-mismatch');
});

await step('plans: fix the revision, another person approves', async () => {
  await asUser('P5ENG');
  await page.click('#plan-edit-btn');
  await page.waitForSelector('#plan-edit form[data-form="plan"]');
  assert(await page.inputValue('input[name="chars[1][name]"]') === 'ผิวและขอบ', 'แก้ร่างต้องดึงหัวข้อเดิมมา');
  await typeLive('#plan-rev', 'B');
  await page.click('#plan-edit button[type="submit"]');
  await waitState((s, R, id) => s.tables.qc_plans[id].drawingRev === 'B', ids.plan1, 'ร่างแก้เป็นฉบับ B');
  await asUser('P5LEAD');
  await page.waitForSelector('#plan-approve-btn:not([disabled])');
  await page.click('#plan-approve-btn');
  await dlgOpen();
  await dlgSubmit();
  await waitState((s, R, id) => s.tables.qc_plans[id].status === 'APPROVED' && s.tables.qc_plans[id].approvedBy === 'P5LEAD', ids.plan1, 'แผนอนุมัติโดย P5LEAD');
  await waitIn('#plan-detail', 'แผนที่ใช้อยู่ของ P5-PLATE');
});

await step('plans: a new version replaces the approved one (old becomes obsolete)', async () => {
  await asUser('P5ENG');
  await page.waitForSelector('#plan-copy-btn');
  await page.click('#plan-copy-btn');
  await page.waitForSelector('#plan-edit form[data-form="plan"]');
  await waitText(`สร้างฉบับใหม่จาก ${ids.plan1}`);
  await waitText(`มีแผนที่ใช้อยู่แล้ว (${ids.plan1})`);
  await page.fill('input[name="chars[0][min]"]', '2.85');
  await page.fill('input[name="chars[0][max]"]', '3.25');
  await page.click('#plan-edit button[type="submit"]');
  await waitState((s, R, id) => Object.values(s.tables.qc_plans).some((p) => p.code === 'P5-PLATE' && p.status === 'DRAFT' && p.id !== id), ids.plan1, 'ร่างฉบับใหม่');
  ids.plan2 = await state((s, R, id) => Object.values(s.tables.qc_plans).find((p) => p.code === 'P5-PLATE' && p.id !== id).id, ids.plan1);
  await asUser('P5LEAD');
  await page.waitForSelector('#plan-approve-btn:not([disabled])');
  await page.click('#plan-approve-btn');
  await dlgOpen();
  const msg = await page.locator('#dlg').innerText();
  assert(msg.indexOf(`${ids.plan1} จะเลิกใช้`) >= 0, 'หน้าต่างอนุมัติต้องบอกว่าแผนเดิมจะเลิกใช้: ' + msg);
  await dlgSubmit();
  await waitState((s, R, x) => s.tables.qc_plans[x[0]].status === 'OBSOLETE' && s.tables.qc_plans[x[0]].replacedBy === x[1] && s.tables.qc_plans[x[1]].status === 'APPROVED',
    [ids.plan1, ids.plan2], 'แผนเดิมเลิกใช้ แทนด้วยฉบับใหม่');
  await page.click('#main button[data-act="tab"][data-arg="OBSOLETE"]');
  await waitIn('#plans-list', `แทนด้วย ${ids.plan2}`);
  await page.click('#main button[data-act="tab"][data-arg="all"]');
  // the finished-goods plan (made and approved by two people)
  const r = await must('qc.plan.save', { code: 'P5-FG', stage: 'FINAL', drawingRev: 'A', sourceRef: 'WI-P5-FG', sampling: '100%',
    chars: [{ name: 'ความกว้างรวม', kind: 'measure', nominal: 1500, min: 1490, max: 1510, unit: 'มม.' }, { name: 'สี/ผิว', kind: 'check' }] }, 'P5ENG');
  await must('qc.plan.approve', { id: r.result.id }, 'P5LEAD');
  ids.fgPlan = r.result.id;
});

await step('lots: receipt creates the lot; store records the certificate', async () => {
  ids.rr = (await must('doc.post', { type: 'RR', supplier: 'P5-SUP', lines: [{ code: 'P5-PLATE', qty: 10, wh: 'P5W', bin: 'P5-01', lot: 'P5-H1' }] }, 'P5STORE')).result.docNo;
  ids.rr2 = (await must('doc.post', { type: 'RR', supplier: 'P5-SUP', lines: [{ code: 'P5-PLATE', qty: 2, wh: 'P5W', bin: 'P5-01', lot: 'P5-H2' }] }, 'P5STORE')).result.docNo;
  await asUser('P5STORE');
  await go('lots');
  await waitIn('#lots-list', 'P5-H1');
  const cells = await rowCells('#lots-list tbody tr', 'P5-H1');
  assert(cells.some((c) => c.indexOf('ผู้ขายเหล็กทดสอบพีห้า') >= 0), 'ต้องแสดงชื่อผู้ขาย ' + cells.join(' | '));
  assert(cells.some((c) => c.indexOf('ยังไม่มี (ต้องมี)') >= 0), 'ใบรับรองต้องขึ้นว่ายังไม่มี ' + cells.join(' | '));
  assert(cells[8] === '10', 'รอตรวจควรเป็น 10 ได้ ' + cells[8]);
  await clickInRow('#lots-list tbody tr', 'P5-H1');
  await page.waitForSelector('#lot-detail');
  await waitIn('#lot-detail', ids.rr);
  assert(await page.locator('#lot-verify-btn').count() === 0, 'สโตร์ไม่มีสิทธิ์ตรวจใบรับรอง – ต้องไม่เห็นปุ่ม');
  await page.click('#lot-cert-btn');
  await dlgOpen();
  await page.fill('#cert-no', 'MTC-P5-001');
  await page.fill('#cert-link', 'javascript:alert(1)');
  await dlgSubmit();
  await dlgError('ลิงก์ต้องขึ้นต้นด้วย https://');
  await page.fill('#cert-link', 'https://files.example.invalid/mtc-p5.pdf');
  await dlgSubmit();
  await dlgClosed();
  await waitState((s) => { const l = s.tables.lots['P5-PLATE|P5-H1']; return l.cert.no === 'MTC-P5-001' && l.cert.enteredBy === 'P5STORE' && !l.cert.verified; }, null, 'บันทึกใบรับรอง');
  await waitIn('#lot-detail', 'รอ QC ตรวจใบรับรอง');
  const href = await page.getAttribute('#lot-detail a[target="_blank"]', 'href');
  assert(href === 'https://files.example.invalid/mtc-p5.pdf', 'ลิงก์ไฟล์ใบรับรองไม่ถูกต้อง ' + href);
});

await step('lots: QC verifies the certificate (not the person who entered it)', async () => {
  await asUser('P5QC');
  await page.waitForSelector('#lot-verify-btn:not([disabled])');
  await page.click('#lot-verify-btn');
  await dlgOpen();
  await dlgSubmit();
  await waitState((s) => { const l = s.tables.lots['P5-PLATE|P5-H1']; return l.cert.verified && l.cert.verifiedBy === 'P5QC'; }, null, 'ใบรับรองตรวจแล้ว');
  await waitIn('#lot-detail', 'ตรวจแล้ว');
  // QC records the certificate of the second heat → the same person cannot check it
  await clickInRow('#lots-list tbody tr', 'P5-H2');
  await waitIn('#lot-detail', 'P5-H2');
  await page.click('#lot-cert-btn');
  await dlgOpen();
  await page.fill('#cert-no', 'MTC-P5-002');
  // demo mode: the photo of the certificate is shrunk by ctx.uploadFile and shown in this tab; the record keeps its name
  await page.setInputFiles('#cert-file', { name: 'p5-cert.png', mimeType: 'image/png', buffer: PNG });
  await dlgSubmit();
  await dlgClosed();
  await waitState((s) => { const c = s.tables.lots['P5-PLATE|P5-H2'].cert; return c.no === 'MTC-P5-002' && c.file === 'p5-cert.png' && c.enteredBy === 'P5QC'; }, null, 'ใบรับรอง H2 เก็บชื่อไฟล์');
  await page.waitForSelector('#lot-cert-preview img');
  assert((await page.getAttribute('#lot-cert-preview img', 'src')).indexOf('data:image/jpeg;base64,') === 0, 'รูปใบรับรองต้องเป็นรูปย่อในหน้าต่างนี้');
  await page.waitForSelector('#lot-verify-btn');
  assert(await page.locator('#lot-verify-btn').isDisabled(), 'ผู้บันทึกใบรับรองต้องตรวจเองไม่ได้');
  await waitIn('#lot-detail', 'คุณเป็นผู้บันทึกใบรับรองนี้');
  await shot('desktop-lot-detail');
});

await step('inspection: live pass/fail per characteristic, photo, PASS', async () => {
  await asUser('P5QC');
  await go('inspections');
  await waitIn('#qc-queue', 'P5-H1');
  await clickInRow('#qc-queue tbody tr', 'P5-H1', 'button[data-act="startIns"]');
  await page.waitForSelector('#ins-form form[data-form="ins"]');
  assert(await page.inputValue('#ins-stage') === 'INCOMING', 'ขั้นตอนควรเป็นตรวจรับ');
  assert(await page.inputValue('#ins-src') === ids.rr, `เอกสารต้นทางควรเป็น ${ids.rr}`);
  assert(await page.inputValue('#ins-qty') === '10', 'จำนวนควรเติมยอดที่ยังไม่ได้ตรวจ (10)');
  await waitIn('#ins-form', ids.plan2);
  await typeLive('#ins-qty', '6');
  await typeLive('#ins-res-C1', '3.5');
  await waitIn('#ins-judge-C1', 'ไม่ผ่าน');
  assert(await page.evaluate(() => document.activeElement && document.activeElement.id) === 'ins-res-C1', 'ช่องที่กำลังกรอกต้องยังโฟกัสอยู่หลังแสดงผล');
  await typeLive('#ins-res-C1', '3.05');
  await waitIn('#ins-judge-C1', 'ผ่าน');
  await waitIn('#ins-overall', 'กรอกแล้ว 1/2 หัวข้อ');
  await page.check('input[name="res[C2]"][value="ผ่าน"]');
  await waitIn('#ins-overall', 'ผลรวม: ผ่าน');
  await page.setInputFiles('#ins-photo', { name: 'p5-photo.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForSelector('#ins-thumbs img');
  assert(await page.inputValue('#ins-res-C1') === '3.05', 'แนบรูปแล้วค่าที่กรอกต้องไม่หาย');
  await shot('desktop-inspection-form');
  await page.click('#ins-form button[type="submit"]');
  await dlgOpen();
  await waitIn('#dlg', 'บันทึกผล ผ่าน');
  await dlgSubmit();
  await waitState((s) => Object.values(s.tables.inspections || {}).some((i) => i.code === 'P5-PLATE' && i.result === 'PASS' && i.qty === 6), null, 'ผลตรวจผ่าน 6');
  const i = await state((s) => Object.values(s.tables.inspections).find((x) => x.code === 'P5-PLATE' && x.result === 'PASS'));
  ids.pass = i.id;
  assert(i.status === 'OPEN' && i.inspector === 'P5QC' && i.sourceDoc === ids.rr && i.planId === ids.plan2, 'ผลตรวจบันทึกไม่ถูกต้อง ' + JSON.stringify(i));
  assert(i.photos.length === 1 && i.photos[0].name === 'p5-photo.png' && i.photos[0].url === '', 'โหมดตัวอย่างบันทึกชื่อรูป (ไม่ฝังรูป) ' + JSON.stringify(i.photos));
  assert(i.results[0].value === 3.05 && i.results[0].ok && i.results[1].ok, 'ผลแต่ละหัวข้อไม่ถูกต้อง');
  await page.waitForSelector('#ins-detail img');
  await waitIn('#ins-detail', 'รอหัวหน้า QC ที่ไม่ใช่ผู้ตรวจ');
  assert(await qtyOf({ code: 'P5-PLATE', lot: 'P5-H1', status: 'QC_HOLD' }) === 10, 'ผลผ่านยังไม่ปล่อย – ของต้องยังรอตรวจ 10');
});

await step('inspection: FAIL opens an NCR and quarantines the quantity', async () => {
  await clickInRow('#qc-queue tbody tr', 'P5-H1', 'button[data-act="startIns"]');
  await page.waitForSelector('#ins-form form[data-form="ins"]');
  assert(await page.inputValue('#ins-qty') === '4', 'ตรวจรอบสองควรเติม 4 (ตรวจผ่านรอปล่อยไปแล้ว 6)');
  await waitIn('#ins-form', 'ตรวจผ่านรอปล่อย 6');
  await typeLive('#ins-res-C1', '2.5');
  await page.check('input[name="res[C2]"][value="ผ่าน"]');
  await waitIn('#ins-overall', 'ผลรวม: ไม่ผ่าน');
  await page.fill('#ins-note', 'ขอบแผ่นบาง ' + EVIL);
  await page.click('#ins-form button[type="submit"]');
  await dlgOpen();
  await waitIn('#dlg', 'บันทึกผลไม่ผ่านและเปิด NCR');
  await dlgSubmit();
  await waitState((s) => Object.values(s.tables.inspections).some((i) => i.code === 'P5-PLATE' && i.result === 'FAIL'), null, 'ผลไม่ผ่าน');
  const i = await state((s) => Object.values(s.tables.inspections).find((x) => x.code === 'P5-PLATE' && x.result === 'FAIL'));
  ids.fail = i.id;
  ids.ncr1 = i.ncrNo;
  assert(i.status === 'NCR' && i.ncrNo, 'ผลไม่ผ่านต้องเปิด NCR');
  assert(await qtyOf({ code: 'P5-PLATE', lot: 'P5-H1', status: 'QUARANTINE' }) === 4, 'ของที่ไม่ผ่านต้องกักกัน 4');
  assert(await qtyOf({ code: 'P5-PLATE', lot: 'P5-H1', status: 'QC_HOLD' }) === 6, 'ของที่ผ่านยังรอตรวจ 6');
  await waitIn('#ins-detail', ids.ncr1);
  await waitIn('#ins-detail', EVIL);
  assert(await page.locator('#main img[src="x"]').count() === 0, 'ข้อความที่ผู้ใช้พิมพ์ต้องแสดงเป็นตัวอักษร');
});

await step('release: the inspector cannot release; a QC lead releases', async () => {
  await page.click('#main button[data-act="tab"][data-arg="release"]');
  await waitIn('#qc-release', ids.pass);
  const cells = await rowCells('#qc-release tbody tr', ids.pass);
  assert(cells[5].indexOf('รอหัวหน้า QC') >= 0, 'ผู้ตรวจไม่มีสิทธิ์ปล่อย – ต้องเห็นว่ารอหัวหน้า QC: ' + cells[5]);
  await waitText('คนวัดกับคนอนุมัติต้องเป็นคนละคน');
  await asUser('P5LEAD');
  await clickInRow('#qc-release tbody tr', ids.pass, 'button[data-act="release"]');
  await dlgOpen();
  assert(await page.inputValue('#rel-qty') === '6', 'จำนวนที่ปล่อยควรเติม 6');
  await dlgSubmit();
  await dlgClosed();
  await waitState((s, R, id) => s.tables.inspections[id].status === 'RELEASED' && s.tables.inspections[id].releasedBy === 'P5LEAD', ids.pass, 'ปล่อยผ่านแล้ว');
  assert(await qtyOf({ code: 'P5-PLATE', lot: 'P5-H1', status: 'AVAILABLE' }) === 6, 'ปล่อยผ่านแล้วต้องใช้ได้ 6');
});

await step('NCR: decide return to supplier, then close', async () => {
  await asUser('P5LEAD');
  await go('ncrs');
  await waitIn('#ncr-list', ids.ncr1);
  await clickInRow('#ncr-list tbody tr', ids.ncr1);
  await page.waitForSelector('#ncr-detail');
  await waitIn('#ncr-detail', ids.fail);
  await page.click('#ncr-decide-btn');
  await dlgOpen();
  assert(await page.locator('#dlg input[name="disposition"][value="USE_AS_IS"]').isEnabled(), 'หัวหน้า QC ที่ไม่ใช่ผู้ตรวจต้องเลือกยอมรับแบบมีเงื่อนไขได้');
  await page.fill('#disp-reason', 'ผู้ขายยืนยันรับคืน');
  await dlgSubmit();
  await dlgError('เลือกการตัดสิน 1 แบบ');
  await page.check('#dlg input[name="disposition"][value="RETURN"]');
  await dlgSubmit();
  await dlgClosed();
  await waitState((s, R, no) => s.tables.ncrs[no].status === 'DISPOSITIONED' && s.tables.ncrs[no].disposition === 'RETURN' && s.tables.ncrs[no].docType === 'RV', ids.ncr1, 'ตัดสินคืนผู้ขาย');
  ids.rv = await state((s, R, no) => s.tables.ncrs[no].docNo, ids.ncr1);
  assert(await qtyOf({ code: 'P5-PLATE', lot: 'P5-H1', status: 'QUARANTINE' }) === 0, 'คืนผู้ขายแล้วของกักกันต้องหมด');
  await waitIn('#ncr-detail', ids.rv);
  await page.click('#ncr-close-btn');
  await dlgOpen();
  await page.fill('#close-note', 'ผู้ขายรับคืนแล้ว');
  await dlgSubmit();
  await dlgClosed();
  await waitState((s, R, no) => s.tables.ncrs[no].status === 'CLOSED' && s.tables.ncrs[no].closedBy === 'P5LEAD', ids.ncr1, 'ปิด NCR');
});

await step('finished goods: รอตรวจ cannot be delivered; FAIL → rework → re-inspection → release → delivery', async () => {
  ids.fr = (await must('doc.post', { type: 'FR', job: 'P5-JOB-1', lines: [{ code: 'P5-FG', qty: 2, wh: 'P5W', bin: 'P5-02' }] }, 'P5STORE')).result.docNo;
  const dl0 = await exec('doc.post', { type: 'DL', job: 'P5-JOB-1', lines: [{ code: 'P5-FG', qty: 1, wh: 'P5W', bin: 'P5-02' }] }, 'P5STORE');
  assert(!dl0.ok, 'ของผลิตเสร็จที่ยังรอตรวจต้องส่งมอบไม่ได้');
  await asUser('P5QC');
  await go('inspections');
  await page.click('#main button[data-act="tab"][data-arg="queue"]');
  await waitText('ผลิตเสร็จยังไม่เท่ากับผ่าน QC');
  // sample data may hold other finished goods in รอตรวจ: the tile counts every one of them, P5-FG adds 2
  const fgHold = await state((st, R) => R.util.round(Object.values(st.tables.balances || {}).filter((b) => b.status === 'QC_HOLD' && b.wh !== R.TRANSIT && b.qty > 0
    && st.tables.items[b.code] && (st.tables.items[b.code].qcFinal || st.tables.items[b.code].type === 'FG')).reduce((x, b) => x + b.qty, 0)));
  assert(fgHold >= 2 && (await kpi('ผลิตเสร็จรอตรวจ')) === new Intl.NumberFormat('th-TH').format(fgHold), `ผลิตเสร็จรอตรวจควรเป็น ${fgHold} ได้ ` + await kpi('ผลิตเสร็จรอตรวจ'));
  await waitIn('#qc-queue', 'ผลิตเสร็จ – ส่งมอบไม่ได้จนกว่าจะผ่าน QC');
  await clickInRow('#qc-queue tbody tr', 'P5-FG', 'button[data-act="startIns"]');
  await page.waitForSelector('#ins-form form[data-form="ins"]');
  assert(await page.inputValue('#ins-stage') === 'FINAL', 'ของจาก FR ต้องตรวจขั้นก่อนส่งมอบ');
  assert(await page.inputValue('#ins-job') === 'P5-JOB-1', 'ใบงานต้องมาจาก FR');
  await typeLive('#ins-res-C1', '1520');
  await page.check('input[name="res[C2]"][value="ผ่าน"]');
  await waitIn('#ins-overall', 'ผลรวม: ไม่ผ่าน');
  await page.click('#ins-form button[type="submit"]');
  await dlgOpen();
  await dlgSubmit();
  await waitState((s) => Object.values(s.tables.inspections).some((i) => i.code === 'P5-FG' && i.result === 'FAIL'), null, 'FG ไม่ผ่าน');
  const f = await state((s) => Object.values(s.tables.inspections).find((x) => x.code === 'P5-FG' && x.result === 'FAIL'));
  ids.fgFail = f.id;
  ids.ncr2 = f.ncrNo;
  // QC lead: rework
  await asUser('P5LEAD');
  await go('ncrs');
  await clickInRow('#ncr-list tbody tr', ids.ncr2);
  await page.click('#ncr-decide-btn');
  await dlgOpen();
  await page.check('#dlg input[name="disposition"][value="REWORK"]');
  await page.fill('#disp-reason', 'เจียรขอบให้ได้ขนาด');
  await dlgSubmit();
  await dlgClosed();
  await waitState((s, R, no) => s.tables.ncrs[no].disposition === 'REWORK', ids.ncr2, 'ตัดสินแก้ไขงาน');
  assert(await qtyOf({ code: 'P5-FG', status: 'REWORK' }) === 2, 'แก้ไขงานแล้วของต้องเป็นรอแก้ไข 2');
  await page.waitForSelector('#ncr-close-btn');
  assert(await page.locator('#ncr-close-btn').isDisabled(), 'แก้ไขงานแล้วยังไม่ตรวจซ้ำ – ต้องปิด NCR ไม่ได้');
  await waitIn('#ncr-detail', 'ก่อนจึงปิด NCR ได้');
  // the QC lead re-inspects after rework (qc_lead holds qc.inspect)
  await go('inspections');
  await page.click('#main button[data-act="tab"][data-arg="queue"]');
  await clickInRow('#qc-queue tbody tr', 'P5-FG', 'button[data-act="startRe"]');
  await page.waitForSelector('#ins-form form[data-form="ins"]');
  assert(await page.inputValue('#ins-from') === 'REWORK', 'ตรวจซ้ำต้องเป็นของรอแก้ไข');
  assert(await page.inputValue('#ins-reof') === ids.fgFail, `ตรวจซ้ำต้องอ้างผลเดิม ${ids.fgFail}`);
  await waitText('บันทึกผลตรวจซ้ำหลังแก้ไข');
  await typeLive('#ins-res-C1', '1500');
  await page.check('input[name="res[C2]"][value="ผ่าน"]');
  await page.click('#ins-form button[type="submit"]');
  await dlgOpen();
  await dlgSubmit();
  await waitState((s, R, id) => Object.values(s.tables.inspections).some((i) => i.reinspectionOf === id && i.result === 'PASS'), ids.fgFail, 'ตรวจซ้ำผ่าน');
  ids.fgRe = await state((s, R, id) => Object.values(s.tables.inspections).find((i) => i.reinspectionOf === id).id, ids.fgFail);
  // the same QC lead inspected it – the engine names why they cannot release it
  await page.waitForSelector('#ins-release-btn');
  assert(await page.locator('#ins-release-btn').isDisabled(), 'ผู้ตรวจซ้ำต้องปล่อยผ่านเองไม่ได้');
  await waitIn('#ins-detail', 'ต้องเป็นคนละคนกับผู้ตรวจ');
  await page.click('#main button[data-act="tab"][data-arg="release"]');
  const cells = await rowCells('#qc-release tbody tr', ids.fgRe);
  assert(cells[5].indexOf('ต้องเป็นคนละคนกับผู้ตรวจ') >= 0, 'แถวรอปล่อยต้องบอกเหตุผล: ' + cells[5]);
  await asUser('P5LEAD2');
  await clickInRow('#qc-release tbody tr', ids.fgRe, 'button[data-act="release"]');
  await dlgOpen();
  await dlgSubmit();
  await dlgClosed();
  await waitState((s, R, id) => s.tables.inspections[id].status === 'RELEASED', ids.fgRe, 'ปล่อยผ่านของตรวจซ้ำ');
  assert(await qtyOf({ code: 'P5-FG', status: 'AVAILABLE' }) === 2, 'ปล่อยแล้วของสำเร็จรูปต้องใช้ได้ 2');
  // NCR now closes (re-inspection done)
  await go('ncrs');
  await page.click('#main button[data-act="tab"][data-arg="disp"]');
  await clickInRow('#ncr-list tbody tr', ids.ncr2);
  await page.waitForSelector('#ncr-close-btn:not([disabled])');
  await waitIn('#ncr-detail', ids.fgRe);
  await page.click('#ncr-close-btn');
  await dlgOpen();
  await dlgSubmit();
  await dlgClosed();
  await waitState((s, R, no) => s.tables.ncrs[no].status === 'CLOSED', ids.ncr2, 'ปิด NCR แก้ไขงาน');
  ids.dl = (await must('doc.post', { type: 'DL', job: 'P5-JOB-1', lines: [{ code: 'P5-FG', qty: 2, wh: 'P5W', bin: 'P5-02' }] }, 'P5STORE')).result.docNo;
});

await step('trace: from a heat to its jobs, outputs and deliveries; back from the job', async () => {
  ids.pd = (await must('doc.post', { type: 'PD', job: 'P5-JOB-1', lines: [{ code: 'P5-PLATE', qty: 3, wh: 'P5W', bin: 'P5-01', lot: 'P5-H1' }] }, 'P5STORE')).result.docNo;
  await asUser('P5VIEW');
  await go('lots');
  await page.click('#main button[data-act="tab"][data-arg="trace"]');
  await page.fill('#lots-tq', 'p5 h');
  await page.click('form[data-form="trace"] button[type="submit"]');
  await waitText('พบ 2 ล็อตที่ตรงกับ');
  await clickInRow('#main tbody tr.clickable', 'P5-H1');
  await page.waitForSelector('#trace-head');
  for (const s of [ids.rr, ids.pd, ids.fr, ids.dl, 'P5-JOB-1', 'ผู้ขายเหล็กทดสอบพีห้า', '1 · รับเข้า', '2 · จ่ายออก (เบิกให้งาน / คืนผู้ขาย / ตัดทิ้ง)', '3 · ผลผลิตของงานที่ใช้ล็อตนี้ (FR)', '4 · ส่งมอบลูกค้า (DL)', ids.pass, ids.rv]) await waitText(s);
  assert(!(await mainText()).includes(ids.rr2), 'ล็อตอื่นต้องไม่ปน');
  await shot('desktop-trace');
  // CSV: no download capability here → the copy box shows the rows
  await page.click('#trace-head button[data-act="traceCsv"]');
  await dlgOpen();
  const csv = await page.inputValue('#dlg textarea');
  assert(csv.indexOf(ids.rr) >= 0 && csv.indexOf(ids.dl) >= 0 && csv.indexOf('ส่งมอบ DL') >= 0, 'CSV สอบกลับต้องมีใบรับและใบส่งมอบ');
  await dlgSubmit();
  await dlgClosed();
  // back from the job
  await page.click('#main a[data-go="lots"] .code >> text=P5-JOB-1');
  await waitText('ล็อตที่ใบงาน P5-JOB-1 ใช้');
  const cells = await rowCells('#job-lots tbody tr', 'P5-H1');
  assert(cells, 'ต้องมีแถวล็อต P5-H1 ของใบงาน');
  const row = cells.join(' | ');
  for (const s of ['ผู้ขายเหล็กทดสอบพีห้า', 'MTC-P5-001', 'ตรวจแล้ว', ids.rr]) assert(row.indexOf(s) >= 0, `แถวใบงานควรมี ${s}: ${row}`);
  assert(cells[4].indexOf('3') === 0, 'ใช้สุทธิควรเป็น 3 ได้ ' + cells[4]);
  await waitText(ids.fr);
  await waitText(ids.dl);
});

await step('lot quarantine blocks every issue; NCR for quarantined stock → scrap; release goes back to รอตรวจ', async () => {
  await asUser('P5QC');
  await go('lots');
  await page.click('#main button[data-act="tab"][data-arg="list"]');
  await clickInRow('#lots-list tbody tr', 'P5-H1');
  await waitIn('#lot-detail', 'P5-H1');
  await page.click('#lot-quar-btn');
  await dlgOpen();
  await waitIn('#dlg', 'กลับไปเป็น "รอตรวจ" ไม่กลับเป็น "ใช้ได้" ทันที');
  await dlgSubmit();
  await dlgError('เหตุผล');
  await page.fill('#quar-reason', 'ใบรับรองไม่ตรงกับ Heat ที่ตอก ' + EVIL);
  await dlgSubmit();
  await dlgClosed();
  await waitState((s) => s.tables.lots['P5-PLATE|P5-H1'].status === 'QUARANTINED', null, 'ล็อตถูกกักกัน');
  assert(await qtyOf({ code: 'P5-PLATE', lot: 'P5-H1', status: 'QUARANTINE' }) === 3, 'ของใช้ได้ 3 ต้องเป็นกักกัน');
  const pd = await exec('doc.post', { type: 'PD', job: 'P5-JOB-2', lines: [{ code: 'P5-PLATE', qty: 1, wh: 'P5W', bin: 'P5-01', lot: 'P5-H1' }] }, 'P5STORE');
  assert(!pd.ok && pd.errors.some((e) => e.code === 'LOT_QUARANTINED'), 'ล็อตกักกันต้องเบิกไม่ได้ ' + JSON.stringify(pd.errors));
  await waitIn('#lot-detail', 'กักกันทั้งล็อต');
  assert(await page.locator('#lot-release-btn').count() === 0, 'QC ผู้ตรวจไม่มีสิทธิ์ปลดกักกัน');
  assert(await page.locator('#main img[src="x"]').count() === 0, 'เหตุผลต้องแสดงเป็นตัวอักษร');
  // open an NCR for one quarantined plate
  await go('ncrs');
  await page.click('#main button[data-act="tab"][data-arg="held"]');
  await clickInRow('#ncr-held tbody tr', 'P5-PLATE', 'button[data-act="openNcr"]');
  await dlgOpen();
  assert(await page.inputValue('#open-qty') === '3', 'จำนวนควรเติมยอดกักกันที่ยังไม่มี NCR');
  assert((await page.inputValue('#open-defect')).indexOf('ใบรับรองไม่ตรงกับ Heat') === 0, 'ข้อบกพร่องควรเติมเหตุผลการกักกัน');
  await page.fill('#open-qty', '1');
  await dlgSubmit();
  await dlgClosed();
  await waitState((s) => Object.values(s.tables.ncrs).some((n) => n.code === 'P5-PLATE' && n.status === 'OPEN' && n.qty === 1 && !n.inspectionId), null, 'เปิด NCR ของกักกัน');
  ids.ncr3 = await state((s) => Object.values(s.tables.ncrs).find((n) => n.code === 'P5-PLATE' && n.status === 'OPEN').ncrNo);
  await page.waitForSelector('#ncr-detail');
  assert(await page.locator('#ncr-decide-btn').count() === 0, 'QC ผู้ตรวจไม่มีสิทธิ์ตัดสิน NCR');
  await asUser('P5LEAD');
  await page.click('#ncr-decide-btn');
  await dlgOpen();
  await page.check('#dlg input[name="disposition"][value="SCRAP"]');
  await page.fill('#disp-reason', 'แผ่นบิดงอ ใช้ไม่ได้');
  await dlgSubmit();
  await dlgClosed();
  await waitState((s, R, no) => s.tables.ncrs[no].docType === 'SC', ids.ncr3, 'ตัดทิ้งด้วยใบ SC');
  assert(await qtyOf({ code: 'P5-PLATE', lot: 'P5-H1', status: 'QUARANTINE' }) === 2, 'ตัดทิ้ง 1 เหลือกักกัน 2');
  // release the lot: back to รอตรวจ, never straight to ใช้ได้
  await go('lots');
  await clickInRow('#lots-list tbody tr', 'P5-H1');
  await page.waitForSelector('#lot-release-btn:not([disabled])');
  await page.click('#lot-release-btn');
  await dlgOpen();
  await page.fill('#rel-reason', 'ผู้ขายส่งใบรับรองที่ถูกต้องแล้ว');
  await dlgSubmit();
  await dlgClosed();
  await waitState((s) => s.tables.lots['P5-PLATE|P5-H1'].status === 'ACTIVE', null, 'ปลดกักกันล็อต');
  assert(await qtyOf({ code: 'P5-PLATE', lot: 'P5-H1', status: 'QC_HOLD' }) === 2, 'ปลดกักกันแล้วต้องกลับไปรอตรวจ 2');
  assert(await qtyOf({ code: 'P5-PLATE', lot: 'P5-H1', status: 'AVAILABLE' }) === 0, 'ปลดกักกันต้องไม่กลับเป็นใช้ได้ทันที');
  await waitIn('#lot-detail', 'ปลดกักกันล่าสุด');
});

await step('NCR use as is: only a QC lead who did not inspect, with conditions', async () => {
  await must('doc.post', { type: 'FR', job: 'P5-JOB-3', lines: [{ code: 'P5-FG', qty: 1, wh: 'P5W', bin: 'P5-02' }] }, 'P5STORE');
  await asUser('P5QC');
  await go('inspections');
  await page.click('#main button[data-act="tab"][data-arg="queue"]');
  await clickInRow('#qc-queue tbody tr', 'P5-FG', 'button[data-act="startIns"]');
  await page.waitForSelector('#ins-form form[data-form="ins"]');
  await typeLive('#ins-res-C1', '1515');
  await page.check('input[name="res[C2]"][value="ผ่าน"]');
  await waitIn('#ins-judge-C1', 'ไม่ผ่าน');
  await page.click('#ins-form button[type="submit"]');
  await dlgOpen();
  await dlgSubmit();
  await waitState((s) => Object.values(s.tables.inspections).some((i) => i.code === 'P5-FG' && i.jobNo === 'P5-JOB-3' && i.result === 'FAIL'), null, 'FG งาน 3 ไม่ผ่าน');
  ids.ncr4 = await state((s) => Object.values(s.tables.inspections).find((i) => i.code === 'P5-FG' && i.jobNo === 'P5-JOB-3').ncrNo);
  assert(await qtyOf({ code: 'P5-FG', wh: 'P5W', bin: 'P5-02', status: 'QUARANTINE' }) === 1, 'ของที่ไม่ผ่านต้องกักกัน 1');
  // engineering may decide NCRs but not accept them as they are
  await asUser('P5ENG');
  await go('ncrs');
  await page.click('#main button[data-act="tab"][data-arg="open"]');
  await clickInRow('#ncr-list tbody tr', ids.ncr4);
  await page.click('#ncr-decide-btn');
  await dlgOpen();
  assert(await page.locator('#dlg input[name="disposition"][value="USE_AS_IS"]').isDisabled(), 'วิศวกรรมต้องเลือกยอมรับแบบมีเงื่อนไขไม่ได้');
  await waitIn('#dlg', 'เลือกไม่ได้: ต้องเป็นหัวหน้า QC');
  assert(await page.locator('#dlg input[name="disposition"][value="SCRAP"]').isEnabled(), 'วิศวกรรมต้องเลือกตัดทิ้งได้');
  await page.click('#dlg .dlg-f .btn-ghost');
  await dlgClosed();
  // a QC lead who did not inspect: conditions are required
  await asUser('P5LEAD');
  await page.waitForSelector('#ncr-decide-btn');
  await page.click('#ncr-decide-btn');
  await dlgOpen();
  await page.check('#dlg input[name="disposition"][value="USE_AS_IS"]');
  await page.fill('#disp-reason', 'เกินเกณฑ์ 5 มม. ลูกค้ายอมรับ');
  await dlgSubmit();
  await dlgError('ต้องระบุเงื่อนไข');
  await page.fill('#disp-cond', 'ใช้กับรถลูกค้ารายนี้เท่านั้น ' + EVIL);
  await dlgSubmit();
  await dlgClosed();
  await waitState((s, R, no) => { const n = s.tables.ncrs[no]; return n.disposition === 'USE_AS_IS' && n.dispositionBy === 'P5LEAD' && n.docType === 'QS' && n.conditions.indexOf('ใช้กับรถลูกค้ารายนี้') === 0; }, ids.ncr4, 'ยอมรับแบบมีเงื่อนไข');
  assert(await qtyOf({ code: 'P5-FG', wh: 'P5W', bin: 'P5-02', status: 'AVAILABLE' }) === 1, 'ยอมรับแบบมีเงื่อนไขแล้วของต้องใช้ได้ 1');
  const doc = await state((s, R, no) => s.tables.ncrs[no].docNo, ids.ncr4);
  await waitIn('#ncr-detail', doc);
  await waitIn('#ncr-detail', 'ใช้กับรถลูกค้ารายนี้เท่านั้น');
  assert(await page.locator('#main img[src="x"]').count() === 0, 'เงื่อนไขต้องแสดงเป็นตัวอักษร');
  await page.click('#ncr-close-btn');
  await dlgOpen();
  await dlgSubmit();
  await dlgClosed();
  await waitState((s, R, no) => s.tables.ncrs[no].status === 'CLOSED', ids.ncr4, 'ปิด NCR ยอมรับแบบมีเงื่อนไข');
});

await step('viewer sees no action buttons', async () => {
  await asUser('P5VIEW');
  await go('lots');
  await clickInRow('#lots-list tbody tr', 'P5-H1');
  await page.waitForSelector('#lot-detail');
  for (const sel of ['#lot-cert-btn', '#lot-verify-btn', '#lot-quar-btn', '#lot-release-btn']) assert(await page.locator(sel).count() === 0, `ผู้ดูต้องไม่เห็น ${sel}`);
  await go('qc-plans');
  assert(await page.locator('#plan-new-btn').count() === 0, 'ผู้ดูต้องไม่เห็นปุ่มสร้างแผน');
  await go('inspections');
  await page.click('#main button[data-act="tab"][data-arg="queue"]');
  assert(await page.locator('#main button[data-act="startIns"], #ins-new-btn').count() === 0, 'ผู้ดูต้องไม่เห็นปุ่มตรวจ');
  await go('ncrs');
  await page.click('#main button[data-act="tab"][data-arg="all"]');
  await clickInRow('#ncr-list tbody tr', ids.ncr1);
  await page.waitForSelector('#ncr-detail');
  assert(await page.locator('#ncr-decide-btn, #ncr-close-btn').count() === 0, 'ผู้ดูต้องไม่เห็นปุ่มตัดสิน/ปิด');
});

await step('many lots scroll inside their own box', async () => {
  const lines = [];
  for (let i = 1; i <= 80; i++) lines.push({ code: 'P5-PLATE', qty: 1, wh: 'P5W', bin: 'P5-02', lot: `P5-BULK-${String(i).padStart(3, '0')}` });
  await must('doc.post', { type: 'AJ', remark: 'ยอดตั้งต้นทดสอบพีห้า', lines }, 'P5STORE');
  await asUser('P5STORE');
  await go('lots');
  await waitIn('#lots-list', 'P5-BULK-080');
  const box = await page.evaluate(() => {
    const el = document.querySelector('#lots-list');
    return { cls: el.className, h: el.getBoundingClientRect().height, inner: el.scrollHeight, vh: window.innerHeight };
  });
  assert(box.cls.indexOf('scroll') >= 0 && box.h <= box.vh * 0.72 && box.inner > box.h, 'ตารางล็อตยาวต้องเลื่อนในกรอบของตัวเอง ' + JSON.stringify(box));
  await typeLive('#lots-q', 'p5 bulk 07');
  const n = await page.locator('#lots-list tbody tr').count();
  assert(n === 10, `ค้น "p5 bulk 07" ควรได้ 10 ล็อต ได้ ${n}`);
  assert(await page.evaluate(() => document.activeElement && document.activeElement.id) === 'lots-q', 'ช่องค้นหาต้องยังโฟกัสอยู่');
  await page.click('#main button[data-act="clear"]');
});

await step('phone width: nothing wider than the screen', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await asUser('P5LEAD');
  await go('lots');
  await clickInRow('#lots-list tbody tr', 'P5-H1');
  await page.waitForSelector('#lot-detail');
  await noOverflow('lots detail');
  await page.click('#lot-cert-btn');
  await dlgOpen();
  const card = await page.evaluate(() => { const r = document.querySelector('#dlg .dlg-card').getBoundingClientRect(); return { l: r.left, r: r.right, w: window.innerWidth }; });
  assert(card.l >= 0 && card.r <= card.w + 1, 'หน้าต่างใบรับรองต้องอยู่ในจอโทรศัพท์ ' + JSON.stringify(card));
  await noOverflow('certificate dialog');
  await page.click('#dlg .dlg-f .btn-ghost');
  await dlgClosed();
  await page.click('#main button[data-act="tab"][data-arg="trace"]');
  await page.waitForSelector('#trace-head');
  await noOverflow('lots trace');
  await page.click('#main button[data-act="tab"][data-arg="job"]');
  await noOverflow('lots job trace');
  await go('qc-plans');
  await page.click('#main button[data-act="tab"][data-arg="all"]');
  await clickInRow('#plans-list tbody tr', ids.plan2);
  await page.waitForSelector('#plan-detail');
  await noOverflow('qc-plans detail');
  await page.click('#plan-copy-btn');
  await page.waitForSelector('#plan-edit');
  await noOverflow('qc-plans editor');
  await page.click('#plan-edit button[data-act="closeEdit"]');
  await go('inspections');
  await page.click('#main button[data-act="tab"][data-arg="queue"]');
  await clickInRow('#qc-queue tbody tr', 'P5-H1', 'button[data-act="startIns"]');
  await page.waitForSelector('#ins-form');
  await noOverflow('inspection form');
  await shot('phone-inspection-form');
  await page.click('#ins-form button[data-act="insClose"]');
  await page.click('#main button[data-act="tab"][data-arg="all"]');
  await clickInRow('#qc-all tbody tr', ids.pass);
  await page.waitForSelector('#ins-detail');
  await noOverflow('inspection detail');
  await go('ncrs');
  await page.click('#main button[data-act="tab"][data-arg="all"]');
  await clickInRow('#ncr-list tbody tr', ids.ncr2);
  await page.waitForSelector('#ncr-detail');
  await noOverflow('ncr detail');
  await shot('phone-ncr');
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
console.log('\np5 ok');
