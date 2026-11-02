// Phase 4 acceptance criteria (file 01): เติมสต็อกและจัดซื้อครบวงจร – suppliers, PR → PO → receipts, suggestions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RRS, world, stockIn } from './helpers.mjs';

const qty = (s, f) => RRS.q.qty(s, f);
const TODAY = '2026-11-02'; // the test clock starts 2026-11-02 08:00 Bangkok
const day = (n) => RRS.util.addDays(TODAY, n);
const P = () => RRS.purchasing;

/** World with two suppliers and a bought item: BUY-BOLT ตัว, Min 100 / Max 300, SUP-A sells boxes of 50, MOQ 2, pack 2. */
async function buyWorld(opts) {
  const w = await world(opts);
  await w.ok('PUR', 'supplier.upsert', { id: 'SUP-A', name: 'ผู้ขายทดสอบ เอ', taxId: '0-1055-55000-00-1', contact: 'คุณเอ', phone: '02-000-0000', leadDays: 10 });
  await w.ok('PUR', 'supplier.upsert', { id: 'SUP-B', name: 'ผู้ขายทดสอบ บี', leadDays: 5 });
  await w.ok('LEAD', 'item.upsert', { code: 'BUY-BOLT', name: 'สกรูทดสอบ M10', baseUnit: 'ตัว', type: 'BUY', minQty: 100, maxQty: 300 });
  await w.ok('PUR', 'itemSupplier.upsert', { code: 'BUY-BOLT', supplier: 'SUP-A', price: 120, buyUnit: 'กล่อง', factor: 50, moq: 2, pack: 2, leadDays: 7, preferred: true });
  return w;
}
const row = (s, code, extra = {}) => P().suggest(s, { today: TODAY, ...extra }).find((r) => r.code === code);
async function issuedPo(w, lines, supplier = 'SUP-A', by = 'PUR') {
  const r = await w.ok(by, 'po.create', { supplier, lines });
  await w.ok(by, 'po.issue', { poNo: r.result.poNo });
  return r.result.poNo;
}
async function approvedPr(w, lines, by = 'STORE1', approver = 'PURLEAD') {
  const r = await w.ok(by, 'pr.create', { lines, remark: 'ทดสอบ' });
  await w.ok(approver, 'pr.approve', { prNo: r.result.prNo });
  return r.result.prNo;
}
const bolt = (q, dueDate = day(5), extra = {}) => ({ code: 'BUY-BOLT', qty: q, dueDate, wh: 'A', ...extra });
const has = (arr, re) => arr.some((x) => re.test(x));

// ---------------------------------------------------------------------------------------------------------------
// acceptance criteria
// ---------------------------------------------------------------------------------------------------------------
test('รับ PO บางส่วนแล้วยอดค้างรับถูกต้อง', async () => {
  const w = await buyWorld();
  const poNo = await issuedPo(w, [bolt(6)]);
  let s = await w.state();
  let po = s.tables.pos[poNo];
  assert.match(poNo, /^PO6911-0001$/);
  assert.equal(po.status, 'ISSUED');
  assert.deepEqual([po.lines[0].unit, po.lines[0].factor, po.lines[0].base, po.lines[0].price], ['กล่อง', 50, 300, 120]);
  assert.equal(po.issuedBy, 'PUR');

  // 2 boxes through po.receive (one RR document built and posted)
  const r1 = await w.ok('STORE1', 'po.receive', { poNo, lines: [{ line: 1, qty: 2, bin: 'A-01' }], supplierDoc: 'DN-778' });
  s = await w.state();
  po = s.tables.pos[poNo];
  assert.equal(po.lines[0].received, 100);
  assert.equal(P().lineOutstanding(po.lines[0]), 200);
  assert.equal(po.status, 'PARTIAL');
  assert.equal(r1.result.poStatus, 'PARTIAL');
  const rr = s.tables.documents[r1.result.docNo];
  assert.equal(rr.type, 'RR');
  assert.equal(rr.ref, poNo);
  assert.deepEqual([rr.lines[0].poNo, rr.lines[0].poLine, rr.lines[0].base], [poNo, 1, 100]);
  assert.equal(qty(s, { code: 'BUY-BOLT', wh: 'A', status: 'AVAILABLE' }), 100);
  let out = P().outstanding(s, { today: TODAY });
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].outstanding, out[0].outstandingBuy, out[0].late], [200, 4, false]);

  // 50 pieces through the ordinary RR document with poNo + poLine
  const r2 = await w.ok('STORE2', 'doc.post', { type: 'RR', lines: [{ code: 'BUY-BOLT', qty: 50, wh: 'A', bin: 'A-01', poNo, poLine: 1 }] });
  s = await w.state();
  assert.equal(s.tables.pos[poNo].lines[0].received, 150);
  assert.equal(P().outstanding(s, { today: TODAY })[0].outstanding, 150);

  // the rest: 3 boxes → RECEIVED, nothing outstanding
  await w.ok('STORE1', 'po.receive', { poNo, lines: [{ line: 1, qty: 3, bin: 'A-02' }] });
  s = await w.state();
  assert.equal(s.tables.pos[poNo].status, 'RECEIVED');
  assert.deepEqual(P().outstanding(s, { today: TODAY }), []);

  // cancelling a receipt gives the quantity back to the PO line (same commit as the stock reversal)
  await w.ok('LEAD', 'doc.cancel', { docNo: r2.result.docNo, reason: 'คีย์ซ้ำ' });
  s = await w.state();
  po = s.tables.pos[poNo];
  assert.equal(po.lines[0].received, 250);
  assert.equal(po.status, 'PARTIAL');
  assert.equal(P().outstanding(s, { today: TODAY })[0].outstanding, 50);
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);

  // close the remaining 50 as cancelled qty
  const close = await w.ok('PURLEAD', 'po.close', { poNo, reason: 'ผู้ขายแจ้งของหมด' });
  assert.deepEqual(close.result.closed, [{ line: 1, qty: 50 }]);
  s = await w.state();
  po = s.tables.pos[poNo];
  assert.deepEqual([po.status, po.lines[0].cancelled, P().lineOutstanding(po.lines[0]), po.closedBy], ['CLOSED', 50, 0, 'PURLEAD']);
  const late = await w.exec('STORE1', 'po.receive', { poNo, lines: [{ line: 1, qty: 1, bin: 'A-01' }] });
  assert.equal(late.errors[0].code, 'BAD_STATE');
  assert.deepEqual(po.log.map((e) => e.action), ['create', 'issue', 'receive', 'receive', 'receive', 'receiveUndo', 'close']);
});

