// Review test of the sample data (src/engine/fixture.js) and the self-test (src/engine/selftest.js), used like real staff.
//   RRS_OUT=/tmp/stockqc-fixture-review node tests/e2e/fixture-review.mjs [--shots dir]
// 1. two tabs that both found the demo empty end with the same single sample and no error
// 2. a sample step that is refused shows its Thai reason + what to do in the banner; "เริ่มข้อมูลตัวอย่างใหม่" recovers
// 3. QC works on the sample by clicking: inspects the side panel waiting in รอตรวจ (an empty measurement is refused and
//    changes nothing), the inspector cannot release the own result, the QC lead releases it and the panel is usable
// 4. the UAT page runs the self-test by clicking: every criterion passes, the 7 criteria that need people are marked,
//    and nothing is written to the page's data
// 5. names / remarks with HTML are shown as text on every page (phone + desktop), nothing wider than 390 px
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

const KEY = 'FXR'; // codes of this test
const XSS = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';
const problems = [];
let current = '';
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function watch(p, tag) {
  p.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|cdnjs|ERR_|net::/.test(m.text())) problems.push(`console ${tag} (${current}): ${m.text()}`); });
  p.on('pageerror', (e) => problems.push(`pageerror ${tag} (${current}): ${e.message}`));
  p.on('dialog', async (d) => { problems.push(`browser dialog ${tag} (${current}): ${d.type()} ${d.message()}`); await d.dismiss().catch(() => {}); });
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
const page = await context.newPage();
watch(page, 'main');

