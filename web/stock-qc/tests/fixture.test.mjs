// Sample data (src/engine/fixture.js) and the in-browser acceptance self-test (src/engine/selftest.js).
//   node --test tests/fixture.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { RRS } from './helpers.mjs';

const NOW = '2026-11-15T03:00:00.000Z'; // 10:00 Bangkok – fixed so the sample is the same on every run
const rows = (s, t, f) => RRS.q.rows(s, t, f);

async function loaded(opts) {
  const store = new RRS.MemoryStore();
  const ledger = new RRS.Ledger(store, { holder: 'fixture-test', sleep: () => Promise.resolve() });
  const info = await RRS.fixture.load(ledger, opts || { now: NOW });
  return { store, ledger, info, s: ledger.state };
}

test('the sample loads into an empty MemoryStore through ledger.execute, small and fast', async () => {
  const t0 = Date.now();
  const { store, info, s } = await loaded();
  assert.ok(info.commits > 50 && info.commits <= 400, `commits ${info.commits}`);
  assert.equal(info.commits, store.commits.length);
  assert.equal(info.commits, info.steps, 'one commit per command, nothing skipped with every module loaded');
  assert.ok(Date.now() - t0 < 3000, 'loads in under 3 s');
  // every commit came from a command with its own request id (a fixed sequence)
  assert.ok(store.commits.every((c) => /^demo-\d{3}-/.test(c.id)));
  assert.equal(new Set(store.commits.map((c) => c.id)).size, store.commits.length);
  // the story happened over the last days, in order, never after "now"
  const ats = store.commits.map((c) => Date.parse(c.at));
  assert.ok(ats.every((t, i) => i === 0 || t > ats[i - 1]), 'commit times increase');
  assert.ok(ats[ats.length - 1] < Date.parse(NOW));
  assert.equal(RRS.util.bkkDate(store.commits[0].at), RRS.util.addDays('2026-11-15', -14));
  assert.equal(s.seq, info.commits);
});

test('balances equal their history, the commit chain verifies and the daily check passes', async () => {
  const { store, s } = await loaded();
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
  let prev = RRS.core.GENESIS;
  for (const c of store.commits) {
    assert.equal(RRS.core.verifyCommit(c), true, `commit ${c.seq}`);
    assert.equal(c.prev, prev, `commit ${c.seq} follows the one before`);
    prev = c.hash;
  }
  assert.equal(s.head, prev);
  const v = RRS.reports.verifyBackup(store.commits, { compare: s });
  assert.deepEqual(v.problems, []);
  const d = RRS.reports.dailyCheck(s);
  assert.deepEqual(d.problems, []);
  assert.ok(rows(s, 'balances').every((b) => b.qty > 0), 'no negative or zero balance rows');
});

