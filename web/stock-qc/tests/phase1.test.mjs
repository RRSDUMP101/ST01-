// Phase 0 + Phase 1 acceptance criteria (file 01) and the base engine guarantees.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RRS, world, stockIn } from './helpers.mjs';

const qty = (s, f) => RRS.q.qty(s, f);

test('sha256 matches the standard test vectors', () => {
  assert.equal(RRS.util.sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(RRS.util.sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(RRS.util.sha256('a'.repeat(1000)).length, 64);
});

test('bootstrap only once; commands need a known user with the right role', async () => {
  const w = await world();
  const again = await w.exec('ADMIN', 'system.bootstrap', { name: 'x' });
  assert.equal(again.ok, false);
  const nobody = await w.exec('GHOST', 'item.upsert', { code: 'X', name: 'x', baseUnit: 'ชิ้น' });
  assert.equal(nobody.errors[0].code, 'NO_USER');
  const viewer = await w.exec('VIEW', 'item.upsert', { code: 'X', name: 'x', baseUnit: 'ชิ้น' });
  assert.equal(viewer.errors[0].code, 'NO_PERMISSION');
});

test('Phase 0: codes that read the same are refused; alt codes resolve to the item', async () => {
  const w = await world();
  const clash = await w.exec('LEAD', 'item.upsert', { code: 'tst 001', name: 'dup', baseUnit: 'ชิ้น' });
  assert.equal(clash.ok, false);
  assert.equal(clash.errors[0].code, 'CODE_CLASH');
  await w.ok('LEAD', 'item.upsert', { code: 'TST-003', name: 'สาม', baseUnit: 'ชิ้น', expressCode: 'EXP-3', countCode: '01-0003' });
  const s = await w.state();
  assert.equal(RRS.q.item(s, 'exp-3').id, 'TST-003');
  assert.equal(RRS.q.item(s, '01 0003').id, 'TST-003');
  const clash2 = await w.exec('LEAD', 'item.upsert', { code: 'TST-004', name: 'สี่', baseUnit: 'ชิ้น', expressCode: 'TST003' });
  assert.equal(clash2.errors[0].code, 'CODE_CLASH');
});

test('Phase 0: bulk import is all-or-nothing with the row of every error', async () => {
  const w = await world();
  const before = await w.state();
  const n = Object.keys(before.tables.items).length;
  const r = await w.exec('LEAD', 'master.import', { items: [
    { code: 'NEW-1', name: 'ใหม่', baseUnit: 'ชิ้น' }, { code: 'NEW-2', name: '', baseUnit: 'ชิ้น' }] });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].row, 2);
  const after = await w.state();
  assert.equal(Object.keys(after.tables.items).length, n);
});

test('Phase 1: same SKU in warehouse A and B – an issue from B leaves A alone', async () => {
  const w = await world();
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  await stockIn(w, 'TST-001', 'B', 'B-01', 10);
  await w.ok('STORE1', 'doc.post', { type: 'PD', job: 'SO-1', lines: [{ code: 'TST-001', qty: 3, wh: 'B', bin: 'B-01' }] });
  const s = await w.state();
  assert.equal(qty(s, { code: 'TST-001', wh: 'A' }), 10);
  assert.equal(qty(s, { code: 'TST-001', wh: 'B' }), 7);
  const mv = RRS.inventory.history(s, { code: 'TST-001' })[0];
  assert.equal(mv.wh, 'B');
  assert.equal(mv.bin, 'B-01');
  assert.equal(mv.by, 'STORE1');
});

test('Phase 1: two people issue the last piece at the same moment – exactly one succeeds', async () => {
  const w = await world();
  await stockIn(w, 'TST-002', 'A', 'A-01', 1);
  w.store.delay = 3; // both requests in flight together
  const [a, b] = await Promise.all([
    w.exec('STORE1', 'doc.post', { type: 'PD', lines: [{ code: 'TST-002', qty: 1, wh: 'A', bin: 'A-01' }] }, 'req-a'),
    w.exec('STORE2', 'doc.post', { type: 'PD', lines: [{ code: 'TST-002', qty: 1, wh: 'A', bin: 'A-01' }] }, 'req-b'),
  ]);
  w.store.delay = 0;
  assert.equal([a.ok, b.ok].filter(Boolean).length, 1, JSON.stringify([a.errors, b.errors]));
  const loser = a.ok ? b : a;
  assert.equal(loser.errors[0].code, 'NOT_ENOUGH');
  const s = await w.state();
  assert.equal(qty(s, { code: 'TST-002' }), 0);
});