// ---- helpers ------------------------------------------------------------------------------------------------
const ready = (p) => (p || page).waitForFunction(() => window.RRS && window.RRS.app && window.RRS.app.loading === false && window.RRS.app.ledger, null, { timeout: 60000 });
const state = (fn, arg, p) => (p || page).evaluate(([src, a]) => (0, eval)(src)(window.RRS.app.ledger.state, window.RRS, a), [fn.toString(), arg === undefined ? null : arg]);
async function exec(kind, payload, user) {
  const r = await page.evaluate(([k, p, u]) => window.RRS.app.ledger.execute({ kind: k, payload: p }, { user: u }), [kind, payload, user]);
  assert(r.ok, `${kind} โดย ${user}: ${JSON.stringify(r.errors)}`);
  return r;
}
async function go(id) {
  await page.evaluate((x) => { location.hash = x; }, id);
  await page.waitForSelector(`.page[data-page="${id}"]`, { timeout: 10000 });
}
async function asUser(id) {
  await page.selectOption('#who-sel', id);
  await page.waitForFunction((x) => window.RRS.app.demoUser === x && document.querySelector('#who-sel').value === x, id);
}
const text = (sel) => page.locator(sel || '#main').innerText().catch(() => '');
async function waitText(t, timeout, sel) {
  await page.waitForFunction(([x, s]) => (document.querySelector(s) || {}).innerText.indexOf(x) >= 0, [t, sel || '#main'], { timeout: timeout || 6000 })
    .catch(async () => { throw new Error(`ไม่พบข้อความ "${t}" ใน ${sel || 'หน้า'}\n---\n${(await text(sel)).slice(0, 1500)}`); });
}
async function toast(t) {
  await page.waitForFunction((x) => document.querySelector('#toasts').innerText.indexOf(x) >= 0, t, { timeout: 8000 })
    .catch(async () => { throw new Error(`ไม่มีข้อความแจ้ง "${t}" (มี: ${await text('#toasts')})`); });
}
const clearToasts = () => page.evaluate(() => { document.querySelector('#toasts').innerHTML = ''; });
const dlgOpen = (p) => (p || page).waitForSelector('#dlg:not([hidden]) .dlg-card', { timeout: 6000 });
const dlgSubmit = (p) => (p || page).click('#dlg .dlg-f button[type=submit]');
const dlgClosed = (p) => (p || page).waitForSelector('#dlg[hidden]', { state: 'attached', timeout: 8000 });
async function noOverflow(where, p) {
  const w = await (p || page).evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  assert(w[0] <= w[1] + 1, `${where}: หน้ากว้าง ${w[0]} px เกินจอ ${w[1]} px`);
}
async function shot(name, p) {
  if (shots) await (p || page).screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
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

// ---- 0. clean start -----------------------------------------------------------------------------------------
let full = 0;
await step('clean start builds the sample once', async () => {
  await page.goto(file);
  await ready();
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await ready();
  const s = await state((st, R) => ({ seq: st.seq, sample: R.fixture.isSampleState(st) }));
  assert(s.sample && s.seq > 50, `ข้อมูลตัวอย่าง ${JSON.stringify(s)}`);
  full = s.seq;
  assert(!(await page.locator('#banner .bar-bad').count()), `ไม่ควรมีข้อความผิดพลาด: ${await text('#banner')}`);
});

// ---- 1. two tabs at the same moment -------------------------------------------------------------------------
await step('two tabs opened together on an empty demo end with one sample and no error', async () => {
  const ctx2 = await browser.newContext({ viewport: { width: 1366, height: 900 } }); // its own (empty) storage
  // hold the sample load of each tab at a gate: both tabs have found the store empty (as when the browser restores two
  // tabs at once) before either writes anything. Each tab then builds in one go without seeing the other's writes, and
  // the sample is deterministic, so both write the same history – the check is that they end the same with no error.
  // (Loaders that do see each other's writes – one shared store – are covered by tests/fixture.test.mjs.)
  await ctx2.addInitScript(() => {
    const R = (window.RRS = window.RRS || {});
    let fx;
    window.__fxrGate = new Promise((res) => { window.__fxrOpen = res; });
    Object.defineProperty(R, 'fixture', { configurable: true, enumerable: true, get: () => fx, set(v) {
      const load = v.load;
      v.load = async (ledger, o) => {
        window.__fxrWaiting = true;
        await window.__fxrGate;
        return load(ledger, o);
      };
      fx = v;
    } });
  });
  const [a, b] = [await ctx2.newPage(), await ctx2.newPage()];
  watch(a, 'tab-a');
  watch(b, 'tab-b');
  await Promise.all([a.goto(file), b.goto(file)]);
  await Promise.all([a, b].map((p) => p.waitForFunction(() => window.__fxrWaiting === true, null, { timeout: 30000 })));
  await Promise.all([a, b].map((p) => p.evaluate(() => window.__fxrOpen())));
  await Promise.all([ready(a), ready(b)]);
  // the tab that stepped back follows the other one through the store
  for (const p of [a, b]) {
    await p.waitForFunction((n) => window.RRS.app.ledger.state.seq === n, full, { timeout: 20000 })
      .catch(async () => { throw new Error(`แท็บควรมีข้อมูลตัวอย่าง ${full} รายการ ได้ ${await p.evaluate(() => window.RRS.app.ledger.state.seq)} · ${await p.locator('#banner').innerText()}`); });
  }
  const sa = await state((s, R) => ({ head: s.head, verify: R.inventory.verifyBalances(s).length, offcuts: Object.keys(s.tables.offcuts).length, jobs: Object.keys(s.tables.jobs).length }), null, a);
  const sb = await state((s) => ({ head: s.head }), null, b);
  const stored = await a.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => /demo/i.test(k)) || '[]')).length);
  assert(sa.head === sb.head && stored === full, `สองแท็บต้องเห็นข้อมูลชุดเดียวกัน ${JSON.stringify({ sa, sb, stored, full })}`);
  assert(sa.verify === 0 && sa.offcuts === 4 && sa.jobs === 3, `ข้อมูลตัวอย่างต้องไม่ถูกสร้างซ้ำ ${JSON.stringify(sa)}`);
  for (const p of [a, b]) {
    const bad = await p.locator('#banner .bar-bad').count();
    assert(!bad, `แท็บไม่ควรแสดงข้อผิดพลาด: ${await p.locator('#banner').innerText()}`);
  }
  await ctx2.close();
});