test('everything is clearly sample data: company, DEMO codes, role users, no customer names', async () => {
  const { s, store } = await loaded();
  const st = s.tables.settings.main;
  assert.equal(st.company, 'ข้อมูลตัวอย่าง');
  assert.equal(RRS.fixture.isSampleState(s), true);
  const items = rows(s, 'items');
  assert.ok(items.length >= 20 && items.length <= 30, `items ${items.length}`);
  for (const it of items) {
    assert.ok(it.id.startsWith('DEMO-'), it.id);
    assert.ok(RRS.fixture.isSample(it.id));
    assert.match(it.remark, /ตัวอย่าง/);
  }
  for (const sup of rows(s, 'suppliers')) {
    assert.ok(sup.id.startsWith('DEMO-'), sup.id);
    assert.match(sup.name, /\(ตัวอย่าง\)/);
    assert.equal(sup.taxId, '', 'no made-up tax ids');
  }
  // one user per role, named by the role and marked as sample; the administrator keeps the id ADMIN
  const users = rows(s, 'users');
  const roles = new Set(users.flatMap((u) => u.roles));
  for (const r of Object.keys(RRS.auth.ROLES)) assert.ok(roles.has(r), `role ${r}`);
  for (const u of users) {
    assert.ok(u.id === 'ADMIN' || u.id.startsWith('DEMO_'), u.id);
    assert.match(u.name, /\(ตัวอย่าง\)$/);
    assert.equal(u.accountId, '', 'sample users are not bound to real accounts');
  }
  for (const r of Object.keys(RRS.auth.ROLES)) assert.equal(users.filter((u) => u.roles.includes(r)).length, 1, `one user with role ${r}`);
  // jobs: SO numbers only, never a customer name
  const jobs = rows(s, 'jobs');
  assert.ok(jobs.length >= 2);
  for (const j of jobs) assert.match(j.soNo, /^SO-DEMO-\d{3}$/);
  const text = JSON.stringify(store.commits);
  assert.ok(!/customerName/.test(text), 'no customer name field anywhere');
  for (const j of jobs.filter((x) => x.source === 'sales')) {
    assert.ok(j.customerId.startsWith('DEMO-') && j.orderId.startsWith('DEMO-') && j.productionJobId.startsWith('DEMO-'));
  }
  // decisions answered as examples
  for (const id of ['Q01', 'Q02']) {
    const d = s.tables.decisions[id];
    assert.equal(d.status, 'decided');
    assert.match(d.answer, /^ตัวอย่าง/);
    assert.match(d.decidedBy, /ตัวอย่าง/);
  }
  assert.equal(rows(s, 'decisions', (d) => d.status === 'decided').length, 2, 'the other decisions stay open');
  for (const u of rows(s, 'uat')) assert.match(u.evidence + ' ' + u.note, /ตัวอย่าง/);
  // sample UAT results never make a phase look accepted (every phase with records has one not passed)
  for (const ph of new Set(rows(s, 'uat').map((u) => u.phase))) {
    assert.ok(rows(s, 'uat', (u) => u.phase === ph).some((u) => u.status !== 'PASS'), `phase ${ph} looks fully passed`);
  }
  assert.equal(rows(s, 'uat_signoffs').length, 0, 'no sample sign-off – acceptance is never faked');
  assert.equal(rows(s, 'rollouts').length, 0);
});

