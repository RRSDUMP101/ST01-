// Phase 3 acceptance criteria (file 01): reconcile with Express and controlled stock counts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RRS, world, stockIn } from './helpers.mjs';

const qty = (s, f) => RRS.q.qty(s, f);
const fileOf = (fileName, snapshotAt, rows) => ({
  fileName, snapshotAt, rows, fileHash: RRS.util.sha256(fileName + '\n' + snapshotAt + '\n' + JSON.stringify(rows)),
});
/** World with Express warehouse 01 = RRS warehouse A (the default Express warehouse is '01'). */
async function expressWorld(ownership) {
  const w = await world();
  await w.ok('LEAD', 'warehouse.upsert', { code: 'A', name: 'คลัง A', expressCode: '01' });
  if (ownership) await w.ok('ADMIN', 'settings.update', { patch: { ownership: { qty: ownership } } });
  return w;
}
const adjust = (code, wh, bin, reason = 'ยึดยอด Express ตามข้อตกลง ค-1') => ({ code, wh, bin, action: 'adjust', reason });

// ---------------------------------------------------------------------------------------------------------------
// acceptance criteria
// ---------------------------------------------------------------------------------------------------------------
test('นำเข้าไฟล์เดิมซ้ำไม่เปลี่ยนยอดซ้ำ', async () => {
  const w = await expressWorld('Express');
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  const file = fileOf('stock-01.xlsx', w.clock.peek(), [{ code: 'TST-001', wh: '01', qty: 12 }]);
  let s = await w.state();
  const balances = JSON.stringify(s.tables.balances);
  const imp = await w.ok('LEAD', 'express.import', file);
  s = await w.state();
  assert.equal(JSON.stringify(s.tables.balances), balances, 'the import itself changes no stock');
  assert.equal(s.tables.express_batches[imp.result.batchId].status, 'REVIEW');
  await w.ok('ACC', 'express.resolve', { batchId: imp.result.batchId, lines: [adjust('TST-001', 'A', 'A-01')] });
  s = await w.state();
  assert.equal(qty(s, { code: 'TST-001' }), 12);
  const seq = s.seq;
  const again = await w.exec('LEAD', 'express.import', file);
  assert.equal(again.ok, false);
  assert.equal(again.errors[0].code, 'DUPLICATE_FILE');
  // the same content under another name / hash written in capitals is the same file
  const renamed = await w.exec('ACC', 'express.import', { ...file, fileName: 'สำเนา.xlsx', fileHash: file.fileHash.toUpperCase() });
  assert.equal(renamed.errors[0].code, 'DUPLICATE_FILE');
  // deciding the same row again does not adjust twice
  const twice = await w.exec('ACC', 'express.resolve', { batchId: imp.result.batchId, lines: [adjust('TST-001', 'A', 'A-01')] });
  assert.equal(twice.errors[0].code, 'ALREADY_ADJUSTED');
  s = await w.state();
  assert.equal(s.seq, seq);
  assert.equal(qty(s, { code: 'TST-001' }), 12);
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
});

test('ไฟล์เก่าไม่ทับรายการใหม่โดยอัตโนมัติ', async () => {
  const w = await expressWorld('Express');
  const t0 = w.clock.peek(); // before any stock
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  const t1 = w.clock.peek();
  await w.ok('STORE1', 'doc.post', { type: 'PD', job: 'SO-9', lines: [{ code: 'TST-001', qty: 3, wh: 'A', bin: 'A-01' }] });
  const b1 = (await w.ok('LEAD', 'express.import', fileOf('t1.xlsx', t1, [{ code: 'TST-001', wh: '01', qty: 12 }]))).result.batchId;
  let s = await w.state();
  const row = RRS.reconcile.reconcile(s, b1).rows.find((r) => r.code === 'TST-001');
  assert.deepEqual([row.express, row.rrsAtSnapshot, row.rrsNow, row.diff, row.status], [12, 10, 7, 2, 'DIFF']);
  await w.ok('ACC', 'express.resolve', { batchId: b1, lines: [adjust('TST-001', 'A', 'A-01')] });
  s = await w.state();
  assert.equal(qty(s, { code: 'TST-001', wh: 'A' }), 9, '7 now + 2 at the snapshot: the issue made after the file is kept (not 12)');
  await w.ok('ACC', 'express.close', { batchId: b1 });

  // a file older than the closed batch arrives afterwards
  const imp0 = await w.ok('LEAD', 'express.import', fileOf('t0.xlsx', t0, [{ code: 'TST-001', wh: '01', qty: 5 }, { code: 'TST-002', wh: '01', qty: 4 }]));
  assert.equal(imp0.result.olderThanLatest, true);
  assert.ok(imp0.warnings.some((x) => /เก่ากว่า/.test(x)));
  const b0 = imp0.result.batchId;
  s = await w.state();
  const r0 = RRS.reconcile.reconcile(s, b0);
  assert.equal(r0.olderThanLatest, true);
  const old001 = r0.rows.find((r) => r.code === 'TST-001');
  assert.equal(old001.status, 'ONLY_EXPRESS');
  assert.ok(old001.staleBy.length === 1, 'TST-001 was re-based by EX-00001 after this file was made');
  const seq = s.seq;
  const noConfirm = await w.exec('ACC', 'express.resolve', { batchId: b0, lines: [adjust('TST-002', 'A', 'A-01')] });
  assert.equal(noConfirm.errors[0].code, 'OLD_SNAPSHOT');
  const stale = await w.exec('ACC', 'express.resolve', { batchId: b0, confirmOld: true, lines: [adjust('TST-001', 'A', 'A-01')] });
  assert.equal(stale.errors[0].code, 'STALE_ROW');
  s = await w.state();
  assert.equal(s.seq, seq, 'nothing changed');
  assert.equal(qty(s, { code: 'TST-001' }), 9);
  // confirmed on purpose: only the confirmed row moves, the stale one is explained
  await w.ok('ACC', 'express.resolve', { batchId: b0, confirmOld: true, lines: [
    adjust('TST-002', 'A', 'A-01', 'ตรวจแล้ว ไฟล์เก่ายังถูกสำหรับรหัสนี้'),
    { code: 'TST-001', wh: 'A', action: 'explain', reason: 'ไฟล์เก่า ยอดปรับแล้วในรอบ EX-00001' }] });
  s = await w.state();
  assert.equal(qty(s, { code: 'TST-002', wh: 'A' }), 4);
  assert.equal(qty(s, { code: 'TST-001', wh: 'A' }), 9);
  // the deliberate use of an old file is on record with the decision
  const used = s.tables.express_batches[b0].resolutions.find((x) => x.code === 'TST-002');
  assert.deepEqual([used.action, used.confirmOld, used.by], ['adjust', true, 'ACC']);
  assert.equal(s.tables.express_batches[b0].resolutions.find((x) => x.code === 'TST-001').confirmOld, false);
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
});

test('นับในคลัง B สร้าง AJ ที่คลัง B', async () => {
  const w = await world();
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  await stockIn(w, 'TST-001', 'B', 'B-01', 10);
  await stockIn(w, 'TST-PLATE', 'B', 'B-01', 5, { lot: 'H1' });
  const ct = (await w.ok('LEAD', 'count.create', { wh: 'B' })).result.id; // whole warehouse B
  await w.ok('STORE1', 'count.enter', { id: ct, lines: [
    { code: 'TST-001', bin: 'B-01', counted: 9 },
    { code: 'TST-PLATE', bin: 'B-01', lot: 'H1', counted: 5 },
    { code: 'TST-PLATE', bin: 'B-01', lot: 'H2', counted: 1 }] });
  await w.ok('STORE1', 'count.submit', { id: ct });
  const r = await w.ok('ACC', 'count.approve', { id: ct, reasons: {
    'TST-001|B-01|': 'ของเสียหายทิ้งไปแล้วไม่ได้ตัดยอด', 'TST-PLATE|B-01|H2': 'พบแผ่นล็อต H2 ที่ยังไม่ได้รับเข้า' } });
  const s = await w.state();
  const doc = s.tables.documents[r.result.docNo];
  assert.equal(doc.type, 'AJ');
  assert.equal(doc.source, 'count:' + ct);
  assert.equal(doc.status, 'POSTED');
  assert.deepEqual(doc.lines.map((l) => [l.code, l.wh, l.bin, l.lot, l.base]), [['TST-001', 'B', 'B-01', '', -1], ['TST-PLATE', 'B', 'B-01', 'H2', 1]]);
  assert.equal(qty(s, { code: 'TST-001', wh: 'A' }), 10, 'warehouse A is not touched');
  assert.equal(qty(s, { code: 'TST-001', wh: 'B' }), 9);
  assert.equal(qty(s, { code: 'TST-PLATE', wh: 'B', lot: 'H2' }), 1);
  assert.equal(s.tables.count_sessions[ct].docNo, r.result.docNo);
  assert.equal(s.tables.count_sessions[ct].status, 'APPROVED');
  assert.ok(RRS.inventory.history(s, { docNo: r.result.docNo }).every((m) => m.wh === 'B'));
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
});