// ---- 2. a refused sample step -------------------------------------------------------------------------------
await step('a refused sample step shows its Thai reason and the way out; reset recovers', async () => {
  const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx3.addInitScript(() => {
    // refuse "approve BOM" while building the sample, until the test switches the fault off
    const R = (window.RRS = window.RRS || {});
    let fx;
    Object.defineProperty(R, 'fixture', { configurable: true, enumerable: true, get: () => fx, set(v) {
      const load = v.load;
      v.load = (ledger, o) => {
        if (sessionStorage.getItem('fxr-fault') === 'off') return load(ledger, o);
        const real = ledger.execute.bind(ledger);
        ledger.execute = (cmd, c) => (cmd.kind === 'bom.approve' ? Promise.resolve({ ok: false, errors: [{ code: 'TEST', message: 'ปฏิเสธเพื่อทดสอบ' }] }) : real(cmd, c));
        return load(ledger, o).finally(() => { ledger.execute = real; });
      };
      fx = v;
    } });
  });
  const p = await ctx3.newPage();
  watch(p, 'fault');
  await p.goto(file);
  await ready(p);
  await p.waitForSelector('#banner .bar-bad');
  const msg = await p.locator('#banner .bar-bad').innerText();
  assert(/สร้างข้อมูลตัวอย่างไม่สำเร็จ ขั้นที่ \d+ \(อนุมัติ BOM\): ปฏิเสธเพื่อทดสอบ/.test(msg), `ข้อความควรบอกขั้นและเหตุผล: ${msg}`);
  assert(/ไม่ครบชุด/.test(msg) && /เริ่มข้อมูลตัวอย่างใหม่/.test(msg), `ข้อความควรบอกว่าทำอย่างไรต่อ: ${msg}`);
  await noOverflow('ข้อความผิดพลาดที่ความกว้างโทรศัพท์', p);
  if (shots) await p.screenshot({ path: path.join(shots, 'phone-fixture-refused.png') });
  const partial = await p.evaluate(() => window.RRS.app.ledger.state.seq);
  assert(partial > 0 && partial < full, `ข้อมูลหยุดกลางคัน ${partial}`);
  // the person follows the message: start the sample again
  await p.evaluate(() => sessionStorage.setItem('fxr-fault', 'off'));
  await p.click('#banner button[data-act="_resetDemo"]');
  await dlgOpen(p);
  await dlgSubmit(p);
  await ready(p);
  await p.waitForFunction((n) => window.RRS.app.ledger.state.seq === n, full, { timeout: 20000 });
  assert(!(await p.locator('#banner .bar-bad').count()), `หลังเริ่มใหม่ไม่ควรมีข้อผิดพลาด: ${await p.locator('#banner').innerText()}`);
  await ctx3.close();
});

