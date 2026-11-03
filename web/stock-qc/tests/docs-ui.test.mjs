// Guided document UI against the real engine/ledger. Only dialogs and DOM form controls are replaced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { RRS, world, stockIn } from './helpers.mjs';

for (const file of ['ui/kit.js', 'ui/pages/10-docs.js']) vm.runInThisContext(readFileSync(new URL('../src/' + file, import.meta.url), 'utf8'), { filename: file });
const page = RRS.ui.pages.docs;
const arg = (value) => ({ dataset: { arg: value } });
const values = (extra = {}) => ({ date: '2026-11-03', job: '', ref: '', department: '', remark: '',
  lines: [{ code: 'TST-001', qty: '3', unit: '', wh: 'A', bin: 'A-01', lot: '', remark: '' }], ...extra });

async function setup(userId = 'STORE1') {
  const w = await world();
  const ledger = w.ledgerFor(userId);
  await ledger.catchUp();
  let mounted = null;
  const calls = [], checks = [], confirms = [], notices = [];
  const ctx = { get state() { return ledger.state; }, get user() { return ledger.state.tables.users[userId]; },
    view: {}, today: '2026-11-03', now: '2026-11-03T02:00:00Z',
    can: (permission, wh) => RRS.auth.can(ledger.state.tables.users[userId], permission, wh),
    userName: (id) => id, item: (id) => RRS.q.item(ledger.state, id),
    set(patch) { Object.assign(this.view, patch); mounted = null; },
    toast(message, tone) { notices.push({ message, tone }); },
    confirmation: true,
    async confirm(options) { confirms.push(options); return typeof ctx.confirmation === 'function' ? ctx.confirmation(options) : ctx.confirmation; },
    async exec(kind, payload) { calls.push({ kind, payload: structuredClone(payload) }); return w.exec(userId, kind, payload); },
    check(kind, payload) { checks.push({ kind, payload: structuredClone(payload) }); return ledger.check({ kind, payload }, { user: userId, now: ctx.now }); },
    async dialog(options) { return ctx.dialogValues ? options.onSubmit(ctx.dialogValues) : null; },
  };
  RRS.app = { ledger };
  globalThis.document = { querySelector: () => mounted };
  function mount(data, bad = false) {
    const elements = [];
    for (const [name, value] of Object.entries(data)) {
      if (name === 'lines') value.forEach((line, i) => Object.entries(line).forEach(([key, v]) => elements.push({ name: `lines[${i}][${key}]`, value: String(v), type: key === 'qty' ? 'number' : 'text' })));
      else elements.push({ name, value: String(value), type: 'text' });
    }
    for (const e of elements) Object.assign(e, { disabled: false, validity: { badInput: bad && e.type === 'number' }, closest: () => null,
      getAttribute: () => 'จำนวน' });
    mounted = { elements, reportValidity: () => true, querySelectorAll: () => elements.filter((e) => e.type === 'number') };
    return mounted;
  }
  return { w, ctx, calls, checks, confirms, notices, mount, ledger, html: () => String(page.render(ctx)), documents: () => Object.values(ledger.state.tables.documents || {}) };
}

test('all manual types have Thai cards; selecting a type or homepage shortcut never persists a draft', async () => {
  const f = await setup('ADMIN');
  page.actions.newDoc(f.ctx);
  const html = f.html();
  for (const [type] of Object.entries(RRS.inventory.DOC_TYPES).filter(([type]) => RRS.inventory.manualType(type))) assert.ok(html.includes(`data-arg="${type}"`), type);
  assert.ok(!html.includes('data-arg="QS"'));
  page.actions.chooseType(f.ctx, arg('RR'));
  assert.equal(f.documents().length, 0);
  assert.equal(f.calls.length, 0);
  assert.match(f.html(), /รับสินค้าเข้า/);
  assert.doesNotMatch(f.html(), /id="docs-list"|class="split"/);
  assert.equal((f.html().match(/btn-primary/g) || []).length, 1);
  f.ctx.view.createType = 'TR';
  assert.match(f.html(), /โอนย้ายสินค้า/);
  assert.equal(f.ctx.view.newType, 'TR');
  assert.equal(f.calls.length, 0);
});