test('มีการเบิกระหว่างนับกับอนุมัติแล้วระบบคำนวณ/บล็อกตามกติกาที่ตกลง – timestamp: ปรับผลต่าง ณ เวลานับ ต้องรับทราบ', async () => {
  const w = await world();
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  const ct = (await w.ok('LEAD', 'count.create', { wh: 'A', bins: ['A-01'] })).result.id;
  let s = await w.state();
  assert.equal(s.tables.count_sessions[ct].mode, 'timestamp', 'default from settings.policies.countMode');
  await w.ok('STORE1', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 8 }] });
  await w.ok('STORE2', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 8 }] }); // confirms the big diff
  await w.ok('STORE1', 'count.submit', { id: ct });
  // an issue between counting and approval is allowed in timestamp mode
  await w.ok('STORE1', 'doc.post', { type: 'PD', job: 'SO-1', lines: [{ code: 'TST-001', qty: 3, wh: 'A', bin: 'A-01' }] });
  s = await w.state();
  const view = RRS.reconcile.countView(s, ct);
  assert.equal(view.lines[0].moved, true);
  assert.ok(view.lines[0].flags.includes('MOVED_DURING_COUNT'));
  assert.equal(view.lines[0].adjust, -2);
  assert.equal(view.needsAck, true);
  const seq = s.seq;
  const reasons = { 'TST-001|A-01|': 'เบิกไม่ได้ลงเอกสาร 2 ชิ้น' };
  const noAck = await w.exec('LEAD', 'count.approve', { id: ct, reasons });
  assert.equal(noAck.errors[0].code, 'MOVED_DURING_COUNT');
  s = await w.state();
  assert.equal(s.seq, seq);
  assert.equal(qty(s, { code: 'TST-001' }), 7);
  const r = await w.ok('LEAD', 'count.approve', { id: ct, reasons, ack: true });
  s = await w.state();
  assert.equal(qty(s, { code: 'TST-001', wh: 'A', bin: 'A-01' }), 5, '7 now − 2 counted at count time (not overwritten to 8)');
  assert.equal(s.tables.documents[r.result.docNo].lines[0].base, -2);
  const sess = s.tables.count_sessions[ct];
  assert.ok(sess.lines[0].flags.includes('MOVED_DURING_COUNT'));
  assert.deepEqual([sess.ack.by, sess.ack.lines], ['LEAD', ['TST-001|A-01|']]);
});