test('the content covers every phase (warehouses, BOM, purchasing, QC, jobs, transfer, Express, count, offcuts, UAT)', async () => {
  const { s, info } = await loaded();
  const P = RRS.planning;
  // Phase 0: warehouses with bins, units, an approved BOM, pilot scope
  assert.deepEqual(rows(s, 'warehouses').map((w) => [w.code, w.name]).sort(), [['01', 'คลังวัตถุดิบ'], ['02', 'คลังชิ้นส่วนรอประกอบ'], ['03', 'คลังสินค้าสำเร็จรูป']]);
  assert.ok(rows(s, 'bins', (b) => b.wh === '01').length >= 3 && rows(s, 'bins', (b) => b.wh === '02').length >= 3);
  assert.deepEqual(s.tables.settings.main.pilot.warehouses, ['01', '02', '03']);
  assert.ok(s.tables.settings.main.pilot.groups.length >= 1);
  assert.equal(s.tables.item_units['DEMO-CH100|เส้น'].factor, 56);
  const bom = s.tables.boms['DEMO-DB6|A'];
  assert.equal(bom.status, 'APPROVED');
  assert.ok(bom.lines.length >= 15);
  const plates = rows(s, 'items', (i) => i.trackLot === 'heat');
  assert.ok(plates.length >= 3 && plates.every((i) => i.certRequired && i.qcIncoming));
  assert.ok(rows(s, 'items', (i) => i.side === 'L').length && rows(s, 'items', (i) => i.side === 'R').length, 'L/R parts');
  assert.ok(rows(s, 'items', (i) => i.type === 'PART' && i.qcFinal).length >= 2);
  assert.ok(rows(s, 'items', (i) => i.type === 'FG').length === 1);
  // opening balances: one AJ, keyed in Express
  const ajs = rows(s, 'documents', (d) => d.type === 'AJ' && !d.source);
  assert.equal(ajs.length, 1);
  assert.equal(ajs[0].expressStatus, 'KEYED');
  // Phase 4: suppliers + terms, PR approved → PO partially received with heat lots and certificates, a late PO
  assert.equal(rows(s, 'suppliers').length, 3);
  assert.ok(rows(s, 'item_suppliers').length >= 8);
  const pr = rows(s, 'prs')[0];
  assert.equal(pr.status, 'CONVERTED');
  assert.ok(pr.approvedBy && pr.approvedBy !== pr.requestedBy);
  const partial = rows(s, 'pos', (p) => p.status === 'PARTIAL');
  assert.equal(partial.length, 1);
  assert.ok(RRS.purchasing.outstanding(s, { today: info.today }).some((l) => l.late), 'a late PO line');
  const heats = rows(s, 'lots', (l) => l.poNo === partial[0].poNo);
  assert.equal(heats.length, 2);
  assert.ok(heats.every((l) => l.cert.no));
  assert.ok(heats.some((l) => l.cert.verified));
  // Phase 5: one PASS released, one FAIL → NCR decided REWORK, an FR waiting for QC
  const insp = rows(s, 'inspections');
  assert.ok(insp.some((i) => i.result === 'PASS' && i.status === 'RELEASED' && i.releasedBy !== i.inspector));
  const fail = insp.find((i) => i.result === 'FAIL');
  assert.ok(fail);
  const ncr = s.tables.ncrs[fail.ncrNo];
  assert.deepEqual([ncr.status, ncr.disposition], ['DISPOSITIONED', 'REWORK']);
  assert.ok(RRS.q.qty(s, { code: fail.code, lot: fail.lot, status: 'REWORK' }) > 0);
  const fr = rows(s, 'documents', (d) => d.type === 'FR');
  assert.equal(fr.length, 1);
  assert.equal(fr[0].lines[0].status, 'QC_HOLD');
  assert.equal(rows(s, 'qc_plans', (p) => p.status === 'APPROVED').length, 3);
  // Phase 2: one job fully reserved, one short, a pick and a production record
  const [j1, j2] = info.jobs;
  const r1 = P.readiness(s, j1);
  const r2 = P.readiness(s, j2);
  const fromStock = (job) => s.tables.jobs[job].lines.filter((l) => !l.output && !(l.toMake > 0));
  for (const l of fromStock(j1)) {
    const rl = r1.lines.find((x) => x.line === l.line);
    assert.equal(RRS.util.round(rl.issued + rl.reservedRemaining), rl.required, `${j1} ${l.code} covered`);
  }
  assert.ok(r2.lines.filter((x) => x.missing > 0 && x.statusCode === 'SHORT').length >= 2, `${j2} is short`);
  assert.ok(rows(s, 'documents', (d) => d.type === 'PD' && d.job === j1 && d.source === 'pick').length === 1);
  assert.ok(s.tables.jobs[j1].lines.some((l) => l.finished > 0));
  // Phase 1/3: a transfer in transit, an Express batch with differences, a count waiting for approval
  assert.equal(rows(s, 'documents', (d) => d.type === 'TR' && d.status === 'IN_TRANSIT').length, 1);
  const batch = rows(s, 'express_batches')[0];
  assert.equal(batch.status, 'REVIEW');
  const rec = RRS.reconcile.reconcile(s, batch.id);
  assert.ok(rec.totals.DIFF >= 2 && rec.totals.UNKNOWN_CODE === 1 && rec.totals.MATCH >= 3, JSON.stringify(rec.totals));
  assert.equal(rec.totals.resolved, 1);
  const ct = rows(s, 'count_sessions')[0];
  assert.equal(ct.status, 'SUBMITTED');
  const view = RRS.reconcile.countView(s, ct.id);
  assert.ok(view.canApprove && view.aj.length >= 2, 'differences confirmed by a recount, waiting for approval');
  assert.ok(view.lines.some((l) => (l.flags || []).includes('RECOUNTED')));
  // the approver must be someone who neither counted nor submitted (the accounting sample user can)
  const appr = RRS.core.prepare(s, { kind: 'count.approve', payload: { id: ct.id, reasons: Object.fromEntries(view.aj.map((a) => [a.key, 'ตัวอย่าง'])) } },
    { now: NOW, user: 'DEMO_ACC' });
  assert.equal(appr.ok, true, JSON.stringify(appr.errors));
  // Phase 6: offcuts (one used with a piece left), UAT examples, training, a pilot issue, a daily check
  const oc = rows(s, 'offcuts');
  assert.ok(oc.length >= 3 && oc.some((o) => o.status === 'USED' && o.children.length === 1));
  assert.ok(rows(s, 'uat').length >= 3);
  assert.ok(rows(s, 'uat', (u) => u.status === 'FAIL').length >= 1);
  assert.equal(rows(s, 'trainings').length, 1);
  assert.equal(rows(s, 'pilot_issues').length, 1);
  assert.equal(rows(s, 'daily_checks')[0].ok, true);
  // Sales Office job (ids only), not mapped yet
  const sj = rows(s, 'jobs', (j) => j.source === 'sales');
  assert.equal(sj.length, 1);
  assert.equal(sj[0].product, '');
});