test('ระบบไม่แนะนำซื้อซ้ำโดยไม่หักของค้างรับที่เข้าได้ทัน', async () => {
  const w = await buyWorld();
  await stockIn(w, 'BUY-BOLT', 'A', 'A-01', 60);
  let s = await w.state();
  let r = row(s, 'BUY-BOLT');
  assert.deepEqual([r.available, r.projected, r.min, r.max, r.leadDays], [60, 60, 100, 300, 7]);
  assert.deepEqual([r.orderQty, r.orderBuyQty, r.buyUnit, r.status, r.supplier], [300, 6, 'กล่อง', 'ORDER', 'SUP-A']);
  assert.ok(r.reasons.length >= 5 && has(r.reasons, /Max 300 − 60 = 240/));

  // a PO that arrives after the lead time cannot prevent the shortage: shown, not counted
  const poNo = await issuedPo(w, [bolt(6, day(20))]);
  s = await w.state();
  r = row(s, 'BUY-BOLT');
  assert.deepEqual([r.incomingSure, r.incomingLater, r.orderQty], [0, 300, 300]);
  assert.ok(has(r.reasons, /เข้าไม่ทัน/));

  // the supplier confirms an earlier date (กำหนดเข้าจริง): now it arrives in time → no second order
  const noReason = await w.exec('PUR', 'po.setDue', { poNo, line: 1, dueDate: day(3) });
  assert.equal(noReason.errors[0].code, 'REQUIRED');
  await w.ok('PUR', 'po.setDue', { poNo, line: 1, dueDate: day(3), reason: 'ผู้ขายยืนยันส่งเร็วขึ้น' });
  s = await w.state();
  r = row(s, 'BUY-BOLT');
  assert.deepEqual([r.incomingSure, r.projected, r.orderQty, r.status], [300, 360, 0, 'OK']);
  assert.equal(s.tables.pos[poNo].lines[0].originalDue, day(20));

  // seen after its due date the PO is late: not "sure" by default (policy lateIsUncertain) → suggests again
  r = row(s, 'BUY-BOLT', { today: day(10) });
  assert.deepEqual([r.incomingLate, r.incomingSure, r.lateCounted, r.orderQty], [300, 0, false, 300]);
  assert.ok(has(r.reasons, /ไม่นับ \(นโยบาย: ของล่าช้าไม่แน่นอน\)/));
  await w.ok('MGR', 'settings.update', { patch: { policies: { lateIsUncertain: false } } });
  s = await w.state();
  r = row(s, 'BUY-BOLT', { today: day(10) });
  assert.deepEqual([r.incomingLate, r.lateCounted, r.projected, r.orderQty], [300, true, 360, 0]);
});

test('ระบบไม่แนะนำซื้อซ้ำ – ใบขอซื้อจากคำแนะนำที่ยังไม่ออก PO ถูกหักแล้ว', async () => {
  const w = await buyWorld();
  await stockIn(w, 'BUY-BOLT', 'A', 'A-01', 60);
  let s = await w.state();
  const lines = P().draftPrLines(s, { today: TODAY, wh: 'A', code: 'BUY-BOLT' });
  assert.deepEqual(lines.map((l) => [l.code, l.qty, l.needDate, l.wh, l.supplier]), [['BUY-BOLT', 300, day(7), 'A', 'SUP-A']]);
  const pr = await w.ok('STORE1', 'pr.create', { lines, source: 'แนะนำสั่งซื้อ' });
  s = await w.state();
  let r = row(s, 'BUY-BOLT');
  assert.deepEqual([r.need, r.pendingPr, r.orderQty, r.status], [240, 300, 0, 'COVERED']);
  assert.ok(has(r.reasons, new RegExp(pr.result.prNo)));
  // rejected → no longer counted, the suggestion comes back
  await w.ok('PURLEAD', 'pr.reject', { prNo: pr.result.prNo, reason: 'รอรวมกับรอบหน้า' });
  s = await w.state();
  r = row(s, 'BUY-BOLT');
  assert.deepEqual([r.pendingPr, r.orderQty], [0, 300]);
  // a draft PO is counted the same way (prepared, not sent yet)
  await w.ok('PUR', 'po.create', { supplier: 'SUP-A', lines: [bolt(6, day(3))] });
  s = await w.state();
  r = row(s, 'BUY-BOLT');
  assert.deepEqual([r.draftPo, r.incomingSure, r.orderQty, r.status], [300, 0, 0, 'COVERED']);
});

test('ปริมาณสั่งสอดคล้อง MOQ/แพ็ก', async () => {
  const w = await buyWorld();
  await w.ok('LEAD', 'item.upsert', { code: 'BUY-NUT', name: 'น็อตทดสอบ', baseUnit: 'ตัว', type: 'BUY', minQty: 10, maxQty: 20 });
  await w.ok('PUR', 'itemSupplier.upsert', { code: 'BUY-NUT', supplier: 'SUP-B', price: 30, buyUnit: 'กล่อง', factor: 12, moq: 3, pack: 2, preferred: true });
  await stockIn(w, 'BUY-NUT', 'A', 'A-01', 5);
  let s = await w.state();
  let r = row(s, 'BUY-NUT');
  // need 15 → 2 boxes → at least MOQ 3 → a multiple of the pack (2) → 4 boxes = 48 pieces
  assert.deepEqual([r.need, r.orderBuyQty, r.orderQty, r.amount, r.leadDays], [15, 4, 48, 120, 5]);
  assert.ok(r.orderBuyQty >= 3 && r.orderBuyQty % 2 === 0 && r.orderQty === r.orderBuyQty * 12);
  assert.ok(has(r.reasons, /ขั้นต่ำ 3 กล่อง, แพ็กละ 2 กล่อง/));
  await w.ok('PUR', 'itemSupplier.upsert', { code: 'BUY-NUT', supplier: 'SUP-B', pack: 0 });
  r = row(await w.state(), 'BUY-NUT');
  assert.deepEqual([r.orderBuyQty, r.orderQty], [3, 36]);
  await w.ok('PUR', 'itemSupplier.upsert', { code: 'BUY-NUT', supplier: 'SUP-B', moq: 0, pack: 5 });
  r = row(await w.state(), 'BUY-NUT');
  assert.deepEqual([r.orderBuyQty, r.orderQty], [5, 60]);
  assert.deepEqual([P().roundBuy(13, 12, 3, 2), P().roundBuy(0, 12, 3, 2), P().roundBuy(2.5, 1, 0, 0), P().roundBuy(7, 1, 0, 0)], [4, 0, 3, 7]);

  // a PO made from a PR rounds the same way and says so
  await w.ok('PUR', 'itemSupplier.upsert', { code: 'BUY-NUT', supplier: 'SUP-B', moq: 3, pack: 2 });
  const prNo = await approvedPr(w, [{ code: 'BUY-NUT', qty: 15, needDate: day(10), wh: 'A', supplier: 'SUP-B', reason: 'Min' }]);
  const po = await w.ok('PUR', 'po.create', { supplier: 'SUP-B', prNos: [prNo] });
  s = await w.state();
  const pl = s.tables.pos[po.result.poNo].lines[0];
  assert.deepEqual([pl.qty, pl.unit, pl.base, pl.prNo, pl.prLine, pl.dueDate, pl.price], [4, 'กล่อง', 48, prNo, 1, day(10), 30]);
  assert.ok(has(po.warnings, /มากกว่าที่ขอซื้อค้าง 15/));
  assert.equal(s.tables.prs[prNo].status, 'CONVERTED');
  assert.deepEqual(s.tables.prs[prNo].poNos, [po.result.poNo]);
  // a hand-made PO below the MOQ or off the pack is allowed but warned
  const small = await w.ok('PUR', 'po.create', { supplier: 'SUP-B', lines: [{ code: 'BUY-NUT', qty: 1, dueDate: day(5), wh: 'A' }] });
  assert.ok(has(small.warnings, /MOQ/));
  const odd = await w.ok('PUR', 'po.create', { supplier: 'SUP-B', lines: [{ code: 'BUY-NUT', qty: 3, dueDate: day(5), wh: 'A' }] });
  assert.ok(has(odd.warnings, /ไม่เต็มแพ็ก/));
});

test('ยกเลิก PO แล้วคำนวณแผนใหม่', async () => {
  const w = await buyWorld();
  await stockIn(w, 'BUY-BOLT', 'A', 'A-01', 60);
  const poNo = await issuedPo(w, [bolt(6, day(3))]);
  let s = await w.state();
  assert.equal(row(s, 'BUY-BOLT').orderQty, 0);
  const noReason = await w.exec('PUR', 'po.cancel', { poNo });
  assert.equal(noReason.errors[0].code, 'REQUIRED');
  await w.ok('PUR', 'po.cancel', { poNo, reason: 'ผู้ขายยกเลิกการผลิต' });
  s = await w.state();
  const po = s.tables.pos[poNo];
  assert.deepEqual([po.status, po.lines[0].cancelled, po.cancelledBy, po.cancelReason], ['CANCELLED', 300, 'PUR', 'ผู้ขายยกเลิกการผลิต']);
  assert.deepEqual(P().outstanding(s, { today: TODAY }), []);
  const r = row(s, 'BUY-BOLT');
  assert.deepEqual([r.incomingSure, r.projected, r.orderQty, r.status], [0, 60, 300, 'ORDER']);
  const twice = await w.exec('PUR', 'po.cancel', { poNo, reason: 'ซ้ำ' });
  assert.equal(twice.errors[0].code, 'ALREADY_CANCELLED');
  const issueCancelled = await w.exec('PUR', 'po.issue', { poNo });
  assert.equal(issueCancelled.errors[0].code, 'BAD_STATE');
});