test('Phase 1: the same request sent again (also after a restart) changes stock once', async () => {
  const w = await world();
  await stockIn(w, 'TST-001', 'A', 'A-01', 5);
  const cmd = { type: 'PD', lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01' }] };
  const r1 = await w.exec('STORE1', 'doc.post', cmd, 'phone-123');
  const r2 = await w.exec('STORE1', 'doc.post', cmd, 'phone-123');
  assert.equal(r1.ok, true);
  assert.equal(r2.duplicate, true);
  // a fresh ledger on the same store (= the app restarted) still knows the request
  const fresh = new RRS.Ledger(w.store, { holder: 'restart', sleep: () => Promise.resolve() });
  const r3 = await fresh.execute({ kind: 'doc.post', payload: cmd, requestId: 'phone-123' }, { user: 'STORE1' });
  assert.equal(r3.duplicate, true);
  assert.equal(qty(fresh.state, { code: 'TST-001' }), 4);
  const reused = await w.exec('STORE1', 'doc.post', { ...cmd, remark: 'other' }, 'phone-123');
  assert.equal(reused.errors[0].code, 'REQUEST_REUSED');
});

test('Phase 1: a document with one bad line changes nothing', async () => {
  const w = await world();
  await stockIn(w, 'TST-001', 'A', 'A-01', 5);
  const before = await w.state();
  const seq = before.seq;
  for (const bad of [
    { code: 'NO-SUCH', qty: 1, wh: 'A', bin: 'A-01' },
    { code: 'TST-001', qty: 1, unit: 'กก.', wh: 'A', bin: 'A-01' },
    { code: 'TST-001', qty: 'abc', wh: 'A', bin: 'A-01' },
    { code: 'TST-001', qty: 1, wh: 'Z' },
    { code: 'TST-001', qty: 1, wh: 'A', bin: 'NOPE' },
  ]) {
    const r = await w.exec('STORE1', 'doc.post', { type: 'PD', lines: [{ code: 'TST-001', qty: 2, wh: 'A', bin: 'A-01' }, bad] });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.errors[0].line, 2);
  }
  const after = await w.state();
  assert.equal(after.seq, seq);
  assert.equal(qty(after, { code: 'TST-001' }), 5);
});

test('Phase 1: units convert with their factor; stock is kept in the base unit', async () => {
  const w = await world();
  await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'TST-001', qty: 2, unit: 'โหล', wh: 'A', bin: 'A-01' }] });
  const s = await w.state();
  assert.equal(qty(s, { code: 'TST-001' }), 24);
});

test('Phase 1: negative stock is blocked; an exception needs another person with approval rights', async () => {
  const w = await world();
  await stockIn(w, 'TST-002', 'A', 'A-01', 2);
  const blocked = await w.exec('STORE1', 'doc.post', { type: 'OU', lines: [{ code: 'TST-002', qty: 5, wh: 'A', bin: 'A-01' }] });
  assert.equal(blocked.errors[0].code, 'NOT_ENOUGH');
  const draft = await w.ok('STORE1', 'doc.saveDraft', { type: 'OU', lines: [{ code: 'TST-002', qty: 5, wh: 'A', bin: 'A-01' }] });
  const docNo = draft.result.docNo;
  const noPolicy = await w.exec('STORE1', 'doc.requestOverride', { docNo, reason: 'ของมาแล้วยังไม่ลงระบบ' });
  assert.equal(noPolicy.errors[0].code, 'POLICY');
  await w.ok('ADMIN', 'settings.update', { patch: { policies: { negativeStock: 'approve' } } });
  await w.ok('STORE1', 'doc.requestOverride', { docNo, reason: 'ของมาแล้วยังไม่ลงระบบ' });
  const self = await w.exec('LEAD', 'doc.approveOverride', { docNo });
  assert.equal(self.ok, true); // LEAD is another person with the right
  const s = await w.state();
  assert.equal(qty(s, { code: 'TST-002' }), -3);
  assert.equal(s.tables.documents[docNo].override.approvedBy, 'LEAD');
  assert.equal(s.tables.documents[docNo].override.requestedBy, 'STORE1');
});

test('Phase 1: the requester cannot approve their own exception', async () => {
  const w = await world();
  await w.ok('ADMIN', 'settings.update', { patch: { policies: { negativeStock: 'approve' } } });
  const draft = await w.ok('LEAD', 'doc.saveDraft', { type: 'OU', lines: [{ code: 'TST-002', qty: 1, wh: 'A', bin: 'A-01' }] });
  await w.ok('LEAD', 'doc.requestOverride', { docNo: draft.result.docNo, reason: 'ทดสอบแยกหน้าที่' });
  const r = await w.exec('LEAD', 'doc.approveOverride', { docNo: draft.result.docNo });
  assert.equal(r.errors[0].code, 'SAME_PERSON');
});