test('มีการเบิกระหว่างนับกับอนุมัติแล้วระบบคำนวณ/บล็อกตามกติกาที่ตกลง – freeze: หยุดเอกสารในพื้นที่ที่นับจนอนุมัติ', async () => {
  const w = await world();
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  await stockIn(w, 'TST-001', 'A', 'A-02', 5);
  await stockIn(w, 'TST-001', 'B', 'B-01', 5);
  const before = await w.ok('STORE1', 'doc.post', { type: 'PD', lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01' }] });
  await w.ok('ADMIN', 'settings.update', { patch: { policies: { countMode: 'freeze' } } });
  const ct = (await w.ok('LEAD', 'count.create', { wh: 'A', bins: ['A-01'] })).result.id;
  let s = await w.state();
  assert.equal(s.tables.count_sessions[ct].mode, 'freeze');
  assert.equal(RRS.reconcile.frozenBy(s, 'A', 'A-01'), ct);
  assert.equal(RRS.reconcile.frozenBy(s, 'A', 'A-02'), '');
  const pd = (bin, wh = 'A') => ({ type: 'PD', job: 'SO-2', lines: [{ code: 'TST-001', qty: 1, wh, bin }] });
  assert.equal((await w.exec('STORE1', 'doc.post', pd('A-01'))).errors[0].code, 'COUNT_FREEZE');
  assert.equal((await w.exec('LEAD', 'doc.post', { type: 'AJ', lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01' }] })).errors[0].code, 'COUNT_FREEZE');
  assert.equal((await w.exec('STORE1', 'doc.post', { type: 'TR', lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-02', toWh: 'A', toBin: 'A-01' }] })).errors[0].code, 'COUNT_FREEZE');
  assert.equal((await w.exec('LEAD', 'doc.cancel', { docNo: before.result.docNo, reason: 'ทดสอบยกเลิกระหว่างหยุดนับ' })).errors[0].code, 'COUNT_FREEZE');
  await w.ok('STORE1', 'doc.post', pd('A-02')); // other bins of the warehouse are free
  await w.ok('STORE1', 'doc.post', pd('B-01', 'B'));
  await w.ok('STORE1', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 8 }] });
  await w.ok('STORE1', 'count.submit', { id: ct });
  assert.equal((await w.exec('STORE1', 'doc.post', pd('A-01'))).errors[0].code, 'COUNT_FREEZE', 'still frozen while waiting for approval');
  const r = await w.ok('LEAD', 'count.approve', { id: ct, reasons: { 'TST-001|A-01|': 'นับจริงได้ 8' } });
  s = await w.state();
  assert.equal(qty(s, { code: 'TST-001', wh: 'A', bin: 'A-01' }), 8, 'the approval itself still posts its AJ');
  assert.equal(r.result.moved.length, 0);
  await w.ok('STORE1', 'doc.post', pd('A-01')); // released
  // whole-warehouse freeze, released by cancelling the session
  const all = (await w.ok('LEAD', 'count.create', { wh: 'B', bins: [] })).result.id;
  assert.equal((await w.exec('STORE1', 'doc.post', pd('B-01', 'B'))).errors[0].code, 'COUNT_FREEZE');
  await w.ok('LEAD', 'count.cancel', { id: all, reason: 'เลื่อนนับเป็นสัปดาห์หน้า' });
  await w.ok('STORE1', 'doc.post', pd('B-01', 'B'));
  s = await w.state();
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
});

test('ยอดต่างมีคำอธิบายและผู้รับผิดชอบ', async () => {
  const w = await world();
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  await stockIn(w, 'TST-002', 'A', 'A-01', 4);
  const ct = (await w.ok('LEAD', 'count.create', { wh: 'A', bins: ['A-01'] })).result.id;
  await w.ok('STORE1', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 9 }, { code: 'TST-002', bin: 'A-01', counted: 4 }] });
  await w.ok('STORE1', 'count.submit', { id: ct });
  const none = await w.exec('LEAD', 'count.approve', { id: ct });
  assert.equal(none.errors[0].code, 'REASON_REQUIRED');
  const blank = await w.exec('LEAD', 'count.approve', { id: ct, reasons: { 'TST-001|A-01|': '   ' } });
  assert.equal(blank.errors[0].code, 'REASON_REQUIRED');
  const typo = await w.exec('LEAD', 'count.approve', { id: ct, reasons: { 'TST-001|A-01|': 'x', 'TST-999|A-01|': 'x' } });
  assert.equal(typo.errors[0].code, 'BAD_KEY');
  const r = await w.ok('LEAD', 'count.approve', { id: ct, reasons: { 'TST-001|A-01|': { reason: 'เบิกให้งาน SO-7 แล้วไม่ได้ลงเอกสาร', responsible: 'STORE2' } } });
  const s = await w.state();
  const sess = s.tables.count_sessions[ct];
  const l1 = sess.lines.find((l) => l.code === 'TST-001');
  assert.equal(l1.reason, 'เบิกให้งาน SO-7 แล้วไม่ได้ลงเอกสาร');
  assert.equal(l1.responsible, 'STORE2');
  assert.equal(l1.reasonBy, 'LEAD');
  assert.ok(l1.reasonAt);
  assert.equal(l1.countedBy, 'STORE1');
  assert.ok(l1.countedAt);
  assert.equal(l1.adjust, -1);
  assert.deepEqual([sess.approvedBy, !!sess.approvedAt, sess.createdBy, sess.submittedBy], ['LEAD', true, 'LEAD', 'STORE1']);
  const ajLine = s.tables.documents[r.result.docNo].lines[0];
  assert.equal(ajLine.remark, 'เบิกให้งาน SO-7 แล้วไม่ได้ลงเอกสาร');
  assert.equal(s.tables.documents[r.result.docNo].lines.length, 1, 'the line without a difference is not adjusted');

  // Express differences: every decision needs a reason and keeps who/when; a batch with open differences cannot close
  const x = await expressWorld();
  await stockIn(x, 'TST-001', 'A', 'A-01', 10);
  const b = (await x.ok('LEAD', 'express.import', fileOf('e.xlsx', x.clock.peek(), [{ code: 'TST-001', wh: '01', qty: 7 }]))).result.batchId;
  const noReason = await x.exec('ACC', 'express.resolve', { batchId: b, lines: [{ code: 'TST-001', wh: 'A', action: 'explain', reason: '' }] });
  assert.equal(noReason.errors[0].code, 'REASON_REQUIRED');
  assert.equal((await x.exec('ACC', 'express.close', { batchId: b })).errors[0].code, 'UNRESOLVED');
  await x.ok('ACC', 'express.resolve', { batchId: b, lines: [{ code: 'TST-001', wh: 'A', action: 'explain', reason: 'PD6911-0003 ยังไม่ได้คีย์ใน Express' }] });
  let xs = await x.state();
  const res = xs.tables.express_batches[b].resolutions[0];
  assert.deepEqual([res.action, res.reason, res.by, !!res.at, res.express, res.rrsAtSnapshot], ['explain', 'PD6911-0003 ยังไม่ได้คีย์ใน Express', 'ACC', true, 7, 10]);
  assert.equal(RRS.reconcile.reconcile(xs, b).rows[0].resolved, true);
  await x.ok('ACC', 'express.close', { batchId: b });
  xs = await x.state();
  assert.deepEqual([xs.tables.express_batches[b].status, xs.tables.express_batches[b].closedBy], ['CLOSED', 'ACC']);
  assert.equal((await x.exec('ACC', 'express.resolve', { batchId: b, lines: [{ code: 'TST-001', wh: 'A', action: 'explain', reason: 'ซ้ำ' }] })).errors[0].code, 'BAD_STATE');
});

// ---------------------------------------------------------------------------------------------------------------
// Express import, mapping and reconciliation view
// ---------------------------------------------------------------------------------------------------------------
test('Express: map warehouses, keep unknown codes (never by name), statuses, pending documents', async () => {
  const w = await expressWorld();
  const opening = await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  await stockIn(w, 'TST-002', 'A', 'A-01', 3);
  await stockIn(w, 'TST-001', 'B', 'B-01', 2);
  const pd = await w.ok('STORE1', 'doc.post', { type: 'PD', job: 'SO-3', lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01' }] });
  await w.ok('ACC', 'doc.markExpress', { docNo: pd.result.docNo, expressNo: '' }); // still waiting
  const snap = w.clock.peek();
  const imp = await w.ok('LEAD', 'express.import', fileOf('mix.csv', snap, [
    { code: 'TST-001', wh: '01', qty: 9 }, // 01 -> A by expressCode: MATCH (10 − 1)
    { code: 'tst 002', wh: 'A', qty: 2, unit: 'ชิ้น' }, // same code A; code read loosely: DIFF
    { code: 'TST-FG', wh: '', qty: 1 }, // no warehouse -> default 01 -> A: ONLY_EXPRESS
    { code: 'ชิ้นทดสอบ 1', wh: '01', qty: 4 }, // item NAME, not a code -> unknown
    { code: 'XX-404', wh: 'ZZ', qty: 1 }, // unknown code, unknown warehouse -> default
    { code: 'TST-001', wh: 'B', qty: 1, unit: 'โหล' }]), // B by code, 1 โหล = 12: DIFF
  );
  assert.deepEqual(imp.result.unknown.map((u) => u.row), [4, 5]);
  assert.deepEqual(imp.result.byDefault.map((u) => [u.row, u.wh]), [[5, 'A']]);
  let s = await w.state();
  const batch = s.tables.express_batches[imp.result.batchId];
  assert.deepEqual(batch.rows.map((r) => [r.code, r.wh, r.whBy, r.base]), [
    ['TST-001', 'A', 'expressCode', 9], ['TST-002', 'A', 'code', 2], ['TST-FG', 'A', 'default', 1], ['', 'A', 'expressCode', 4],
    ['', 'A', 'default', 1], ['TST-001', 'B', 'code', 12]]);
  // a later movement does not change the snapshot comparison
  await w.ok('STORE1', 'doc.post', { type: 'PD', job: 'SO-4', lines: [{ code: 'TST-002', qty: 3, wh: 'A', bin: 'A-01' }] });
  await stockIn(w, 'TST-PLATE', 'B', 'B-01', 1, { lot: 'H9' }); // after the snapshot – not listed
  s = await w.state();
  const rec = RRS.reconcile.reconcile(s, imp.result.batchId);
  const get = (code, wh) => rec.rows.find((r) => r.code === code && r.wh === wh);
  assert.equal(get('TST-001', 'A').status, 'MATCH');
  // documents not keyed in Express yet that touch the code in that warehouse (the opening AJ and the PD)
  assert.deepEqual(get('TST-001', 'A').pendingDocs, [opening.result.docNo, pd.result.docNo]);
  assert.equal(get('TST-001', 'B').pendingDocs.length, 1);
  assert.deepEqual([get('TST-002', 'A').status, get('TST-002', 'A').rrsAtSnapshot, get('TST-002', 'A').rrsNow, get('TST-002', 'A').diff], ['DIFF', 3, 0, -1]);
  assert.equal(get('TST-FG', 'A').status, 'ONLY_EXPRESS');
  assert.deepEqual([get('TST-001', 'B').status, get('TST-001', 'B').diff], ['DIFF', 10]);
  assert.equal(rec.rows.filter((r) => r.status === 'UNKNOWN_CODE').length, 2);
  assert.equal(rec.rows.find((r) => r.code === 'TST-PLATE'), undefined);
  assert.deepEqual([rec.totals.MATCH, rec.totals.DIFF, rec.totals.ONLY_EXPRESS, rec.totals.UNKNOWN_CODE, rec.totals.unresolved], [1, 2, 1, 2, 5]);
  // stock in RRS that the file does not list, in a warehouse the file covers
  const b2 = (await w.ok('LEAD', 'express.import', fileOf('only.csv', w.clock.peek(), [{ code: 'TST-001', wh: '01', qty: 9 }]))).result.batchId;
  s = await w.state();
  const only = RRS.reconcile.reconcile(s, b2).rows;
  assert.deepEqual(only.map((r) => [r.code, r.wh, r.status]), [['TST-001', 'A', 'MATCH']]);
  await stockIn(w, 'TST-002', 'A', 'A-02', 6);
  const b3 = (await w.ok('LEAD', 'express.import', fileOf('only3.csv', w.clock.peek(), [{ code: 'TST-001', wh: '01', qty: 9 }]))).result.batchId;
  s = await w.state();
  const r3 = RRS.reconcile.reconcile(s, b3).rows.find((r) => r.code === 'TST-002');
  assert.deepEqual([r3.status, r3.express, r3.rrsAtSnapshot, r3.diff], ['ONLY_RRS', 0, 6, -6]);
  // an unknown-code row can be explained by its row number
  await w.ok('ACC', 'express.resolve', { batchId: imp.result.batchId, lines: [{ row: 4, action: 'explain', reason: 'ชื่อสินค้า ไม่ใช่รหัส – แจ้งบัญชีแก้ไฟล์' }] });
  s = await w.state();
  assert.equal(RRS.reconcile.reconcile(s, imp.result.batchId).rows.find((r) => r.key === 'row:4').resolved, true);
});

test('Express: pending keying – รอคีย์ vs คีย์แล้ว, and keyed documents cancelled later', async () => {
  const w = await world();
  await stockIn(w, 'TST-001', 'A', 'A-01', 5);
  const pd = await w.ok('STORE1', 'doc.post', { type: 'PD', lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01' }] });
  const tr = await w.ok('STORE1', 'doc.post', { type: 'TR', lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01', toWh: 'B' }] });
  let s = await w.state();
  let p = RRS.reconcile.pendingExpress(s, '2026-11-05');
  assert.equal(p.totals.wait, 2); // the opening AJ and the PD; TR has no Express type (N/A)
  assert.ok(p.wait.every((d) => d.ageDays === 3));
  assert.equal(p.wait.find((d) => d.docNo === tr.result.docNo), undefined);
  await w.ok('ACC', 'doc.markExpress', { docNo: pd.result.docNo, expressNo: 'EXP-PD-1' });
  s = await w.state();
  p = RRS.reconcile.pendingExpress(s);
  assert.deepEqual([p.totals.wait, p.totals.keyed], [1, 1]);
  assert.equal(p.keyed[0].expressNo, 'EXP-PD-1');
  await w.ok('LEAD', 'doc.cancel', { docNo: pd.result.docNo, reason: 'เบิกผิดรหัส' });
  s = await w.state();
  p = RRS.reconcile.pendingExpress(s);
  assert.deepEqual([p.totals.keyed, p.totals.cancelledKeyed], [0, 1]);
});

test('Express: rrsQtyAt counts every quality status, leaves out stock in transit and movements after the moment', async () => {
  const w = await world();
  await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'TST-PLATE', qty: 4, wh: 'A', bin: 'A-01', lot: 'H1' }] }); // QC_HOLD
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  const t = w.clock.peek();
  await w.ok('STORE1', 'doc.post', { type: 'TR', lines: [{ code: 'TST-001', qty: 4, wh: 'A', bin: 'A-01', toWh: 'B' }] });
  const s = await w.state();
  assert.equal(RRS.reconcile.rrsQtyAt(s, 'TST-PLATE', 'A', t), 4);
  assert.equal(RRS.reconcile.rrsQtyAt(s, 'TST-001', 'A', t), 10);
  assert.equal(RRS.reconcile.rrsQtyAt(s, 'TST-001', 'A', w.clock.peek()), 6);
  assert.equal(RRS.reconcile.rrsQtyAt(s, 'tst 001', 'B', w.clock.peek()), 0, 'in transit is in no warehouse');
  assert.equal(RRS.reconcile.rrsQtyAt(s, 'TST-001', 'A', '2026-01-01T00:00:00Z'), 0);
});

test('Express: when RRS owns the quantity a file can only be explained, never adjusted', async () => {
  const w = await expressWorld(); // default ownership.qty = RRS
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  const b = (await w.ok('LEAD', 'express.import', fileOf('rrs.xlsx', w.clock.peek(), [{ code: 'TST-001', wh: '01', qty: 3 }]))).result.batchId;
  const r = await w.exec('ACC', 'express.resolve', { batchId: b, lines: [adjust('TST-001', 'A', 'A-01')] });
  assert.equal(r.errors[0].code, 'OWNERSHIP');
  const s = await w.state();
  assert.equal(qty(s, { code: 'TST-001' }), 10);
});

test('Express: bad input is refused and changes nothing', async () => {
  const w = await expressWorld('Express');
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  const now = w.clock.peek();
  const good = fileOf('ok.xlsx', now, [{ code: 'TST-001', wh: '01', qty: 1 }]);
  const seq = (await w.state()).seq;
  const cases = [
    [{ ...good, fileName: '' }, 'REQUIRED'],
    [{ ...good, fileHash: 'abc' }, 'BAD_HASH'],
    [{ ...good, snapshotAt: '2026-11-02 08:00' }, 'BAD_TIME'], // no time zone
    [{ ...good, snapshotAt: '2026-11-02' }, 'BAD_TIME'],
    [{ ...good, snapshotAt: '2030-01-01T00:00:00Z' }, 'FUTURE_TIME'],
    [{ ...good, rows: [] }, 'NO_ROWS'],
    [{ ...good, rows: [{ code: 'TST-001', wh: '01', qty: 'สิบ' }] }, 'BAD_QTY'],
    [{ ...good, rows: [{ code: 'TST-001', wh: '01', qty: 1, unit: 'กล่อง' }] }, 'NO_UNIT'],
  ];
  for (const [payload, code] of cases) {
    const r = await w.exec('LEAD', 'express.import', payload);
    assert.equal(r.ok, false, code);
    assert.equal(r.errors[0].code, code, JSON.stringify(r.errors));
  }
  // a warehouse that maps to nothing (and no usable default) is not guessed
  await w.ok('ADMIN', 'settings.update', { patch: { express: { defaultWarehouse: '' } } });
  assert.equal((await w.exec('LEAD', 'express.import', { ...good, rows: [{ code: 'TST-001', wh: 'ZZ', qty: 1 }] })).errors[0].code, 'NO_WAREHOUSE');
  await w.ok('LEAD', 'warehouse.upsert', { code: 'B', name: 'คลัง B', expressCode: '01' });
  assert.equal((await w.exec('LEAD', 'express.import', good)).errors[0].code, 'AMBIGUOUS_WH');
  const s = await w.state();
  assert.equal(s.seq, seq + 2, 'only the two master-data changes were saved');
  assert.equal(Object.keys(s.tables.express_batches || {}).length, 0);
  // resolve input
  await w.ok('LEAD', 'warehouse.upsert', { code: 'B', name: 'คลัง B', expressCode: '' });
  const b = (await w.ok('LEAD', 'express.import', good)).result.batchId;
  const bad = [
    [{ batchId: 'EX-99999', lines: [adjust('TST-001', 'A', 'A-01')] }, 'NOT_FOUND'],
    [{ batchId: b, lines: [] }, 'NO_LINES'],
    [{ batchId: b, lines: [{ code: 'TST-001', wh: 'A', action: 'delete', reason: 'x' }] }, 'BAD_VALUE'],
    [{ batchId: b, lines: [adjust('TST-002', 'A', 'A-01')] }, 'NOT_IN_BATCH'],
    [{ batchId: b, lines: [adjust('NOPE', 'A', 'A-01')] }, 'NOT_FOUND'],
    [{ batchId: b, lines: [adjust('TST-001', 'A', 'A-01'), { code: 'TST-001', wh: 'A', action: 'explain', reason: 'x' }] }, 'DUPLICATE_LINE'],
    [{ batchId: b, lines: [adjust('TST-001', 'A', 'NO-BIN')] }, 'NOT_FOUND'],
  ];
  const seq2 = (await w.state()).seq;
  for (const [payload, code] of bad) {
    const r = await w.exec('ACC', 'express.resolve', payload);
    assert.equal(r.errors[0].code, code, JSON.stringify(r.errors));
  }
  const after = await w.state();
  assert.equal(after.seq, seq2);
  assert.equal(qty(after, { code: 'TST-001' }), 10);
});

// ---------------------------------------------------------------------------------------------------------------
// counts: recount rule, duplicates, bad input, cancel / undo
// ---------------------------------------------------------------------------------------------------------------
test('Count: a big difference needs a recount by another person; disagreeing counts stay DUPLICATE until one is confirmed', async () => {
  const w = await world();
  await stockIn(w, 'TST-001', 'A', 'A-01', 100);
  await stockIn(w, 'TST-002', 'A', 'A-01', 10);
  const ct = (await w.ok('LEAD', 'count.create', { wh: 'A', bins: ['A-01'] })).result.id;
  // limit = max(recountQty 1, 2 % of 100 = 2): 98 is fine, 97 needs a recount
  const r1 = await w.ok('STORE1', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 97 }, { code: 'TST-002', bin: 'A-01', counted: 10 }] });
  assert.deepEqual(r1.result.recount, ['TST-001|A-01|']);
  assert.equal(r1.result.lines[0].system, undefined, 'counters are not shown the system quantity');
  assert.equal((await w.exec('STORE1', 'count.submit', { id: ct })).errors[0].code, 'NEEDS_RECOUNT');
  const self = await w.exec('STORE1', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 100 }] });
  assert.equal(self.errors[0].code, 'SAME_PERSON');
  await w.ok('STORE2', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 99 }] }); // disagrees
  let v = RRS.reconcile.countView(await w.state(), ct);
  assert.ok(v.lines[0].flags.includes('DUPLICATE'));
  assert.equal(v.canSubmit, false);
  assert.equal(v.lines[0].adjust, null);
  // within the limit, two people with different values are still a duplicate
  await w.ok('STORE2', 'count.enter', { id: ct, lines: [{ code: 'TST-002', bin: 'A-01', counted: 9 }] });
  v = RRS.reconcile.countView(await w.state(), ct);
  assert.ok(v.lines[1].flags.includes('DUPLICATE'));
  // a third person agrees with one of them -> accepted
  await w.ok('LEAD', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 99 }, { code: 'TST-002', bin: 'A-01', counted: 10 }] });
  v = RRS.reconcile.countView(await w.state(), ct);
  assert.deepEqual(v.lines.map((l) => [l.flags.join(), l.adjust]), [['RECOUNTED', -1], ['RECOUNTED', 0]]);
  assert.deepEqual(v.aj, [{ key: 'TST-001|A-01|', code: 'TST-001', wh: 'A', bin: 'A-01', lot: '', qty: -1 }]);
  assert.equal(v.canSubmit, true);
  await w.ok('STORE1', 'count.submit', { id: ct });
  // the approver must not have counted: STORE1, STORE2 and LEAD all counted -> ACC approves
  assert.equal((await w.exec('LEAD', 'count.approve', { id: ct, reasons: { 'TST-001|A-01|': 'นับยืนยันสองคน' } })).errors[0].code, 'SAME_PERSON');
  await w.ok('ACC', 'count.approve', { id: ct, reasons: { 'TST-001|A-01|': 'นับยืนยันสองคน' } });
  const s = await w.state();
  assert.equal(qty(s, { code: 'TST-001' }), 99);
  assert.equal(qty(s, { code: 'TST-002' }), 10);
  const line = s.tables.count_sessions[ct].lines[0];
  assert.deepEqual([line.counted, line.countedBy, line.recounts.map((x) => [x.counted, x.by])], [97, 'STORE1', [[99, 'STORE2'], [99, 'LEAD']]]);
});