// ---- 3. QC on the sample ------------------------------------------------------------------------------------
await step('QC inspects the sample side panel: empty value refused, own result not releasable, QC lead releases', async () => {
  const key = await state((s, R) => {
    const b = Object.values(s.tables.balances).find((x) => x.code === 'DEMO-SP-L' && x.status === 'QC_HOLD');
    return b ? R.balanceKey(b) : null;
  });
  assert(key, 'ข้อมูลตัวอย่างควรมีแผงข้างซ้ายรอตรวจ');
  await asUser('DEMO_QC');
  await go('inspections');
  await page.click(`#main button[data-act="startIns"][data-arg="${key}"]`);
  await page.waitForSelector('#ins-form');
  await page.fill('#ins-res-C1', '4200');
  await page.fill('#ins-res-C2', '600');
  await page.locator('#ins-form input[name="res[C4]"][value="ผ่าน"]').check();
  const seq0 = await state((s) => s.seq);
  await page.click('#ins-form form[data-form="ins"] button[type=submit]');
  await waitText('บันทึกไม่ได้ – ยังไม่มีอะไรเปลี่ยน', 6000, '#ins-form');
  assert(await state((s) => s.seq) === seq0, 'ค่าที่ว่างต้องไม่บันทึกอะไร');
  await noOverflow('ฟอร์มตรวจ (desktop)');
  await page.fill('#ins-res-C3', '90');
  await page.click('#ins-form form[data-form="ins"] button[type=submit]');
  await dlgOpen();
  await waitText('ผลผ่านจะรอหัวหน้า QC', 4000, '#dlg');
  await dlgSubmit();
  await dlgClosed();
  await toast('ผ่าน – รอหัวหน้า QC ปล่อยผ่าน');
  const ins = await state((s) => Object.values(s.tables.inspections).filter((i) => i.code === 'DEMO-SP-L').map((i) => ({ id: i.id, result: i.result, status: i.status, by: i.inspector, plan: i.planRev }))[0]);
  assert(ins && ins.result === 'PASS' && ins.status === 'OPEN' && ins.by === 'DEMO_QC' && ins.plan === 'B', `ผลตรวจ ${JSON.stringify(ins)}`);
  // known issue (needsChange, app.js / 52-inspections.js): the measurement was typed just before the save, so its 250 ms
  // live update fires after the form is gone and opens an EMPTY inspection form again – logged, not failed here
  await page.waitForTimeout(500);
  if (await page.locator('#ins-form').count()) console.log('note  หลังบันทึกผลตรวจ มีฟอร์มตรวจว่างเปิดขึ้นมาเอง (live input ค้างหลังกดบันทึก) – ดู needsChange');
  // the inspector cannot release the own result
  await page.waitForSelector('#ins-detail');
  const btn = page.locator('#ins-detail #ins-release-btn');
  assert(!(await btn.count()) || await btn.isDisabled(), 'ผู้ตรวจต้องปล่อยผลของตัวเองไม่ได้');
  await waitText('รอหัวหน้า QC', 4000, '#ins-detail');
  // the QC lead releases it
  await asUser('DEMO_QCLEAD');
  await go('inspections');
  await page.click(`#main [data-act="tab"][data-arg="release"]`);
  await page.click(`#main button[data-act="release"][data-arg="${ins.id}"]`);
  await dlgOpen();
  await page.fill('#rel-qty', '');
  await dlgSubmit();
  await waitText('ใส่จำนวนที่ปล่อย', 4000, '#dlg');
  await page.fill('#rel-qty', '1');
  await clearToasts();
  await dlgSubmit();
  await dlgClosed();
  await toast(`ปล่อยผ่าน ${ins.id} แล้ว`);
  const after = await state((s, R) => ({ avail: R.q.qty(s, { code: 'DEMO-SP-L', wh: '02', status: 'AVAILABLE' }), hold: R.q.qty(s, { code: 'DEMO-SP-L', status: 'QC_HOLD' }),
    status: s.tables.inspections[Object.keys(s.tables.inspections).find((k) => s.tables.inspections[k].code === 'DEMO-SP-L')].status,
    by: Object.values(s.tables.inspections).find((i) => i.code === 'DEMO-SP-L').releasedBy, verify: R.inventory.verifyBalances(s).length }));
  assert(after.avail === 1 && after.hold === 0 && after.status === 'RELEASED' && after.by === 'DEMO_QCLEAD' && after.verify === 0, `หลังปล่อยผ่าน ${JSON.stringify(after)}`);
  await shot('desktop-qc-released');
});