test('review is read-only; cancelling confirmation does not save; confirming posts a new document once', async () => {
  const f = await setup();
  page.actions.chooseType(f.ctx, arg('RR'));
  const data = values();
  page.forms.draft(f.ctx, data, f.mount(data));
  assert.equal(f.ctx.view.step, 'review');
  assert.equal(f.calls.length, 0);
  assert.equal(f.documents().length, 0);
  assert.match(f.html(), /ยืนยันบันทึกเอกสาร/);
  f.ctx.confirmation = false;
  await page.actions.post(f.ctx);
  assert.equal(f.calls.length, 0);
  assert.equal(f.documents().length, 0);
  f.ctx.confirmation = true;
  await page.actions.post(f.ctx);
  assert.deepEqual(f.calls.map((c) => c.kind), ['doc.post']);
  assert.equal(f.documents().length, 1);
  assert.equal(f.documents()[0].status, 'POSTED');
  assert.equal(RRS.q.qty(f.ctx.state, { code: 'TST-001', wh: 'A' }), 3);
  await page.actions.post(f.ctx);
  assert.equal(f.calls.length, 1);
});

test('explicit save creates a draft without stock movement and preserves linked line metadata', async () => {
  const f = await setup();
  const saved = await f.w.ok('STORE1', 'doc.saveDraft', { type: 'RR', lines: [{ code: 'TST-001', qty: 3, wh: 'A', bin: 'A-01',
    poNo: 'PO-LINK', poLine: 2, reservationId: 'RES-LINK', jobNo: 'JOB-LINK', replace: true, unitCost: 80 }] });
  page.actions.pick(f.ctx, arg(saved.result.docNo));
  f.mount(values({ lines: [{ code: 'TST-001', qty: '4', wh: 'A', bin: 'A-01' }] }));
  await page.actions.saveDraft(f.ctx);
  const doc = f.documents()[0];
  assert.equal(doc.status, 'DRAFT');
  assert.equal(Number(doc.lines[0].qty), 4);
  for (const [key, expected] of Object.entries({ poNo: 'PO-LINK', poLine: 2, reservationId: 'RES-LINK', jobNo: 'JOB-LINK', replace: true, unitCost: 80 })) assert.equal(doc.lines[0][key], expected);
  assert.equal(RRS.q.qty(f.ctx.state, { code: 'TST-001', wh: 'A' }), 0);
});

test('invalid or incomplete lines stay editable; browser-invalid numbers never disappear into a valid post', async () => {
  const f = await setup();
  page.actions.chooseType(f.ctx, arg('RR'));
  for (const line of [{ code: 'UNKNOWN', qty: '3', wh: 'A' }, { code: '', qty: '3', wh: 'A' }, { code: 'TST-001', qty: '-1', wh: 'A' }]) {
    const data = values({ lines: [line] });
    page.forms.draft(f.ctx, data, f.mount(data));
    assert.equal(f.ctx.view.step, 'items');
    assert.equal(f.ctx.view.checked.ok, false);
  }
  const before = f.checks.length;
  const data = values();
  page.forms.draft(f.ctx, data, f.mount(data, true));
  assert.equal(f.checks.length, before);
  assert.ok(f.notices.some((n) => n.tone === 'bad'));
  assert.equal(f.calls.length, 0);
});

test('draft-only planner can review/save but never sees or executes stock posting', async () => {
  const f = await setup('PLAN');
  page.actions.chooseType(f.ctx, arg('PD'));
  const data = values();
  page.forms.draft(f.ctx, data, f.mount(data));
  assert.equal(f.ctx.view.step, 'review');
  assert.doesNotMatch(f.html(), /data-act="post"/);
  await page.actions.post(f.ctx);
  assert.equal(f.calls.length, 0);
  await page.actions.saveDraft(f.ctx);
  assert.equal(f.documents()[0].status, 'DRAFT');
  assert.equal(RRS.q.qty(f.ctx.state, { code: 'TST-001', wh: 'A' }), 0);
});