test('Count: things not counted are listed, never adjusted', async () => {
  const w = await world();
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  await stockIn(w, 'TST-002', 'A', 'A-01', 4);
  await stockIn(w, 'TST-002', 'A', 'A-02', 4); // outside the session's bins
  const ct = (await w.ok('LEAD', 'count.create', { wh: 'A', bins: ['A-01'] })).result.id;
  await w.ok('STORE1', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 10 }] });
  const sub = await w.ok('STORE1', 'count.submit', { id: ct });
  assert.ok(sub.warnings.some((x) => /ไม่ได้นับ/.test(x)));
  let s = await w.state();
  const v = RRS.reconcile.countView(s, ct);
  assert.deepEqual(v.uncounted.map((u) => [u.code, u.bin, u.qty]), [['TST-002', 'A-01', 4]]);
  const r = await w.ok('LEAD', 'count.approve', { id: ct });
  s = await w.state();
  assert.equal(r.result.docNo, '', 'no difference, no AJ');
  assert.equal(qty(s, { code: 'TST-002' }), 8);
  assert.equal(s.tables.count_sessions[ct].status, 'APPROVED');
});

test('Count: bad input and overlapping sessions are refused and change nothing', async () => {
  const w = await world();
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  const seq0 = (await w.state()).seq;
  for (const [payload, code] of [
    [{ wh: 'Z' }, 'NOT_FOUND'], [{ wh: RRS.TRANSIT }, 'NOT_FOUND'], [{ wh: 'A', bins: ['NOPE'] }, 'NOT_FOUND'],
    [{ wh: 'A', mode: 'later' }, 'BAD_VALUE']]) {
    assert.equal((await w.exec('LEAD', 'count.create', payload)).errors[0].code, code);
  }
  assert.equal((await w.state()).seq, seq0);
  const ct = (await w.ok('LEAD', 'count.create', { wh: 'A', bins: ['A-01'] })).result.id;
  assert.equal((await w.exec('LEAD', 'count.create', { wh: 'A', bins: ['A-01', 'A-02'] })).errors[0].code, 'OVERLAP');
  assert.equal((await w.exec('LEAD', 'count.create', { wh: 'A' })).errors[0].code, 'OVERLAP');
  await w.ok('LEAD', 'count.create', { wh: 'A', bins: ['A-02'] }); // another bin is fine
  const seq1 = (await w.state()).seq;
  for (const [line, code] of [
    [{ code: 'NOPE', bin: 'A-01', counted: 1 }, 'NOT_FOUND'],
    [{ code: 'TST-001', bin: 'A-02', counted: 1 }, 'OUT_OF_SCOPE'],
    [{ code: 'TST-001', bin: '', counted: 1 }, 'OUT_OF_SCOPE'],
    [{ code: 'TST-001', bin: 'A-01', counted: -1 }, 'BAD_QTY'],
    [{ code: 'TST-001', bin: 'A-01', counted: 'abc' }, 'BAD_QTY'],
    [{ code: 'TST-001', bin: 'A-01', counted: 1, unit: 'กล่อง' }, 'NO_UNIT'],
    [{ code: 'TST-PLATE', bin: 'A-01', counted: 1 }, 'LOT_REQUIRED'],
    [{ code: 'TST-001', bin: 'A-01', lot: 'L1', counted: 1 }, 'LOT_NOT_TRACKED'],
  ]) {
    const r = await w.exec('STORE1', 'count.enter', { id: ct, lines: [{ code: 'TST-002', bin: 'A-01', counted: 0 }, line] });
    assert.equal(r.errors[0].code, code, JSON.stringify(r.errors));
    assert.equal(r.errors[0].line, 2);
  }
  const dup = await w.exec('STORE1', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 1 }, { code: 'tst 001', bin: 'a-01', counted: 2 }] });
  assert.equal(dup.errors[0].code, 'DUPLICATE_LINE');
  assert.equal((await w.exec('STORE1', 'count.enter', { id: 'CT-09999', lines: [{ code: 'TST-001', bin: 'A-01', counted: 1 }] })).errors[0].code, 'NOT_FOUND');
  assert.equal((await w.exec('STORE1', 'count.submit', { id: ct })).errors[0].code, 'NO_LINES');
  assert.equal((await w.exec('LEAD', 'count.approve', { id: ct })).errors[0].code, 'BAD_STATE', 'not submitted yet');
  const s = await w.state();
  assert.equal(s.seq, seq1);
  assert.equal(s.tables.count_sessions[ct].lines.length, 0);
  // counting in another unit converts to the base unit
  await w.ok('STORE1', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 1, unit: 'โหล' }] });
  assert.equal((await w.state()).tables.count_sessions[ct].lines[0].counted, 12);
});