test('the sample is only put into an empty store; it is the same with the real clock', async () => {
  const { ledger, store } = await loaded();
  // the sample is there already (another tab built it): nothing is written, no error
  const n = store.commits.length;
  const again = await RRS.fixture.load(ledger);
  assert.deepEqual([again.concurrent, again.commits, store.commits.length], [true, n, n]);
  // other data (a real start, team data): refused, never written over
  const other = new RRS.MemoryStore();
  const ol = new RRS.Ledger(other, { holder: 'fixture-test', sleep: () => Promise.resolve() });
  assert.equal((await ol.execute({ kind: 'system.bootstrap', payload: { name: 'ผู้ดูแล', userId: 'ADMIN' }, requestId: 'real-1' }, {})).ok, true);
  await assert.rejects(() => RRS.fixture.load(ol), /ยังว่าง.*มีข้อมูลแล้ว 1 รายการ/);
  assert.equal(other.commits.length, 1);
  const live = await loaded({});
  assert.deepEqual(RRS.inventory.verifyBalances(live.s), []);
  assert.ok(Date.parse(live.store.commits[live.store.commits.length - 1].at) <= Date.now());
  assert.equal(live.info.commits, (await loaded()).info.commits);
});

test('a refused command stops the load with its Thai message', async () => {
  const store = new RRS.MemoryStore();
  const ledger = new RRS.Ledger(store, { holder: 'fixture-test', sleep: () => Promise.resolve() });
  const real = ledger.execute.bind(ledger);
  ledger.execute = (cmd, ctx) => (cmd.kind === 'bom.approve'
    ? Promise.resolve({ ok: false, errors: [{ code: 'TEST', message: 'ปฏิเสธเพื่อทดสอบ' }] }) : real(cmd, ctx));
  await assert.rejects(() => RRS.fixture.load(ledger, { now: NOW }), /สร้างข้อมูลตัวอย่างไม่สำเร็จ ขั้นที่ \d+ \(อนุมัติ BOM\): ปฏิเสธเพื่อทดสอบ – .*ไม่ครบชุด.*เริ่มข้อมูลตัวอย่างใหม่/);
});

test('two tabs building the sample at the same moment: one builds it, the other waits quietly – never twice or mixed', async () => {
  const single = (await loaded()).store.commits.map((c) => c.id);
  const store = new RRS.MemoryStore();
  store.delay = 1; // both loaders really interleave
  const tab = (h) => new RRS.Ledger(store, { holder: h, sleep: () => Promise.resolve() });
  const [a, b] = [tab('tab-a'), tab('tab-b')];
  const out = await Promise.allSettled([RRS.fixture.load(a, { now: NOW }), RRS.fixture.load(b, { now: NOW })]);
  assert.deepEqual(out.map((x) => x.status), ['fulfilled', 'fulfilled'], JSON.stringify(out.map((x) => x.reason && x.reason.message)));
  const infos = out.map((x) => x.value);
  assert.equal(infos.filter((i) => i.concurrent).length, 1, 'exactly one loader stepped back');
  assert.equal(infos.filter((i) => !i.concurrent)[0].commits, single.length);
  store.delay = 0;
  assert.deepEqual(store.commits.map((c) => c.id), single, 'the store holds one sample, the same as a single load');
  await b.catchUp();
  assert.deepEqual(RRS.inventory.verifyBalances(b.state), []);
  assert.equal(RRS.q.rows(b.state, 'offcuts').length, 4);
  assert.equal(b.state.head, a.state.head);
});

test('someone else saving while the sample is built stops it with a clear Thai reason', async () => {
  const store = new RRS.MemoryStore();
  const ledger = new RRS.Ledger(store, { holder: 'fixture-test', sleep: () => Promise.resolve() });
  const other = new RRS.Ledger(store, { holder: 'other-tab', sleep: () => Promise.resolve() });
  const real = ledger.execute.bind(ledger);
  ledger.execute = async (cmd, ctx) => {
    if (cmd.kind === 'master.import') {
      const r = await other.execute({ kind: 'user.upsert', payload: { id: 'OTHER', name: 'อีกหน้าต่าง', roles: ['viewer'] }, requestId: 'other-1' },
        { user: 'ADMIN', now: ctx.now });
      assert.equal(r.ok, true, JSON.stringify(r.errors));
    }
    return real(cmd, ctx);
  };
  await assert.rejects(() => RRS.fixture.load(ledger, { now: NOW }), /ขั้นที่ \d+ \(.+\): มีการบันทึกจากหน้าต่างหรือผู้ใช้อื่นระหว่างสร้างข้อมูลตัวอย่าง – .*เริ่มข้อมูลตัวอย่างใหม่/);
  assert.ok(store.commits.length < 30, 'stopped right there');
});