test('ยกเลิก PO แล้วคำนวณแผนใหม่ – ยกเลิกบางบรรทัด/บางส่วน', async () => {
  const w = await buyWorld();
  const poNo = await issuedPo(w, [bolt(6, day(3))]);
  let s = await w.state();
  assert.deepEqual([row(s, 'BUY-BOLT').projected, row(s, 'BUY-BOLT').orderQty], [300, 0]);
  const tooMuch = await w.exec('PUR', 'po.cancelLine', { poNo, line: 1, qty: 7, reason: 'ลดจำนวน' });
  assert.equal(tooMuch.errors[0].code, 'TOO_MUCH');
  await w.ok('PUR', 'po.cancelLine', { poNo, line: 1, qty: 5, reason: 'ลดจำนวนตามงบ' });
  s = await w.state();
  let r = row(s, 'BUY-BOLT');
  assert.deepEqual([s.tables.pos[poNo].status, r.incomingSure, r.projected, r.orderQty], ['ISSUED', 50, 50, 300]);
  await w.ok('PUR', 'po.cancelLine', { poNo, line: 1, reason: 'ยกเลิกที่เหลือ' });
  s = await w.state();
  assert.equal(s.tables.pos[poNo].status, 'CANCELLED');
  r = row(s, 'BUY-BOLT');
  assert.deepEqual([r.incomingSure, r.orderQty], [0, 300]);
});

test('ยกเลิก PO แล้วคำนวณแผนใหม่ – ใบขอซื้อกลับมาค้างออก PO และออกใบใหม่ได้', async () => {
  const w = await buyWorld();
  await stockIn(w, 'BUY-BOLT', 'A', 'A-01', 60);
  const prNo = await approvedPr(w, [{ code: 'BUY-BOLT', qty: 240, needDate: day(6), wh: 'A', reason: 'ต่ำกว่า Min' }]);
  const first = await w.ok('PUR', 'po.create', { supplier: 'SUP-A', prNos: [prNo] });
  await w.ok('PUR', 'po.issue', { poNo: first.result.poNo });
  let s = await w.state();
  assert.equal(P().prOpen(s, prNo).lines[0].open, 0);
  assert.deepEqual([row(s, 'BUY-BOLT').incomingSure, row(s, 'BUY-BOLT').pendingPr, row(s, 'BUY-BOLT').orderQty], [300, 0, 0]);
  const again = await w.exec('PUR', 'po.create', { supplier: 'SUP-A', prNos: [prNo] });
  assert.equal(again.errors[0].code, 'NOTHING');
  await w.ok('PUR', 'po.cancel', { poNo: first.result.poNo, reason: 'ผู้ขายส่งไม่ได้' });
  s = await w.state();
  assert.equal(P().prOpen(s, prNo).lines[0].open, 240);
  const r = row(s, 'BUY-BOLT');
  assert.deepEqual([r.incomingSure, r.need, r.pendingPr, r.orderQty, r.status], [0, 240, 240, 0, 'COVERED']);
  const second = await w.ok('PUR', 'po.create', { supplier: 'SUP-A', prNos: [prNo] });
  s = await w.state();
  assert.deepEqual(s.tables.prs[prNo].poNos, [first.result.poNo, second.result.poNo]);
  assert.equal(P().prOpen(s, prNo).lines[0].open, 0);
});

test('ของรอตรวจยังไม่เพิ่มยอดพร้อมเบิก', async () => {
  const w = await buyWorld();
  await w.ok('PUR', 'itemSupplier.upsert', { code: 'TST-PLATE', supplier: 'SUP-A', price: 2500, preferred: true });
  await w.ok('PUR', 'reorder.set', { code: 'TST-PLATE', min: 10, max: 20 });
  const poNo = await issuedPo(w, [{ code: 'TST-PLATE', qty: 20, dueDate: day(5), wh: 'A' }]);
  const noLot = await w.exec('STORE1', 'po.receive', { poNo, lines: [{ line: 1, qty: 20, bin: 'A-02' }] });
  assert.equal(noLot.errors[0].code, 'LOT_REQUIRED');
  await w.ok('STORE1', 'po.receive', { poNo, lines: [{ line: 1, qty: 20, bin: 'A-02', lot: 'H-001' }] });
  const s = await w.state();
  assert.equal(s.tables.pos[poNo].status, 'RECEIVED');
  assert.equal(qty(s, { code: 'TST-PLATE', status: 'QC_HOLD' }), 20);
  assert.equal(qty(s, { code: 'TST-PLATE', status: 'AVAILABLE' }), 0);
  const r = row(s, 'TST-PLATE');
  assert.deepEqual([r.available, r.qcHold, r.free, r.incomingSure, r.projected, r.min, r.max], [0, 20, 0, 0, 0, 10, 20]);
  assert.equal(r.orderQty, 20, 'stock waiting for QC is not counted as available');
  assert.ok(has(r.reasons, /รอตรวจ 20 แผ่น – ยังไม่นับเป็นของพร้อมเบิก/));
  // nobody can issue it, and it cannot go back to the vendor before QC decides
  const issue = await w.exec('STORE1', 'doc.post', { type: 'PD', lines: [{ code: 'TST-PLATE', qty: 1, wh: 'A', bin: 'A-02', lot: 'H-001' }] });
  assert.equal(issue.errors[0].code, 'NOT_ENOUGH');
  const back = await w.exec('STORE1', 'po.return', { poNo, reason: 'ผิวมีรอย', lines: [{ line: 1, qty: 1, bin: 'A-02', lot: 'H-001', status: 'QC_HOLD' }] });
  assert.equal(back.errors[0].code, 'BAD_STATUS');
});