test('Count: cancel and undo – a cancelled session keeps its lines; cancelling the AJ returns the stock', async () => {
  const w = await world();
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  const ct = (await w.ok('LEAD', 'count.create', { wh: 'A', bins: ['A-01'], mode: 'freeze' })).result.id;
  await w.ok('STORE1', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 9 }] });
  assert.equal((await w.exec('LEAD', 'count.cancel', { id: ct })).errors[0].code, 'REQUIRED');
  assert.equal((await w.exec('STORE1', 'count.cancel', { id: ct, reason: 'x' })).errors[0].code, 'NO_PERMISSION');
  await w.ok('LEAD', 'count.cancel', { id: ct, reason: 'นับผิดพื้นที่' });
  let s = await w.state();
  assert.deepEqual([s.tables.count_sessions[ct].status, s.tables.count_sessions[ct].cancelledBy, s.tables.count_sessions[ct].lines.length], ['CANCELLED', 'LEAD', 1]);
  assert.equal((await w.exec('LEAD', 'count.cancel', { id: ct, reason: 'ซ้ำ' })).errors[0].code, 'BAD_STATE');
  assert.equal((await w.exec('STORE2', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 9 }] })).errors[0].code, 'BAD_STATE');
  await w.ok('STORE1', 'doc.post', { type: 'PD', lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01' }] }); // freeze released
  // approved session: cancel the session is refused, the AJ is cancelled instead
  const c2 = (await w.ok('LEAD', 'count.create', { wh: 'A', bins: ['A-01'] })).result.id;
  await w.ok('STORE1', 'count.enter', { id: c2, lines: [{ code: 'TST-001', bin: 'A-01', counted: 8 }] });
  await w.ok('STORE1', 'count.submit', { id: c2 });
  const ap = await w.ok('LEAD', 'count.approve', { id: c2, reasons: { 'TST-001|A-01|': 'ชำรุด' } });
  assert.equal((await w.exec('LEAD', 'count.cancel', { id: c2, reason: 'ผิด' })).errors[0].code, 'BAD_STATE');
  s = await w.state();
  assert.equal(qty(s, { code: 'TST-001' }), 8);
  await w.ok('LEAD', 'doc.cancel', { docNo: ap.result.docNo, reason: 'อนุมัติผิดรอบ' });
  s = await w.state();
  assert.equal(qty(s, { code: 'TST-001' }), 9);
  assert.deepEqual([s.tables.count_sessions[c2].status, s.tables.count_sessions[c2].docCancelled.docNo], ['APPROVED', ap.result.docNo]);
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
});

test('Express: cancel and undo – a cancelled adjustment reopens the row; discard needs no live adjustment; a discarded file may be read again', async () => {
  const w = await expressWorld('Express');
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  const file = fileOf('undo.xlsx', w.clock.peek(), [{ code: 'TST-001', wh: '01', qty: 12 }]);
  const b = (await w.ok('LEAD', 'express.import', file)).result.batchId;
  const r = await w.ok('ACC', 'express.resolve', { batchId: b, lines: [adjust('TST-001', 'A', 'A-01')] });
  let s = await w.state();
  assert.equal(s.tables.documents[r.result.docNo].expressStatus, 'N/A', 'an AJ that mirrors Express is not keyed into Express again');
  assert.equal((await w.exec('ACC', 'express.discard', { batchId: b, reason: 'ไฟล์ผิด' })).errors[0].code, 'HAS_ADJUSTMENTS');
  await w.ok('LEAD', 'doc.cancel', { docNo: r.result.docNo, reason: 'ปรับผิด' });
  s = await w.state();
  assert.equal(qty(s, { code: 'TST-001' }), 10);
  const res = s.tables.express_batches[b].resolutions[0];
  assert.deepEqual([res.cancelledBy, !!res.cancelledAt], ['LEAD', true]);
  assert.equal(RRS.reconcile.reconcile(s, b).rows[0].resolved, false);
  assert.equal((await w.exec('LEAD', 'express.discard', { batchId: b })).errors[0].code, 'REQUIRED');
  await w.ok('LEAD', 'express.discard', { batchId: b, reason: 'ไฟล์ตัดยอดผิดวัน' });
  s = await w.state();
  assert.deepEqual([s.tables.express_batches[b].status, s.tables.express_batches[b].discardedBy], ['DISCARDED', 'LEAD']);
  assert.equal(s.tables.express_batches[b].rows.length, 1, 'history kept');
  assert.equal((await w.exec('ACC', 'express.resolve', { batchId: b, lines: [adjust('TST-001', 'A', 'A-01')] })).errors[0].code, 'BAD_STATE');
  assert.equal((await w.exec('ACC', 'express.close', { batchId: b })).errors[0].code, 'BAD_STATE');
  const again = await w.ok('LEAD', 'express.import', file);
  assert.notEqual(again.result.batchId, b);
  assert.equal((await w.exec('LEAD', 'express.import', file)).errors[0].code, 'DUPLICATE_FILE');
});

