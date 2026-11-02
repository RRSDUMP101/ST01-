import test from 'node:test';
import assert from 'node:assert/strict';
import { RRS, world, stockIn } from './helpers.mjs';
const qty = (s, f) => RRS.q.qty(s, f);
const fileOf = (fileName, snapshotAt, rows) => ({ fileName, snapshotAt, rows, fileHash: RRS.util.sha256(fileName + snapshotAt + JSON.stringify(rows)) });

test('P1 recount after an issue: compare like with like', async () => {
  const w = await world();
  await stockIn(w, 'TST-001', 'A', 'A-01', 100);
  const ct = (await w.ok('LEAD', 'count.create', { wh: 'A', bins: ['A-01'] })).result.id;
  await w.ok('STORE1', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 97 }] }); // -3 at 100
  await w.ok('STORE2', 'doc.post', { type: 'PD', lines: [{ code: 'TST-001', qty: 3, wh: 'A', bin: 'A-01' }] }); // sys 97, real 94
  await w.ok('STORE2', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 94 }] }); // -3 at 97 -> agrees
  const v = RRS.reconcile.countView(await w.state(), ct);
  console.log('P1a', v.lines[0].flags, v.lines[0].adjust);
  // false agreement
  const w2 = await world();
  await stockIn(w2, 'TST-001', 'A', 'A-01', 100);
  const c2 = (await w2.ok('LEAD', 'count.create', { wh: 'A', bins: ['A-01'] })).result.id;
  await w2.ok('STORE1', 'count.enter', { id: c2, lines: [{ code: 'TST-001', bin: 'A-01', counted: 97 }] });
  await w2.ok('STORE2', 'doc.post', { type: 'PD', lines: [{ code: 'TST-001', qty: 3, wh: 'A', bin: 'A-01' }] });
  await w2.ok('STORE2', 'count.enter', { id: c2, lines: [{ code: 'TST-001', bin: 'A-01', counted: 97 }] }); // implies 0
  const v2 = RRS.reconcile.countView(await w2.state(), c2);
  console.log('P1b', v2.lines[0].flags, v2.lines[0].adjust);
});

test('P2 transfer.receive into frozen bin', async () => {
  const w = await world();
  await stockIn(w, 'TST-001', 'B', 'B-01', 10);
  const tr = await w.ok('STORE1', 'doc.post', { type: 'TR', lines: [{ code: 'TST-001', qty: 4, wh: 'B', bin: 'B-01', toWh: 'A', toBin: 'A-01' }] });
  await w.ok('LEAD', 'count.create', { wh: 'A', bins: ['A-01'], mode: 'freeze' });
  const r = await w.exec('STORE2', 'transfer.receive', { docNo: tr.result.docNo });
  console.log('P2', r.ok, r.errors);
  const r2 = await w.exec('STORE1', 'doc.post', { type: 'TR', lines: [{ code: 'TST-001', qty: 1, wh: 'B', bin: 'B-01', toWh: 'A', toBin: 'A-01' }] });
  console.log('P2 msg', r2.errors && r2.errors[0].message);
});

test('P3 pendingDocs timing', async () => {
  const w = await world();
  await w.ok('LEAD', 'warehouse.upsert', { code: 'A', name: 'คลัง A', expressCode: '01' });
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  const fut = await w.ok('STORE1', 'doc.post', { type: 'PD', date: '2026-11-30', lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01' }] });
  const T = w.clock.peek();
  const after = await w.ok('STORE1', 'doc.post', { type: 'PD', lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01' }] });
  const b = (await w.ok('LEAD', 'express.import', fileOf('x', T, [{ code: 'TST-001', wh: '01', qty: 10 }]))).result.batchId;
  const s = await w.state();
  const row = RRS.reconcile.reconcile(s, b).rows[0];
  console.log('P3', row.pendingDocs, 'future', fut.result.docNo, 'after', after.result.docNo, row.rrsAtSnapshot);
});

test('P5 zero-diff count after snapshot', async () => {
  const w = await world();
  await w.ok('LEAD', 'warehouse.upsert', { code: 'A', name: 'คลัง A', expressCode: '01' });
  await w.ok('ADMIN', 'settings.update', { patch: { ownership: { qty: 'Express' } } });
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  const T = w.clock.peek();
  const b = (await w.ok('LEAD', 'express.import', fileOf('x', T, [{ code: 'TST-001', wh: '01', qty: 12 }]))).result.batchId;
  const ct = (await w.ok('LEAD', 'count.create', { wh: 'A', bins: ['A-01'] })).result.id;
  await w.ok('STORE1', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 10 }] });
  await w.ok('STORE1', 'count.submit', { id: ct });
  await w.ok('LEAD', 'count.approve', { id: ct });
  const r = await w.exec('ACC', 'express.resolve', { batchId: b, lines: [{ code: 'TST-001', wh: 'A', bin: 'A-01', action: 'adjust', reason: 'x' }] });
  console.log('P5', r.ok, r.errors && r.errors[0].code, qty(await w.state(), { code: 'TST-001' }));
});

test('P6 submitter approves', async () => {
  const w = await world();
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  const ct = (await w.ok('LEAD', 'count.create', { wh: 'A', bins: ['A-01'] })).result.id;
  await w.ok('STORE1', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 9 }] });
  await w.ok('LEAD', 'count.submit', { id: ct });
  const r = await w.exec('LEAD', 'count.approve', { id: ct, reasons: { 'TST-001|A-01|': 'x' } });
  console.log('P6', r.ok, r.errors);
});

test('P7 intra-warehouse transfer in transit at snapshot', async () => {
  const w = await world();
  await w.ok('LEAD', 'warehouse.upsert', { code: 'A', name: 'คลัง A', expressCode: '01' });
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  const tr = await w.ok('STORE1', 'doc.post', { type: 'TR', lines: [{ code: 'TST-001', qty: 4, wh: 'A', bin: 'A-01', toWh: 'A', toBin: 'A-02' }] });
  const T = w.clock.peek();
  const b = (await w.ok('LEAD', 'express.import', fileOf('x', T, [{ code: 'TST-001', wh: '01', qty: 10 }]))).result.batchId;
  const s = await w.state();
  const row = RRS.reconcile.reconcile(s, b).rows[0];
  console.log('P7', row.status, row.express, row.rrsAtSnapshot, row.rrsNow, RRS.reconcile.rrsQtyAt(s, 'TST-001', 'A', T));
  console.log('P8 invalid time', RRS.reconcile.rrsQtyAt(s, 'TST-001', 'A', 'not a time'));
});

test('P9 count of a bin holding QC stock', async () => {
  const w = await world();
  await w.ok('LEAD', 'doc.post', { type: 'AJ', lines: [{ code: 'TST-001', qty: 5, wh: 'A', bin: 'A-01', status: 'QC_HOLD' }] });
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  const ct = (await w.ok('LEAD', 'count.create', { wh: 'A', bins: ['A-01'] })).result.id;
  await w.ok('STORE1', 'count.enter', { id: ct, lines: [{ code: 'TST-001', bin: 'A-01', counted: 15 }] });
  const v = RRS.reconcile.countView(await w.state(), ct);
  console.log('P9', JSON.stringify(v.lines[0]));
});