// ---------------------------------------------------------------------------------------------------------------
// receiving rules, returns, cancel / undo
// ---------------------------------------------------------------------------------------------------------------
test('รับเกินตามสิทธิ์: เผื่อตามนโยบาย, อนุมัติรับเกิน, ยกเลิกใบรับคืนสิทธิ์', async () => {
  const w = await buyWorld();
  const poNo = await issuedPo(w, [bolt(2)]); // 100 pieces
  let s = await w.state();
  const seq = s.seq;
  const over = await w.exec('STORE1', 'po.receive', { poNo, lines: [{ line: 1, qty: 2.2, bin: 'A-01' }] });
  assert.equal(over.errors[0].code, 'OVER_RECEIVE');
  s = await w.state();
  assert.equal(s.seq, seq, 'a refused receipt changes nothing');
  assert.equal(s.tables.pos[poNo].lines[0].received, 0);
  await w.ok('MGR', 'settings.update', { patch: { policies: { overReceivePct: 10 } } });
  await w.ok('STORE1', 'po.receive', { poNo, lines: [{ line: 1, qty: 2.2, bin: 'A-01' }] });
  s = await w.state();
  assert.deepEqual([s.tables.pos[poNo].lines[0].received, s.tables.pos[poNo].status], [110, 'RECEIVED']);

  // second PO: 50 received, 50 outstanding → at most 55 without approval
  const po2 = await issuedPo(w, [bolt(2)]);
  await w.ok('STORE1', 'po.receive', { poNo: po2, lines: [{ line: 1, qty: 1, bin: 'A-01' }] });
  const tooMuch = await w.exec('STORE1', 'po.receive', { poNo: po2, lines: [{ line: 1, qty: 2, bin: 'A-01' }] });
  assert.equal(tooMuch.errors[0].code, 'OVER_RECEIVE');
  assert.match(tooMuch.errors[0].message, /รับได้ไม่เกิน 55/);
  const noRight = await w.exec('LEAD', 'po.allowOverReceive', { poNo: po2, line: 1, qty: 1, reason: 'ผู้ขายส่งเกินมา' });
  assert.equal(noRight.errors[0].code, 'NO_PERMISSION');
  await w.ok('PURLEAD', 'po.allowOverReceive', { poNo: po2, line: 1, qty: 1, reason: 'ผู้ขายส่งเกิน ยอมรับไว้ใช้รอบหน้า' });
  const rr = await w.ok('STORE1', 'po.receive', { poNo: po2, lines: [{ line: 1, qty: 2, bin: 'A-01' }] });
  s = await w.state();
  let pl = s.tables.pos[po2].lines[0];
  assert.deepEqual([pl.received, pl.overAllowed, s.tables.pos[po2].status], [150, 5, 'RECEIVED']);
  assert.deepEqual(pl.overApprovals.map((a) => [a.qty, a.by]), [[50, 'PURLEAD']]);
  await w.ok('LEAD', 'doc.cancel', { docNo: rr.result.docNo, reason: 'รับผิดใบ' });
  s = await w.state();
  pl = s.tables.pos[po2].lines[0];
  assert.deepEqual([pl.received, pl.overAllowed, s.tables.pos[po2].status], [50, 50, 'PARTIAL']);

  // a person holding po.overReceive may receive over without a prior approval (recorded in the PO log)
  const po3 = await issuedPo(w, [bolt(2)]);
  await w.ok('ADMIN', 'po.receive', { poNo: po3, lines: [{ line: 1, qty: 4, bin: 'A-01' }] });
  s = await w.state();
  const entry = s.tables.pos[po3].log.find((e) => e.action === 'receive');
  assert.deepEqual([entry.qty, entry.overByPerm, entry.by], [200, 90, 'ADMIN']);
});

test('คืนผู้ขาย: ลดหนี้, ขอของทดแทนเปิดยอดค้างใหม่, ยกเลิกใบคืนกลับยอด', async () => {
  const w = await buyWorld();
  const poNo = await issuedPo(w, [bolt(4)]); // 200
  const rr = await w.ok('STORE1', 'po.receive', { poNo, lines: [{ line: 1, qty: 4, bin: 'A-01' }] });
  const noReason = await w.exec('STORE1', 'po.return', { poNo, lines: [{ line: 1, qty: 1, bin: 'A-01' }] });
  assert.equal(noReason.errors[0].code, 'REQUIRED');
  // credit return: returned goes up, the PO stays received
  const credit = await w.ok('STORE1', 'po.return', { poNo, reason: 'เกลียวเสีย ขอลดหนี้', lines: [{ line: 1, qty: 1, bin: 'A-01' }] });
  let s = await w.state();
  let pl = s.tables.pos[poNo].lines[0];
  assert.deepEqual([pl.received, pl.returned, pl.replaced, s.tables.pos[poNo].status], [200, 50, 0, 'RECEIVED']);
  assert.equal(s.tables.documents[credit.result.docNo].type, 'RV');
  assert.equal(s.tables.documents[credit.result.docNo].expressStatus, 'N/A');
  assert.equal(qty(s, { code: 'BUY-BOLT' }), 150);
  // return for replacement: the quantity is outstanding again
  const repl = await w.ok('STORE1', 'po.return', { poNo, reason: 'ขนาดผิด ขอเปลี่ยน', lines: [{ line: 1, qty: 1, bin: 'A-01', replace: true }] });
  s = await w.state();
  pl = s.tables.pos[poNo].lines[0];
  assert.deepEqual([pl.received, pl.returned, pl.replaced, P().lineOutstanding(pl), s.tables.pos[poNo].status], [150, 100, 50, 50, 'PARTIAL']);
  assert.deepEqual(s.tables.documents[repl.result.docNo].replaceLines, [1]);
  assert.equal(P().outstanding(s, { today: TODAY })[0].outstanding, 50);
  // returning more than this PO delivered and kept is refused
  const tooMuch = await w.exec('STORE1', 'po.return', { poNo, reason: 'คืนทั้งหมด', lines: [{ line: 1, qty: 3, bin: 'A-01' }] });
  assert.equal(tooMuch.errors[0].code, 'RETURN_OVER');
  // an RV posted as an ordinary document with poNo/poLine is a credit return too
  await w.ok('STORE1', 'doc.post', { type: 'RV', remark: 'คืนผู้ขาย', lines: [{ code: 'BUY-BOLT', qty: 10, wh: 'A', bin: 'A-01', poNo, poLine: 1 }] });
  s = await w.state();
  assert.equal(s.tables.pos[poNo].lines[0].returned, 110);
  // cancelling the replacement return undoes it
  await w.ok('LEAD', 'doc.cancel', { docNo: repl.result.docNo, reason: 'ผู้ขายรับเปลี่ยนไม่ได้' });
  s = await w.state();
  pl = s.tables.pos[poNo].lines[0];
  assert.deepEqual([pl.received, pl.returned, pl.replaced, s.tables.pos[poNo].status], [200, 60, 0, 'RECEIVED']);
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
  // the receipt cannot be cancelled while part of what it brought in has gone back to the vendor –
  // refused by the stock (not enough left to reverse) and, with enough stock from elsewhere, by the PO line
  const noStock = await w.exec('LEAD', 'doc.cancel', { docNo: rr.result.docNo, reason: 'ทดสอบ' });
  assert.equal(noStock.errors[0].code, 'CANNOT_REVERSE');
  await stockIn(w, 'BUY-BOLT', 'A', 'A-01', 100);
  const seq = (await w.state()).seq;
  const undoRr = await w.exec('LEAD', 'doc.cancel', { docNo: rr.result.docNo, reason: 'ทดสอบ' });
  assert.equal(undoRr.errors[0].code, 'RETURNED');
  s = await w.state();
  assert.equal(s.seq, seq);
  assert.equal(s.tables.documents[rr.result.docNo].status, 'POSTED');
});