// ---------------------------------------------------------------------------------------------------------------
// permissions and separation of duties
// ---------------------------------------------------------------------------------------------------------------
test('Permissions: each step needs its role (and the warehouse)', async () => {
  const w = await expressWorld('Express');
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  const file = fileOf('perm.xlsx', w.clock.peek(), [{ code: 'TST-001', wh: '01', qty: 11 }]);
  assert.equal((await w.exec('STORE1', 'express.import', file)).errors[0].code, 'NO_PERMISSION');
  assert.equal((await w.exec('VIEW', 'express.import', file)).errors[0].code, 'NO_PERMISSION');
  const b = (await w.ok('LEAD', 'express.import', file)).result.batchId;
  assert.equal((await w.exec('LEAD', 'express.resolve', { batchId: b, lines: [adjust('TST-001', 'A', 'A-01')] })).errors[0].code, 'NO_PERMISSION');
  assert.equal((await w.exec('LEAD', 'express.close', { batchId: b })).errors[0].code, 'NO_PERMISSION');
  assert.equal((await w.exec('STORE1', 'express.discard', { batchId: b, reason: 'x' })).errors[0].code, 'NO_PERMISSION');
  // an accountant limited to warehouse B cannot decide rows of warehouse A
  await w.ok('ADMIN', 'user.upsert', { id: 'ACCB', name: 'บัญชีคลัง B', roles: ['accounting'], warehouses: ['B'] });
  assert.equal((await w.exec('ACCB', 'express.resolve', { batchId: b, lines: [{ code: 'TST-001', wh: 'A', action: 'explain', reason: 'x' }] })).errors[0].code, 'NO_PERMISSION');
  // the accountant (no doc.postAdjust of their own) may post the approved Express AJ
  await w.ok('ACC', 'express.resolve', { batchId: b, lines: [adjust('TST-001', 'A', 'A-01')] });
  assert.equal(qty(await w.state(), { code: 'TST-001' }), 11);

  assert.equal((await w.exec('STORE1', 'count.create', { wh: 'A' })).errors[0].code, 'NO_PERMISSION');
  const ct = (await w.ok('LEAD', 'count.create', { wh: 'A', bins: ['A-01'] })).result.id;
  assert.equal((await w.exec('VIEW', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 11 }] })).errors[0].code, 'NO_PERMISSION');
  assert.equal((await w.exec('ACC', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 11 }] })).errors[0].code, 'NO_PERMISSION');
  await w.ok('ADMIN', 'user.upsert', { id: 'ONLYB', name: 'สโตร์ B', roles: ['store'], warehouses: ['B'] });
  assert.equal((await w.exec('ONLYB', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 11 }] })).errors[0].code, 'NO_PERMISSION');
  await w.ok('STORE1', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 11 }] });
  await w.ok('STORE1', 'count.submit', { id: ct });
  assert.equal((await w.exec('STORE2', 'count.approve', { id: ct })).errors[0].code, 'NO_PERMISSION');
  assert.equal((await w.exec('VIEW', 'count.cancel', { id: ct, reason: 'x' })).errors[0].code, 'NO_PERMISSION');
  await w.ok('ACC', 'count.approve', { id: ct }); // accounting may approve a count (and post its AJ)
});

test('Separation of duties: the importer cannot adjust from their own file; counters cannot approve their count', async () => {
  const w = await expressWorld('Express');
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  const b = (await w.ok('ACC', 'express.import', fileOf('sod.xlsx', w.clock.peek(), [{ code: 'TST-001', wh: '01', qty: 13 }]))).result.batchId;
  const own = await w.exec('ACC', 'express.resolve', { batchId: b, lines: [adjust('TST-001', 'A', 'A-01')] });
  assert.equal(own.errors[0].code, 'SAME_PERSON');
  await w.ok('ACC', 'express.resolve', { batchId: b, lines: [{ code: 'TST-001', wh: 'A', action: 'explain', reason: 'รอบัญชีอีกคนตรวจ' }] }); // explaining is not a stock change
  let s = await w.state();
  assert.equal(qty(s, { code: 'TST-001' }), 10);

  const ct = (await w.ok('LEAD', 'count.create', { wh: 'A', bins: ['A-01'] })).result.id;
  await w.ok('LEAD', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 9 }] });
  await w.ok('LEAD', 'count.submit', { id: ct });
  const self = await w.exec('LEAD', 'count.approve', { id: ct, reasons: { 'TST-001|A-01|': 'ทดสอบ' } });
  assert.equal(self.errors[0].code, 'SAME_PERSON');
  await w.ok('ACC', 'count.approve', { id: ct, reasons: { 'TST-001|A-01|': 'ทดสอบ' } });
  s = await w.state();
  assert.equal(s.tables.count_sessions[ct].approvedBy, 'ACC');
  assert.equal(qty(s, { code: 'TST-001' }), 9);
});

test('Count: an approval whose AJ would go below zero is refused whole and the session stays submitted', async () => {
  const w = await world();
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  const ct = (await w.ok('LEAD', 'count.create', { wh: 'A', bins: ['A-01'] })).result.id;
  await w.ok('STORE1', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 8 }] });
  await w.ok('STORE2', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 8 }] });
  await w.ok('STORE1', 'count.submit', { id: ct });
  await w.ok('STORE1', 'doc.post', { type: 'PD', lines: [{ code: 'TST-001', qty: 9, wh: 'A', bin: 'A-01' }] }); // system 1 now
  const before = await w.state();
  const seq = before.seq;
  const r = await w.exec('LEAD', 'count.approve', { id: ct, reasons: { 'TST-001|A-01|': 'นับได้ 8' }, ack: true });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, 'NOT_ENOUGH');
  const s = await w.state();
  assert.equal(s.seq, seq);
  assert.equal(s.tables.count_sessions[ct].status, 'SUBMITTED');
  assert.equal(qty(s, { code: 'TST-001' }), 1);
});

// ---------------------------------------------------------------------------------------------------------------
// review findings: numbers that drift, freeze gaps, stale files, separation of duties, QC stock in a count
// ---------------------------------------------------------------------------------------------------------------
test('Count: a recount after stock moved compares the difference each count found at its own time, not the raw number', async () => {
  const w = await world();
  await stockIn(w, 'TST-001', 'A', 'A-01', 100);
  await stockIn(w, 'TST-002', 'A', 'A-02', 50);
  const ct = (await w.ok('LEAD', 'count.create', { wh: 'A' })).result.id; // timestamp mode: issues go on during the count
  // STORE1 finds 3 short of 100 and 5 short of 50 – both over the limit
  const first = await w.ok('STORE1', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 97 }, { code: 'TST-002', bin: 'A-02', counted: 45 }] });
  assert.deepEqual(first.result.recount, ['TST-001|A-01|', 'TST-002|A-02|']);
  await w.ok('STORE1', 'doc.post', { type: 'PD', job: 'SO-5', lines: [{ code: 'TST-001', qty: 3, wh: 'A', bin: 'A-01' }, { code: 'TST-002', qty: 5, wh: 'A', bin: 'A-02' }] });
  // the records are now 97 and 45. STORE2 finds 94 (still 3 short = the same finding) and 45 (no difference: the same
  // number STORE1 wrote, but a different finding – that is not a confirmation)
  await w.ok('STORE2', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 94 }, { code: 'TST-002', bin: 'A-02', counted: 45 }] });
  let v = RRS.reconcile.countView(await w.state(), ct);
  const line = (code) => v.lines.find((l) => l.code === code);
  assert.deepEqual([line('TST-001').flags.includes('RECOUNTED'), line('TST-001').adjust], [true, -3]);
  assert.deepEqual([line('TST-002').flags.includes('DUPLICATE'), line('TST-002').adjust], [true, null]);
  assert.equal(v.canSubmit, false);
  assert.equal((await w.exec('STORE1', 'count.submit', { id: ct })).errors[0].code, 'NEEDS_RECOUNT');
  // a third person settles TST-002: 45 = the record now (agrees with STORE2)
  await w.ok('LEAD', 'count.enter', { id: ct, lines: [{ code: 'TST-002', bin: 'A-02', counted: 45 }] });
  v = RRS.reconcile.countView(await w.state(), ct);
  assert.deepEqual([line('TST-002').flags.includes('RECOUNTED'), line('TST-002').adjust], [true, 0]);
  await w.ok('STORE1', 'count.submit', { id: ct });
  const ap = await w.ok('ACC', 'count.approve', { id: ct, ack: true, reasons: { 'TST-001|A-01|': 'นับยืนยันสองคน ขาด 3' } });
  const s = await w.state();
  assert.equal(qty(s, { code: 'TST-001', wh: 'A', bin: 'A-01' }), 94, 'what is really on the shelf');
  assert.equal(qty(s, { code: 'TST-002', wh: 'A', bin: 'A-02' }), 45);
  assert.deepEqual(s.tables.documents[ap.result.docNo].lines.map((l) => [l.code, l.base]), [['TST-001', -3]]);
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
});