test('selftest: every acceptance criterion of Phase 0–6 passes in its own fresh world', async () => {
  const progress = [];
  const results = await RRS.selftest.run({ onProgress: (p) => progress.push(p) });
  const ids = RRS.reports.UAT_CRITERIA.map((c) => c.id);
  assert.deepEqual(results.map((r) => r.id), ids, 'the same ids as the UAT checklist');
  for (const r of results) {
    const c = RRS.reports.UAT_CRITERIA.find((x) => x.id === r.id);
    assert.equal(r.criterion, c.criterion);
    assert.equal(r.phase, c.phase);
    assert.equal(r.pass, true, `${r.id} ${r.criterion}: ${r.detail}`);
    assert.match(r.detail, /[฀-๿]/, 'Thai detail');
    assert.ok(r.checks > 0);
  }
  assert.equal(progress.length, ids.length);
  assert.deepEqual(progress[progress.length - 1].done, ids.length);
  assert.deepEqual(RRS.selftest.summary(results), { total: ids.length, pass: ids.length, fail: 0 });
  assert.deepEqual(RRS.selftest.ids().sort(), ids.slice().sort(), 'a scenario for every criterion');
  // criteria that only people (or the team's real data) can settle say so – a test on test data is never the acceptance
  const manual = results.filter((r) => r.manual).map((r) => r.id);
  assert.deepEqual(manual, ['P0-1', 'P0-2', 'P0-3', 'P6-2', 'P6-3', 'P6-4', 'P6-5']);
  for (const r of results) {
    if (r.manual) {
      assert.match(r.accept, /[฀-๿]/);
      assert.ok(r.detail.endsWith('ยังไม่ใช่การยอมรับจริง: ' + r.accept), r.detail);
    } else assert.equal(r.accept, '');
  }
  for (const id of ['P0-3', 'P6-3']) assert.match(results.find((r) => r.id === id).accept, /ไฟล์สำรองจริงของทีม/);
  assert.match(results.find((r) => r.id === 'P1-2').detail, /หน่วยความจำ.*สองเครื่อง/);
});

test('selftest catches a store that lets two people save on top of the same balance', async () => {
  const MS = RRS.MemoryStore.prototype;
  const orig = MS.append;
  MS.append = async function (commit) { // no conflict check: a lost update
    if (this.delay) await new Promise((r) => setTimeout(r, this.delay));
    this.commits.push(JSON.parse(JSON.stringify(commit)));
    return { ok: true };
  };
  try {
    const res = await RRS.selftest.run({ only: ['P1-2', 'P2-1'] });
    assert.deepEqual(res.map((r) => [r.id, r.pass]), [['P1-2', false], ['P2-1', false]]);
    assert.match(res[0].detail, /^ไม่ผ่าน .*จำนวนคนที่เบิกสำเร็จ: ได้ 2 ควรเป็น 1/);
  } finally {
    MS.append = orig;
  }
  assert.equal(RRS.selftest.summary(await RRS.selftest.run({ only: ['P1-2', 'P2-1'] })).pass, 2);
});

test('selftest never touches the data of the page and reports a broken rule as a Thai failure', async () => {
  const { store, s } = await loaded();
  const before = JSON.stringify(store.commits);
  const head = s.head;
  const results = await RRS.selftest.run({ only: ['P1-2', 'P1-3'] });
  assert.equal(results.length, 2);
  assert.equal(JSON.stringify(store.commits), before);
  assert.equal(s.head, head);
  // a ledger that forgets request ids posts twice – the criterion must fail and say why
  const orig = RRS.Ledger.prototype._execute;
  RRS.Ledger.prototype._execute = function (command, ctx) { return orig.call(this, Object.assign({}, command, { requestId: '' }), ctx); };
  try {
    const [r] = await RRS.selftest.run({ only: ['P1-3'] });
    assert.equal(r.pass, false);
    assert.match(r.detail, /^ไม่ผ่าน/);
    assert.match(r.detail, /คำขอซ้ำ/);
  } finally {
    RRS.Ledger.prototype._execute = orig;
  }
});