test('ยกเลิก/ย้อนกลับ: ใบขอซื้อ, ยกเลิก PO ที่รับแล้วไม่ได้, ปิด PO แล้วยกเลิกใบรับไม่เปิดยอดค้าง', async () => {
  const w = await buyWorld();
  const d = await w.ok('STORE1', 'pr.create', { draft: true, lines: [{ code: 'BUY-BOLT', qty: 10, wh: 'A' }] });
  const notOwner = await w.exec('STORE2', 'pr.cancel', { prNo: d.result.prNo, reason: 'ไม่ใช้แล้ว' });
  assert.equal(notOwner.errors[0].code, 'NOT_OWNER');
  await w.ok('STORE1', 'pr.cancel', { prNo: d.result.prNo, reason: 'ไม่ใช้แล้ว' });
  let s = await w.state();
  assert.deepEqual([s.tables.prs[d.result.prNo].status, s.tables.prs[d.result.prNo].cancelledBy], ['CANCELLED', 'STORE1']);
  const cancelled = await w.exec('STORE1', 'pr.cancel', { prNo: d.result.prNo, reason: 'ซ้ำ' });
  assert.equal(cancelled.errors[0].code, 'BAD_STATE');

  // a PR ordered in part: cancel the rest
  const prNo = await approvedPr(w, [{ code: 'BUY-BOLT', qty: 400, needDate: day(6), wh: 'A' }]);
  const po = await w.ok('PUR', 'po.create', { supplier: 'SUP-A', prNos: [prNo], lines: [bolt(4, day(6))] });
  s = await w.state();
  assert.deepEqual([P().prOpen(s, prNo).lines[0].ordered, P().prOpen(s, prNo).lines[0].open], [200, 200]);
  assert.equal(s.tables.pos[po.result.poNo].lines[0].prNo, prNo, 'linked through prNos');
  await w.ok('PURLEAD', 'pr.cancel', { prNo, reason: 'ซื้อแค่ครึ่งเดียว' });
  s = await w.state();
  assert.equal(P().prOpen(s, prNo).lines[0].open, 0);
  assert.equal(s.tables.prs[prNo].restCancelled.by, 'PURLEAD');

  // a received PO cannot be cancelled whole; closing it and then cancelling its receipt keeps it closed
  await w.ok('PUR', 'po.issue', { poNo: po.result.poNo });
  const rr = await w.ok('STORE1', 'po.receive', { poNo: po.result.poNo, lines: [{ line: 1, qty: 2, bin: 'A-01' }] });
  const cancel = await w.exec('PUR', 'po.cancel', { poNo: po.result.poNo, reason: 'ไม่เอาแล้ว' });
  assert.equal(cancel.errors[0].code, 'BAD_STATE');
  await w.ok('PURLEAD', 'po.close', { poNo: po.result.poNo, reason: 'รับแค่นี้' });
  await w.ok('LEAD', 'doc.cancel', { docNo: rr.result.docNo, reason: 'รับผิดรหัส' });
  s = await w.state();
  const pl = s.tables.pos[po.result.poNo].lines[0];
  assert.deepEqual([s.tables.pos[po.result.poNo].status, pl.received, pl.cancelled, P().lineOutstanding(pl)], ['CLOSED', 0, 200, 0]);
  assert.equal(qty(s, { code: 'BUY-BOLT' }), 0);
  // a draft PO with nothing received may be cancelled whole
  const draft = await w.ok('PUR', 'po.create', { supplier: 'SUP-A', lines: [bolt(2)] });
  await w.ok('PUR', 'po.cancel', { poNo: draft.result.poNo, reason: 'สร้างผิด' });
  s = await w.state();
  assert.deepEqual([s.tables.pos[draft.result.poNo].status, s.tables.pos[draft.result.poNo].lines[0].cancelled], ['CANCELLED', 100]);
});

test('ร่างใบขอซื้อ → แก้ → ส่งอนุมัติ → อนุมัติ → PO', async () => {
  const w = await buyWorld();
  const d = await w.ok('STORE1', 'pr.create', { draft: true, lines: [{ code: 'BUY-BOLT', qty: 80, wh: 'A', reason: 'ร่าง' }] });
  let s = await w.state();
  assert.match(d.result.prNo, /^PR6911-0001$/);
  assert.equal(s.tables.prs[d.result.prNo].status, 'DRAFT');
  const early = await w.exec('PURLEAD', 'pr.approve', { prNo: d.result.prNo });
  assert.equal(early.errors[0].code, 'BAD_STATE');
  const noDate = await w.exec('STORE1', 'pr.submit', { prNo: d.result.prNo });
  assert.equal(noDate.errors[0].code, 'REQUIRED');
  const other = await w.exec('STORE2', 'pr.create', { prNo: d.result.prNo, draft: true, lines: [{ code: 'BUY-BOLT', qty: 1, wh: 'A' }] });
  assert.equal(other.errors[0].code, 'NOT_OWNER');
  await w.ok('STORE1', 'pr.create', { prNo: d.result.prNo, draft: true, lines: [{ code: 'BUY-BOLT', qty: 90, wh: 'A', needDate: day(9), supplier: 'SUP-A', reason: 'ใช้งาน SO-1' }] });
  await w.ok('STORE1', 'pr.submit', { prNo: d.result.prNo });
  s = await w.state();
  assert.deepEqual([s.tables.prs[d.result.prNo].status, s.tables.prs[d.result.prNo].lines[0].qty], ['SUBMITTED', 90]);
  await w.ok('PURLEAD', 'pr.approve', { prNo: d.result.prNo });
  const po = await w.ok('PUR', 'po.create', { supplier: 'SUP-A', prNos: [d.result.prNo] });
  s = await w.state();
  const pl = s.tables.pos[po.result.poNo].lines[0];
  assert.deepEqual([pl.qty, pl.base, pl.dueDate, pl.wh], [2, 100, day(9), 'A']);
  assert.deepEqual(s.tables.pos[po.result.poNo].prNos, [d.result.prNo]);
  assert.deepEqual(s.tables.prs[d.result.prNo].log.map((e) => e.action), ['create', 'update', 'submit', 'approve', 'convert']);
});

// ---------------------------------------------------------------------------------------------------------------
// permissions and separation of duties
// ---------------------------------------------------------------------------------------------------------------
test('สิทธิ์: แต่ละขั้นต้องมีบทบาทที่ถูกต้อง (และคลัง)', async () => {
  const w = await buyWorld();
  const poNo = await issuedPo(w, [bolt(2)]);
  const denied = async (user, kind, payload) => {
    const r = await w.exec(user, kind, payload);
    assert.equal(r.ok, false, `${user} ${kind}`);
    assert.equal(r.errors[0].code, 'NO_PERMISSION', `${user} ${kind}: ${JSON.stringify(r.errors)}`);
  };
  await denied('VIEW', 'supplier.upsert', { id: 'SUP-X', name: 'x' });
  await denied('STORE1', 'itemSupplier.upsert', { code: 'BUY-BOLT', supplier: 'SUP-B', price: 1 });
  await denied('VIEW', 'reorder.set', { code: 'BUY-BOLT', min: 1, max: 2 });
  await denied('ACC', 'pr.create', { lines: [{ code: 'BUY-BOLT', qty: 1, needDate: day(3), wh: 'A' }] });
  await denied('STORE1', 'po.create', { supplier: 'SUP-A', lines: [bolt(2)] });
  await denied('STORE1', 'po.issue', { poNo });
  await denied('PUR', 'po.close', { poNo, reason: 'ปิด' });
  await denied('PUR', 'po.receive', { poNo, lines: [{ line: 1, qty: 1, bin: 'A-01' }] });
  await denied('PUR', 'doc.post', { type: 'RR', lines: [{ code: 'BUY-BOLT', qty: 1, wh: 'A', bin: 'A-01', poNo, poLine: 1 }] });
  await denied('LEAD', 'po.allowOverReceive', { poNo, line: 1, qty: 1, reason: 'เกิน' });
  const pr = await w.ok('STORE1', 'pr.create', { lines: [{ code: 'BUY-BOLT', qty: 10, needDate: day(3), wh: 'A' }] });
  await denied('PUR', 'pr.approve', { prNo: pr.result.prNo });
  await denied('STORE2', 'pr.reject', { prNo: pr.result.prNo, reason: 'ไม่จำเป็น' });
  await w.ok('PLAN', 'reorder.set', { code: 'BUY-BOLT', wh: 'A', min: 50, max: 150 });
  await w.ok('PUR', 'pr.create', { lines: [{ code: 'BUY-BOLT', qty: 10, needDate: day(3), wh: 'A' }] });
  // warehouse rights: a person limited to A cannot ask for B
  await w.ok('ADMIN', 'user.upsert', { id: 'ONLYA', name: 'สโตร์ A', roles: ['store'], warehouses: ['A'] });
  await denied('ONLYA', 'pr.create', { lines: [{ code: 'BUY-BOLT', qty: 1, needDate: day(3), wh: 'B' }] });
  await denied('ONLYA', 'po.receive', { poNo, lines: [{ line: 1, qty: 1, wh: 'B', bin: 'B-01' }] });
  await w.ok('ONLYA', 'po.receive', { poNo, lines: [{ line: 1, qty: 1, bin: 'A-01' }] });
});

