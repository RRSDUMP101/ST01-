// Phase 2 – จองราย SO และเชื่อมการเบิกกับงานผลิต (plan file 01): acceptance criteria + permissions, separation of
// duties, cancel/undo and bad input. Uses only core/master/inventory commands and the planning module's commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RRS, world, stockIn } from './helpers.mjs';

const P = RRS.planning;
const qty = (s, f) => RRS.q.qty(s, f);
const TODAY = '2026-11-02';
const sixOf = (s, code, extra = {}) => P.six(s, { code, today: TODAY, ...extra })[0];
const res = (s, id) => s.tables.reservations[id];
const jobRow = (s, no) => s.tables.jobs[no];
const lineOf = (s, no, code) => jobRow(s, no).lines.find((l) => l.code === code && !l.output);
const codeOf = (r) => (r.ok ? 'OK' : r.errors[0].code);

/** World + an approved BOM: TST-FG rev A = TST-001 × 2 + TST-002 × 1. */
async function plant() {
  const w = await world();
  await w.ok('ENG', 'bom.upsert', { product: 'TST-FG', rev: 'A', lines: [{ code: 'TST-001', qty: 2 }, { code: 'TST-002', qty: 1 }] });
  await w.ok('ENG', 'bom.approve', { product: 'TST-FG', rev: 'A' });
  return w;
}
async function job(w, payload, user = 'PLAN') {
  const r = await w.ok(user, 'job.create', { dueDate: '2026-11-20', ...payload });
  return r.result.jobNo;
}
async function reserve(w, jobNo, code, wh, n, extra = {}, user = 'PLAN') {
  const r = await w.ok(user, 'reserve.create', { jobNo, code, wh, qty: n, ...extra });
  return r.result.id;
}
const pick = (w, jobNo, lines, user = 'STORE1', requestId) => w.exec(user, 'pick.post', { jobNo, lines }, requestId);