// ---- 4. the self-test from the UAT page ---------------------------------------------------------------------
await step('the UAT page runs the self-test by clicking and writes nothing', async () => {
  await asUser('DEMO_LEAD');
  await go('uat');
  const before = await state((s) => ({ seq: s.seq, head: s.head, uat: JSON.stringify(s.tables.uat) }));
  await clearToasts();
  await page.click('#uat-run');
  await toast('ตรวจอัตโนมัติเสร็จ: ผ่าน 33 ไม่ผ่าน 0');
  await waitText('ผ่าน 33 · ไม่ผ่าน 0');
  const marks = await page.locator('#main .badge', { hasText: 'ต้องให้คนยอมรับ' }).count();
  assert(marks === 7, `เกณฑ์ที่ต้องให้คนยอมรับควรมี 7 ข้อ ได้ ${marks}`);
  const after = await state((s) => ({ seq: s.seq, head: s.head, uat: JSON.stringify(s.tables.uat) }));
  assert(JSON.stringify(after) === JSON.stringify(before), 'การทดสอบอัตโนมัติต้องไม่บันทึกผล UAT หรือแตะข้อมูลของหน้า');
  await noOverflow('หน้า UAT หลังทดสอบ');
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow('หน้า UAT หลังทดสอบ (โทรศัพท์)');
  await shot('phone-uat-selftest');
  await page.setViewportSize({ width: 1366, height: 900 });
});

// ---- 5. HTML in names and remarks ---------------------------------------------------------------------------
await step('names and remarks with HTML show as text on every page (phone and desktop)', async () => {
  await exec('user.upsert', { id: `${KEY}_XSS`, name: `ผู้ใช้ ${XSS}`, roles: ['viewer'] }, 'ADMIN');
  await exec('item.upsert', { create: true, code: `${KEY}-XSS`, name: `สินค้า ${XSS}`, baseUnit: 'ชิ้น', type: 'BUY', group: XSS, remark: XSS }, 'ADMIN');
  await exec('doc.post', { type: 'AJ', ref: XSS, remark: `หมายเหตุ ${XSS}`, lines: [{ code: `${KEY}-XSS`, qty: 2, wh: '01', bin: 'RM-A1', remark: XSS }] }, 'DEMO_LEAD');
  await exec('supplier.upsert', { create: true, id: `${KEY}-SUP`, name: `ผู้ขาย ${XSS}`, contact: XSS }, 'DEMO_PUR');
  await exec('pilot.issue', { severity: 'MINOR', area: XSS, description: `ปัญหา ${XSS}`, ref: XSS }, 'DEMO_STORE');
  await asUser('ADMIN');
  const opt = await page.locator(`#who-sel option[value="${KEY}_XSS"]`).innerText();
  assert(opt.indexOf('<img') >= 0, `ชื่อผู้ใช้ควรแสดงเป็นข้อความ ได้ ${opt}`);
  const ids = await page.evaluate(() => Object.keys(window.RRS.ui.pages));
  for (const vp of [{ w: 390, h: 844 }, { w: 1366, h: 900 }]) {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    for (const id of ids) {
      await go(id);
      const r = await page.evaluate(() => ({ xss: window.__xss || 0, img: document.querySelectorAll('img[src="x"]').length,
        broken: /หน้านี้แสดงไม่ได้/.test(document.querySelector('#main').innerText) }));
      assert(!r.xss && !r.img, `${id} (${vp.w}px): ข้อความ HTML ถูกแปลงเป็นแท็ก ${JSON.stringify(r)}`);
      assert(!r.broken, `${id} (${vp.w}px): หน้านี้แสดงไม่ได้`);
      if (vp.w === 390) await noOverflow(`${id} (390px)`);
    }
  }
  // the item's own pages show the literal text
  await go('items');
  await page.fill('#main input[type=search], #main input[name=q]', `${KEY}-XSS`).catch(() => {});
  await page.waitForTimeout(400);
  const shown = await text('#main');
  assert(shown.indexOf('สินค้า <img src=x') >= 0, `ทะเบียนสินค้าควรแสดงชื่อเป็นข้อความ\n${shown.slice(0, 600)}`);
});

await browser.close();
if (problems.length) {
  console.log('PROBLEMS\n' + problems.join('\n'));
  process.exit(1);
}
console.log('fixture-review ok');