test('แยกหน้าที่: ผู้ขออนุมัติ/ไม่อนุมัติใบขอซื้อของตัวเองไม่ได้ และเก็บผู้อนุมัติ/เวลา', async () => {
  const w = await buyWorld();
  const pr = await w.ok('STORE1', 'pr.create', { lines: [{ code: 'BUY-BOLT', qty: 10, needDate: day(3), wh: 'A' }] });
  await w.ok('PURLEAD', 'pr.approve', { prNo: pr.result.prNo });
  let s = await w.state();
  const row1 = s.tables.prs[pr.result.prNo];
  assert.deepEqual([row1.status, row1.requestedBy, row1.approvedBy], ['APPROVED', 'STORE1', 'PURLEAD']);
  assert.ok(row1.approvedAt > row1.requestedAt);
  const twice = await w.exec('MGR', 'pr.approve', { prNo: pr.result.prNo });
  assert.equal(twice.errors[0].code, 'BAD_STATE');

  const own = await w.ok('ADMIN', 'pr.create', { lines: [{ code: 'BUY-BOLT', qty: 10, needDate: day(3), wh: 'A' }] });
  const self = await w.exec('ADMIN', 'pr.approve', { prNo: own.result.prNo });
  assert.equal(self.errors[0].code, 'SAME_PERSON');
  const selfReject = await w.exec('ADMIN', 'pr.reject', { prNo: own.result.prNo, reason: 'ไม่ใช้' });
  assert.equal(selfReject.errors[0].code, 'SAME_PERSON');
  const noReason = await w.exec('MGR', 'pr.reject', { prNo: own.result.prNo });
  assert.equal(noReason.errors[0].code, 'REQUIRED');
  await w.ok('MGR', 'pr.reject', { prNo: own.result.prNo, reason: 'งบเดือนนี้หมด' });
  s = await w.state();
  assert.deepEqual([s.tables.prs[own.result.prNo].status, s.tables.prs[own.result.prNo].rejectedBy, s.tables.prs[own.result.prNo].rejectReason],
    ['REJECTED', 'MGR', 'งบเดือนนี้หมด']);
  // only APPROVED/CONVERTED PRs can become a PO
  const fromRejected = await w.exec('PUR', 'po.create', { supplier: 'SUP-A', prNos: [own.result.prNo] });
  assert.equal(fromRejected.errors[0].code, 'PR_NOT_APPROVED');
  const waiting = await w.ok('STORE1', 'pr.create', { lines: [{ code: 'BUY-BOLT', qty: 10, needDate: day(3), wh: 'A' }] });
  const fromWaiting = await w.exec('PUR', 'po.create', { supplier: 'SUP-A', lines: [bolt(2, day(3), { prNo: waiting.result.prNo })] });
  assert.equal(fromWaiting.errors[0].code, 'PR_NOT_APPROVED');
});

// ---------------------------------------------------------------------------------------------------------------
// master data, bad input
// ---------------------------------------------------------------------------------------------------------------
test('ผู้ขายหลักได้รายเดียวต่อสินค้า; Lead time ใช้ของสินค้า→ผู้ขาย→7 วัน', async () => {
  const w = await buyWorld();
  let s = await w.state();
  assert.equal(P().preferredSupplier(s, 'BUY-BOLT').supplier, 'SUP-A');
  const r = await w.ok('PUR', 'itemSupplier.upsert', { code: 'BUY-BOLT', supplier: 'SUP-B', price: 2.5, preferred: true });
  assert.ok(has(r.warnings, /SUP-A เป็น SUP-B/));
  s = await w.state();
  assert.deepEqual(P().itemSuppliers(s, 'BUY-BOLT').map((x) => [x.supplier, x.preferred]), [['SUP-B', true], ['SUP-A', false]]);
  let sg = row(s, 'BUY-BOLT');
  assert.deepEqual([sg.supplier, sg.buyUnit, sg.factor, sg.leadDays], ['SUP-B', 'ตัว', 1, 5]); // SUP-B has no item lead → supplier lead 5
  assert.equal(row(s, 'TST-001').leadDays, 7);
  await w.ok('PUR', 'reorder.set', { code: 'BUY-BOLT', leadDays: 12, supplier: 'SUP-A' });
  sg = row(await w.state(), 'BUY-BOLT');
  assert.deepEqual([sg.supplier, sg.leadDays, sg.buyUnit], ['SUP-A', 12, 'กล่อง']);
  // TST-001 has an item unit โหล = 12: the buy unit takes it, a different factor is refused
  await w.ok('PUR', 'itemSupplier.upsert', { code: 'TST-001', supplier: 'SUP-A', buyUnit: 'โหล', price: 100 });
  s = await w.state();
  assert.equal(s.tables.item_suppliers['TST-001|SUP-A'].factor, 12);
});