// ---------------------------------------------------------------------------------------------------------------
// acceptance criteria
// ---------------------------------------------------------------------------------------------------------------
test('เกณฑ์: สอง SO ไม่จองเกินยอดพร้อมใช้', async () => {
  const w = await plant();
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  const j1 = await job(w, { soNo: 'SO-001', product: 'TST-FG', qty: 4 }); // TST-001 ต้องใช้ 8
  const j2 = await job(w, { soNo: 'SO-002', product: 'TST-FG', qty: 4 });
  const r1 = await reserve(w, j1, 'TST-001', 'A', 7);
  const over = await w.exec('PLAN', 'reserve.create', { jobNo: j2, code: 'TST-001', wh: 'A', qty: 5 });
  assert.equal(codeOf(over), 'OVER_FREE');
  assert.match(over.errors[0].message, /พร้อมเบิก/);
  const part = await w.ok('PLAN', 'reserve.create', { jobNo: j2, code: 'TST-001', wh: 'A', qty: 5, allowPartial: true });
  assert.equal(part.result.qty, 3);
  assert.equal(part.result.partial, true);
  assert.equal(part.result.short, 2);
  const none = await w.exec('LEAD', 'reserve.create', { jobNo: j2, code: 'TST-001', wh: 'A', qty: 1, allowPartial: true });
  assert.equal(codeOf(none), 'NO_FREE');
  let s = await w.state();
  const row = sixOf(s, 'TST-001');
  assert.equal(row.available, 10);
  assert.equal(row.reserved, 10);
  assert.equal(row.free, 0);
  assert.equal(row.demand, 16);
  assert.equal(row.short, 6);
  assert.equal(res(s, part.result.id).requested, 5);
  // reserved stock cannot be issued without a job, or to the other SO beyond its own reservation
  const ou = await w.exec('STORE1', 'doc.post', { type: 'OU', lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01' }] });
  assert.equal(codeOf(ou), 'RESERVED');
  const pd = await w.exec('STORE1', 'doc.post', { type: 'PD', job: j2, lines: [{ code: 'TST-001', qty: 4, wh: 'A', bin: 'A-01' }] });
  assert.equal(codeOf(pd), 'RESERVED');
  await w.ok('STORE1', 'doc.post', { type: 'PD', job: j2, lines: [{ code: 'TST-001', qty: 3, wh: 'A', bin: 'A-01' }] });
  s = await w.state();
  assert.equal(res(s, part.result.id).status, 'FILLED');
  assert.equal(res(s, r1).status, 'OPEN');
  assert.equal(P.remaining(res(s, r1)), 7);
  assert.equal(qty(s, { code: 'TST-001' }), 7);
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
});

test('เกณฑ์: สอง SO จองพร้อมกันในเวลาเดียวกัน – รวมแล้วไม่เกินยอดพร้อมใช้', async () => {
  const w = await plant();
  await stockIn(w, 'TST-002', 'A', 'A-01', 10);
  const j1 = await job(w, { soNo: 'SO-101', lines: [{ code: 'TST-002', qty: 8 }] });
  const j2 = await job(w, { soNo: 'SO-102', lines: [{ code: 'TST-002', qty: 8 }] });
  w.store.delay = 3; // both requests in flight together
  const [a, b] = await Promise.all([
    w.exec('PLAN', 'reserve.create', { jobNo: j1, code: 'TST-002', wh: 'A', qty: 6 }, 'rq-a'),
    w.exec('LEAD', 'reserve.create', { jobNo: j2, code: 'TST-002', wh: 'A', qty: 6 }, 'rq-b'),
  ]);
  w.store.delay = 0;
  assert.equal([a.ok, b.ok].filter(Boolean).length, 1, JSON.stringify([a.errors, b.errors]));
  assert.equal(codeOf(a.ok ? b : a), 'OVER_FREE');
  const s = await w.state();
  assert.equal(sixOf(s, 'TST-002').reserved, 6);
  assert.equal(sixOf(s, 'TST-002').free, 4);
});

test('เกณฑ์: ยกเลิกงานคืนยอดจองถูกต้อง', async () => {
  const w = await plant();
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  const j1 = await job(w, { soNo: 'SO-201', product: 'TST-FG', qty: 3 }); // ต้องใช้ 6
  const j2 = await job(w, { soNo: 'SO-202', product: 'TST-FG', qty: 4 }); // ต้องใช้ 8
  const r1 = await reserve(w, j1, 'TST-001', 'A', 6);
  const r2 = await reserve(w, j2, 'TST-001', 'A', 4);
  let s = await w.state();
  assert.equal(sixOf(s, 'TST-001').free, 0);
  const noReason = await w.exec('PLAN', 'job.cancel', { jobNo: j1 });
  assert.equal(codeOf(noReason), 'REQUIRED');
  const c = await w.ok('PLAN', 'job.cancel', { jobNo: j1, reason: 'ลูกค้ายกเลิก SO' });
  assert.deepEqual(c.result.released.map((x) => [x.id, x.qty]), [[r1, 6]]);
  s = await w.state();
  const rel = res(s, r1);
  assert.equal(rel.status, 'RELEASED');
  assert.equal(rel.releasedBy, 'PLAN');
  assert.ok(rel.releasedAt);
  assert.equal(rel.releasedQty, 6);
  assert.match(rel.reason, /ลูกค้ายกเลิก SO/);
  assert.equal(res(s, r2).status, 'OPEN');
  assert.equal(P.remaining(res(s, r2)), 4);
  assert.equal(jobRow(s, j1).status, 'CANCELLED');
  assert.equal(jobRow(s, j1).cancelledBy, 'PLAN');
  assert.equal(jobRow(s, j1).cancelReason, 'ลูกค้ายกเลิก SO');
  const row = sixOf(s, 'TST-001');
  assert.equal(row.reserved, 4);
  assert.equal(row.free, 6);
  assert.equal(row.demand, 8); // the cancelled job no longer counts
  // the freed stock can now be reserved by the other SO
  await reserve(w, j2, 'TST-001', 'A', 4);
  s = await w.state();
  assert.equal(sixOf(s, 'TST-001').free, 2);
  assert.equal(codeOf(await w.exec('PLAN', 'job.cancel', { jobNo: j1, reason: 'ซ้ำ' })), 'ALREADY_CANCELLED');
  assert.equal(codeOf(await w.exec('PLAN', 'reserve.create', { jobNo: j1, code: 'TST-001', wh: 'A', qty: 1 })), 'JOB_CLOSED');
  assert.equal(codeOf(await w.exec('STORE1', 'doc.post', { type: 'PD', job: j1, lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01' }] })), 'JOB_CLOSED');
  assert.ok(res(s, r1), 'ใบจองที่ปล่อยแล้วยังอยู่ (ไม่ลบประวัติ)');
});

test('เกณฑ์: เบิกบางส่วนแล้วเหลือยอดจองถูกต้อง', async () => {
  const w = await plant();
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  const j1 = await job(w, { soNo: 'SO-301', product: 'TST-FG', qty: 3 }); // ต้องใช้ 6
  const id = await reserve(w, j1, 'TST-001', 'A', 6);
  const line = { reservationId: id, qty: 4, wh: 'A', bin: 'A-01', scannedCode: 'TST-001' };
  const p1 = await pick(w, j1, [line], 'STORE1', 'scan-1');
  assert.equal(p1.ok, true, JSON.stringify(p1.errors));
  assert.match(p1.result.docNo, /^PD6911-\d{4}$/);
  const again = await pick(w, j1, [line], 'STORE1', 'scan-1'); // the same scan sent twice
  assert.equal(again.duplicate, true);
  let s = await w.state();
  const r = res(s, id);
  assert.equal(r.issued, 4);
  assert.equal(r.status, 'PARTIAL');
  assert.equal(P.remaining(r), 2);
  assert.equal(r.uses.length, 1);
  assert.equal(r.uses[0].docNo, p1.result.docNo);
  assert.equal(lineOf(s, j1, 'TST-001').issued, 4);
  assert.equal(jobRow(s, j1).status, 'IN_PROGRESS');
  assert.equal(qty(s, { code: 'TST-001' }), 6);
  const doc = s.tables.documents[p1.result.docNo];
  assert.equal(doc.type, 'PD');
  assert.equal(doc.job, j1);
  assert.equal(doc.lines[0].reservationId, id);
  assert.equal(RRS.inventory.history(s, { docNo: p1.result.docNo })[0].job, j1);
  const pl = P.pickList(s, j1);
  assert.equal(pl.length, 1);
  assert.equal(pl[0].remaining, 2);
  assert.deepEqual(pl[0].suggest, [{ bin: 'A-01', lot: '', qty: 2 }]);
  const row = sixOf(s, 'TST-001');
  assert.equal(row.reserved, 2);
  assert.equal(row.free, 4);
  assert.equal(row.demand, 2);
  assert.equal(row.short, 0);
  const over = await pick(w, j1, [{ reservationId: id, qty: 3, wh: 'A', bin: 'A-01' }]);
  assert.equal(codeOf(over), 'OVER_PICK');
  await w.ok('STORE1', 'pick.post', { jobNo: j1, lines: [{ reservationId: id, qty: 2, wh: 'A', bin: 'A-01' }] });
  s = await w.state();
  assert.equal(res(s, id).status, 'FILLED');
  assert.equal(P.remaining(res(s, id)), 0);
  assert.equal(P.pickList(s, j1).length, 0);
  const rd = P.readiness(s, j1);
  assert.equal(rd.lines.find((l) => l.code === 'TST-001').status, 'พร้อม');
  assert.equal(qty(s, { code: 'TST-001' }), 4);
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
});

test('เกณฑ์: ของรอตรวจและของคาดว่าจะเข้าไม่ถูกเบิกเป็นของพร้อมใช้', async () => {
  const w = await plant();
  const jA = await job(w, { soNo: 'SO-401', product: 'TST-FG', qty: 2 }); // ผลิต TST-FG 2 ชุด (บรรทัด 0)
  const jB = await job(w, { soNo: 'SO-402', lines: [{ code: 'TST-FG', qty: 1 }] }); // ต้องการ TST-FG 1 ชุดไปส่ง
  let s = await w.state();
  let fg = sixOf(s, 'TST-FG');
  assert.equal(fg.wip, 2); // future production is not free stock
  assert.equal(fg.available, 0);
  assert.equal(fg.free, 0);
  assert.equal(fg.demand, 1);
  assert.equal(codeOf(await w.exec('PLAN', 'reserve.create', { jobNo: jB, code: 'TST-FG', wh: 'A', qty: 1 })), 'NO_FREE');
  // production finishes one, the store receives it against the job: a qcFinal item waits for QC
  await w.ok('PROD', 'job.record', { jobNo: jA, line: 0, qty: 1 });
  await w.ok('STORE1', 'doc.post', { type: 'FR', job: jA, lines: [{ code: 'TST-FG', qty: 1, wh: 'A', bin: 'A-01' }] });
  s = await w.state();
  assert.equal(qty(s, { code: 'TST-FG', status: 'QC_HOLD' }), 1);
  assert.equal(qty(s, { code: 'TST-FG', status: 'AVAILABLE' }), 0);
  assert.equal(jobRow(s, jA).lines[0].received, 1);
  fg = sixOf(s, 'TST-FG');
  assert.equal(fg.onHand, 1);
  assert.equal(fg.qcHold, 1);
  assert.equal(fg.available, 0);
  assert.equal(fg.free, 0);
  assert.equal(fg.wip, 1);
  assert.equal(fg.short, 1);
  assert.equal(codeOf(await w.exec('PLAN', 'reserve.create', { jobNo: jB, code: 'TST-FG', wh: 'A', qty: 1 })), 'NO_FREE');
  assert.equal(codeOf(await w.exec('PLAN', 'reserve.auto', { jobNo: jB })), 'NOTHING');
  assert.equal(codeOf(await w.exec('STORE1', 'doc.post', { type: 'PD', job: jB, lines: [{ code: 'TST-FG', qty: 1, wh: 'A', bin: 'A-01' }] })), 'NOT_ENOUGH');
  assert.equal(codeOf(await w.exec('STORE1', 'doc.post', { type: 'PD', job: jB, lines: [{ code: 'TST-FG', qty: 1, wh: 'A', bin: 'A-01', status: 'QC_HOLD' }] })), 'BAD_STATUS');
  assert.deepEqual(P.pickList(s, jB), []);
  const rd = P.readiness(s, jB);
  assert.equal(rd.lines[0].status, 'รอตรวจ');
  assert.equal(rd.lines[0].missing, 1);
  // a PO still to arrive (pos table of Phase 4) shows as incoming with its date – never as free stock
  const s2 = structuredClone(s);
  s2.tables.pos = {
    'PO6911-0001': { poNo: 'PO6911-0001', status: 'ISSUED', lines: [{ line: 1, code: 'TST-002', qty: 5, unit: 'ชิ้น', factor: 1, base: 5, dueDate: '2026-11-10', wh: 'A', received: 1, returned: 0, cancelled: 0 }] },
    'PO6911-0002': { poNo: 'PO6911-0002', status: 'DRAFT', lines: [{ line: 1, code: 'TST-002', qty: 9, base: 9, dueDate: '2026-11-05', wh: 'A', received: 0, cancelled: 0 }] },
  };
  const inc = P.six(s2, { code: 'TST-002', today: '2026-11-12' })[0];
  assert.equal(inc.incoming, 4);
  assert.equal(inc.nextIncomingDate, '2026-11-10');
  assert.equal(inc.lateIncoming, 4);
  assert.equal(inc.available, 0);
  assert.equal(inc.free, 0);
  const tryReserve = RRS.core.prepare(s2, { kind: 'reserve.create', payload: { jobNo: jA, code: 'TST-002', wh: 'A', qty: 1 } },
    { now: '2026-11-12T03:00:00.000Z', user: 'PLAN' });
  assert.equal(tryReserve.ok, false);
  assert.equal(tryReserve.errors[0].code, 'NO_FREE');
});

// ---------------------------------------------------------------------------------------------------------------
// plan items 1–4
// ---------------------------------------------------------------------------------------------------------------
test('ใบงานจาก BOM ที่อนุมัติ × จำนวนชุด; BOM ร่าง/ไม่มี BOM ถูกปฏิเสธ; ใบงานแบบระบุรายการเอง', async () => {
  const w = await plant();
  const r = await w.ok('PLAN', 'job.create', { soNo: 'so-500', product: 'TST-FG', qty: 3, dueDate: '2026-11-30', priority: 2, remark: 'ทดสอบ' });
  assert.equal(r.result.jobNo, 'JB6911-0001');
  let s = await w.state();
  const j = jobRow(s, r.result.jobNo);
  assert.equal(j.soNo, 'SO-500');
  assert.equal(j.bomRev, 'A');
  assert.equal(j.status, 'OPEN');
  assert.equal(j.priority, 2);
  assert.equal(j.createdBy, 'PLAN');
  assert.deepEqual(j.lines.map((l) => [l.line, l.code, l.required, l.toMake, !!l.output]),
    [[0, 'TST-FG', 0, 3, true], [1, 'TST-001', 6, 0, false], [2, 'TST-002', 3, 0, false]]);
  await w.ok('ENG', 'bom.upsert', { product: 'TST-FG', rev: 'B', lines: [{ code: 'TST-001', qty: 3 }] });
  const draft = await w.exec('PLAN', 'job.create', { soNo: 'SO-501', product: 'TST-FG', bomRev: 'B', qty: 1, dueDate: '2026-11-30' });
  assert.equal(codeOf(draft), 'BOM_NOT_APPROVED');
  const nob = await w.exec('PLAN', 'job.create', { soNo: 'SO-502', product: 'TST-002', qty: 1, dueDate: '2026-11-30' });
  assert.equal(codeOf(nob), 'NO_BOM');
  const m = await w.ok('PLAN', 'job.create', { jobNo: 'jb-man-1', soNo: 'SO-503', qty: 2, dueDate: '2026-12-01',
    lines: [{ code: 'TST-001', qty: 1, unit: 'โหล' }, { code: 'tst 002', qty: 3 }, { code: 'TST-001', qty: 2 }] });
  assert.equal(m.result.jobNo, 'JB-MAN-1');
  s = await w.state();
  assert.deepEqual(jobRow(s, 'JB-MAN-1').lines.map((l) => [l.line, l.code, l.per, l.required]),
    [[1, 'TST-001', 14, 28], [2, 'TST-002', 3, 6]]);
  assert.equal(jobRow(s, 'JB-MAN-1').product, '');
  assert.equal(codeOf(await w.exec('PLAN', 'job.create', { jobNo: 'JB-MAN-1', soNo: 'SO-504', lines: [{ code: 'TST-001', qty: 1 }], dueDate: '2026-12-01' })), 'DUPLICATE');
  // after a new BOM revision is approved, new jobs take it by default
  await w.ok('ENG', 'bom.approve', { product: 'TST-FG', rev: 'B' });
  const nb = await job(w, { soNo: 'SO-505', product: 'TST-FG', qty: 1 });
  s = await w.state();
  assert.equal(jobRow(s, nb).bomRev, 'B');
});

test('เปลี่ยนการจัดสรร: ลด/เพิ่มยอดจอง ย้ายคลัง ไม่ต่ำกว่าที่เบิก และตรวจของพร้อมเบิกเหมือนจองใหม่', async () => {
  const w = await plant();
  await stockIn(w, 'TST-001', 'A', 'A-01', 6);
  await stockIn(w, 'TST-001', 'B', 'B-01', 5);
  const j1 = await job(w, { soNo: 'SO-601', lines: [{ code: 'TST-001', qty: 10 }] });
  const j2 = await job(w, { soNo: 'SO-602', lines: [{ code: 'TST-001', qty: 10 }] });
  const id = await reserve(w, j1, 'TST-001', 'A', 5);
  assert.equal(codeOf(await w.exec('PLAN', 'reserve.create', { jobNo: j1, code: 'TST-001', wh: 'B', qty: 6 })), 'OVER_NEED');
  await w.ok('PLAN', 'reserve.change', { id, qty: 3 });
  let s = await w.state();
  assert.equal(sixOf(s, 'TST-001', { wh: 'A' }).free, 3);
  assert.equal(codeOf(await w.exec('PLAN', 'reserve.change', { id, qty: 7 })), 'OVER_FREE');
  await reserve(w, j2, 'TST-001', 'A', 2);
  assert.equal(codeOf(await w.exec('PLAN', 'reserve.change', { id, qty: 5 })), 'OVER_FREE');
  await w.ok('LEAD', 'reserve.change', { id, wh: 'B', reason: 'ย้ายไปหยิบที่คลัง B' });
  s = await w.state();
  const r = res(s, id);
  assert.equal(r.wh, 'B');
  assert.equal(r.qty, 3);
  assert.equal(r.changes.length, 2);
  assert.deepEqual([r.changes[1].fromWh, r.changes[1].toWh, r.changes[1].by], ['A', 'B', 'LEAD']);
  assert.equal(sixOf(s, 'TST-001', { wh: 'A' }).reserved, 2);
  assert.equal(sixOf(s, 'TST-001', { wh: 'A' }).free, 4);
  assert.equal(sixOf(s, 'TST-001', { wh: 'B' }).free, 2);
  await w.ok('STORE1', 'pick.post', { jobNo: j1, lines: [{ reservationId: id, qty: 2, wh: 'B', bin: 'B-01' }] });
  assert.equal(codeOf(await w.exec('PLAN', 'reserve.change', { id, qty: 1 })), 'BELOW_ISSUED');
  assert.equal(codeOf(await w.exec('PLAN', 'reserve.change', { id, wh: 'A' })), 'PARTLY_ISSUED');
  assert.equal(codeOf(await w.exec('PLAN', 'reserve.change', { id, qty: 0 })), 'BAD_QTY');
  assert.equal(codeOf(await w.exec('PLAN', 'reserve.change', { id })), 'NOTHING');
  await w.ok('PLAN', 'reserve.change', { id, qty: 2 });
  s = await w.state();
  assert.equal(res(s, id).status, 'FILLED');
  assert.equal(codeOf(await w.exec('PLAN', 'reserve.change', { id, qty: 3 })), 'BAD_STATE');
});

test('จองอัตโนมัติ: เรียงตามลำดับความสำคัญแล้ววันต้องใช้ คลังเรียงตามรหัส ไม่จองส่วนที่ผลิตเอง', async () => {
  const w = await plant();
  await stockIn(w, 'TST-002', 'A', 'A-01', 4);
  await stockIn(w, 'TST-002', 'B', 'B-01', 5);
  const jA = await job(w, { soNo: 'SO-701', lines: [{ code: 'TST-002', qty: 6 }], priority: 3, dueDate: '2026-11-05' });
  const jB = await job(w, { soNo: 'SO-702', lines: [{ code: 'TST-002', qty: 6 }], priority: 1, dueDate: '2026-11-30' });
  const jC = await job(w, { soNo: 'SO-703', lines: [{ code: 'TST-002', qty: 6 }], priority: 1, dueDate: '2026-11-15' });
  const r = await w.ok('LEAD', 'reserve.auto', {});
  assert.deepEqual(r.result.created.map((c) => [c.jobNo, c.wh, c.qty]), [[jC, 'A', 4], [jC, 'B', 2], [jB, 'B', 3]]);
  assert.deepEqual(r.result.short.map((x) => [x.jobNo, x.short]), [[jB, 3], [jA, 6]]);
  let s = await w.state();
  assert.equal(sixOf(s, 'TST-002').reserved, 9);
  assert.equal(sixOf(s, 'TST-002').free, 0);
  assert.equal(res(s, r.result.created[0].id).auto, true);
  assert.equal(codeOf(await w.exec('PLAN', 'reserve.auto', { jobNo: jA })), 'NOTHING');
  // pieces the job makes in-house are not taken from stock
  await stockIn(w, 'TST-001', 'A', 'A-02', 10);
  const jD = await job(w, { soNo: 'SO-704', lines: [{ code: 'TST-001', qty: 4 }] });
  await w.ok('PLAN', 'job.setMake', { jobNo: jD, line: 1, toMake: 3 });
  const d = await w.ok('PLAN', 'reserve.auto', { jobNo: jD });
  assert.deepEqual(d.result.created.map((c) => [c.code, c.qty]), [['TST-001', 1]]);
  s = await w.state();
  assert.equal(sixOf(s, 'TST-001').wip, 3);
});

test('สแกนหยิบ: ตรวจรหัส/รหัสอื่นของสินค้า รุ่น ข้าง คลัง ตำแหน่ง และฉบับ BOM', async () => {
  const w = await plant();
  await w.ok('ENG', 'item.upsert', { code: 'TST-001', name: 'ชิ้นทดสอบ 1', baseUnit: 'ชิ้น', type: 'PART', expressCode: 'EXP-001' });
  await w.ok('ENG', 'master.import', { items: [
    { code: 'TST-BODY', name: 'ตัวถังทดสอบ', baseUnit: 'ชุด', type: 'FG' },
    { code: 'TST-BRK-L', name: 'ขายึดทดสอบ ซ้าย', baseUnit: 'ชิ้น', type: 'PART', side: 'L', model: 'M1' },
    { code: 'TST-BRK-R', name: 'ขายึดทดสอบ ขวา', baseUnit: 'ชิ้น', type: 'PART', side: 'R', model: 'M1' },
    { code: 'TST-BRK-L2', name: 'ขายึดทดสอบ ซ้าย รุ่น 2', baseUnit: 'ชิ้น', type: 'PART', side: 'L', model: 'M2' },
  ] });
  await w.ok('ENG', 'bom.upsert', { product: 'TST-BODY', rev: '1', lines: [{ code: 'TST-001', qty: 2 }, { code: 'TST-BRK-L', qty: 1 }, { code: 'TST-BRK-R', qty: 1 }] });
  await w.ok('ENG', 'bom.approve', { product: 'TST-BODY', rev: '1' });
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  await stockIn(w, 'TST-BRK-L', 'A', 'A-01', 2);
  await stockIn(w, 'TST-BRK-R', 'A', 'A-02', 2);
  const j = await job(w, { soNo: 'SO-801', product: 'TST-BODY', qty: 2 });
  const auto = await w.ok('PLAN', 'reserve.auto', { jobNo: j });
  const id = Object.fromEntries(auto.result.created.map((c) => [c.code, c.id]));
  assert.equal(codeOf(await pick(w, j, [{ reservationId: id['TST-BRK-L'], qty: 1, wh: 'A', bin: 'A-01', scannedCode: 'TST-BRK-R' }])), 'WRONG_ITEM');
  const model = await pick(w, j, [{ reservationId: id['TST-BRK-L'], qty: 1, wh: 'A', bin: 'A-01', scannedCode: 'TST-BRK-L2' }]);
  assert.equal(codeOf(model), 'WRONG_ITEM');
  assert.match(model.errors[0].message, /รุ่น M2/);
  assert.equal(codeOf(await pick(w, j, [{ reservationId: id['TST-BRK-L'], qty: 1, wh: 'A', bin: 'A-01', scannedSide: 'R' }])), 'WRONG_SIDE');
  assert.equal(codeOf(await pick(w, j, [{ reservationId: id['TST-001'], qty: 1, wh: 'B', bin: 'B-01' }])), 'WRONG_WH');
  assert.equal(codeOf(await pick(w, j, [{ reservationId: id['TST-BRK-R'], qty: 1, wh: 'A', bin: 'A-01' }])), 'NOT_ENOUGH');
  assert.equal(codeOf(await pick(w, j, [{ reservationId: 'RS-99999', qty: 1, wh: 'A', bin: 'A-01' }])), 'NOT_FOUND');
  // the Express code of the item scans as the item; the right side passes
  const ok = await pick(w, j, [
    { reservationId: id['TST-001'], qty: 1, wh: 'A', bin: 'A-01', scannedCode: 'exp-001' },
    { reservationId: id['TST-BRK-L'], qty: 1, wh: 'A', bin: 'A-01', scannedCode: 'TST-BRK-L', scannedSide: 'L' },
  ]);
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  // another job's reservation cannot be picked for this job
  const j2 = await job(w, { soNo: 'SO-802', lines: [{ code: 'TST-001', qty: 1 }] });
  const other = await reserve(w, j2, 'TST-001', 'A', 1);
  assert.equal(codeOf(await pick(w, j, [{ reservationId: other, qty: 1, wh: 'A', bin: 'A-01' }])), 'WRONG_JOB');
  // engineering approves a new BOM revision: picking against the old one stops
  await w.ok('ENG', 'bom.upsert', { product: 'TST-BODY', rev: '2', lines: [{ code: 'TST-001', qty: 3 }] });
  await w.ok('ENG', 'bom.approve', { product: 'TST-BODY', rev: '2' });
  const changed = await pick(w, j, [{ reservationId: id['TST-001'], qty: 1, wh: 'A', bin: 'A-01' }]);
  assert.equal(codeOf(changed), 'BOM_CHANGED');
  assert.match(changed.errors[0].message, /BOM เปลี่ยนฉบับ/);
  const s = await w.state();
  assert.equal(P.readiness(s, j).bomOk, false);
  assert.equal(P.readiness(s, j).approvedRev, '2');
});

test('ของที่จองให้งานอื่นเบิก/โอน/จ่ายไม่ได้ งานเจ้าของใช้ได้ ใบปรับยอดไม่ถูกกันแต่ขึ้นเตือน', async () => {
  const w = await plant();
  await stockIn(w, 'TST-001', 'A', 'A-01', 5);
  const j1 = await job(w, { soNo: 'SO-901', lines: [{ code: 'TST-001', qty: 5 }] });
  const id = await reserve(w, j1, 'TST-001', 'A', 4);
  const tr = await w.exec('STORE1', 'doc.post', { type: 'TR', lines: [{ code: 'TST-001', qty: 2, wh: 'A', bin: 'A-01', toWh: 'B', toBin: 'B-01' }] });
  assert.equal(codeOf(tr), 'RESERVED');
  await w.ok('STORE1', 'doc.post', { type: 'TR', lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01', toWh: 'B', toBin: 'B-01' }] });
  // moving reserved stock between bins of the same warehouse keeps it reserved – not blocked
  const binMove = await w.ok('STORE1', 'doc.post', { type: 'TR', lines: [{ code: 'TST-001', qty: 4, wh: 'A', bin: 'A-01', toWh: 'A', toBin: 'A-02' }] });
  await w.ok('STORE2', 'transfer.receive', { docNo: binMove.result.docNo });
  await w.ok('STORE1', 'doc.post', { type: 'TR', lines: [{ code: 'TST-001', qty: 4, wh: 'A', bin: 'A-02', toWh: 'A', toBin: 'A-01' }] })
    .then((r) => w.ok('STORE2', 'transfer.receive', { docNo: r.result.docNo }));
  // the job itself uses its reserved stock (no reservation id on the line: the oldest open one is used)
  const pd = await w.ok('STORE1', 'doc.post', { type: 'PD', job: j1, lines: [{ code: 'TST-001', qty: 4, wh: 'A', bin: 'A-01' }] });
  let s = await w.state();
  assert.equal(res(s, id).status, 'FILLED');
  assert.deepEqual(pd.result.reservationsUsed, [{ id, qty: 4 }]);
  // a stock adjustment records what is really there even when it is reserved; six() flags the gap
  await stockIn(w, 'TST-002', 'A', 'A-01', 3);
  const j2 = await job(w, { soNo: 'SO-902', lines: [{ code: 'TST-002', qty: 3 }] });
  await reserve(w, j2, 'TST-002', 'A', 3);
  await w.ok('LEAD', 'doc.post', { type: 'AJ', remark: 'นับได้น้อยกว่า', lines: [{ code: 'TST-002', qty: -2, wh: 'A', bin: 'A-01' }] });
  s = await w.state();
  const row = sixOf(s, 'TST-002');
  assert.equal(row.available, 1);
  assert.equal(row.reserved, 3);
  assert.equal(row.free, 0);
  assert.equal(row.overReserved, 2);
  assert.ok(row.flags.some((f) => /จองเกิน/.test(f)));
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
});

test('รับสินค้าผลิตเสร็จ (FR) ตามใบงาน: ไม่เกินผลิตเสร็จ − รับแล้ว; บันทึกผลิตไม่เกินที่ตั้งผลิต; แก้ยอดผลิตลด', async () => {
  const w = await plant();
  const j = await job(w, { soNo: 'SO-1001', product: 'TST-FG', qty: 2 });
  const fr = (n, extra = {}) => w.exec('STORE1', 'doc.post', { type: 'FR', job: j, lines: [{ code: 'TST-FG', qty: n, wh: 'A', bin: 'A-01', ...extra }] });
  assert.equal(codeOf(await w.exec('PROD', 'job.record', { jobNo: j, line: 0, qty: 3 })), 'OVER_MAKE');
  assert.equal(codeOf(await fr(1)), 'FR_OVER');
  await w.ok('PROD', 'job.record', { jobNo: j, line: 0, qty: 2 });
  assert.equal(codeOf(await fr(3)), 'FR_OVER');
  const ok = await fr(1);
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  const two = await w.exec('STORE1', 'doc.post', { type: 'FR', job: j, lines: [
    { code: 'TST-FG', qty: 1, wh: 'A', bin: 'A-01' }, { code: 'TST-FG', qty: 1, wh: 'A', bin: 'A-02' }] });
  assert.equal(codeOf(two), 'FR_OVER');
  let s = await w.state();
  assert.equal(jobRow(s, j).lines[0].received, 1);
  assert.equal(jobRow(s, j).lines[0].finished, 2);
  assert.equal(qty(s, { code: 'TST-FG', status: 'QC_HOLD' }), 1);
  assert.equal(codeOf(await w.exec('PROD', 'job.record', { jobNo: j, line: 0, qty: -1 })), 'REQUIRED');
  assert.equal(codeOf(await w.exec('PROD', 'job.record', { jobNo: j, line: 0, qty: -2, remark: 'บันทึกเกิน' })), 'BELOW_RECEIVED');
  await w.ok('PROD', 'job.record', { jobNo: j, line: 0, qty: -1, remark: 'บันทึกเกิน' });
  s = await w.state();
  assert.equal(jobRow(s, j).lines[0].finished, 1);
  assert.ok(jobRow(s, j).log.some((x) => x.action === 'record' && /บันทึกเกิน/.test(x.detail)));
  // a component made in-house for the job
  assert.equal(codeOf(await w.exec('STORE1', 'doc.post', { type: 'FR', job: j, lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01' }] })), 'NOT_MADE');
  assert.equal(codeOf(await w.exec('PLAN', 'job.setMake', { jobNo: j, line: 1, toMake: 5 })), 'OVER_NEED');
  await w.ok('PLAN', 'job.setMake', { jobNo: j, line: 1, toMake: 4 });
  s = await w.state();
  assert.equal(sixOf(s, 'TST-001').wip, 4);
  assert.equal(sixOf(s, 'TST-001').free, 0);
  await w.ok('PROD', 'job.record', { jobNo: j, line: 1, qty: 4 });
  assert.equal(codeOf(await w.exec('PLAN', 'job.setMake', { jobNo: j, line: 1, toMake: 3 })), 'BELOW_FINISHED');
  assert.equal(codeOf(await w.exec('PROD', 'job.record', { jobNo: j, line: 2, qty: 1 })), 'NOT_MADE');
  const frPart = await w.ok('STORE1', 'doc.post', { type: 'FR', job: j, lines: [{ code: 'TST-001', qty: 4, wh: 'A', bin: 'A-01' }] });
  s = await w.state();
  assert.equal(lineOf(s, j, 'TST-001').received, 4);
  assert.equal(qty(s, { code: 'TST-001', status: 'AVAILABLE' }), 4);
  assert.equal(sixOf(s, 'TST-001').wip, 0);
  await w.ok('LEAD', 'doc.cancel', { docNo: frPart.result.docNo, reason: 'รับผิดใบงาน' });
  s = await w.state();
  assert.equal(lineOf(s, j, 'TST-001').received, 0);
  assert.equal(qty(s, { code: 'TST-001' }), 0);
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
});

test('ยกเลิกใบเบิกคืนยอดจองและยอดเบิกของงาน ประวัติการใช้ใบจองไม่ถูกลบ', async () => {
  const w = await plant();
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  const j = await job(w, { soNo: 'SO-1101', product: 'TST-FG', qty: 3 });
  const id = await reserve(w, j, 'TST-001', 'A', 6);
  const p1 = await pick(w, j, [{ reservationId: id, qty: 4, wh: 'A', bin: 'A-01' }]);
  await w.ok('LEAD', 'doc.cancel', { docNo: p1.result.docNo, reason: 'หยิบผิดงาน' });
  let s = await w.state();
  const r = res(s, id);
  assert.equal(r.issued, 0);
  assert.equal(r.status, 'OPEN');
  assert.equal(P.remaining(r), 6);
  assert.deepEqual(r.uses.map((u) => [u.docNo, u.qty, !!u.reversal]), [[p1.result.docNo, 4, false], [p1.result.docNo, -4, true]]);
  assert.equal(lineOf(s, j, 'TST-001').issued, 0);
  assert.equal(qty(s, { code: 'TST-001' }), 10);
  assert.equal(sixOf(s, 'TST-001').reserved, 6);
  // a PD with the job but no reservation id uses the job's open reservation
  await w.ok('STORE1', 'doc.post', { type: 'PD', job: j, lines: [{ code: 'TST-001', qty: 5, wh: 'A', bin: 'A-01' }] });
  s = await w.state();
  assert.equal(res(s, id).issued, 5);
  assert.equal(res(s, id).status, 'PARTIAL');
  assert.equal(lineOf(s, j, 'TST-001').issued, 5);
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
});

test('คืนของเหลือ (RT): ลดยอดเบิก คืนเกินไม่ได้ และยกเลิกใบเบิกที่คืนของไปแล้วไม่ได้', async () => {
  const w = await plant();
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  const j = await job(w, { soNo: 'SO-1201', product: 'TST-FG', qty: 3 });
  const id = await reserve(w, j, 'TST-001', 'A', 6);
  const p1 = await pick(w, j, [{ reservationId: id, qty: 6, wh: 'A', bin: 'A-01' }]);
  const rt = (n) => w.exec('STORE1', 'doc.post', { type: 'RT', job: j, lines: [{ code: 'TST-001', qty: n, wh: 'A', bin: 'A-02' }] });
  assert.equal(codeOf(await rt(7)), 'RT_OVER');
  const back = await rt(2);
  assert.equal(back.ok, true, JSON.stringify(back.errors));
  let s = await w.state();
  assert.equal(lineOf(s, j, 'TST-001').issued, 4);
  assert.equal(res(s, id).status, 'FILLED');
  assert.equal(qty(s, { code: 'TST-001', wh: 'A', bin: 'A-02' }), 2);
  const line = P.readiness(s, j).lines.find((l) => l.code === 'TST-001');
  assert.equal(line.unreserved, 2);
  assert.equal(line.toReserve, 2);
  assert.equal(line.status, 'พร้อม');
  const blocked = await w.exec('LEAD', 'doc.cancel', { docNo: p1.result.docNo, reason: 'ทดสอบ' });
  assert.equal(codeOf(blocked), 'RETURNED');
  await w.ok('LEAD', 'doc.cancel', { docNo: back.result.docNo, reason: 'คืนผิด' });
  s = await w.state();
  assert.equal(lineOf(s, j, 'TST-001').issued, 6);
  await w.ok('LEAD', 'doc.cancel', { docNo: p1.result.docNo, reason: 'ยกเลิกการเบิก' });
  s = await w.state();
  assert.equal(lineOf(s, j, 'TST-001').issued, 0);
  assert.equal(res(s, id).status, 'OPEN');
  assert.equal(qty(s, { code: 'TST-001' }), 10);
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
});

test('แยกหน้าที่: ยกเลิกงานที่มีของเบิกค้างต้องคืนก่อน หรือบังคับโดยคนละคนกับผู้สร้างงาน', async () => {
  const w = await plant();
  await w.ok('ADMIN', 'user.upsert', { id: 'PLAN2', name: 'วางแผน 2', roles: ['planner'] });
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  const j = await job(w, { soNo: 'SO-1301', product: 'TST-FG', qty: 3 });
  const id = await reserve(w, j, 'TST-001', 'A', 6);
  await pick(w, j, [{ reservationId: id, qty: 4, wh: 'A', bin: 'A-01' }]);
  const plain = await w.exec('PLAN', 'job.cancel', { jobNo: j, reason: 'ลูกค้ายกเลิก' });
  assert.equal(codeOf(plain), 'ISSUED_NOT_RETURNED');
  assert.match(plain.errors[0].message, /TST-001 4/);
  assert.equal(codeOf(await w.exec('PLAN2', 'job.cancel', { jobNo: j, reason: 'x', force: true })), 'REQUIRED');
  const self = await w.exec('PLAN', 'job.cancel', { jobNo: j, reason: 'ลูกค้ายกเลิก ของใช้ไปแล้ว', force: true });
  assert.equal(codeOf(self), 'SAME_PERSON');
  let s = await w.state();
  assert.equal(jobRow(s, j).status, 'IN_PROGRESS');
  await w.ok('PLAN2', 'job.cancel', { jobNo: j, reason: 'ลูกค้ายกเลิก ของใช้ไปแล้ว', force: true });
  s = await w.state();
  const jr = jobRow(s, j);
  assert.equal(jr.status, 'CANCELLED');
  assert.equal(jr.forced.by, 'PLAN2');
  assert.ok(jr.forced.at);
  assert.deepEqual(jr.forced.outstanding.map((o) => [o.code, o.issued]), [['TST-001', 4]]);
  assert.equal(res(s, id).status, 'RELEASED');
  assert.equal(res(s, id).releasedQty, 2);
  assert.equal(sixOf(s, 'TST-001').reserved, 0);
  // returning leftovers of a cancelled job still works and lowers what it holds
  await w.ok('STORE1', 'doc.post', { type: 'RT', job: j, lines: [{ code: 'TST-001', qty: 4, wh: 'A', bin: 'A-01' }] });
  s = await w.state();
  assert.equal(lineOf(s, j, 'TST-001').issued, 0);
});

test('ยกเลิกงานหลังคืนของเหลือครบ ทำได้โดยไม่ต้องบังคับ', async () => {
  const w = await plant();
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  const j = await job(w, { soNo: 'SO-1302', product: 'TST-FG', qty: 3 });
  const id = await reserve(w, j, 'TST-001', 'A', 6);
  await pick(w, j, [{ reservationId: id, qty: 4, wh: 'A', bin: 'A-01' }]);
  await w.ok('STORE1', 'doc.post', { type: 'RT', job: j, lines: [{ code: 'TST-001', qty: 4, wh: 'A', bin: 'A-01' }] });
  const c = await w.ok('PLAN', 'job.cancel', { jobNo: j, reason: 'ลูกค้ายกเลิก' });
  assert.deepEqual(c.result.released.map((x) => x.qty), [2]);
  const s = await w.state();
  assert.equal(jobRow(s, j).forced, null);
  assert.equal(sixOf(s, 'TST-001').free, 10);
});

test('สิทธิ์: สร้างงาน/จอง/หยิบ/บันทึกผลิต/ยกเลิก ตามบทบาท และสิทธิ์รายคลัง', async () => {
  const w = await plant();
  await w.ok('ADMIN', 'user.upsert', { id: 'PLANA', name: 'วางแผนคลัง A', roles: ['planner'], warehouses: ['A'] });
  await w.ok('ADMIN', 'user.upsert', { id: 'STOREA', name: 'สโตร์คลัง A', roles: ['store'], warehouses: ['A'] });
  await stockIn(w, 'TST-001', 'A', 'A-01', 5);
  await stockIn(w, 'TST-001', 'B', 'B-01', 5);
  const payload = { soNo: 'SO-1401', product: 'TST-FG', qty: 3, dueDate: '2026-11-20' };
  for (const u of ['VIEW', 'STORE1', 'PROD', 'LEAD']) assert.equal(codeOf(await w.exec(u, 'job.create', payload)), 'NO_PERMISSION', u);
  const j = await job(w, { soNo: 'SO-1401', product: 'TST-FG', qty: 3 });
  for (const u of ['STORE1', 'PROD', 'VIEW']) {
    assert.equal(codeOf(await w.exec(u, 'reserve.create', { jobNo: j, code: 'TST-001', wh: 'A', qty: 1 })), 'NO_PERMISSION', u);
  }
  const idB = await reserve(w, j, 'TST-001', 'B', 2, {}, 'LEAD'); // store lead may reserve
  const restricted = await w.exec('PLANA', 'reserve.create', { jobNo: j, code: 'TST-001', wh: 'B', qty: 1 });
  assert.equal(codeOf(restricted), 'NO_PERMISSION');
  assert.equal(codeOf(await w.exec('PLANA', 'reserve.release', { id: idB, reason: 'ทดสอบ' })), 'NO_PERMISSION');
  const auto = await w.ok('PLANA', 'reserve.auto', { jobNo: j });
  assert.deepEqual(auto.result.created.map((c) => c.wh), ['A']);
  assert.equal(codeOf(await pick(w, j, [{ reservationId: idB, qty: 1, wh: 'B', bin: 'B-01' }], 'PLAN')), 'NO_PERMISSION');
  assert.equal(codeOf(await pick(w, j, [{ reservationId: idB, qty: 1, wh: 'B', bin: 'B-01' }], 'STOREA')), 'NO_PERMISSION');
  assert.equal((await pick(w, j, [{ reservationId: idB, qty: 1, wh: 'B', bin: 'B-01' }], 'STORE1')).ok, true);
  await w.ok('PLAN', 'job.setMake', { jobNo: j, line: 2, toMake: 3 });
  assert.equal(codeOf(await w.exec('STORE1', 'job.record', { jobNo: j, line: 2, qty: 1 })), 'NO_PERMISSION');
  assert.equal((await w.exec('PROD', 'job.record', { jobNo: j, line: 2, qty: 1 })).ok, true);
  for (const u of ['PROD', 'STORE1', 'LEAD']) {
    assert.equal(codeOf(await w.exec(u, 'job.setMake', { jobNo: j, line: 2, toMake: 2 })), 'NO_PERMISSION', u);
    assert.equal(codeOf(await w.exec(u, 'job.cancel', { jobNo: j, reason: 'ทดสอบ' })), 'NO_PERMISSION', u);
    assert.equal(codeOf(await w.exec(u, 'job.status', { jobNo: j, status: 'DONE' })), 'NO_PERMISSION', u);
  }
});

test('ข้อมูลผิดถูกปฏิเสธพร้อมข้อความภาษาไทย และไม่เปลี่ยนอะไรเลย', async () => {
  const w = await plant();
  await stockIn(w, 'TST-001', 'A', 'A-01', 5);
  const j = await job(w, { soNo: 'SO-1501', product: 'TST-FG', qty: 2 });
  const id = await reserve(w, j, 'TST-001', 'A', 2);
  const before = (await w.state()).seq;
  const due = '2026-11-20';
  const cases = [
    ['PLAN', 'job.create', { product: 'TST-FG', qty: 1, dueDate: due }, 'REQUIRED'],
    ['PLAN', 'job.create', { soNo: 'S', product: 'TST-FG', qty: 1, dueDate: '2026-13-01' }, 'BAD_DATE'],
    ['PLAN', 'job.create', { soNo: 'S', product: 'TST-FG', qty: 1, dueDate: '2026-02-30' }, 'BAD_DATE'],
    ['PLAN', 'job.create', { soNo: 'S', product: 'TST-FG', qty: 1 }, 'BAD_DATE'],
    ['PLAN', 'job.create', { soNo: 'S', product: 'TST-FG', qty: 1, dueDate: due, priority: 0 }, 'BAD_VALUE'],
    ['PLAN', 'job.create', { soNo: 'S', product: 'TST-FG', qty: 1, dueDate: due, priority: 6 }, 'BAD_VALUE'],
    ['PLAN', 'job.create', { soNo: 'S', product: 'TST-FG', qty: 1, dueDate: due, priority: 'ด่วน' }, 'BAD_VALUE'],
    ['PLAN', 'job.create', { soNo: 'S', product: 'TST-FG', qty: 0, dueDate: due }, 'BAD_QTY'],
    ['PLAN', 'job.create', { soNo: 'S', product: 'TST-FG', qty: -2, dueDate: due }, 'BAD_QTY'],
    ['PLAN', 'job.create', { soNo: 'S', product: 'TST-FG', qty: 'abc', dueDate: due }, 'BAD_QTY'],
    ['PLAN', 'job.create', { soNo: 'S', product: 'TST-FG', dueDate: due }, 'BAD_QTY'],
    ['PLAN', 'job.create', { soNo: 'S', product: 'NO-SUCH', qty: 1, dueDate: due }, 'NOT_FOUND'],
    ['PLAN', 'job.create', { soNo: 'S', product: 'TST-FG', bomRev: 'Z', qty: 1, dueDate: due }, 'NOT_FOUND'],
    ['PLAN', 'job.create', { soNo: 'S', lines: [{ code: 'NO-SUCH', qty: 1 }], dueDate: due }, 'NOT_FOUND'],
    ['PLAN', 'job.create', { soNo: 'S', lines: [{ code: 'TST-001', qty: 0 }], dueDate: due }, 'BAD_QTY'],
    ['PLAN', 'job.create', { soNo: 'S', lines: [{ code: 'TST-001', qty: 1, unit: 'กก.' }], dueDate: due }, 'NO_UNIT'],
    ['PLAN', 'job.create', { soNo: 'S', product: 'TST-FG', qty: 1, lines: [{ code: 'TST-001', qty: 1 }], dueDate: due }, 'BAD_INPUT'],
    ['PLAN', 'job.create', { soNo: 'S', dueDate: due }, 'REQUIRED'],
    ['PLAN', 'job.create', { soNo: 'S', jobNo: 'ใบงาน 1', lines: [{ code: 'TST-001', qty: 1 }], dueDate: due }, 'BAD_CODE'],
    ['PLAN', 'job.update', { jobNo: j, dueDate: '31/12/2026' }, 'BAD_DATE'],
    ['PLAN', 'job.update', { jobNo: j, priority: 9 }, 'BAD_VALUE'],
    ['PLAN', 'job.update', { jobNo: j }, 'NOTHING'],
    ['PLAN', 'job.update', { jobNo: 'NOPE', remark: 'x' }, 'NOT_FOUND'],
    ['PLAN', 'job.setMake', { jobNo: j, line: 9, toMake: 1 }, 'NOT_FOUND'],
    ['PLAN', 'job.setMake', { jobNo: j, line: 1, toMake: -1 }, 'BAD_QTY'],
    ['PLAN', 'job.setMake', { jobNo: j, line: 0, toMake: 3 }, 'OVER_NEED'],
    ['PROD', 'job.record', { jobNo: j, line: 0, qty: 'abc' }, 'BAD_QTY'],
    ['PROD', 'job.record', { jobNo: j, line: 0, qty: 0 }, 'BAD_QTY'],
    ['PLAN', 'job.status', { jobNo: j, status: 'CANCELLED' }, 'BAD_VALUE'],
    ['PLAN', 'job.cancel', { jobNo: 'NOPE', reason: 'x' }, 'NOT_FOUND'],
    ['PLAN', 'reserve.create', { jobNo: 'NOPE', code: 'TST-001', wh: 'A', qty: 1 }, 'NOT_FOUND'],
    ['PLAN', 'reserve.create', { code: 'TST-001', wh: 'A', qty: 1 }, 'REQUIRED'],
    ['PLAN', 'reserve.create', { jobNo: j, code: 'NO-SUCH', wh: 'A', qty: 1 }, 'NOT_FOUND'],
    ['PLAN', 'reserve.create', { jobNo: j, code: 'TST-PLATE', wh: 'A', qty: 1 }, 'NOT_IN_JOB'],
    ['PLAN', 'reserve.create', { jobNo: j, code: 'TST-FG', wh: 'A', qty: 1 }, 'NOT_IN_JOB'],
    ['PLAN', 'reserve.create', { jobNo: j, code: 'TST-001', wh: 'Z', qty: 1 }, 'NOT_FOUND'],
    ['PLAN', 'reserve.create', { jobNo: j, code: 'TST-001', wh: 'TRANSIT', qty: 1 }, 'RESERVED'],
    ['PLAN', 'reserve.create', { jobNo: j, code: 'TST-001', wh: '', qty: 1 }, 'REQUIRED'],
    ['PLAN', 'reserve.create', { jobNo: j, code: 'TST-001', wh: 'A', qty: 0 }, 'BAD_QTY'],
    ['PLAN', 'reserve.create', { jobNo: j, code: 'TST-001', wh: 'A', qty: 'x' }, 'BAD_QTY'],
    ['PLAN', 'reserve.create', { jobNo: j, code: 'TST-001', wh: 'A', qty: 1, unit: 'กล่อง' }, 'NO_UNIT'],
    ['PLAN', 'reserve.create', { jobNo: j, code: 'TST-001', wh: 'A', qty: 1, needDate: 'พรุ่งนี้' }, 'BAD_DATE'],
    ['PLAN', 'reserve.create', { jobNo: j, code: 'TST-001', wh: 'A', qty: 1, priority: 7 }, 'BAD_VALUE'],
    ['PLAN', 'reserve.change', { id: 'RS-99999', qty: 1 }, 'NOT_FOUND'],
    ['PLAN', 'reserve.change', { id, wh: 'Z' }, 'NOT_FOUND'],
    ['PLAN', 'reserve.release', { id: 'RS-99999', reason: 'x' }, 'NOT_FOUND'],
    ['PLAN', 'reserve.release', { id }, 'REQUIRED'],
    ['PLAN', 'reserve.auto', { jobNo: 'NOPE' }, 'NOT_FOUND'],
    ['STORE1', 'pick.post', { jobNo: j, lines: [] }, 'NO_LINES'],
    ['STORE1', 'pick.post', { jobNo: j }, 'NO_LINES'],
    ['STORE1', 'pick.post', { jobNo: 'NOPE', lines: [{ reservationId: id, qty: 1 }] }, 'NOT_FOUND'],
    ['STORE1', 'pick.post', { jobNo: j, lines: [{ reservationId: id, qty: 0, wh: 'A', bin: 'A-01' }] }, 'BAD_QTY'],
    ['STORE1', 'pick.post', { jobNo: j, lines: [{ reservationId: id, qty: 1, wh: 'A', bin: 'NOPE' }] }, 'NOT_FOUND'],
    ['STORE1', 'doc.post', { type: 'PD', job: j, lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01', reservationId: 'RS-99999' }] }, 'NOT_FOUND'],
    ['STORE1', 'doc.post', { type: 'PD', job: j, lines: [{ code: 'TST-002', qty: 1, wh: 'A', bin: 'A-01', reservationId: id }] }, 'WRONG_ITEM'],
    ['STORE1', 'doc.post', { type: 'PD', lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01', reservationId: id }] }, 'WRONG_JOB'],
    ['STORE1', 'doc.post', { type: 'PD', job: j, lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01', jobNo: 'OTHER-JOB' }] }, 'JOB_MISMATCH'],
    ['STORE1', 'doc.post', { type: 'RT', job: j, lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01', reservationId: id }] }, 'BAD_INPUT'],
    ['STORE1', 'doc.post', { type: 'PD', job: j, lines: [{ code: 'TST-FG', qty: 1, wh: 'A', bin: 'A-01' }] }, 'OWN_PRODUCT'],
    ['STORE1', 'doc.post', { type: 'RT', job: j, lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01' }] }, 'RT_OVER'],
  ];
  for (const [user, kind, payload, code] of cases) {
    const r = await w.exec(user, kind, payload);
    assert.equal(r.ok, false, `${kind} ${JSON.stringify(payload)} ควรถูกปฏิเสธ`);
    assert.equal(r.errors[0].code, code, `${kind} ${JSON.stringify(payload)} → ${JSON.stringify(r.errors)}`);
    assert.match(r.errors[0].message, /[฀-๿]/, 'ข้อความต้องเป็นภาษาไทย');
  }
  const s = await w.state();
  assert.equal(s.seq, before);
  assert.equal(res(s, id).issued, 0);
  assert.equal(qty(s, { code: 'TST-001' }), 5);
});

test('ใบหยิบที่มีบรรทัดผิดหนึ่งบรรทัด ไม่เปลี่ยนยอด ไม่ตัดจอง', async () => {
  const w = await plant();
  await w.ok('ENG', 'item.upsert', { code: 'TST-002', name: 'ชิ้นทดสอบ 2', baseUnit: 'ชิ้น', type: 'PART', side: 'R' });
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  await stockIn(w, 'TST-002', 'A', 'A-01', 10);
  const j = await job(w, { soNo: 'SO-1601', product: 'TST-FG', qty: 3 });
  const auto = await w.ok('PLAN', 'reserve.auto', { jobNo: j });
  const id = Object.fromEntries(auto.result.created.map((c) => [c.code, c.id]));
  const before = await w.state();
  const seq = before.seq;
  const r = await pick(w, j, [
    { reservationId: id['TST-001'], qty: 2, wh: 'A', bin: 'A-01' },
    { reservationId: id['TST-002'], qty: 1, wh: 'A', bin: 'A-01', scannedSide: 'L' },
  ]);
  assert.equal(codeOf(r), 'WRONG_SIDE');
  assert.equal(r.errors[0].line, 2);
  const s = await w.state();
  assert.equal(s.seq, seq);
  assert.equal(res(s, id['TST-001']).issued, 0);
  assert.equal(qty(s, { code: 'TST-001' }), 10);
});

test('ความพร้อมของงาน: แสดงว่างานใดขาดอะไร (พร้อม/ขาด/ระหว่างผลิต) ตามลำดับความสำคัญ', async () => {
  const w = await plant();
  await stockIn(w, 'TST-001', 'A', 'A-01', 6);
  const jHigh = await job(w, { soNo: 'SO-1701', product: 'TST-FG', qty: 3, priority: 1, dueDate: '2026-11-10' }); // TST-001 6, TST-002 3
  const jLow = await job(w, { soNo: 'SO-1702', lines: [{ code: 'TST-001', qty: 6 }], priority: 4, dueDate: '2026-11-05' });
  let s = await w.state();
  let rh = P.readiness(s, jHigh);
  const h1 = rh.lines.find((l) => l.code === 'TST-001');
  assert.deepEqual([h1.allocated, h1.missing, h1.status, h1.toReserve, h1.freeNow], [6, 0, 'พร้อม', 6, 6]);
  const h2 = rh.lines.find((l) => l.code === 'TST-002');
  assert.deepEqual([h2.missing, h2.status, h2.statusCode], [3, 'ขาด', 'SHORT']);
  assert.equal(rh.ready, false);
  assert.deepEqual(rh.missing.map((m) => [m.code, m.missing]), [['TST-002', 3]]);
  assert.equal(rh.output.code, 'TST-FG');
  assert.equal(rh.output.wip, 3);
  let rl = P.readiness(s, jLow);
  assert.deepEqual([rl.lines[0].missing, rl.lines[0].status], [6, 'ขาด']); // the free stock goes to the higher priority
  await w.ok('PLAN', 'job.setMake', { jobNo: jLow, line: 1, toMake: 6 });
  s = await w.state();
  rl = P.readiness(s, jLow);
  assert.equal(rl.lines[0].status, 'ระหว่างผลิต');
  assert.equal(rl.lines[0].makeLeft, 6);
  assert.equal(rl.lines[0].wip, 6);
  // reserving makes the line ready whatever its priority; the other job then lacks it (pieces jLow makes are its own)
  await reserve(w, jHigh, 'TST-001', 'A', 6);
  s = await w.state();
  assert.equal(P.readiness(s, jHigh).lines.find((l) => l.code === 'TST-001').status, 'พร้อม');
  rl = P.readiness(s, jLow);
  assert.equal(rl.lines[0].missing, 6);
  assert.equal(rl.lines[0].status, 'ระหว่างผลิต');
  assert.equal(P.readiness(s, 'NOPE'), null);
  // the six-box view of the whole store, every active item
  const all = P.six(s, { today: TODAY, all: true });
  assert.ok(all.find((r) => r.code === 'TST-PLATE'));
  const r1 = all.find((r) => r.code === 'TST-001');
  assert.deepEqual([r1.onHand, r1.reserved, r1.free, r1.wip, r1.demand, r1.short], [6, 6, 0, 6, 12, 6]);
  assert.equal(P.jobs(s, { open: true })[0].jobNo, jHigh);
});

test('ปิดงานผลิตเสร็จ/ส่งมอบ: ปล่อยของจองที่เหลือ เบิกเพิ่มไม่ได้ คืนของได้ ยกเลิกใบเบิกหลังปิดงานไม่จองซ้ำ', async () => {
  const w = await plant();
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  await stockIn(w, 'TST-002', 'A', 'A-01', 5);
  const j = await job(w, { soNo: 'SO-1801', product: 'TST-FG', qty: 3 });
  const id1 = await reserve(w, j, 'TST-001', 'A', 6);
  const id2 = await reserve(w, j, 'TST-002', 'A', 2);
  await pick(w, j, [{ reservationId: id1, qty: 4, wh: 'A', bin: 'A-01' }]);
  const pB = await pick(w, j, [{ reservationId: id1, qty: 2, wh: 'A', bin: 'A-01' }]);
  const done = await w.ok('PLAN', 'job.status', { jobNo: j, status: 'DONE' });
  assert.deepEqual(done.result.released.map((x) => [x.id, x.qty]), [[id2, 2]]);
  assert.ok(done.warnings.some((x) => /เบิกไม่ครบ/.test(x)));
  let s = await w.state();
  assert.equal(jobRow(s, j).status, 'DONE');
  assert.equal(jobRow(s, j).doneBy, 'PLAN');
  assert.equal(res(s, id2).status, 'RELEASED');
  assert.equal(res(s, id1).status, 'FILLED');
  assert.equal(sixOf(s, 'TST-002').reserved, 0);
  assert.equal(sixOf(s, 'TST-001').demand, 0); // a closed job is no longer demand
  assert.equal(codeOf(await pick(w, j, [{ reservationId: id1, qty: 1, wh: 'A', bin: 'A-01' }])), 'JOB_CLOSED');
  assert.equal(codeOf(await w.exec('STORE1', 'doc.post', { type: 'PD', job: j, lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01' }] })), 'JOB_CLOSED');
  assert.equal(codeOf(await w.exec('PLAN', 'reserve.create', { jobNo: j, code: 'TST-001', wh: 'A', qty: 1 })), 'JOB_CLOSED');
  await w.ok('STORE1', 'doc.post', { type: 'RT', job: j, lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01' }] });
  await w.ok('LEAD', 'doc.cancel', { docNo: pB.result.docNo, reason: 'หยิบซ้ำ' });
  s = await w.state();
  assert.equal(lineOf(s, j, 'TST-001').issued, 3);
  assert.equal(res(s, id1).status, 'RELEASED');
  assert.match(res(s, id1).reason, /หลังปิดงาน/);
  assert.equal(sixOf(s, 'TST-001').reserved, 0);
  assert.equal(codeOf(await w.exec('PLAN', 'job.status', { jobNo: j, status: 'DONE' })), 'BAD_STATE');
  await w.ok('PLAN', 'job.status', { jobNo: j, status: 'DELIVERED' });
  s = await w.state();
  assert.equal(jobRow(s, j).deliveredBy, 'PLAN');
  assert.equal(codeOf(await w.exec('PLAN', 'job.cancel', { jobNo: j, reason: 'ทดสอบ' })), 'BAD_STATE');
  assert.equal(codeOf(await w.exec('PLAN', 'job.update', { jobNo: j, remark: 'ทดสอบ' })), 'JOB_CLOSED');
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
});

test('แก้ใบงาน: วันต้องใช้/ลำดับเปลี่ยน ใบจองที่ใช้ค่าของงานตามไปด้วย', async () => {
  const w = await plant();
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  await stockIn(w, 'TST-002', 'A', 'A-01', 10);
  const j = await job(w, { soNo: 'SO-1901', product: 'TST-FG', qty: 2, priority: 3, dueDate: '2026-11-20' });
  const r1 = await reserve(w, j, 'TST-001', 'A', 4);
  const r2 = await reserve(w, j, 'TST-002', 'A', 2, { priority: 1, needDate: '2026-11-15' });
  let s = await w.state();
  assert.deepEqual([res(s, r1).priority, res(s, r1).needDate], [3, '2026-11-20']);
  await w.ok('PLAN', 'job.update', { jobNo: j, dueDate: '2026-11-25', priority: 2, remark: 'ลูกค้าเลื่อนรับ' });
  s = await w.state();
  const jr = jobRow(s, j);
  assert.deepEqual([jr.dueDate, jr.priority, jr.remark, jr.updatedBy], ['2026-11-25', 2, 'ลูกค้าเลื่อนรับ', 'PLAN']);
  assert.ok(jr.log.some((x) => x.action === 'update'));
  assert.deepEqual([res(s, r1).priority, res(s, r1).needDate], [2, '2026-11-25']);
  assert.deepEqual([res(s, r2).priority, res(s, r2).needDate], [1, '2026-11-15']);
});

test('ปล่อยการจองต้องมีเหตุผล เก็บผู้ปล่อย/เวลา และปล่อยซ้ำไม่ได้', async () => {
  const w = await plant();
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  const j = await job(w, { soNo: 'SO-2001', product: 'TST-FG', qty: 3 });
  const id = await reserve(w, j, 'TST-001', 'A', 5);
  assert.equal(codeOf(await w.exec('LEAD', 'reserve.release', { id, reason: '  ' })), 'REQUIRED');
  const r = await w.ok('LEAD', 'reserve.release', { id, reason: 'เปลี่ยนไปใช้ของคลัง B' });
  assert.equal(r.result.released, 5);
  const s = await w.state();
  const row = res(s, id);
  assert.deepEqual([row.status, row.releasedBy, row.releasedQty, row.reason], ['RELEASED', 'LEAD', 5, 'เปลี่ยนไปใช้ของคลัง B']);
  assert.ok(row.releasedAt);
  assert.equal(sixOf(s, 'TST-001').free, 10);
  assert.equal(codeOf(await w.exec('LEAD', 'reserve.release', { id, reason: 'ซ้ำ' })), 'BAD_STATE');
  assert.equal(codeOf(await w.exec('LEAD', 'reserve.change', { id, qty: 1 })), 'BAD_STATE');
});

const dlFromOtherModule = !!RRS.inventory.DOC_TYPES.DL;
test('ส่งมอบลูกค้า (DL) ตามใบงานตัดยอดจองของงานนั้น ไม่ติดสถานะปิดงาน และยกเลิกแล้วคืนยอดจอง',
  { skip: dlFromOtherModule && 'DL นิยามโดยโมดูลอื่น – ทดสอบที่โมดูลนั้น' }, async () => {
    RRS.inventory.defineType('DL', { name: 'ส่งมอบลูกค้า (ทดสอบ)', dir: -1 });
    try {
      const w = await plant();
      await stockIn(w, 'TST-FG', 'A', 'A-01', 3);
      const jA = await job(w, { soNo: 'SO-2101', product: 'TST-FG', qty: 1 });
      const jB = await job(w, { soNo: 'SO-2102', lines: [{ code: 'TST-FG', qty: 2 }] });
      const id = await reserve(w, jB, 'TST-FG', 'A', 2);
      const dl = await w.ok('STORE1', 'doc.post', { type: 'DL', job: jB, lines: [{ code: 'TST-FG', qty: 2, wh: 'A', bin: 'A-01' }] });
      let s = await w.state();
      assert.equal(res(s, id).status, 'FILLED');
      assert.equal(lineOf(s, jB, 'TST-FG').issued, 2);
      // delivering the product of a finished job is not an issue into the job
      await w.ok('PLAN', 'job.status', { jobNo: jA, status: 'DONE' });
      await w.ok('STORE1', 'doc.post', { type: 'DL', job: jA, lines: [{ code: 'TST-FG', qty: 1, wh: 'A', bin: 'A-01' }] });
      s = await w.state();
      assert.equal(jobRow(s, jA).lines.length, 3);
      await w.ok('LEAD', 'doc.cancel', { docNo: dl.result.docNo, reason: 'ส่งผิดใบ' });
      s = await w.state();
      assert.equal(res(s, id).status, 'OPEN');
      assert.equal(lineOf(s, jB, 'TST-FG').issued, 0);
      assert.deepEqual(RRS.inventory.verifyBalances(s), []);
    } finally {
      delete RRS.inventory.DOC_TYPES.DL;
    }
  });

test('เอกสารเดิมที่ใส่งานเป็นข้อความอิสระ (ไม่มีในทะเบียนใบงาน) ทำงานเหมือนเดิม', async () => {
  const w = await plant();
  await stockIn(w, 'TST-001', 'A', 'A-01', 5);
  await w.ok('STORE1', 'doc.post', { type: 'PD', job: 'SO-LEGACY', lines: [{ code: 'TST-001', qty: 2, wh: 'A', bin: 'A-01' }] });
  await w.ok('STORE1', 'doc.post', { type: 'RT', job: 'SO-LEGACY', lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01' }] });
  const s = await w.state();
  assert.equal(qty(s, { code: 'TST-001' }), 4);
  assert.equal(Object.keys(s.tables.jobs || {}).length, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// independent review: holes found after the first build (each test failed before the fix)
// ---------------------------------------------------------------------------------------------------------------

/** Numbers that must always agree after any sequence of commands. */
function assertConsistent(s) {
  assert.deepEqual(RRS.inventory.verifyBalances(s), [], 'ยอดคงเหลือ = ผลรวมประวัติ');
  for (const r of Object.values(s.tables.reservations || {})) {
    const used = RRS.util.round((r.uses || []).reduce((t, u) => t + u.qty, 0));
    assert.equal(r.issued, used, `${r.id}: issued = Σ uses`);
    assert.ok(r.issued >= 0 && r.issued <= r.qty, `${r.id}: 0 ≤ issued ${r.issued} ≤ qty ${r.qty}`);
    if (r.status !== 'RELEASED') {
      assert.equal(r.status, r.issued >= r.qty ? 'FILLED' : r.issued > 0 ? 'PARTIAL' : 'OPEN', `${r.id}: สถานะตรงกับยอด`);
    }
  }
  // without adjustments no warehouse holds more open reservations than its AVAILABLE stock
  const held = {};
  for (const r of Object.values(s.tables.reservations || {})) {
    if (P.remaining(r) > 0) held[r.code + '|' + r.wh] = RRS.util.round((held[r.code + '|' + r.wh] || 0) + P.remaining(r));
  }
  for (const k of Object.keys(held)) {
    const [code, wh] = k.split('|');
    assert.ok(held[k] <= RRS.q.qty(s, { code, wh, status: 'AVAILABLE' }) + 1e-9, `${k}: จอง ${held[k]} เกินของใช้ได้`);
  }
  for (const j of Object.values(s.tables.jobs || {})) {
    for (const l of j.lines) {
      assert.ok(l.issued >= 0 && l.received >= 0 && l.received <= l.finished && l.finished <= Math.max(l.toMake, l.finished), `${j.jobNo} บรรทัด ${l.line}`);
    }
    // an open job line never holds more reservations than it still needs (no stale reservation blocks other jobs)
    if (j.status === 'OPEN' || j.status === 'IN_PROGRESS') {
      for (const l of j.lines.filter((x) => !x.output)) {
        const held = RRS.util.round(Object.values(s.tables.reservations || {})
          .filter((r) => r.jobNo === j.jobNo && r.code === l.code).reduce((t, r) => t + P.remaining(r), 0));
        assert.ok(held <= Math.max(0, l.required - l.issued) + 1e-9, `${j.jobNo} ${l.code}: จองค้าง ${held} เกินที่ยังต้องใช้ ${l.required - l.issued}`);
      }
    }
  }
}

test('ทบทวน: เอกสารหลายบรรทัด (บรรทัดมี/ไม่มีใบจอง หรือหลายงาน) เบิกของที่จองให้งานอื่นไม่ได้', async () => {
  const w = await plant();
  await stockIn(w, 'TST-001', 'A', 'A-01', 12);
  const j1 = await job(w, { soNo: 'SO-R01', lines: [{ code: 'TST-001', qty: 10 }] });
  const j2 = await job(w, { soNo: 'SO-R02', lines: [{ code: 'TST-001', qty: 10 }] });
  const k = await job(w, { soNo: 'SO-R03', lines: [{ code: 'TST-001', qty: 10 }] });
  const r1 = await reserve(w, j1, 'TST-001', 'A', 4);
  const rk = await reserve(w, k, 'TST-001', 'A', 6); // ไม่ได้จอง 2
  const seq = (await w.state()).seq;
  // line 1 uses j1's reservation (4), line 2 has none: 4 more than the 2 free pieces would take k's stock
  const mixed = await w.exec('STORE1', 'doc.post', { type: 'PD', job: j1, lines: [
    { code: 'TST-001', qty: 4, wh: 'A', bin: 'A-01', reservationId: r1 }, { code: 'TST-001', qty: 4, wh: 'A', bin: 'A-01' }] });
  assert.equal(codeOf(mixed), 'RESERVED');
  assert.match(mixed.errors[0].message, /จอง/);
  // two jobs on one document: j1 5 (4 reserved + 1 free) and j2 2 (free) = 3 free pieces needed, only 2 are free
  const twoJobs = await w.exec('STORE1', 'doc.post', { type: 'PD', lines: [
    { code: 'TST-001', qty: 5, wh: 'A', bin: 'A-01', jobNo: j1 }, { code: 'TST-001', qty: 2, wh: 'A', bin: 'A-01', jobNo: j2 }] });
  assert.equal(codeOf(twoJobs), 'RESERVED');
  let s = await w.state();
  assert.equal(s.seq, seq);
  // within its own reservation + the free part the same shape is fine
  await w.ok('STORE1', 'doc.post', { type: 'PD', job: j1, lines: [
    { code: 'TST-001', qty: 4, wh: 'A', bin: 'A-01', reservationId: r1 }, { code: 'TST-001', qty: 2, wh: 'A', bin: 'A-01' }] });
  s = await w.state();
  assert.equal(res(s, r1).status, 'FILLED');
  assert.equal(P.remaining(res(s, rk)), 6);
  assert.equal(qty(s, { code: 'TST-001', wh: 'A', status: 'AVAILABLE' }), 6);
  assert.equal(sixOf(s, 'TST-001').overReserved, 0);
  // 2 new free pieces shared by two jobs on one document: at most 2 may go out in total
  await stockIn(w, 'TST-001', 'A', 'A-02', 2);
  const tooMuch = await w.exec('STORE1', 'doc.post', { type: 'PD', lines: [
    { code: 'TST-001', qty: 2, wh: 'A', bin: 'A-02', jobNo: j1 }, { code: 'TST-001', qty: 2, wh: 'A', bin: 'A-01', jobNo: j2 }] });
  assert.equal(codeOf(tooMuch), 'RESERVED');
  await w.ok('STORE1', 'doc.post', { type: 'PD', lines: [
    { code: 'TST-001', qty: 1, wh: 'A', bin: 'A-02', jobNo: j1 }, { code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01', jobNo: j2 }] });
  s = await w.state();
  assert.equal(P.remaining(res(s, rk)), 6);
  assert.equal(qty(s, { code: 'TST-001', wh: 'A', status: 'AVAILABLE' }), 6);
  assertConsistent(s);
});

test('ทบทวน: ใบโอนหลายบรรทัด – ย้ายช่องเก็บในคลังเดียวกันไม่ถูกนับเป็นการเอาของจองออก', async () => {
  const w = await plant();
  await stockIn(w, 'TST-001', 'A', 'A-01', 5);
  const j1 = await job(w, { soNo: 'SO-R11', lines: [{ code: 'TST-001', qty: 4 }] });
  await reserve(w, j1, 'TST-001', 'A', 4);
  // 4 reserved pieces move to another bin of A, the 1 free piece goes to B – nothing reserved leaves A
  const tr = await w.exec('STORE1', 'doc.post', { type: 'TR', lines: [
    { code: 'TST-001', qty: 4, wh: 'A', bin: 'A-01', toWh: 'A', toBin: 'A-02' }, { code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01', toWh: 'B', toBin: 'B-01' }] });
  assert.equal(tr.ok, true, JSON.stringify(tr.errors));
  // but 2 pieces to B would take one reserved piece
  await w.ok('STORE2', 'transfer.receive', { docNo: tr.result.docNo });
  const bad = await w.exec('STORE1', 'doc.post', { type: 'TR', lines: [
    { code: 'TST-001', qty: 2, wh: 'A', bin: 'A-02', toWh: 'A', toBin: 'A-01' }, { code: 'TST-001', qty: 1, wh: 'A', bin: 'A-02', toWh: 'B', toBin: 'B-01' }] });
  assert.equal(codeOf(bad), 'RESERVED');
  assertConsistent(await w.state());
});

test('ทบทวน: เลขใบงานที่ตั้งเองตรงกับเลขอัตโนมัติ – ใบงานใหม่ได้เลขถัดไป ไม่เขียนทับใบเดิม', async () => {
  const w = await plant();
  await w.ok('PLAN', 'job.create', { jobNo: 'JB6911-0001', soNo: 'SO-MANUAL', lines: [{ code: 'TST-001', qty: 1 }], dueDate: '2026-11-20' });
  const r = await w.ok('PLAN', 'job.create', { soNo: 'SO-AUTO', lines: [{ code: 'TST-002', qty: 1 }], dueDate: '2026-11-20' });
  assert.equal(r.result.jobNo, 'JB6911-0002');
  const s = await w.state();
  assert.equal(jobRow(s, 'JB6911-0001').soNo, 'SO-MANUAL');
  assert.equal(jobRow(s, 'JB6911-0002').soNo, 'SO-AUTO');
});

test('ทบทวน: เบิกจากคลังอื่นจนงานได้ครบ – ใบจองที่เหลือไม่ค้างกันของงานอื่น และยกเลิกใบเบิกแล้วคืนการจอง', async () => {
  const w = await plant();
  await stockIn(w, 'TST-001', 'A', 'A-01', 5);
  await stockIn(w, 'TST-001', 'B', 'B-01', 4);
  const j = await job(w, { soNo: 'SO-R21', lines: [{ code: 'TST-001', qty: 4 }] });
  const k = await job(w, { soNo: 'SO-R22', lines: [{ code: 'TST-001', qty: 4 }] });
  const id = await reserve(w, j, 'TST-001', 'A', 4);
  // 3 pieces come from B (not reserved there): j still needs only 1 – the reservation in A keeps 1
  const pd = await w.ok('STORE1', 'doc.post', { type: 'PD', job: j, lines: [{ code: 'TST-001', qty: 3, wh: 'B', bin: 'B-01' }] });
  let s = await w.state();
  assert.equal(lineOf(s, j, 'TST-001').issued, 3);
  assert.equal(res(s, id).qty, 1);
  assert.equal(res(s, id).status, 'OPEN');
  assert.ok(res(s, id).changes.some((c) => c.docNo === pd.result.docNo && c.fromQty === 4 && c.toQty === 1), 'เก็บประวัติการตัดยอดจอง');
  assert.equal(sixOf(s, 'TST-001', { wh: 'A' }).free, 4);
  assertConsistent(s);
  // cancelling the issue gives the reservation back (the stock in A is still free)
  await w.ok('LEAD', 'doc.cancel', { docNo: pd.result.docNo, reason: 'เบิกผิดคลัง' });
  s = await w.state();
  assert.equal(lineOf(s, j, 'TST-001').issued, 0);
  assert.equal(res(s, id).qty, 4);
  assert.equal(res(s, id).status, 'OPEN');
  assertConsistent(s);
  // the whole line from B: the reservation in A is let go (with who/when/why) and k can reserve A
  const pd2 = await w.ok('STORE1', 'doc.post', { type: 'PD', job: j, lines: [{ code: 'TST-001', qty: 4, wh: 'B', bin: 'B-01' }] });
  s = await w.state();
  assert.equal(res(s, id).status, 'RELEASED');
  assert.equal(res(s, id).releasedBy, 'STORE1');
  assert.ok(res(s, id).releasedAt);
  assert.match(res(s, id).reason, new RegExp(pd2.result.docNo));
  await reserve(w, k, 'TST-001', 'A', 4);
  assertConsistent(await w.state());
  // cancelling now can give back only what is still free in A (1); the rest stays with k – with a warning
  const c = await w.ok('LEAD', 'doc.cancel', { docNo: pd2.result.docNo, reason: 'เบิกผิดคลัง' });
  s = await w.state();
  assert.equal(P.remaining(res(s, id)), 1);
  assert.notEqual(res(s, id).status, 'RELEASED');
  assert.ok(c.warnings.some((x) => /คืนการจอง/.test(x)), JSON.stringify(c.warnings));
  assert.equal(sixOf(s, 'TST-001', { wh: 'A' }).free, 0);
  assert.equal(sixOf(s, 'TST-001', { wh: 'A' }).overReserved, 0);
  assertConsistent(s);
});

test('ทบทวน: โอนของที่จองไว้ไปอีกคลัง แล้วเบิกจากคลังปลายทาง – ไม่เหลือยอดจองลอยที่คลังต้นทาง', async () => {
  const w = await plant();
  await stockIn(w, 'TST-001', 'A', 'A-01', 5);
  const j = await job(w, { soNo: 'SO-R31', lines: [{ code: 'TST-001', qty: 4 }] });
  const k = await job(w, { soNo: 'SO-R32', lines: [{ code: 'TST-001', qty: 4 }] });
  await reserve(w, j, 'TST-001', 'A', 4);
  const tr = await w.ok('STORE1', 'doc.post', { type: 'TR', job: j, lines: [{ code: 'TST-001', qty: 4, wh: 'A', bin: 'A-01', toWh: 'B', toBin: 'B-01' }] });
  await w.ok('STORE2', 'transfer.receive', { docNo: tr.result.docNo });
  await w.ok('STORE1', 'doc.post', { type: 'PD', job: j, lines: [{ code: 'TST-001', qty: 4, wh: 'B', bin: 'B-01' }] });
  await stockIn(w, 'TST-001', 'A', 'A-01', 3);
  const s = await w.state();
  assert.equal(sixOf(s, 'TST-001', { wh: 'A' }).reserved, 0);
  assert.equal(sixOf(s, 'TST-001', { wh: 'A' }).free, 4);
  await reserve(w, k, 'TST-001', 'A', 4); // the stock left in A is free for the other SO
  assertConsistent(await w.state());
});

test('ทบทวน: ใบโอนตามใบงาน – ยอดจองย้ายตามของ (ออกจากต้นทางทันที เข้าปลายทางเมื่อรับ) ยกเลิกใบโอนแล้วกลับที่เดิม', async () => {
  const w = await plant();
  await stockIn(w, 'TST-001', 'A', 'A-01', 6);
  const j = await job(w, { soNo: 'SO-R35', lines: [{ code: 'TST-001', qty: 4 }] });
  const k = await job(w, { soNo: 'SO-R36', lines: [{ code: 'TST-001', qty: 4 }] });
  const id = await reserve(w, j, 'TST-001', 'A', 4, { needDate: '2026-11-12', priority: 2 });
  // moving the job's reserved stock to the production warehouse B
  const tr = await w.ok('STORE1', 'doc.post', { type: 'TR', job: j, lines: [{ code: 'TST-001', qty: 4, wh: 'A', bin: 'A-01', toWh: 'B', toBin: 'B-01' }] });
  let s = await w.state();
  assert.equal(res(s, id).status, 'RELEASED');
  assert.equal(sixOf(s, 'TST-001', { wh: 'A' }).overReserved, 0); // no stale reservation left in A
  assert.equal(sixOf(s, 'TST-001', { wh: 'A' }).free, 2);
  assertConsistent(s);
  // cancelling the transfer in transit puts the reservation back in A
  await w.ok('LEAD', 'doc.cancel', { docNo: tr.result.docNo, reason: 'โอนผิด' });
  s = await w.state();
  assert.deepEqual([res(s, id).status, P.remaining(res(s, id)), res(s, id).wh], ['OPEN', 4, 'A']);
  assertConsistent(s);
  // transfer again, receive in two steps: each arrival is reserved for the job in B
  const tr2 = await w.ok('STORE1', 'doc.post', { type: 'TR', job: j, lines: [{ code: 'TST-001', qty: 4, wh: 'A', bin: 'A-01', toWh: 'B', toBin: 'B-01' }] });
  await w.ok('STORE2', 'transfer.receive', { docNo: tr2.result.docNo, lines: [{ line: 1, qty: 1 }] });
  await w.ok('STORE2', 'transfer.receive', { docNo: tr2.result.docNo });
  s = await w.state();
  const inB = P.reservations(s, { jobNo: j, wh: 'B', open: true });
  assert.deepEqual(inB.map((r) => r.qty), [1, 3]);
  assert.ok(inB.every((r) => r.needDate === '2026-11-12' && r.priority === 2 && r.fromDoc === tr2.result.docNo));
  assert.equal(sixOf(s, 'TST-001', { wh: 'B' }).free, 0);
  // the other SO cannot take it in B, and may reserve what is left in A
  assert.equal(codeOf(await w.exec('STORE1', 'doc.post', { type: 'PD', job: k, lines: [{ code: 'TST-001', qty: 1, wh: 'B', bin: 'B-01' }] })), 'RESERVED');
  await reserve(w, k, 'TST-001', 'A', 2);
  // the job picks in B against the moved reservations
  const pl = P.pickList(await w.state(), j);
  assert.deepEqual(pl.map((x) => [x.wh, x.remaining]), [['B', 1], ['B', 3]]);
  await pick(w, j, pl.map((x) => ({ reservationId: x.reservationId, qty: x.remaining, wh: 'B', bin: 'B-01' })));
  s = await w.state();
  assert.equal(lineOf(s, j, 'TST-001').issued, 4);
  assert.equal(P.reservations(s, { jobNo: j, open: true }).length, 0);
  assertConsistent(s);
});

test('ทบทวน: ใบโอนตามใบงานของล็อตที่ถูกกักกันระหว่างทาง – รับปลายทางแล้วไม่จองต่อ', async () => {
  const w = await plant();
  await w.ok('LEAD', 'item.upsert', { code: 'TST-LOT', name: 'ชิ้นติดล็อต', baseUnit: 'ชิ้น', type: 'PART', trackLot: 'lot' });
  await stockIn(w, 'TST-LOT', 'A', 'A-01', 3, { lot: 'L1' });
  const j = await job(w, { soNo: 'SO-R37', lines: [{ code: 'TST-LOT', qty: 3 }] });
  await reserve(w, j, 'TST-LOT', 'A', 3);
  const tr = await w.ok('STORE1', 'doc.post', { type: 'TR', job: j, lines: [{ code: 'TST-LOT', qty: 3, wh: 'A', bin: 'A-01', lot: 'L1', toWh: 'B', toBin: 'B-01' }] });
  const s = await w.state();
  const receive = (state) => RRS.core.prepare(state, { kind: 'transfer.receive', payload: { docNo: tr.result.docNo } },
    { now: '2026-11-03T03:00:00.000Z', user: 'STORE2' });
  const newRes = (r) => r.commit.effects.filter((e) => e.t === 'reservations' && e.v && e.v.wh === 'B');
  const normal = receive(s);
  assert.equal(normal.ok, true, JSON.stringify(normal.errors));
  assert.deepEqual(newRes(normal).map((e) => [e.v.jobNo, e.v.qty]), [[j, 3]]);
  // the quality module's lots table (Phase 5) says the lot was quarantined in transit
  const s2 = structuredClone(s);
  s2.tables.lots = { 'TST-LOT|L1': { code: 'TST-LOT', lot: 'L1', kind: 'lot', status: 'QUARANTINED' } };
  const held = receive(s2);
  assert.equal(held.ok, true, JSON.stringify(held.errors));
  assert.deepEqual(newRes(held), []);
});

test('ทบทวน: สิทธิ์คลังของใบหยิบใช้สิทธิ์ "หยิบ/เบิกให้งาน" (ไม่ใช่สิทธิ์บันทึกรับ–จ่ายทั่วไป); ล็อต/ช่องเก็บต้องตรง', async () => {
  const w = await plant();
  await w.ok('LEAD', 'item.upsert', { code: 'TST-LOT', name: 'ชิ้นติดล็อต', baseUnit: 'ชิ้น', type: 'PART', trackLot: 'lot' });
  await stockIn(w, 'TST-LOT', 'A', 'A-01', 3, { lot: 'L1' });
  await stockIn(w, 'TST-LOT', 'A', 'A-02', 3, { lot: 'L2' });
  const j = await job(w, { soNo: 'SO-R81', lines: [{ code: 'TST-LOT', qty: 4 }] });
  const id = await reserve(w, j, 'TST-LOT', 'A', 4);
  const s = await w.state();
  assert.deepEqual(P.pickList(s, j)[0].suggest, [{ bin: 'A-01', lot: 'L1', qty: 3 }, { bin: 'A-02', lot: 'L2', qty: 1 }]);
  assert.equal(codeOf(await pick(w, j, [{ reservationId: id, qty: 1, wh: 'A', bin: 'A-01', lot: 'L2' }])), 'NOT_ENOUGH');
  assert.equal(codeOf(await pick(w, j, [{ reservationId: id, qty: 1, wh: 'A', bin: 'A-01' }])), 'LOT_REQUIRED');
  assert.equal(codeOf(await pick(w, j, [{ reservationId: id, qty: 1, wh: 'A', bin: 'B-01', lot: 'L1' }])), 'NOT_FOUND');
  // a company that lets production pick: picking rights are enough, the general posting right is not needed
  const orig = RRS.auth.PERMS['pick.post'].slice();
  RRS.auth.definePerm('pick.post', orig.concat(['production']));
  try {
    const r = await pick(w, j, [{ reservationId: id, qty: 3, wh: 'A', bin: 'A-01', lot: 'L1' }, { reservationId: id, qty: 1, wh: 'A', bin: 'A-02', lot: 'L2' }], 'PROD');
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(codeOf(await w.exec('PROD', 'doc.post', { type: 'PD', job: j, lines: [{ code: 'TST-LOT', qty: 1, wh: 'A', bin: 'A-02', lot: 'L2' }] })), 'NO_PERMISSION');
  } finally {
    RRS.auth.definePerm('pick.post', orig);
  }
  assertConsistent(await w.state());
});

test('ทบทวน: เปลี่ยนยอดจองระบุหน่วย (โหล) แปลงเป็นหน่วยหลัก ไม่ตีความเป็นชิ้น', async () => {
  const w = await plant();
  await stockIn(w, 'TST-001', 'A', 'A-01', 30);
  const j = await job(w, { soNo: 'SO-R41', lines: [{ code: 'TST-001', qty: 2, unit: 'โหล' }] });
  const id = await reserve(w, j, 'TST-001', 'A', 1, { unit: 'โหล' });
  await w.ok('PLAN', 'reserve.change', { id, qty: 2, unit: 'โหล' });
  let s = await w.state();
  assert.equal(res(s, id).qty, 24);
  assert.equal(codeOf(await w.exec('PLAN', 'reserve.change', { id, qty: 1, unit: 'กล่อง' })), 'NO_UNIT');
  await pick(w, j, [{ reservationId: id, qty: 0.5, unit: 'โหล', wh: 'A', bin: 'A-01' }]);
  s = await w.state();
  assert.equal(res(s, id).issued, 6);
  assert.equal(codeOf(await w.exec('PLAN', 'reserve.change', { id, qty: 0.25, unit: 'โหล' })), 'BELOW_ISSUED');
  assertConsistent(s);
});

test('ทบทวน: ความพร้อม – ของกักกัน (NCR) ไม่ขึ้นว่า "รอตรวจ"; ใบงานที่ไม่มีรายการไม่ขึ้นว่าพร้อม', async () => {
  const w = await plant();
  const j = await job(w, { soNo: 'SO-R51', lines: [{ code: 'TST-002', qty: 2 }] });
  await w.ok('LEAD', 'doc.post', { type: 'AJ', lines: [{ code: 'TST-002', qty: 2, wh: 'A', bin: 'A-01', status: 'QUARANTINE' }] });
  let s = await w.state();
  assert.equal(P.readiness(s, j).lines[0].status, 'ขาด');
  assert.equal(sixOf(s, 'TST-002').qcHold, 2); // six() still counts it as not usable
  await w.ok('LEAD', 'doc.post', { type: 'AJ', lines: [{ code: 'TST-002', qty: 2, wh: 'A', bin: 'A-02', status: 'QC_HOLD' }] });
  s = await w.state();
  assert.equal(P.readiness(s, j).lines[0].status, 'รอตรวจ');
  // a job with no component lines (e.g. a Sales Office job not mapped yet) is not "ready"
  const empty = structuredClone(s);
  empty.tables.jobs['JB-EMPTY'] = { ...jobRow(s, j), jobNo: 'JB-EMPTY', lines: [] };
  assert.equal(P.readiness(empty, 'JB-EMPTY').ready, false);
});

test('ทบทวน: ชิ้นส่วนที่งานผลิตเองรับเข้า (FR) ถูกจองให้งานนั้นทันที ไม่หลุดเป็นของพร้อมเบิกของงานอื่น', async () => {
  const w = await plant();
  const j = await job(w, { soNo: 'SO-R61', product: 'TST-FG', qty: 2 }); // TST-001 ต้องใช้ 4
  const other = await job(w, { soNo: 'SO-R62', lines: [{ code: 'TST-001', qty: 4 }] });
  await w.ok('PLAN', 'job.setMake', { jobNo: j, line: 1, toMake: 4 });
  await w.ok('PROD', 'job.record', { jobNo: j, line: 1, qty: 3 });
  const fr = await w.ok('STORE1', 'doc.post', { type: 'FR', job: j, lines: [{ code: 'TST-001', qty: 3, wh: 'A', bin: 'A-01' }] });
  let s = await w.state();
  const mine = P.reservations(s, { jobNo: j, open: true });
  assert.deepEqual(mine.map((r) => [r.code, r.wh, r.qty]), [['TST-001', 'A', 3]]);
  assert.equal(sixOf(s, 'TST-001').free, 0);
  assert.equal(codeOf(await w.exec('PLAN', 'reserve.create', { jobNo: other, code: 'TST-001', wh: 'A', qty: 1 })), 'NO_FREE');
  assert.equal(codeOf(await w.exec('STORE1', 'doc.post', { type: 'PD', job: other, lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01' }] })), 'RESERVED');
  // the job picks its own pieces against that reservation
  await pick(w, j, [{ reservationId: mine[0].id, qty: 2, wh: 'A', bin: 'A-01' }]);
  s = await w.state();
  assert.equal(lineOf(s, j, 'TST-001').issued, 2);
  assertConsistent(s);
  // cancelling a receipt takes back what it reserved (the rest of it, never below what was issued)
  await stockIn(w, 'TST-001', 'A', 'A-01', 2); // other stock so the receipt can be reversed
  await w.ok('LEAD', 'doc.cancel', { docNo: fr.result.docNo, reason: 'รับซ้ำ' });
  s = await w.state();
  assert.equal(P.remaining(res(s, mine[0].id)), 0);
  assert.equal(lineOf(s, j, 'TST-001').received, 0);
  assertConsistent(s);
});

test('ทบทวน: ตัวเลขไม่เพี้ยนหลังจอง/หยิบบางส่วน/คืน/ยกเลิก/ทำซ้ำหลายรอบ', async () => {
  const w = await plant();
  await stockIn(w, 'TST-001', 'A', 'A-01', 12);
  await stockIn(w, 'TST-001', 'B', 'B-01', 3);
  const j = await job(w, { soNo: 'SO-R71', product: 'TST-FG', qty: 4 }); // TST-001 ต้องใช้ 8
  const k = await job(w, { soNo: 'SO-R72', lines: [{ code: 'TST-001', qty: 6 }] });
  const steps = [];
  const step = async (name, fn) => { await fn(); steps.push(name); assertConsistent(await w.state()); };
  let ra;
  await step('จองบางส่วน', async () => { ra = (await w.ok('PLAN', 'reserve.create', { jobNo: j, code: 'TST-001', wh: 'A', qty: 10, allowPartial: true })).result.id; });
  let rk;
  await step('อีก SO จองที่เหลือ', async () => { rk = await reserve(w, k, 'TST-001', 'A', 4); });
  let p1, p2, rt;
  await step('หยิบ 5', async () => { p1 = (await w.ok('STORE1', 'pick.post', { jobNo: j, lines: [{ reservationId: ra, qty: 5, wh: 'A', bin: 'A-01' }] })).result.docNo; });
  await step('หยิบซ้ำคำขอเดิม', async () => { await pick(w, j, [{ reservationId: ra, qty: 3, wh: 'A', bin: 'A-01' }], 'STORE1', 'same-scan'); await pick(w, j, [{ reservationId: ra, qty: 3, wh: 'A', bin: 'A-01' }], 'STORE1', 'same-scan'); });
  let s = await w.state();
  assert.equal(res(s, ra).issued, 8);
  assert.equal(res(s, ra).status, 'FILLED');
  p2 = RRS.inventory.history(s, { code: 'TST-001' }).find((m) => m.docType === 'PD' && m.docNo !== p1).docNo;
  await step('คืนของเหลือ 2', async () => { rt = (await w.ok('STORE1', 'doc.post', { type: 'RT', job: j, lines: [{ code: 'TST-001', qty: 2, wh: 'A', bin: 'A-02' }] })).result.docNo; });
  await step('ย้ายการจองของอีก SO ไปคลัง B', async () => { await w.ok('PLAN', 'reserve.change', { id: rk, qty: 3, wh: 'B', reason: 'ใช้ของคลัง B' }); });
  await step('จองเพิ่มส่วนที่คืน', async () => { await w.ok('PLAN', 'reserve.auto', { jobNo: j }); });
  await step('ยกเลิกใบคืน', async () => { await w.ok('LEAD', 'doc.cancel', { docNo: rt, reason: 'คืนผิด' }); });
  await step('ยกเลิกใบเบิกแรก', async () => { await w.ok('LEAD', 'doc.cancel', { docNo: p1, reason: 'หยิบผิด' }); });
  await step('ยกเลิกซ้ำไม่ได้', async () => {
    assert.equal(codeOf(await w.exec('LEAD', 'doc.cancel', { docNo: p1, reason: 'ซ้ำ' })), 'ALREADY_CANCELLED');
  });
  s = await w.state();
  assert.equal(lineOf(s, j, 'TST-001').issued, 3);
  assert.equal(qty(s, { code: 'TST-001' }), 12);
  const six = sixOf(s, 'TST-001');
  assert.equal(six.reserved, RRS.util.round(P.reservations(s, { open: true, code: 'TST-001' }).reduce((t, r) => t + P.remaining(r), 0)));
  assert.equal(six.demand, 8 - 3 + 6);
  await step('ปิดงาน', async () => { await w.ok('PLAN', 'job.status', { jobNo: j, status: 'DONE' }); });
  await step('ยกเลิกใบเบิกหลังปิดงาน', async () => { await w.ok('LEAD', 'doc.cancel', { docNo: p2, reason: 'ยกเลิกหลังปิด' }); });
  s = await w.state();
  assert.equal(lineOf(s, j, 'TST-001').issued, 0);
  assert.equal(P.reservations(s, { jobNo: j, open: true }).length, 0);
  assert.equal(qty(s, { code: 'TST-001' }), 15);
  assert.equal(steps.length, 12);
});

test('ตารางใหม่มีคำอธิบายภาษาไทยครบ (พจนานุกรมข้อมูล / แท็บ Google Sheet) และมีช่องตามสัญญากลาง', () => {
  const need = {
    jobs: ['jobNo', 'soNo', 'product', 'bomRev', 'qty', 'dueDate', 'priority', 'status', 'lines', 'createdBy', 'createdAt'],
    reservations: ['id', 'jobNo', 'code', 'wh', 'qty', 'issued', 'needDate', 'priority', 'status', 'createdBy', 'createdAt',
      'releasedBy', 'releasedAt', 'reason'],
  };
  for (const t of Object.keys(need)) {
    const def = RRS.schema.tables[t];
    assert.ok(def, t);
    assert.equal(def.phase, 2);
    assert.match(def.label, /[฀-๿]/);
    const names = def.fields.map((f) => f.name);
    for (const n of need[t]) assert.ok(names.includes(n), `${t}.${n}`);
    for (const f of def.fields) assert.match(f.label, /[฀-๿]/, `${t}.${f.name}`);
  }
  assert.deepEqual(RRS.schema.tables.jobs.key, ['jobNo']);
  assert.deepEqual(RRS.schema.tables.reservations.key, ['id']);
  for (const k of ['job.create', 'job.update', 'job.setMake', 'job.record', 'job.status', 'job.cancel', 'reserve.create',
    'reserve.change', 'reserve.release', 'reserve.auto', 'pick.post']) assert.ok(RRS.commands.defs[k], k);
});