test('negative stock follows existing approval policy and preserves separation of duties', async () => {
  const f = await setup();
  await f.w.ok('ADMIN', 'settings.update', { patch: { policies: { negativeStock: 'approve' } } });
  await f.ledger.catchUp();
  page.actions.chooseType(f.ctx, arg('OU'));
  const data = values();
  page.forms.draft(f.ctx, data, f.mount(data));
  assert.equal(f.ctx.view.step, 'review');
  assert.match(f.html(), /data-act="requestOverride"/);
  await page.actions.requestOverride(f.ctx); // cancel reason dialog
  assert.equal(f.calls.length, 0);
  f.ctx.dialogValues = { reason: 'เร่งใช้ชิ้นส่วนและรอคีย์รับเข้า' };
  await page.actions.requestOverride(f.ctx);
  assert.deepEqual(f.calls.map((c) => c.kind), ['doc.saveDraft', 'doc.requestOverride']);
  const doc = f.documents()[0];
  assert.equal(doc.status, 'WAIT_APPROVAL');
  assert.equal(RRS.q.qty(f.ctx.state, { code: 'TST-001', wh: 'A' }), 0);
  const denied = await f.w.exec('STORE1', 'doc.approveOverride', { docNo: doc.docNo });
  assert.equal(denied.ok, false);
  await f.w.ok('LEAD', 'doc.approveOverride', { docNo: doc.docNo });
  await f.ledger.catchUp();
  assert.equal(RRS.q.qty(f.ctx.state, { code: 'TST-001', wh: 'A' }), -3);
});

test('concurrent stock usage is revalidated and cannot create negative stock or an extra draft', async () => {
  const f = await setup();
  await stockIn(f.w, 'TST-001', 'A', 'A-01', 3);
  await f.ledger.catchUp();
  page.actions.chooseType(f.ctx, arg('OU'));
  const data = values();
  page.forms.draft(f.ctx, data, f.mount(data));
  assert.equal(f.ctx.view.checked.ok, true);
  f.ctx.confirmation = async () => {
    await f.w.ok('STORE2', 'doc.post', { type: 'OU', lines: data.lines });
    return true;
  };
  await page.actions.post(f.ctx);
  assert.equal(f.ctx.view.checked.ok, false);
  assert.equal(f.documents().filter((d) => d.type === 'OU').length, 1);
  assert.equal(f.documents().filter((d) => d.status === 'DRAFT').length, 0);
  assert.equal(RRS.q.qty(f.ctx.state, { code: 'TST-001', wh: 'A' }), 0);
});

test('edited draft is not saved until confirmation and a changed draft requires fresh review', async () => {
  const f = await setup();
  const saved = await f.w.ok('STORE1', 'doc.saveDraft', { type: 'RR', lines: values().lines });
  page.actions.pick(f.ctx, arg(saved.result.docNo));
  const data = values({ remark: 'แก้ข้อความ' });
  page.forms.draft(f.ctx, data, f.mount(data));
  f.ctx.confirmation = false;
  await page.actions.post(f.ctx);
  assert.equal(f.calls.length, 0);
  assert.equal(f.documents()[0].remark, '');
  await f.w.ok('STORE2', 'doc.saveDraft', { type: 'RR', docNo: saved.result.docNo, remark: 'อีกคนแก้แล้ว', lines: values().lines });
  await f.ledger.catchUp();
  f.ctx.confirmation = true;
  await page.actions.post(f.ctx);
  assert.equal(f.calls.length, 0);
  assert.equal(f.ctx.view.step, 'items');
  assert.equal(f.documents()[0].remark, 'อีกคนแก้แล้ว');
});