test('Phase 1: transfer A→B through in-transit, receive, and the totals match the history', async () => {
  const w = await world();
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  const tr = await w.ok('STORE1', 'doc.post', { type: 'TR', lines: [{ code: 'TST-001', qty: 4, wh: 'A', bin: 'A-01', toWh: 'B', toBin: 'B-01' }] });
  const no = tr.result.docNo;
  let s = await w.state();
  assert.equal(qty(s, { code: 'TST-001', wh: 'A' }), 6);
  assert.equal(qty(s, { code: 'TST-001', wh: RRS.TRANSIT }), 4);
  assert.equal(qty(s, { code: 'TST-001', wh: 'B' }), 0);
  await w.ok('STORE2', 'transfer.receive', { docNo: no, lines: [{ line: 1, qty: 1 }] });
  s = await w.state();
  assert.equal(s.tables.documents[no].status, 'IN_TRANSIT');
  await w.ok('STORE2', 'transfer.receive', { docNo: no });
  s = await w.state();
  assert.equal(s.tables.documents[no].status, 'RECEIVED');
  assert.equal(qty(s, { code: 'TST-001', wh: 'B', bin: 'B-01' }), 4);
  assert.equal(qty(s, { code: 'TST-001', wh: RRS.TRANSIT }), 0);
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
  const cancel = await w.exec('LEAD', 'doc.cancel', { docNo: no, reason: 'ทดสอบ' });
  assert.equal(cancel.ok, false);
});

test('Phase 1: cancel a transfer in transit and cancel twice – stock returns once, history kept', async () => {
  const w = await world();
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  const tr = await w.ok('STORE1', 'doc.post', { type: 'TR', lines: [{ code: 'TST-001', qty: 4, wh: 'A', bin: 'A-01', toWh: 'B' }] });
  const no = tr.result.docNo;
  const noReason = await w.exec('LEAD', 'doc.cancel', { docNo: no });
  assert.equal(noReason.errors[0].code, 'REQUIRED');
  await w.ok('LEAD', 'doc.cancel', { docNo: no, reason: 'โอนผิดคลัง' });
  const twice = await w.exec('LEAD', 'doc.cancel', { docNo: no, reason: 'ซ้ำ' });
  assert.equal(twice.errors[0].code, 'ALREADY_CANCELLED');
  const s = await w.state();
  assert.equal(qty(s, { code: 'TST-001', wh: 'A' }), 10);
  assert.equal(qty(s, { code: 'TST-001', wh: RRS.TRANSIT }), 0);
  const hist = RRS.inventory.history(s, { docNo: no });
  assert.equal(hist.length, 4);
  assert.equal(hist.filter((m) => m.reversalOf).length, 2);
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
});

test('Phase 1: a receipt whose stock was used cannot be cancelled', async () => {
  const w = await world();
  const rr = await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'TST-002', qty: 3, wh: 'A', bin: 'A-01' }] });
  await w.ok('STORE1', 'doc.post', { type: 'PD', lines: [{ code: 'TST-002', qty: 2, wh: 'A', bin: 'A-01' }] });
  const r = await w.exec('LEAD', 'doc.cancel', { docNo: rr.result.docNo, reason: 'ทดสอบ' });
  assert.equal(r.errors[0].code, 'CANNOT_REVERSE');
});

test('Phase 1: warehouse rights – a user limited to A cannot issue from B', async () => {
  const w = await world();
  await w.ok('ADMIN', 'user.upsert', { id: 'ONLYA', name: 'สโตร์ A', roles: ['store'], warehouses: ['A'] });
  await stockIn(w, 'TST-001', 'B', 'B-01', 3);
  const r = await w.exec('ONLYA', 'doc.post', { type: 'PD', lines: [{ code: 'TST-001', qty: 1, wh: 'B', bin: 'B-01' }] });
  assert.equal(r.errors[0].code, 'NO_PERMISSION');
});

test('Phase 1: adjustments need the store lead; numbering per type and month', async () => {
  const w = await world();
  const r = await w.exec('STORE1', 'doc.post', { type: 'AJ', lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01' }] });
  assert.equal(r.errors[0].code, 'NO_PERMISSION');
  const a = await stockIn(w, 'TST-001', 'A', 'A-01', 1);
  const b = await stockIn(w, 'TST-001', 'A', 'A-01', 1);
  assert.match(a.result.docNo, /^AJ6911-0001$/);
  assert.match(b.result.docNo, /^AJ6911-0002$/);
});

test('Phase 1: lots – tracked items need a lot; untracked items may not carry one', async () => {
  const w = await world();
  const noLot = await w.exec('LEAD', 'doc.post', { type: 'AJ', lines: [{ code: 'TST-PLATE', qty: 2, wh: 'A', bin: 'A-01' }] });
  assert.equal(noLot.errors[0].code, 'LOT_REQUIRED');
  const extra = await w.exec('LEAD', 'doc.post', { type: 'AJ', lines: [{ code: 'TST-001', qty: 2, wh: 'A', bin: 'A-01', lot: 'L1' }] });
  assert.equal(extra.errors[0].code, 'LOT_NOT_TRACKED');
});

test('commit chain: every commit verifies; a changed commit is detected', async () => {
  const w = await world();
  await stockIn(w, 'TST-001', 'A', 'A-01', 1);
  for (const c of w.store.commits) assert.equal(RRS.core.verifyCommit(c), true);
  const forged = JSON.parse(JSON.stringify(w.store.commits[w.store.commits.length - 1]));
  forged.effects[0].v.qty = 999;
  assert.equal(RRS.core.verifyCommit(forged), false);
});