test('Freeze: a transfer already on the way cannot be received into a frozen bin (another bin can)', async () => {
  const w = await world();
  await stockIn(w, 'TST-001', 'B', 'B-01', 10);
  const tr = (await w.ok('STORE1', 'doc.post', { type: 'TR', lines: [{ code: 'TST-001', qty: 4, wh: 'B', bin: 'B-01', toWh: 'A', toBin: 'A-01' }] })).result.docNo;
  const ct = await w.ok('LEAD', 'count.create', { wh: 'A', bins: ['A-01'], mode: 'freeze' });
  assert.ok(ct.warnings.some((x) => x.includes(tr)), 'the transfer on the way is announced');
  const seq = (await w.state()).seq;
  const r = await w.exec('STORE2', 'transfer.receive', { docNo: tr, lines: [{ line: 1, qty: 1 }] });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, 'COUNT_FREEZE');
  assert.match(r.errors[0].message, /ที่ A\/A-01 /);
  // a new transfer into the frozen bin: the message names the frozen place, not the source bin
  const tr2 = await w.exec('STORE1', 'doc.post', { type: 'TR', lines: [{ code: 'TST-001', qty: 1, wh: 'B', bin: 'B-01', toWh: 'A', toBin: 'A-01' }] });
  assert.equal(tr2.errors[0].code, 'COUNT_FREEZE');
  assert.match(tr2.errors[0].message, /ที่ A\/A-01 /);
  let s = await w.state();
  assert.equal(s.seq, seq, 'nothing changed');
  assert.equal(qty(s, { code: 'TST-001', wh: RRS.TRANSIT }), 4);
  await w.ok('STORE2', 'transfer.receive', { docNo: tr, lines: [{ line: 1, qty: 1, toBin: 'A-02' }] }); // a bin not being counted
  await w.ok('LEAD', 'count.cancel', { id: ct.result.id, reason: 'เลื่อนนับ' });
  await w.ok('STORE2', 'transfer.receive', { docNo: tr }); // the rest into A-01 once released
  s = await w.state();
  assert.deepEqual([qty(s, { code: 'TST-001', wh: 'A', bin: 'A-01' }), qty(s, { code: 'TST-001', wh: 'A', bin: 'A-02' }), s.tables.documents[tr].status], [3, 1, 'RECEIVED']);
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
});

test('Express: pending documents are the ones in RRS at the snapshot (by posting time) and not keyed in Express', async () => {
  const w = await expressWorld();
  const opening = await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  const dated = await w.ok('STORE1', 'doc.post', { type: 'PD', date: '2026-11-30', lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01' }] }); // posted now, dated later
  const undone = await w.ok('STORE1', 'doc.post', { type: 'PD', lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01' }] });
  const keyed = await w.ok('STORE1', 'doc.post', { type: 'PD', lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01' }] });
  await w.ok('ACC', 'doc.markExpress', { docNo: keyed.result.docNo, expressNo: 'EXP-9' });
  const snap = w.clock.peek();
  await w.ok('LEAD', 'doc.cancel', { docNo: undone.result.docNo, reason: 'เบิกผิด' }); // cancelled after the file was made
  const later = await w.ok('STORE1', 'doc.post', { type: 'PD', lines: [{ code: 'TST-001', qty: 2, wh: 'A', bin: 'A-01' }] }); // same day, after the file
  const b = (await w.ok('LEAD', 'express.import', fileOf('pend.xlsx', snap, [{ code: 'TST-001', wh: '01', qty: 9 }]))).result.batchId;
  const row = RRS.reconcile.reconcile(await w.state(), b).rows[0];
  assert.deepEqual([row.rrsAtSnapshot, row.rrsNow, row.diff], [7, 6, 2]);
  // the 2 is explained by the two PDs that were in RRS at the snapshot but are not in Express
  assert.deepEqual(row.pendingDocs, [opening.result.docNo, dated.result.docNo, undone.result.docNo].sort());
  assert.ok(!row.pendingDocs.includes(later.result.docNo), 'posted after the file: it cannot explain the difference');
  assert.ok(!row.pendingDocs.includes(keyed.result.docNo));
});

test('Express: a count made after the file – even one without a difference – makes the file stale for that row', async () => {
  const w = await expressWorld('Express');
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  await stockIn(w, 'TST-002', 'A', 'A-01', 5);
  const b = (await w.ok('LEAD', 'express.import', fileOf('before-count.xlsx', w.clock.peek(), [{ code: 'TST-001', wh: '01', qty: 12 }, { code: 'TST-002', wh: '01', qty: 6 }]))).result.batchId;
  const ct = (await w.ok('LEAD', 'count.create', { wh: 'A', bins: ['A-01'] })).result.id;
  await w.ok('STORE1', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 10 }] }); // the record is right
  await w.ok('STORE1', 'count.submit', { id: ct });
  assert.equal((await w.ok('LEAD', 'count.approve', { id: ct })).result.docNo, '', 'no difference, no AJ');
  let s = await w.state();
  assert.deepEqual(RRS.reconcile.reconcile(s, b).rows.find((r) => r.code === 'TST-001').staleBy, [ct]);
  const seq = s.seq;
  const r = await w.exec('ACC', 'express.resolve', { batchId: b, confirmOld: true, lines: [adjust('TST-001', 'A', 'A-01')] });
  assert.equal(r.errors[0].code, 'STALE_ROW');
  assert.ok(r.errors[0].message.includes(ct));
  s = await w.state();
  assert.equal(s.seq, seq);
  assert.equal(qty(s, { code: 'TST-001' }), 10, 'the counted quantity is not overwritten by the older file');
  // the row the count did not cover still follows the file
  await w.ok('ACC', 'express.resolve', { batchId: b, lines: [adjust('TST-002', 'A', 'A-01')] });
  assert.equal(qty(await w.state(), { code: 'TST-002' }), 6);
});

test('Separation of duties: whoever sends a count for approval cannot approve it', async () => {
  const w = await world();
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  const ct = (await w.ok('LEAD', 'count.create', { wh: 'A', bins: ['A-01'] })).result.id;
  await w.ok('STORE1', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 9 }] });
  await w.ok('LEAD', 'count.submit', { id: ct }); // LEAD did not count, but asks for the approval
  const own = await w.exec('LEAD', 'count.approve', { id: ct, reasons: { 'TST-001|A-01|': 'ชำรุด' } });
  assert.equal(own.errors[0].code, 'SAME_PERSON');
  assert.equal(qty(await w.state(), { code: 'TST-001' }), 10);
  await w.ok('ACC', 'count.approve', { id: ct, reasons: { 'TST-001|A-01|': 'ชำรุด' } });
  const s = await w.state();
  assert.deepEqual([s.tables.count_sessions[ct].submittedBy, s.tables.count_sessions[ct].approvedBy, qty(s, { code: 'TST-001' })], ['LEAD', 'ACC', 9]);
});