test('post-only grant can post new receipts and existing unedited drafts without acquiring draft permission', async () => {
  const f = await setup('VIEW');
  await f.w.ok('ADMIN', 'user.upsert', { id: 'VIEW', name: 'Post only', roles: ['viewer'], permissions: { 'doc.post': true } });
  await f.ledger.catchUp();
  page.actions.chooseType(f.ctx, arg('RR'));
  const data = values();
  page.forms.draft(f.ctx, data, f.mount(data));
  assert.doesNotMatch(f.html(), /data-act="saveDraft"/);
  await page.actions.post(f.ctx);
  assert.equal(f.documents()[0].status, 'POSTED');
  const saved = await f.w.ok('STORE1', 'doc.saveDraft', { type: 'RR', lines: data.lines });
  await f.ledger.catchUp();
  page.actions.pick(f.ctx, arg(saved.result.docNo));
  assert.doesNotMatch(f.html(), /data-form="draft"/);
  page.actions.check(f.ctx);
  await page.actions.post(f.ctx);
  assert.equal(f.documents().find((d) => d.docNo === saved.result.docNo).status, 'POSTED');
  assert.deepEqual(f.calls.map((c) => c.kind), ['doc.post', 'doc.post']);
});

test('viewer sees no create actions and user text is escaped in review', async () => {
  const viewer = await setup('VIEW');
  assert.doesNotMatch(viewer.html(), /data-act="newDoc"/);
  page.actions.chooseType(viewer.ctx, arg('RR'));
  assert.equal(viewer.ctx.view.newType, undefined);
  const f = await setup();
  page.actions.chooseType(f.ctx, arg('RR'));
  const data = values({ remark: '<img src=x onerror=alert(1)>' });
  page.forms.draft(f.ctx, data, f.mount(data));
  assert.doesNotMatch(f.html(), /<img src=x/);
  assert.match(f.html(), /&lt;img/);
});

test('line cards keep labels, preserve blank rows, and promote required lot after selecting a tracked item', async () => {
  const f = await setup();
  page.actions.chooseType(f.ctx, arg('RR'));
  assert.match(f.html(), /class="docs-line"/);
  assert.doesNotMatch(f.html(), /class="tbl dense"/);
  f.mount(values({ lines: [{ code: '', qty: '', wh: 'A' }] }));
  page.actions.addLine(f.ctx);
  assert.equal(f.ctx.view.lines.length, 2);
  assert.equal(f.ctx.view.lines[1].wh, 'A');
  f.mount(values({ lines: [{ code: 'TST-PLATE', qty: '1', wh: 'A', bin: 'A-01' }, { code: '', qty: '', wh: 'A' }] }));
  page.actions.lineItem(f.ctx);
  const html = f.html();
  assert.match(html, /สินค้านี้ต้องระบุล็อต/);
  const firstCard = html.slice(html.indexOf('<fieldset'), html.indexOf('</fieldset>'));
  assert.ok(firstCard.indexOf('name="lines[0][lot]"') < firstCard.indexOf('<details'));
  assert.match(firstCard, /name="lines\[0\]\[lot\]" required/);
  assert.equal(f.calls.length, 0);
});

test('saving a partial draft is allowed while review shows resolved unit conversion and stock status', async () => {
  const f = await setup();
  page.actions.chooseType(f.ctx, arg('RR'));
  const incomplete = values({ lines: [{ code: 'TST-001', qty: '', wh: 'A' }] });
  const form = f.mount(incomplete);
  form.reportValidity = () => false;
  await page.actions.saveDraft(f.ctx);
  assert.equal(f.documents()[0].status, 'DRAFT');
  const data = values({ lines: [{ code: 'TST-001', qty: '2', unit: 'โหล', wh: 'A', bin: 'A-01' }] });
  page.forms.draft(f.ctx, data, f.mount(data));
  assert.equal(f.ctx.view.reviewLines[0].base, 24);
  assert.equal(f.ctx.view.reviewLines[0].status, 'AVAILABLE');
  assert.match(f.html(), /24/);
  assert.match(f.html(), /สถานะของ/);
});