test('ข้อมูลผิดถูกปฏิเสธและไม่เปลี่ยนอะไร', async () => {
  const w = await buyWorld();
  await w.ok('PUR', 'supplier.upsert', { id: 'SUP-OFF', name: 'ผู้ขายเลิกใช้', active: false });
  const draft = await w.ok('PUR', 'po.create', { supplier: 'SUP-A', lines: [bolt(2)] });
  const issued = await issuedPo(w, [bolt(2)]);
  let s = await w.state();
  const seq = s.seq;
  const bad = [
    ['PUR', 'supplier.upsert', { id: '', name: 'x' }, 'REQUIRED'],
    ['PUR', 'supplier.upsert', { id: 'S 1?', name: 'x' }, 'BAD_CODE'],
    ['PUR', 'supplier.upsert', { id: 'SUP-N' }, 'REQUIRED'],
    ['PUR', 'supplier.upsert', { id: 'SUP-N', name: 'x', taxId: '12345' }, 'BAD_VALUE'],
    ['PUR', 'supplier.upsert', { id: 'SUP-N', name: 'x', leadDays: -1 }, 'BAD_VALUE'],
    ['PUR', 'supplier.upsert', { id: 'SUP-N', name: 'x', leadDays: 1.5 }, 'BAD_VALUE'],
    ['PUR', 'itemSupplier.upsert', { code: 'NO-SUCH', supplier: 'SUP-A' }, 'NOT_FOUND'],
    ['PUR', 'itemSupplier.upsert', { code: 'BUY-BOLT', supplier: 'NOPE' }, 'NOT_FOUND'],
    ['PUR', 'itemSupplier.upsert', { code: 'BUY-BOLT', supplier: 'SUP-B', buyUnit: 'ลัง' }, 'NO_UNIT'],
    ['PUR', 'itemSupplier.upsert', { code: 'TST-001', supplier: 'SUP-B', buyUnit: 'โหล', factor: 10 }, 'UNIT_CONFLICT'],
    ['PUR', 'itemSupplier.upsert', { code: 'BUY-BOLT', supplier: 'SUP-B', price: -5 }, 'BAD_VALUE'],
    ['PUR', 'itemSupplier.upsert', { code: 'BUY-BOLT', supplier: 'SUP-OFF', preferred: true }, 'BAD_VALUE'],
    ['PUR', 'reorder.set', { code: 'BUY-BOLT', min: 10, max: 5 }, 'BAD_VALUE'],
    ['PUR', 'reorder.set', { code: 'BUY-BOLT', wh: 'Z' }, 'NOT_FOUND'],
    ['STORE1', 'pr.create', { lines: [] }, 'REQUIRED'],
    ['STORE1', 'pr.create', { lines: [{ code: 'BUY-BOLT', qty: -1, needDate: day(3), wh: 'A' }] }, 'BAD_QTY'],
    ['STORE1', 'pr.create', { lines: [{ code: 'BUY-BOLT', qty: 1, needDate: '2026-02-30', wh: 'A' }] }, 'BAD_DATE'],
    ['STORE1', 'pr.create', { lines: [{ code: 'BUY-BOLT', qty: 1, needDate: day(3) }] }, 'REQUIRED'],
    ['STORE1', 'pr.create', { lines: [{ code: 'BUY-BOLT', qty: 1, needDate: day(3), wh: 'A', supplier: 'NOPE' }] }, 'NOT_FOUND'],
    ['PUR', 'po.create', { supplier: 'NOPE', lines: [bolt(2)] }, 'NOT_FOUND'],
    ['PUR', 'po.create', { supplier: 'SUP-OFF', lines: [bolt(2)] }, 'INACTIVE'],
    ['PUR', 'po.create', { supplier: 'SUP-A', lines: [] }, 'REQUIRED'],
    ['PUR', 'po.create', { supplier: 'SUP-A', lines: [bolt(2), { code: 'NO-SUCH', qty: 1, dueDate: day(3), wh: 'A' }] }, 'NOT_FOUND'],
    ['PUR', 'po.create', { supplier: 'SUP-A', lines: [bolt(0)] }, 'BAD_QTY'],
    ['PUR', 'po.create', { supplier: 'SUP-A', lines: [bolt('abc')] }, 'BAD_QTY'],
    ['PUR', 'po.create', { supplier: 'SUP-A', lines: [bolt(2, '2026-13-01')] }, 'BAD_DATE'],
    ['PUR', 'po.create', { supplier: 'SUP-A', lines: [bolt(2, day(-1))] }, 'BAD_DATE'],
    ['PUR', 'po.create', { supplier: 'SUP-A', lines: [bolt(2, day(3), { unit: 'ลัง' })] }, 'NO_UNIT'],
    ['PUR', 'po.create', { supplier: 'SUP-A', lines: [bolt(2, day(3), { wh: 'Z' })] }, 'NOT_FOUND'],
    ['PUR', 'po.create', { supplier: 'SUP-A', lines: [bolt(2, '')] }, 'REQUIRED'],
    ['PUR', 'po.create', { supplier: 'SUP-B', lines: [{ code: 'TST-002', qty: 5, dueDate: day(3), wh: 'A' }] }, 'PRICE_REQUIRED'],
    ['PUR', 'po.create', { supplier: 'SUP-A', lines: [bolt(2, day(3), { unit: 'ตัว' })] }, 'PRICE_REQUIRED'],
    ['PUR', 'po.create', { supplier: 'SUP-A', prNos: ['PR6911-9999'] }, 'NOT_FOUND'],
    ['PUR', 'po.issue', { poNo: issued }, 'BAD_STATE'],
    ['PUR', 'po.setDue', { poNo: issued, line: 1, dueDate: 'พรุ่งนี้', reason: 'เลื่อน' }, 'BAD_DATE'],
    ['PUR', 'po.cancelLine', { poNo: issued, line: 9, reason: 'ไม่มี' }, 'NOT_FOUND'],
    ['STORE1', 'po.receive', { poNo: draft.result.poNo, lines: [{ line: 1, qty: 1, bin: 'A-01' }] }, 'BAD_STATE'],
    ['STORE1', 'po.receive', { poNo: 'PO6911-9999', lines: [{ line: 1, qty: 1, bin: 'A-01' }] }, 'NOT_FOUND'],
    ['STORE1', 'po.receive', { poNo: issued, lines: [{ line: 9, qty: 1, bin: 'A-01' }] }, 'NOT_FOUND'],
    ['STORE1', 'po.receive', { poNo: issued, lines: [{ line: 1, qty: 'x', bin: 'A-01' }] }, 'BAD_QTY'],
    ['STORE1', 'po.receive', { poNo: issued, lines: [] }, 'REQUIRED'],
    ['STORE1', 'po.receive', { poNo: issued, lines: [{ line: 1, qty: 1, bin: 'NOPE' }] }, 'NOT_FOUND'],
    ['STORE1', 'doc.post', { type: 'RR', lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01', poNo: issued, poLine: 1 }] }, 'WRONG_ITEM'],
    ['STORE1', 'doc.post', { type: 'RR', lines: [{ code: 'BUY-BOLT', qty: 1, wh: 'A', bin: 'A-01', poNo: 'PO6911-9999', poLine: 1 }] }, 'NOT_FOUND'],
    ['STORE1', 'doc.post', { type: 'RR', lines: [{ code: 'BUY-BOLT', qty: 1, wh: 'A', bin: 'A-01', poNo: issued }] }, 'REQUIRED'],
    ['STORE1', 'doc.post', { type: 'RR', lines: [{ code: 'BUY-BOLT', qty: 1, wh: 'A', bin: 'A-01', poNo: draft.result.poNo, poLine: 1 }] }, 'BAD_STATE'],
    ['STORE1', 'doc.post', { type: 'RV', lines: [{ code: 'BUY-BOLT', qty: 1, wh: 'A', bin: 'A-01', poNo: draft.result.poNo, poLine: 1 }] }, 'BAD_STATE'],
  ];
  for (const [user, kind, payload, code] of bad) {
    const r = await w.exec(user, kind, payload);
    assert.equal(r.ok, false, `${kind} ${JSON.stringify(payload)} should fail`);
    assert.equal(r.errors[0].code, code, `${kind} ${JSON.stringify(payload)}: ${JSON.stringify(r.errors)}`);
  }
  // a bad second line points at line 2 and keeps the first one out too
  const two = await w.exec('PUR', 'po.create', { supplier: 'SUP-A', lines: [bolt(2), bolt(2, day(3), { unit: 'ลัง' })] });
  assert.equal(two.errors[0].line, 2);
  s = await w.state();
  assert.equal(s.seq, seq, 'nothing was saved');
  assert.throws(() => P().suggest(s, {}), /today/);
  assert.deepEqual(P().outstanding(s, { today: TODAY, code: 'NO-SUCH' }), []);
});

// ---------------------------------------------------------------------------------------------------------------
// read helpers: usage, demand / reservations, per-warehouse, affected jobs
// ---------------------------------------------------------------------------------------------------------------
test('สถิติยอดใช้: นับ PD/OU ในช่วงวัน ไม่นับเอกสารที่ยกเลิก และใช้ตั้ง Min/Max เมื่อไม่ได้ตั้ง', async () => {
  const w = await buyWorld();
  await w.ok('LEAD', 'item.upsert', { code: 'BUY-USE', name: 'วัสดุสิ้นเปลืองทดสอบ', baseUnit: 'ชิ้น', type: 'CONS' });
  await stockIn(w, 'BUY-USE', 'A', 'A-01', 100);
  const out = (type, date, q) => w.ok('STORE1', 'doc.post', { type, date, lines: [{ code: 'BUY-USE', qty: q, wh: 'A', bin: 'A-01' }] });
  await out('PD', '2026-10-20', 10);
  await out('OU', '2026-10-25', 5);
  const wrong = await out('PD', '2026-10-28', 7);
  await w.ok('LEAD', 'doc.cancel', { docNo: wrong.result.docNo, reason: 'เบิกผิด' });
  await out('PD', '2026-09-01', 50);
  const s = await w.state();
  const u30 = P().usage(s, 'BUY-USE', { today: TODAY, days: 30 });
  const sd30 = Math.sqrt(((10 - 0.5) ** 2 + (5 - 0.5) ** 2 + 28 * 0.25) / 30);
  assert.deepEqual([u30.total, u30.avgDay, u30.sd, u30.activeDays, u30.from], [15, 0.5, RRS.util.round(sd30, 4), 2, '2026-10-04']);
  assert.equal(P().usage(s, 'BUY-USE', { today: TODAY, days: 30, wh: 'B' }).total, 0);
  const u90 = P().usage(s, 'BUY-USE', { today: TODAY });
  assert.deepEqual([u90.days, u90.total], [90, 65]);
  // no Min/Max on the item: taken from usage, z = 1.65, Max = Min + 14 days
  let r = row(s, 'BUY-USE');
  const min = Math.ceil(u90.avgDay * 7 + 1.65 * u90.sd * Math.sqrt(7));
  assert.deepEqual([r.usage.total, r.min, r.max, r.available], [65, min, Math.ceil(min + u90.avgDay * 14), 35]);
  assert.match(r.minMaxFrom, /สถิติยอดใช้ 90 วัน/);
  // a rule may use a shorter window
  await w.ok('PUR', 'reorder.set', { code: 'BUY-USE', usageDays: 30 });
  r = row(await w.state(), 'BUY-USE');
  const min30 = Math.ceil(0.5 * 7 + 1.65 * u30.sd * Math.sqrt(7));
  assert.deepEqual([r.min, r.max], [min30, Math.ceil(min30 + 0.5 * 14)]);
  // no history and no Min/Max → nothing to suggest
  const none = row(s, 'TST-002');
  assert.deepEqual([none.min, none.max, none.orderQty], [0, 0, 0]);
  assert.match(none.minMaxFrom, /ไม่มีประวัติ/);
});

test('แนะนำสั่งซื้อหักของจองและความต้องการใบงาน; เตือนงานที่ได้รับผลกระทบเมื่อ PO ล่าช้า', async () => {
  const w = await buyWorld();
  await stockIn(w, 'BUY-BOLT', 'A', 'A-01', 150);
  const poNo = await issuedPo(w, [bolt(2, day(4))]); // 100
  const later = await issuedPo(w, [bolt(2, day(9))], 'SUP-A');
  // jobs and reservations belong to the planning module (Phase 2): put rows in a copy of the state
  const s = structuredClone(await w.state());
  s.tables.jobs = {
    'JB-1': { jobNo: 'JB-1', soNo: 'SO-1', status: 'OPEN', dueDate: day(6), priority: 2, lines: [{ line: 1, code: 'BUY-BOLT', required: 120, issued: 20 }] },
    'JB-2': { jobNo: 'JB-2', soNo: 'SO-2', status: 'IN_PROGRESS', dueDate: day(8), priority: 1, lines: [{ line: 1, code: 'BUY-BOLT', required: 50, issued: 0 }] },
    'JB-3': { jobNo: 'JB-3', soNo: 'SO-3', status: 'DONE', dueDate: day(1), priority: 1, lines: [{ line: 1, code: 'BUY-BOLT', required: 999, issued: 0 }] },
  };
  s.tables.reservations = {
    'RS-00001': { id: 'RS-00001', jobNo: 'JB-1', code: 'BUY-BOLT', wh: 'A', qty: 40, issued: 0, status: 'OPEN', needDate: day(6), priority: 2 },
    'RS-00002': { id: 'RS-00002', jobNo: 'JB-2', code: 'BUY-BOLT', wh: 'A', qty: 30, issued: 30, status: 'FILLED', needDate: day(8), priority: 1 },
  };
  const r = row(s, 'BUY-BOLT');
  // free 150 − 40 = 110, sure 100 (the PO due on day 9 is after the 7-day lead), uncovered demand 60 + 50 = 110
  assert.deepEqual([r.reserved, r.free, r.incomingSure, r.incomingLater, r.demandTotal, r.demand, r.projected], [40, 110, 100, 100, 150, 110, 100]);
  assert.deepEqual([r.need, r.orderBuyQty, r.orderQty], [200, 4, 200]);
  assert.ok(has(r.reasons, /ใบงานเปิดยังต้องใช้ 150 ตัว/));
  // nothing is late today
  assert.deepEqual(P().affectedJobs(s, { today: TODAY }), []);
  // ... but the day-9 PO arrives after both jobs need it
  const risk = P().affectedJobs(s, { today: TODAY, atRisk: true });
  assert.deepEqual(risk.map((x) => [x.poNo, x.jobs.map((j) => j.jobNo)]), [[later, ['JB-2', 'JB-1']]]);
  // seen on day 10 both PO lines are late; the jobs that still need the item are listed (highest priority first)
  const hit = P().affectedJobs(s, { today: day(10) });
  assert.deepEqual(hit.map((x) => [x.poNo, x.daysLate]), [[poNo, 6], [later, 1]]);
  assert.deepEqual(hit[0].jobs.map((j) => [j.jobNo, j.need, j.reserved, j.uncovered, j.affected]), [['JB-2', 50, 0, 50, true], ['JB-1', 100, 40, 60, true]]);
  assert.deepEqual(hit[0].reservations.map((x) => [x.id, x.remaining]), [['RS-00001', 40]]);
  assert.match(hit[0].message, /เลยกำหนด 6 วัน/);
  assert.match(hit[0].message, /JB-2/);
});

test('แนะนำสั่งซื้อรายคลัง: เงื่อนไขของคลัง, PO ของคลังอื่นไม่นับ, ของระหว่างโอนเข้าคลังนับ, ปิดการแนะนำได้', async () => {
  const w = await buyWorld();
  await stockIn(w, 'BUY-BOLT', 'A', 'A-01', 40);
  await stockIn(w, 'BUY-BOLT', 'B', 'B-01', 500);
  await issuedPo(w, [bolt(6, day(3), { wh: 'B' })]);
  await w.ok('PUR', 'reorder.set', { code: 'BUY-BOLT', wh: 'A', min: 50, max: 80 });
  let s = await w.state();
  let a = row(s, 'BUY-BOLT', { wh: 'A' });
  assert.deepEqual([a.wh, a.available, a.incomingSure, a.min, a.max, a.projected, a.orderQty, a.orderBuyQty], ['A', 40, 0, 50, 80, 40, 100, 2]);
  assert.match(a.minMaxFrom, /คลัง A/);
  const b = row(s, 'BUY-BOLT', { wh: 'B' });
  assert.deepEqual([b.available, b.incomingSure, b.min, b.max, b.orderQty], [500, 300, 100, 300, 0]);
  const all = row(s, 'BUY-BOLT');
  assert.deepEqual([all.available, all.incomingSure, all.orderQty], [540, 300, 0]);
  // stock moving B → A counts for A while in transit
  await w.ok('STORE1', 'doc.post', { type: 'TR', lines: [{ code: 'BUY-BOLT', qty: 30, wh: 'B', bin: 'B-01', toWh: 'A', toBin: 'A-01' }] });
  s = await w.state();
  a = row(s, 'BUY-BOLT', { wh: 'A' });
  assert.deepEqual([a.transit, a.projected, a.orderQty], [30, 70, 0]);
  assert.equal(row(s, 'BUY-BOLT', { wh: 'B' }).transit, 0);
  // a rule may switch suggestions off
  await w.ok('PUR', 'reorder.set', { code: 'BUY-BOLT', wh: 'A', min: 500, max: 900, active: false });
  a = row(await w.state(), 'BUY-BOLT', { wh: 'A' });
  assert.deepEqual([a.status, a.orderQty], ['OFF', 0]);
  assert.ok(P().suggest(await w.state(), { today: TODAY, onlyOrder: true }).every((x) => x.orderQty > 0));
});

test('ตารางของ Phase 4 อยู่ในพจนานุกรมข้อมูลพร้อมชื่อภาษาไทย และเอกสาร RV ถูกเพิ่ม', () => {
  for (const t of ['suppliers', 'item_suppliers', 'reorder_rules', 'prs', 'pos']) {
    const def = RRS.schema.tables[t];
    assert.ok(def, t);
    assert.equal(def.phase, 4);
    assert.ok(def.fields.length >= 5 && def.fields.every((f) => /[฀-๿]/.test(f.label)), t);
  }
  assert.deepEqual(RRS.schema.tables.item_suppliers.key, ['code', 'supplier']);
  const rv = RRS.inventory.DOC_TYPES.RV;
  assert.deepEqual([rv.name, rv.dir, rv.express, rv.outStatuses], ['คืนสินค้าผู้ขาย', -1, false, ['AVAILABLE', 'QUARANTINE', 'REWORK']]);
});