test('Express: a move between bins of one warehouse still in transit stays in that warehouse; a bad time gives no number', async () => {
  const w = await expressWorld();
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  await stockIn(w, 'TST-001', 'B', 'B-01', 5);
  const binMove = (await w.ok('STORE1', 'doc.post', { type: 'TR', lines: [{ code: 'TST-001', qty: 4, wh: 'A', bin: 'A-01', toWh: 'A', toBin: 'A-02' }] })).result.docNo;
  await w.ok('STORE1', 'doc.post', { type: 'TR', lines: [{ code: 'TST-001', qty: 2, wh: 'B', bin: 'B-01', toWh: 'A', toBin: 'A-01' }] }); // between warehouses
  const snap = w.clock.peek();
  await w.ok('STORE2', 'transfer.receive', { docNo: binMove }); // received after the file
  const b = (await w.ok('LEAD', 'express.import', fileOf('bins.xlsx', snap, [{ code: 'TST-001', wh: '01', qty: 10 }, { code: 'TST-001', wh: 'B', qty: 3 }]))).result.batchId;
  const s = await w.state();
  const rows = RRS.reconcile.reconcile(s, b).rows;
  const a = rows.find((r) => r.wh === 'A');
  assert.deepEqual([a.status, a.rrsAtSnapshot, a.rrsNow], ['MATCH', 10, 10], 'Express has no bins: a bin move is no difference');
  assert.equal(rows.find((r) => r.wh === 'B').rrsAtSnapshot, 3, 'between warehouses: in neither until received');
  assert.equal(RRS.reconcile.rrsQtyAt(s, 'TST-001', 'A', snap), 10);
  assert.equal(RRS.reconcile.rrsQtyAt(s, 'TST-001', 'A', 'not a time'), null, 'a bad time is not answered with today’s quantity');
});

test('Count: counting above the record where QC stock lies must be checked (ack) before adjusting', async () => {
  const w = await world();
  await w.ok('LEAD', 'doc.post', { type: 'AJ', lines: [{ code: 'TST-001', qty: 5, wh: 'A', bin: 'A-01', status: 'QC_HOLD' }, { code: 'TST-002', qty: 2, wh: 'A', bin: 'A-01', status: 'QC_HOLD' }] });
  await w.ok('LEAD', 'doc.post', { type: 'AJ', lines: [{ code: 'TST-001', qty: 10, wh: 'A', bin: 'A-01' }, { code: 'TST-002', qty: 4, wh: 'A', bin: 'A-01' }] });
  const ct = (await w.ok('LEAD', 'count.create', { wh: 'A', bins: ['A-01'] })).result.id;
  // 15 = 10 usable + the 5 tagged for QC, most likely counted together; TST-002 is 1 short (no double count possible)
  await w.ok('STORE1', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 15 }, { code: 'TST-002', bin: 'A-01', counted: 3 }] });
  await w.ok('STORE2', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 15 }] });
  await w.ok('STORE1', 'count.submit', { id: ct });
  const v = RRS.reconcile.countView(await w.state(), ct);
  const l1 = v.lines.find((l) => l.code === 'TST-001');
  const l2 = v.lines.find((l) => l.code === 'TST-002');
  assert.deepEqual([l1.adjust, l1.heldQty, l1.flags.includes('HELD_STOCK')], [5, 5, true]);
  assert.deepEqual([l2.adjust, l2.heldQty, l2.flags.includes('HELD_STOCK')], [-1, 2, false]);
  assert.equal(v.needsAck, true);
  const seq = (await w.state()).seq;
  const reasons = { 'TST-001|A-01|': 'ตรวจแล้ว ของเกินอยู่นอกพื้นที่กักกัน', 'TST-002|A-01|': 'ชำรุดทิ้ง' };
  const noAck = await w.exec('ACC', 'count.approve', { id: ct, reasons });
  assert.equal(noAck.errors[0].code, 'HELD_STOCK');
  assert.equal((await w.state()).seq, seq);
  await w.ok('ACC', 'count.approve', { id: ct, reasons, ack: true });
  const s = await w.state();
  assert.deepEqual([s.tables.count_sessions[ct].ack.by, s.tables.count_sessions[ct].ack.held], ['ACC', ['TST-001|A-01|']]);
  assert.equal(qty(s, { code: 'TST-001', status: 'AVAILABLE' }), 15);
  assert.equal(qty(s, { code: 'TST-001', status: 'QC_HOLD' }), 5, 'QC stock is untouched by the count');
  assert.equal(qty(s, { code: 'TST-002', status: 'AVAILABLE' }), 3);
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
});

test('Express: adjust, cancel, cancel again, adjust again – the difference is applied once and every decision is kept', async () => {
  const w = await expressWorld('Express');
  const opening = await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  const b = (await w.ok('LEAD', 'express.import', fileOf('redo.xlsx', w.clock.peek(), [{ code: 'TST-001', wh: '01', qty: 7 }]))).result.batchId;
  await w.ok('STORE1', 'doc.post', { type: 'PD', lines: [{ code: 'TST-001', qty: 2, wh: 'A', bin: 'A-01' }] }); // after the file
  const r1 = await w.ok('ACC', 'express.resolve', { batchId: b, lines: [adjust('TST-001', 'A', 'A-01')] });
  // the opening AJ was never keyed in Express: the person adjusting is told (it must not be keyed on top of the file)
  assert.ok(r1.warnings.some((x) => x.includes(opening.result.docNo)));
  let s = await w.state();
  assert.equal(qty(s, { code: 'TST-001' }), 5, '8 now − 3 found at the snapshot');
  assert.deepEqual(s.tables.express_batches[b].resolutions[0].pendingDocs, [opening.result.docNo]);
  await w.ok('LEAD', 'doc.cancel', { docNo: r1.result.docNo, reason: 'ปรับผิด' });
  assert.equal((await w.exec('LEAD', 'doc.cancel', { docNo: r1.result.docNo, reason: 'ซ้ำ' })).errors[0].code, 'ALREADY_CANCELLED');
  s = await w.state();
  assert.equal(qty(s, { code: 'TST-001' }), 8);
  const r2 = await w.ok('ACC', 'express.resolve', { batchId: b, lines: [adjust('TST-001', 'A', 'A-01', 'ตรวจแล้ว ยึด Express')] });
  assert.notEqual(r2.result.docNo, r1.result.docNo);
  s = await w.state();
  assert.equal(qty(s, { code: 'TST-001' }), 5, 'the same difference once – not twice');
  const row = RRS.reconcile.reconcile(s, b).rows[0];
  assert.deepEqual([row.diff, row.resolution.docNo, row.resolved], [-3, r2.result.docNo, true]);
  assert.deepEqual(s.tables.express_batches[b].resolutions.map((x) => [x.docNo, !!x.cancelledAt]), [[r1.result.docNo, true], [r2.result.docNo, false]]);
  await w.ok('ACC', 'express.close', { batchId: b });
  assert.deepEqual(RRS.inventory.verifyBalances(await w.state()), []);
});

test('Freeze and stale checks trust no document `source` typed by the caller', async () => {
  const w = await expressWorld('Express');
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  const b = (await w.ok('LEAD', 'express.import', fileOf('spoof.xlsx', w.clock.peek(), [{ code: 'TST-001', wh: '01', qty: 12 }]))).result.batchId;
  const ct = (await w.ok('LEAD', 'count.create', { wh: 'A', bins: ['A-01'], mode: 'freeze' })).result.id;
  const seq = (await w.state()).seq;
  // a document claiming to be the count's own adjustment is still a document in a frozen bin
  const pd = await w.exec('STORE1', 'doc.post', { type: 'PD', source: 'count:' + ct, lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01' }] });
  assert.equal(pd.ok, false);
  assert.equal(pd.errors[0].code, 'COUNT_FREEZE');
  assert.equal((await w.state()).seq, seq);
  await w.ok('LEAD', 'count.cancel', { id: ct, reason: 'ทดสอบเสร็จ' });
  // a hand-made AJ claiming a count / another Express batch as its source does not make the file stale
  const fake = await w.ok('LEAD', 'doc.post', { type: 'AJ', source: 'count:CT-00009', lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01' }] });
  await w.ok('LEAD', 'doc.post', { type: 'AJ', source: 'express:' + b, lines: [{ code: 'TST-001', qty: -1, wh: 'A', bin: 'A-01' }] });
  let s = await w.state();
  assert.deepEqual(RRS.reconcile.reconcile(s, b).rows[0].staleBy, []);
  const r = await w.ok('ACC', 'express.resolve', { batchId: b, lines: [adjust('TST-001', 'A', 'A-01')] });
  assert.equal(qty(await w.state(), { code: 'TST-001' }), 12);
  // cancelling the fake one does not reopen the batch's real decision
  await w.ok('LEAD', 'doc.cancel', { docNo: fake.result.docNo, reason: 'ทดสอบ' });
  s = await w.state();
  assert.equal(s.tables.express_batches[b].resolutions[0].cancelledAt, '');
  assert.equal(RRS.reconcile.reconcile(s, b).rows[0].resolution.docNo, r.result.docNo);
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
});
