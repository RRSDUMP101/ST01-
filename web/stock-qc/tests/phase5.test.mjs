// Phase 5 – ล็อต คุณภาพ และการกักกัน เชื่อม RRS QC (plan file 01): acceptance criteria + permissions, separation of
// duties, cancel/undo and bad input. Uses only core/master/inventory commands and the quality module's commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RRS, world, stockIn } from './helpers.mjs';

const Q = RRS.quality;
const qty = (s, f) => RRS.q.qty(s, f);
const codeOf = (r) => (r.ok ? 'OK' : r.errors[0].code);
const codesOf = (r) => (r.ok ? [] : r.errors.map((e) => e.code));
const docsOf = (s, type) => Object.values(s.tables.documents || {}).filter((d) => d.type === type);

const PLATE_CHARS = [
  { name: 'ความหนา', kind: 'measure', nominal: 3, min: 2.8, max: 3.2, unit: 'มม.', method: 'ไมโครมิเตอร์' },
  { name: 'ผิว', kind: 'check', method: 'ดูด้วยตา' },
];
const plateOk = [{ char: 'ความหนา', value: 3.01 }, { char: 'ผิว', value: 'ผ่าน' }];
const plateBad = [{ char: 'ความหนา', value: 2.5 }, { char: 'ผิว', value: 'ผ่าน' }];
const FG_CHARS = [
  { name: 'ความกว้างรวม', kind: 'measure', nominal: 1500, min: 1490, max: 1510, unit: 'มม.' },
  { name: 'สี/ผิว', kind: 'check' },
];
const fgOk = [{ char: 'C1', value: 1500 }, { char: 'สี/ผิว', value: 'OK' }];
const fgBad = [{ char: 'C1', value: 1520 }, { char: 'สี/ผิว', value: 'OK' }];
const PHOTO = [{ name: 'หน้างาน', url: 'https://files.example.invalid/qc/p1.jpg' }];
// Tests may not create purchase orders (Phase 4 commands). When the purchasing module is loaded it refuses a PO number
// it does not know, so the PO reference is only exercised without it (it is then kept as a plain reference).
const HAS_PO = !!RRS.schema.tables.pos;
const withPo = (poNo) => (HAS_PO ? {} : { poNo, poLine: 1 });
const poOf = (poNo) => (HAS_PO ? '' : poNo);

/** Plan saved by ENG and approved by QCLEAD (two people). */
async function approvedPlan(w, code, stage, chars, extra = {}) {
  const r = await w.ok('ENG', 'qc.plan.save', { code, stage, drawingRev: '', sourceRef: 'WI-QC-01', sampling: '100%', chars, ...extra });
  await w.ok('QCLEAD', 'qc.plan.approve', { id: r.result.id });
  return r.result.id;
}
/** Receipt of plates (qcIncoming → รอตรวจ) by the store lead. */
async function receivePlate(w, lot, n, extra = {}) {
  const r = await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'TST-PLATE', qty: n, wh: 'A', bin: 'A-01', lot, ...extra }] });
  return r.result.docNo;
}
async function certVerified(w, lot, no = 'MTC-' + lot) {
  await w.ok('STORE1', 'lot.update', { code: 'TST-PLATE', lot, cert: { no, file: 'https://files.example.invalid/cert.pdf' } });
  await w.ok('QC1', 'lot.verifyCert', { code: 'TST-PLATE', lot });
}
function inspectPlate(w, planId, lot, n, results, extra = {}, user = 'QC1') {
  return w.exec(user, 'qc.inspect', { stage: 'INCOMING', code: 'TST-PLATE', wh: 'A', bin: 'A-01', lot, qty: n, planId, results,
    photos: PHOTO, ...extra });
}
/** Plates of `lot` received, cert verified, inspected and released → AVAILABLE. */
async function platesReady(w, planId, lot, n, extra = {}) {
  const rr = await receivePlate(w, lot, n, extra);
  await certVerified(w, lot);
  const i = await inspectPlate(w, planId, lot, n, plateOk, { sourceDoc: rr });
  assert.equal(i.ok, true, JSON.stringify(i.errors));
  await w.ok('QCLEAD', 'qc.release', { id: i.result.id });
  return rr;
}

// ---------------------------------------------------------------------------------------------------------------
// acceptance criteria
// ---------------------------------------------------------------------------------------------------------------
test('ค้น Heat/Lot แล้วพบใบรับและงานที่ใช้', async () => {
  const w = await world();
  const platePlan = await approvedPlan(w, 'TST-PLATE', 'INCOMING', PLATE_CHARS);
  const fgPlan = await approvedPlan(w, 'TST-FG', 'FINAL', FG_CHARS);
  const rr = await platesReady(w, platePlan, 'HT-7788', 10, withPo('PO-TEST-1'));
  await receivePlate(w, 'HT-9999', 2); // another heat – must not show up
  const pd1 = (await w.ok('STORE1', 'doc.post', { type: 'PD', job: 'JOB-01', lines: [{ code: 'TST-PLATE', qty: 4, wh: 'A', bin: 'A-01', lot: 'HT-7788' }] })).result.docNo;
  const pd2 = (await w.ok('STORE1', 'doc.post', { type: 'PD', job: 'JOB-02', lines: [{ code: 'TST-PLATE', qty: 3, wh: 'A', bin: 'A-01', lot: 'HT-7788' }] })).result.docNo;
  const rt = (await w.ok('STORE1', 'doc.post', { type: 'RT', job: 'JOB-01', lines: [{ code: 'TST-PLATE', qty: 1, wh: 'A', bin: 'A-01', lot: 'HT-7788' }] })).result.docNo;
  const fr = (await w.ok('LEAD', 'doc.post', { type: 'FR', job: 'JOB-01', lines: [{ code: 'TST-FG', qty: 1, wh: 'A', bin: 'A-01' }] })).result.docNo;
  const fi = await w.ok('QC1', 'qc.inspect', { stage: 'FINAL', code: 'TST-FG', wh: 'A', bin: 'A-01', qty: 1, sourceDoc: fr, planId: fgPlan, results: fgOk, photos: PHOTO });
  await w.ok('QCLEAD', 'qc.release', { id: fi.result.id });
  const dl = (await w.ok('STORE1', 'doc.post', { type: 'DL', job: 'JOB-01', lines: [{ code: 'TST-FG', qty: 1, wh: 'A', bin: 'A-01' }] })).result.docNo;

  const s = await w.state();
  // search by the heat number alone (spaces/dashes/case ignored)
  const found = Q.findLots(s, 'ht 7788');
  assert.deepEqual(found.map((l) => l.code + ' ' + l.lot), ['TST-PLATE HT-7788']);
  const t = Q.trace(s, { lot: 'HT-7788' });
  assert.equal(t.lot.code, 'TST-PLATE');
  assert.equal(t.lot.kind, 'heat');
  assert.equal(t.lot.docNo, rr);
  assert.equal(t.lot.poNo, poOf('PO-TEST-1'));
  assert.equal(t.lot.cert.verified, true);
  assert.deepEqual(t.receipts.map((e) => e.docNo), [rr, rt]);
  assert.equal(t.receipts[0].poNo, poOf('PO-TEST-1'));
  assert.equal(t.receipts[0].qty, 10);
  assert.deepEqual(t.issues.map((e) => [e.docNo, e.job, e.qty]), [[pd1, 'JOB-01', 4], [pd2, 'JOB-02', 3]]);
  assert.deepEqual(t.jobs, ['JOB-01', 'JOB-02']);
  assert.deepEqual(t.outputs.map((e) => e.docNo), [fr]);
  assert.deepEqual(t.deliveries.map((e) => e.docNo), [dl]);
  assert.equal(t.inspections.length, 1);
  assert.equal(t.inspections[0].result, 'PASS');
  assert.ok(t.statusChanges.length >= 1, 'the release is a QS document in the history');
  assert.ok(!JSON.stringify(t).includes('HT-9999'));
  // with the item code too
  assert.equal(Q.trace(s, { code: 'tst plate', lot: 'HT-7788' }).receipts.length, 2);
  // back from the job: lots consumed, receipts with PO and cert
  const j = Q.traceJob(s, 'job-01');
  assert.equal(j.lots.length, 1);
  assert.deepEqual([j.lots[0].code, j.lots[0].lot, j.lots[0].issued, j.lots[0].returned, j.lots[0].qty], ['TST-PLATE', 'HT-7788', 4, 1, 3]);
  assert.deepEqual(j.lots[0].receipts.map((x) => [x.docNo, x.poNo]), [[rr, poOf('PO-TEST-1')]]);
  assert.equal(j.lots[0].cert.no, 'MTC-HT-7788');
  assert.equal(j.lots[0].cert.verified, true);
  assert.deepEqual(j.outputs.map((e) => e.docNo), [fr]);
  assert.deepEqual(j.deliveries.map((e) => e.docNo), [dl]);
  assert.equal(j.inspections[0].jobNo, 'JOB-01', 'the FINAL inspection took the job from its FR');
  assert.deepEqual(Q.traceJob(s, 'JOB-02').lots.map((l) => l.qty), [3]);
});

test('กักล็อตแล้วทุกช่องทางเบิกถูกบล็อก', async () => {
  const w = await world();
  const plan = await approvedPlan(w, 'TST-PLATE', 'INCOMING', PLATE_CHARS);
  await stockIn(w, 'TST-PLATE', 'A', 'A-01', 10, { lot: 'H1', status: 'AVAILABLE' });
  await stockIn(w, 'TST-PLATE', 'B', 'B-01', 5, { lot: 'H1', status: 'AVAILABLE' });
  const tr = (await w.ok('STORE1', 'doc.post', { type: 'TR', lines: [{ code: 'TST-PLATE', qty: 2, wh: 'B', bin: 'B-01', lot: 'H1', toWh: 'A', toBin: 'A-02' }] })).result.docNo;
  const rr = (await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'TST-PLATE', qty: 4, wh: 'A', bin: 'A-02', lot: 'H1' }] })).result.docNo;
  const open = await w.ok('QC1', 'qc.inspect', { stage: 'INCOMING', code: 'TST-PLATE', wh: 'A', bin: 'A-02', lot: 'H1', qty: 4, planId: plan, results: plateOk, sourceDoc: rr });
  await stockIn(w, 'TST-PLATE', 'A', 'A-01', 3, { lot: 'H2', status: 'AVAILABLE' }); // another heat stays usable

  const q = await w.ok('QC1', 'lot.quarantine', { code: 'TST-PLATE', lot: 'H1', reason: 'ใบรับรองไม่ตรงกับ heat ที่ตอกบนแผ่น' });
  let s = await w.state();
  assert.equal(q.result.moved, 17);
  assert.equal(q.result.inTransit, 2);
  assert.ok(q.warnings.some((x) => x.includes('ระหว่างโอน')));
  assert.equal(qty(s, { code: 'TST-PLATE', lot: 'H1', status: 'QC_HOLD' }), 0);
  assert.equal(qty(s, { code: 'TST-PLATE', lot: 'H1', status: 'QUARANTINE' }), 17);
  assert.equal(qty(s, { code: 'TST-PLATE', lot: 'H1' }), 19, 'the stock is still where it is – only its status changed');
  assert.equal(qty(s, { code: 'TST-PLATE', lot: 'H2', status: 'AVAILABLE' }), 3);
  const qs = s.tables.documents[q.result.docNo];
  assert.equal(qs.type, 'QS');
  assert.equal(qs.lines.length, 3);
  assert.equal(RRS.inventory.history(s, { docNo: qs.docNo }).length, 6, 'a pair of movements per status change');
  assert.equal(s.tables.lots['TST-PLATE|H1'].status, 'QUARANTINED');
  assert.equal(s.tables.lots['TST-PLATE|H1'].quarantinedBy, 'QC1');
  assert.equal(s.tables.inspections[open.result.id].status, 'VOID', 'the PASS waiting for release must be inspected again');
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
  // the transfer in transit lands in quarantine (transfer.receiveLine hook) – nothing is left for a sweep
  const rec = await w.ok('STORE2', 'transfer.receive', { docNo: tr });
  assert.ok(rec.warnings.some((x) => x.includes('กักกัน')));
  assert.equal(codeOf(await w.exec('STORE1', 'doc.post', { type: 'PD', lines: [{ code: 'TST-PLATE', qty: 1, wh: 'A', bin: 'A-02', lot: 'H1' }] })), 'LOT_QUARANTINED');
  assert.equal(codeOf(await w.exec('QC1', 'lot.quarantine', { code: 'TST-PLATE', lot: 'H1', reason: 'ซ้ำ' })), 'ALREADY');
  s = await w.state();
  assert.equal(qty(s, { code: 'TST-PLATE', lot: 'H1', status: 'AVAILABLE' }), 0);
  assert.equal(qty(s, { code: 'TST-PLATE', lot: 'H1', status: 'QUARANTINE' }), 19);
  assert.deepEqual(s.tables.lots['TST-PLATE|H1'].history.map((h) => h.action).filter((a) => a !== 'RECEIVE'), ['QUARANTINE']);
  assert.equal(s.tables.lots['TST-PLATE|H1'].quarantinedBy, 'QC1');

  const seq = s.seq;
  const line = (extra = {}) => ({ code: 'TST-PLATE', qty: 1, wh: 'A', bin: 'A-01', lot: 'H1', ...extra });
  // direct posting of every outgoing type
  for (const [user, type, l] of [
    ['STORE1', 'PD', line()], ['STORE1', 'OU', line()], ['STORE1', 'DL', line()],
    ['STORE1', 'TR', line({ toWh: 'B', toBin: 'B-01' })], ['LEAD', 'AJ', line({ qty: -1 })], ['STORE1', 'PD', line({ wh: 'B', bin: 'B-01' })],
  ]) {
    const r = await w.exec(user, 'doc.post', { type, job: 'JOB-X', lines: [l] });
    assert.equal(codeOf(r), 'LOT_QUARANTINED', type);
  }
  // asking for the quarantined status itself is refused too
  const asQ = await w.exec('STORE1', 'doc.post', { type: 'PD', lines: [line({ status: 'QUARANTINE' })] });
  assert.equal(asQ.ok, false);
  // draft → post
  const draft = await w.ok('STORE1', 'doc.saveDraft', { type: 'PD', job: 'JOB-X', lines: [line()] });
  assert.equal(codeOf(await w.exec('STORE1', 'doc.post', { docNo: draft.result.docNo })), 'LOT_QUARANTINED');
  // approved negative-stock exception
  await w.ok('ADMIN', 'settings.update', { patch: { policies: { negativeStock: 'approve' } } });
  const ov = await w.ok('STORE1', 'doc.saveDraft', { type: 'OU', lines: [line({ qty: 50 })] });
  await w.ok('STORE1', 'doc.requestOverride', { docNo: ov.result.docNo, reason: 'ของจริงมีมากกว่าในระบบ' });
  assert.equal(codeOf(await w.exec('LEAD', 'doc.approveOverride', { docNo: ov.result.docNo })), 'LOT_QUARANTINED');
  // inspecting / releasing the quarantined stock is refused as well
  assert.equal(codeOf(await inspectPlate(w, plan, 'H1', 1, plateOk, { fromStatus: 'QUARANTINE' })), 'BAD_STATUS');
  assert.equal(codeOf(await w.exec('QCLEAD', 'qc.release', { id: open.result.id })), 'BAD_STATE');
  // a direct scrap of quarantined stock needs an NCR decision
  assert.equal(codeOf(await w.exec('LEAD', 'doc.post', { type: 'SC', remark: 'เสีย', lines: [line({ status: 'QUARANTINE' })] })), 'NCR_REQUIRED');
  s = await w.state();
  assert.equal(s.seq, seq + 4, 'only the two drafts, the policy change and the exception request were saved');
  assert.equal(qty(s, { code: 'TST-PLATE', lot: 'H1', status: 'QUARANTINE' }), 19);

  // a new receipt of the quarantined heat lands in quarantine
  const again = await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'TST-PLATE', qty: 2, wh: 'B', bin: 'B-01', lot: 'H1' }] });
  assert.ok(again.warnings.some((x) => x.includes('กักกัน')));
  s = await w.state();
  assert.equal(qty(s, { code: 'TST-PLATE', lot: 'H1', status: 'QUARANTINE' }), 21);
  assert.equal(qty(s, { code: 'TST-PLATE', lot: 'H1', status: 'QC_HOLD' }), 0);
  // the way out for a quarantined lot: an NCR decided SCRAP / RETURN (SC/RV are not blocked by the lot)
  const ncr = await w.ok('QC1', 'ncr.open', { code: 'TST-PLATE', wh: 'B', bin: 'B-01', lot: 'H1', qty: 2, defect: 'heat ไม่ตรงใบรับรอง' });
  const sc = await w.ok('QCLEAD', 'ncr.disposition', { ncrNo: ncr.result.ncrNo, disposition: 'SCRAP', reason: 'ไม่มีใบรับรองที่ถูกต้อง' });
  assert.equal(sc.result.docType, 'SC');
  s = await w.state();
  assert.equal(qty(s, { code: 'TST-PLATE', lot: 'H1' }), 19);
});

test('ผู้ไม่มีสิทธิ์ปล่อยผ่านไม่ได้', async () => {
  const w = await world();
  const plan = await approvedPlan(w, 'TST-PLATE', 'INCOMING', PLATE_CHARS);
  const rr = await receivePlate(w, 'L-REL', 6);
  const i = await w.ok('QC1', 'qc.inspect', { stage: 'INCOMING', code: 'TST-PLATE', wh: 'A', bin: 'A-01', lot: 'L-REL', qty: 6, planId: plan, results: plateOk, sourceDoc: rr });
  assert.equal(i.result.result, 'PASS');
  const id = i.result.id;
  let s = await w.state();
  assert.equal(s.tables.inspections[id].status, 'OPEN', 'ผ่านแล้ว ยังรออนุมัติปล่อย');
  assert.equal(qty(s, { code: 'TST-PLATE', status: 'QC_HOLD' }), 6);
  const seq = s.seq;
  for (const u of ['QC1', 'STORE1', 'LEAD', 'ENG', 'PROD', 'VIEW', 'GHOST']) {
    const r = await w.exec(u, 'qc.release', { id });
    assert.ok(['NO_PERMISSION', 'NO_USER'].includes(codeOf(r)), u + ' ' + codeOf(r));
  }
  // the QC lead is blocked until the material certificate is entered and verified by QC
  assert.equal(codeOf(await w.exec('QCLEAD', 'qc.release', { id })), 'CERT_MISSING');
  await w.ok('STORE1', 'lot.update', { code: 'TST-PLATE', lot: 'L-REL', cert: { no: 'MTC-1' } });
  assert.equal(codeOf(await w.exec('QCLEAD', 'qc.release', { id })), 'CERT_NOT_VERIFIED');
  assert.equal(codeOf(await w.exec('STORE1', 'lot.verifyCert', { code: 'TST-PLATE', lot: 'L-REL' })), 'NO_PERMISSION');
  await w.ok('QC1', 'lot.verifyCert', { code: 'TST-PLATE', lot: 'L-REL' });
  // a QC lead limited to warehouse B cannot release stock in A
  await w.ok('ADMIN', 'user.upsert', { id: 'QCB', name: 'หัวหน้า QC คลัง B', roles: ['qc_lead'], warehouses: ['B'] });
  assert.equal(codeOf(await w.exec('QCB', 'qc.release', { id })), 'NO_PERMISSION');
  // nobody can post a status change by hand, and QC_HOLD stock cannot be issued meanwhile
  // refused either by inventory (internal type, BAD_TYPE) or by the quality module's own check (QS_MANUAL)
  assert.ok(['BAD_TYPE', 'QS_MANUAL'].includes(codeOf(await w.exec('LEAD', 'doc.post', { type: 'QS', lines: [{ code: 'TST-PLATE', qty: 6, wh: 'A', bin: 'A-01', lot: 'L-REL' }] }))));
  assert.equal(codeOf(await w.exec('STORE1', 'doc.post', { type: 'PD', lines: [{ code: 'TST-PLATE', qty: 1, wh: 'A', bin: 'A-01', lot: 'L-REL' }] })), 'NOT_ENOUGH');
  s = await w.state();
  assert.equal(s.seq, seq + 3, 'only the cert, its verification and the new user were saved');
  assert.equal(qty(s, { code: 'TST-PLATE', status: 'QC_HOLD' }), 6);
  assert.equal(s.tables.inspections[id].status, 'OPEN');
  assert.deepEqual(Q.releaseCheck(s, id, 'QCLEAD'), []);
  assert.equal(Q.releaseCheck(s, id, 'QC1')[0].code, 'SAME_PERSON');

  const ok = await w.ok('QCLEAD', 'qc.release', { id });
  s = await w.state();
  assert.equal(qty(s, { code: 'TST-PLATE', status: 'AVAILABLE' }), 6);
  assert.equal(qty(s, { code: 'TST-PLATE', status: 'QC_HOLD' }), 0);
  const row = s.tables.inspections[id];
  assert.deepEqual([row.status, row.releasedBy, row.releasedQty], ['RELEASED', 'QCLEAD', 6]);
  assert.equal(s.tables.documents[ok.result.docNo].type, 'QS');
  assert.equal(codeOf(await w.exec('QCLEAD', 'qc.release', { id })), 'ALREADY_RELEASED');
  // a FAIL can never be released
  await receivePlate(w, 'L-BAD', 2);
  const bad = await inspectPlate(w, plan, 'L-BAD', 2, plateBad);
  assert.equal(codeOf(await w.exec('QCLEAD', 'qc.release', { id: bad.result.id })), 'NOT_PASS');
});

test('ตรวจซ้ำผูกผลเดิมและฉบับแบบถูกต้อง', async () => {
  const w = await world();
  await w.ok('ENG', 'item.upsert', { code: 'QC-BRK', name: 'ขายึดทดสอบ', baseUnit: 'ชิ้น', type: 'PART', trackLot: 'lot', qcIncoming: true,
    drawingNo: 'DWG-100', drawingRev: 'A' });
  const chars = [{ name: 'ความยาว', kind: 'measure', nominal: 100, min: 99.5, max: 100.5, unit: 'มม.' }, { name: 'รูเจาะ', kind: 'check' }];
  const planA = await approvedPlan(w, 'QC-BRK', 'INCOMING', chars, { drawingRev: 'A', sourceRef: 'DWG-100 rev A' });
  const insp = (lot, n, value, extra = {}) => w.exec('QC1', 'qc.inspect', { stage: 'INCOMING', code: 'QC-BRK', wh: 'A', bin: 'A-01', lot, qty: n,
    planId: planA, results: [{ char: 'ความยาว', value }, { char: 'รูเจาะ', value: true }], photos: PHOTO, ...extra });
  await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'QC-BRK', qty: 5, wh: 'A', bin: 'A-01', lot: 'L1' }] });
  const f = await insp('L1', 5, 101);
  assert.equal(f.result.result, 'FAIL');
  const ncrNo = f.result.ncrNo;
  let s = await w.state();
  assert.equal(s.tables.inspections[f.result.id].planRev, 'A');
  assert.equal(s.tables.inspections[f.result.id].status, 'NCR');
  assert.equal(s.tables.ncrs[ncrNo].status, 'OPEN');
  assert.equal(qty(s, { code: 'QC-BRK', status: 'QUARANTINE' }), 5);
  await w.ok('QCLEAD', 'ncr.disposition', { ncrNo, disposition: 'REWORK', reason: 'เจียความยาวให้ได้ตามแบบ' });
  s = await w.state();
  assert.equal(qty(s, { code: 'QC-BRK', status: 'REWORK' }), 5);
  assert.equal(codeOf(await w.exec('QCLEAD', 'ncr.close', { ncrNo })), 'REINSPECTION_PENDING');
  // a re-inspection must point at the earlier FAIL of the same item + lot
  assert.equal(codeOf(await insp('L1', 5, 100.1, { fromStatus: 'REWORK' })), 'REINSPECTION_REQUIRED');
  await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'QC-BRK', qty: 2, wh: 'A', bin: 'A-01', lot: 'L9' }] });
  const pass9 = await insp('L9', 2, 100);
  assert.equal(codeOf(await insp('L1', 5, 100.1, { fromStatus: 'REWORK', reinspectionOf: pass9.result.id })), 'NOT_FAIL');
  assert.equal(codeOf(await insp('L9', 2, 100.1, { fromStatus: 'REWORK', reinspectionOf: f.result.id })), 'REINSPECT_MISMATCH');
  const re = await insp('L1', 5, 100.1, { fromStatus: 'REWORK', reinspectionOf: ncrNo });
  assert.equal(re.result.result, 'PASS');
  s = await w.state();
  const r1 = s.tables.inspections[re.result.id];
  assert.deepEqual([r1.reinspectionOf, r1.reinspectionNcr, r1.planId, r1.planRev, r1.revChanged, r1.fromStatus],
    [f.result.id, ncrNo, planA, 'A', false, 'REWORK']);
  assert.deepEqual(s.tables.ncrs[ncrNo].reinspections.map((x) => [x.id, x.result]), [[re.result.id, 'PASS']]);
  await w.ok('QCLEAD', 'qc.release', { id: re.result.id });
  await w.ok('QCLEAD', 'ncr.close', { ncrNo, note: 'แก้แล้วผ่าน' });
  s = await w.state();
  assert.equal(qty(s, { code: 'QC-BRK', lot: 'L1', status: 'AVAILABLE' }), 5);
  assert.equal(s.tables.ncrs[ncrNo].status, 'CLOSED');

  // the drawing changes to rev B while lot L2 waits for its re-inspection
  await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'QC-BRK', qty: 3, wh: 'A', bin: 'A-01', lot: 'L2' }] });
  const f2 = await insp('L2', 3, 98);
  await w.ok('QCLEAD', 'ncr.disposition', { ncrNo: f2.result.ncrNo, disposition: 'REWORK', reason: 'เชื่อมต่อความยาว' });
  await w.ok('ENG', 'bom.upsert', { product: 'QC-BRK', rev: 'B', lines: [{ code: 'TST-PLATE', qty: 1 }] });
  await w.ok('ENG', 'bom.approve', { product: 'QC-BRK', rev: 'B' });
  s = await w.state();
  assert.equal(s.tables.items['QC-BRK'].drawingRev, 'B');
  assert.equal(Q.planFor(s, 'QC-BRK', 'INCOMING').stale, true);
  assert.equal(codeOf(await insp('L2', 3, 100, { fromStatus: 'REWORK', reinspectionOf: f2.result.id })), 'PLAN_REV_STALE');
  // a plan is approved only for the item's approved revision, by someone else than its maker
  const planC = (await w.ok('ENG', 'qc.plan.save', { code: 'QC-BRK', stage: 'INCOMING', drawingRev: 'C', sourceRef: 'DWG-100 rev C', chars })).result.id;
  assert.equal(codeOf(await w.exec('QCLEAD', 'qc.plan.approve', { id: planC })), 'REV_MISMATCH');
  const planB = (await w.ok('ENG', 'qc.plan.save', { code: 'QC-BRK', stage: 'INCOMING', drawingRev: 'B', sourceRef: 'DWG-100 rev B',
    chars: [{ name: 'ความยาว', kind: 'measure', nominal: 98, min: 97.5, max: 98.5, unit: 'มม.' }, { name: 'รูเจาะ', kind: 'check' }] })).result.id;
  assert.equal(codeOf(await w.exec('ENG', 'qc.plan.approve', { id: planB })), 'SAME_PERSON');
  await w.ok('QCLEAD', 'qc.plan.approve', { id: planB });
  s = await w.state();
  assert.deepEqual([s.tables.qc_plans[planA].status, s.tables.qc_plans[planA].replacedBy], ['OBSOLETE', planB]);
  assert.equal(Q.planFor(s, 'QC-BRK', 'INCOMING').id, planB);
  assert.equal(Q.planFor(s, 'QC-BRK', 'INCOMING').stale, false);
  assert.equal(codeOf(await insp('L2', 3, 98, { fromStatus: 'REWORK', reinspectionOf: f2.result.id })), 'PLAN_NOT_APPROVED');
  const re2 = await w.exec('QC1', 'qc.inspect', { stage: 'INCOMING', code: 'QC-BRK', wh: 'A', bin: 'A-01', lot: 'L2', qty: 3, fromStatus: 'REWORK',
    reinspectionOf: f2.result.id, planId: planB, results: [{ char: 'C1', value: 98 }, { char: 'C2', value: 'OK' }] });
  assert.equal(re2.ok, true, JSON.stringify(re2.errors));
  assert.ok(re2.warnings.some((x) => x.includes('ฉบับแบบเปลี่ยน')));
  s = await w.state();
  const r2 = s.tables.inspections[re2.result.id];
  assert.deepEqual([r2.result, r2.reinspectionOf, r2.planId, r2.planRev, r2.revChanged], ['PASS', f2.result.id, planB, 'B', true]);
  assert.equal(s.tables.inspections[f2.result.id].planRev, 'A', 'the original result keeps its revision');
});

test('ผลิตเสร็จยังไม่เท่ากับผ่าน QC', async () => {
  const w = await world();
  const finalPlan = await approvedPlan(w, 'TST-FG', 'FINAL', FG_CHARS);
  const fr = (await w.ok('LEAD', 'doc.post', { type: 'FR', job: 'JOB-9', lines: [{ code: 'TST-FG', qty: 2, wh: 'A', bin: 'A-01' }] })).result.docNo;
  let s = await w.state();
  assert.equal(qty(s, { code: 'TST-FG', status: 'QC_HOLD' }), 2);
  assert.equal(qty(s, { code: 'TST-FG', status: 'AVAILABLE' }), 0);
  const dl = (extra = {}) => w.exec('STORE1', 'doc.post', { type: 'DL', job: 'JOB-9', lines: [{ code: 'TST-FG', qty: 1, wh: 'A', bin: 'A-01', ...extra }] });
  assert.equal(codeOf(await dl()), 'NOT_ENOUGH');
  assert.equal(codeOf(await dl({ status: 'QC_HOLD' })), 'BAD_STATUS');
  // inspected and PASS – still not released
  const i = await w.ok('QC1', 'qc.inspect', { stage: 'FINAL', code: 'TST-FG', wh: 'A', bin: 'A-01', qty: 2, sourceDoc: fr, planId: finalPlan, results: fgOk, photos: PHOTO });
  s = await w.state();
  assert.equal(s.tables.inspections[i.result.id].jobNo, 'JOB-9');
  assert.equal(s.tables.inspections[i.result.id].status, 'OPEN');
  assert.equal(codeOf(await dl()), 'NOT_ENOUGH');
  const queue = Q.qcQueue(s, '2026-11-02');
  const qb = queue.balances.find((b) => b.code === 'TST-FG');
  assert.deepEqual([qb.status, qb.qty, qb.waitingRelease, qb.toInspect], ['QC_HOLD', 2, 2, 0]);
  // the same stock cannot be inspected twice while it waits for release
  assert.equal(codeOf(await w.exec('QC1', 'qc.inspect', { stage: 'FINAL', code: 'TST-FG', wh: 'A', bin: 'A-01', qty: 1, planId: finalPlan, results: fgOk })), 'NOT_ENOUGH');
  // release one: one can be delivered
  const r1 = await w.ok('QCLEAD', 'qc.release', { id: i.result.id, qty: 1 });
  assert.equal(r1.result.done, false);
  assert.equal((await dl()).ok, true);
  assert.equal(codeOf(await dl()), 'NOT_ENOUGH');
  await w.ok('QCLEAD', 'qc.release', { id: i.result.id });
  s = await w.state();
  assert.deepEqual([s.tables.inspections[i.result.id].status, s.tables.inspections[i.result.id].releasedQty,
    s.tables.inspections[i.result.id].releases.length], ['RELEASED', 2, 2]);
  assert.equal((await dl()).ok, true);
  // a FINAL fail goes to quarantine: delivery stays blocked
  const fr2 = (await w.ok('LEAD', 'doc.post', { type: 'FR', job: 'JOB-9', lines: [{ code: 'TST-FG', qty: 1, wh: 'A', bin: 'A-01' }] })).result.docNo;
  const bad = await w.ok('QC1', 'qc.inspect', { stage: 'FINAL', code: 'TST-FG', wh: 'A', bin: 'A-01', qty: 1, sourceDoc: fr2, planId: finalPlan, results: fgBad, photos: PHOTO });
  assert.ok(bad.result.ncrNo);
  s = await w.state();
  assert.equal(qty(s, { code: 'TST-FG', status: 'QUARANTINE' }), 1);
  assert.match(s.tables.ncrs[bad.result.ncrNo].defect, /ความกว้างรวม = 1520/);
  assert.equal(codeOf(await dl()), 'NOT_ENOUGH');
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
});

test('คืน/ตัดทิ้งกระทบจำนวนและประวัติถูกต้อง', async () => {
  const w = await world();
  const plan = await approvedPlan(w, 'TST-PLATE', 'INCOMING', PLATE_CHARS);
  const rr = await receivePlate(w, 'H5', 10, withPo('PO-77'));
  await certVerified(w, 'H5');
  const a = await inspectPlate(w, plan, 'H5', 3, plateBad, { sourceDoc: rr });
  const b = await inspectPlate(w, plan, 'H5', 2, [{ char: 'ความหนา', value: 3 }, { char: 'ผิว', value: 'ไม่ผ่าน' }], { sourceDoc: rr });
  const p = await inspectPlate(w, plan, 'H5', 5, plateOk, { sourceDoc: rr });
  assert.deepEqual([a.result.result, b.result.result, p.result.result], ['FAIL', 'FAIL', 'PASS']);
  await w.ok('QCLEAD', 'qc.release', { id: p.result.id });
  let s = await w.state();
  assert.deepEqual([qty(s, { code: 'TST-PLATE', status: 'QUARANTINE' }), qty(s, { code: 'TST-PLATE', status: 'AVAILABLE' }),
    qty(s, { code: 'TST-PLATE', status: 'QC_HOLD' })], [5, 5, 0]);
  // return to the supplier and scrap
  const ret = await w.ok('QCLEAD', 'ncr.disposition', { ncrNo: a.result.ncrNo, disposition: 'RETURN', reason: 'ความหนาต่ำกว่าเกณฑ์ ผู้ขายรับคืน' });
  const scr = await w.ok('ENG', 'ncr.disposition', { ncrNo: b.result.ncrNo, disposition: 'SCRAP', reason: 'ผิวเป็นสนิมลึก ใช้ไม่ได้' });
  s = await w.state();
  assert.equal(ret.result.docType, 'RV');
  assert.equal(scr.result.docType, 'SC');
  const rv = s.tables.documents[ret.result.docNo];
  assert.deepEqual([rv.type, rv.status, rv.ref, rv.lines[0].status, rv.lines[0].base, rv.lines[0].poNo, rv.lines[0].lot],
    ['RV', 'POSTED', a.result.ncrNo, 'QUARANTINE', 3, poOf('PO-77'), 'H5']);
  const sc = s.tables.documents[scr.result.docNo];
  assert.deepEqual([sc.type, sc.lines[0].status, sc.lines[0].base], ['SC', 'QUARANTINE', 2]);
  assert.deepEqual([qty(s, { code: 'TST-PLATE', status: 'QUARANTINE' }), qty(s, { code: 'TST-PLATE', status: 'AVAILABLE' }),
    qty(s, { code: 'TST-PLATE' })], [0, 5, 5]);
  assert.deepEqual(RRS.inventory.history(s, { docNo: rv.docNo }).map((m) => [m.qty, m.status, m.by]), [[-3, 'QUARANTINE', 'QCLEAD']]);
  assert.deepEqual(RRS.inventory.history(s, { docNo: sc.docNo }).map((m) => [m.qty, m.status, m.by]), [[-2, 'QUARANTINE', 'ENG']]);
  const na = s.tables.ncrs[a.result.ncrNo];
  assert.deepEqual([na.status, na.disposition, na.dispositionBy, na.docNo, na.docType, !!na.dispositionAt], ['DISPOSITIONED', 'RETURN', 'QCLEAD', rv.docNo, 'RV', true]);
  assert.equal(s.tables.ncrs[b.result.ncrNo].reason, 'ผิวเป็นสนิมลึก ใช้ไม่ได้');
  // the whole history of the heat adds up
  const t = Q.trace(s, { code: 'TST-PLATE', lot: 'H5' });
  assert.deepEqual(t.issues.map((e) => e.type).sort(), ['RV', 'SC']);
  assert.equal(t.receipts[0].qty, 10);
  assert.equal(util(t.issues), 5);
  assert.deepEqual(t.ncrs.map((n) => n.disposition).sort(), ['RETURN', 'SCRAP']);
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
  const moves = RRS.inventory.history(s, { code: 'TST-PLATE', lot: 'H5' });
  assert.equal(RRS.util.round(moves.reduce((x, m) => x + m.qty, 0)), 5);
  await w.ok('QCLEAD', 'ncr.close', { ncrNo: a.result.ncrNo, note: 'ผู้ขายรับของแล้ว' });
  await w.ok('ENG', 'ncr.close', { ncrNo: b.result.ncrNo });
  s = await w.state();
  assert.deepEqual([s.tables.ncrs[a.result.ncrNo].status, s.tables.ncrs[a.result.ncrNo].closedBy], ['CLOSED', 'QCLEAD']);
  function util(list) {
    return list.reduce((x, e) => x + e.qty, 0);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// permissions, separation of duties, cancel/undo, bad input
// ---------------------------------------------------------------------------------------------------------------
test('สิทธิ์: แต่ละขั้นต้องมีบทบาทและคลังที่ถูกต้อง', async () => {
  const w = await world();
  const planInput = { code: 'TST-PLATE', stage: 'INCOMING', drawingRev: '', sourceRef: 'WI-QC-01', chars: PLATE_CHARS };
  for (const u of ['QC1', 'STORE1', 'PROD', 'VIEW']) assert.equal(codeOf(await w.exec(u, 'qc.plan.save', planInput)), 'NO_PERMISSION', u);
  const draft = (await w.ok('QCLEAD', 'qc.plan.save', planInput)).result.id;
  for (const u of ['QC1', 'LEAD', 'PROD']) assert.equal(codeOf(await w.exec(u, 'qc.plan.approve', { id: draft })), 'NO_PERMISSION', u);
  await w.ok('ENG', 'qc.plan.approve', { id: draft });
  const rr = await receivePlate(w, 'P1', 4);
  await stockIn(w, 'TST-PLATE', 'B', 'B-01', 4, { lot: 'P1', status: 'AVAILABLE' });
  for (const u of ['STORE1', 'ENG', 'PROD', 'VIEW']) assert.equal(codeOf(await inspectPlate(w, draft, 'P1', 1, plateOk, {}, u)), 'NO_PERMISSION', u);
  for (const u of ['VIEW', 'ENG', 'PROD']) {
    assert.equal(codeOf(await w.exec(u, 'lot.update', { code: 'TST-PLATE', lot: 'P1', cert: { no: 'X' } })), 'NO_PERMISSION', u);
  }
  await w.ok('STORE1', 'lot.update', { code: 'TST-PLATE', lot: 'P1', cert: { no: 'MTC-P1' } });
  assert.equal(codeOf(await w.exec('ENG', 'lot.verifyCert', { code: 'TST-PLATE', lot: 'P1' })), 'NO_PERMISSION');
  // warehouse limits
  await w.ok('ADMIN', 'user.upsert', { id: 'QCB', name: 'QC คลัง B', roles: ['qc'], warehouses: ['B'] });
  assert.equal(codeOf(await inspectPlate(w, draft, 'P1', 1, plateOk, { sourceDoc: rr }, 'QCB')), 'NO_PERMISSION');
  assert.equal(codeOf(await w.exec('QCB', 'lot.quarantine', { code: 'TST-PLATE', lot: 'P1', reason: 'สงสัยผิดสเปก' })), 'NO_PERMISSION', 'stock of the lot is also in A');
  assert.equal(codeOf(await w.exec('STORE1', 'lot.quarantine', { code: 'TST-PLATE', lot: 'P1', reason: 'สงสัยผิดสเปก' })), 'NO_PERMISSION');
  await w.ok('LEAD', 'lot.quarantine', { code: 'TST-PLATE', lot: 'P1', reason: 'สงสัยผิดสเปก' }); // the store lead may quarantine
  for (const u of ['LEAD', 'QC1', 'ENG']) {
    assert.equal(codeOf(await w.exec(u, 'lot.release', { code: 'TST-PLATE', lot: 'P1', reason: 'ตรวจแล้วไม่พบปัญหา' })), 'NO_PERMISSION', u);
  }
  await w.ok('QCLEAD', 'lot.release', { code: 'TST-PLATE', lot: 'P1', reason: 'ตรวจแล้วไม่พบปัญหา' });
  const f = await inspectPlate(w, draft, 'P1', 2, plateBad);
  for (const u of ['QC1', 'STORE1', 'LEAD', 'VIEW']) {
    assert.equal(codeOf(await w.exec(u, 'ncr.disposition', { ncrNo: f.result.ncrNo, disposition: 'SCRAP', reason: 'เสีย' })), 'NO_PERMISSION', u);
  }
  // engineering may decide rework/scrap but not accept as-is
  assert.equal(codeOf(await w.exec('ENG', 'ncr.disposition', { ncrNo: f.result.ncrNo, disposition: 'USE_AS_IS', reason: 'ใช้ได้', conditions: 'ใช้กับงานภายใน' })), 'NO_PERMISSION');
  // a QC lead limited to B cannot decide on stock in A
  await w.ok('ADMIN', 'user.upsert', { id: 'QCLB', name: 'หัวหน้า QC คลัง B', roles: ['qc_lead'], warehouses: ['B'] });
  assert.equal(codeOf(await w.exec('QCLB', 'ncr.disposition', { ncrNo: f.result.ncrNo, disposition: 'SCRAP', reason: 'ผิวเสียหาย' })), 'NO_PERMISSION');
  await w.ok('ENG', 'ncr.disposition', { ncrNo: f.result.ncrNo, disposition: 'SCRAP', reason: 'ผิวเสียหาย' });
  assert.equal(codeOf(await w.exec('QC1', 'ncr.close', { ncrNo: f.result.ncrNo })), 'NO_PERMISSION');
  assert.equal(codeOf(await w.exec('VIEW', 'ncr.open', { code: 'TST-PLATE', wh: 'A', bin: 'A-01', lot: 'P1', qty: 1, defect: 'x' })), 'NO_PERMISSION');
});

test('แยกหน้าที่: ผู้ทำ ผู้ตรวจ และผู้อนุมัติต้องเป็นคนละคน', async () => {
  const w = await world();
  await w.ok('ADMIN', 'user.upsert', { id: 'QCL2', name: 'หัวหน้า QC 2', roles: ['qc_lead'] });
  await w.ok('ADMIN', 'user.upsert', { id: 'DUAL', name: 'หัวหน้าสโตร์ที่เป็น QC ด้วย', roles: ['store_lead', 'qc'] });
  // plan: maker / last editor cannot approve
  const id = (await w.ok('ENG', 'qc.plan.save', { code: 'TST-PLATE', stage: 'INCOMING', sourceRef: 'WI-QC-01', chars: PLATE_CHARS })).result.id;
  assert.equal(codeOf(await w.exec('ENG', 'qc.plan.approve', { id })), 'SAME_PERSON');
  await w.ok('QCLEAD', 'qc.plan.save', { id, code: 'TST-PLATE', stage: 'INCOMING', sourceRef: 'WI-QC-01 ฉบับ 2', chars: PLATE_CHARS });
  assert.equal(codeOf(await w.exec('QCLEAD', 'qc.plan.approve', { id })), 'SAME_PERSON');
  await w.ok('QCL2', 'qc.plan.approve', { id });
  let s = await w.state();
  assert.deepEqual([s.tables.qc_plans[id].createdBy, s.tables.qc_plans[id].updatedBy, s.tables.qc_plans[id].approvedBy], ['ENG', 'QCLEAD', 'QCL2']);
  assert.deepEqual(s.tables.qc_plans[id].history.map((h) => h.action), ['CREATE', 'EDIT', 'APPROVE']);
  // cert: entered by ≠ verified by
  const rr = await receivePlate(w, 'S1', 4);
  await w.ok('QC1', 'lot.update', { code: 'TST-PLATE', lot: 'S1', cert: { no: 'MTC-S1' } });
  assert.equal(codeOf(await w.exec('QC1', 'lot.verifyCert', { code: 'TST-PLATE', lot: 'S1' })), 'SAME_PERSON');
  await w.ok('QCLEAD', 'lot.verifyCert', { code: 'TST-PLATE', lot: 'S1' });
  // receipt poster ≠ inspector ≠ releaser
  const own = (await w.ok('DUAL', 'doc.post', { type: 'RR', lines: [{ code: 'TST-PLATE', qty: 1, wh: 'A', bin: 'A-02', lot: 'S1' }] })).result.docNo;
  assert.equal(codeOf(await w.exec('DUAL', 'qc.inspect', { stage: 'INCOMING', code: 'TST-PLATE', wh: 'A', bin: 'A-02', lot: 'S1', qty: 1, planId: id, results: plateOk, sourceDoc: own })), 'SAME_PERSON');
  const byLead = await inspectPlate(w, id, 'S1', 4, plateOk, { sourceDoc: rr }, 'QCLEAD');
  assert.equal(codeOf(await w.exec('QCLEAD', 'qc.release', { id: byLead.result.id })), 'SAME_PERSON');
  const passOwnDoc = await w.ok('QC1', 'qc.inspect', { stage: 'INCOMING', code: 'TST-PLATE', wh: 'A', bin: 'A-02', lot: 'S1', qty: 1, planId: id, results: plateOk, sourceDoc: own });
  await w.ok('ADMIN', 'user.upsert', { id: 'DUAL', name: 'หัวหน้าสโตร์ที่เป็น QC ด้วย', roles: ['store_lead', 'qc_lead'] });
  assert.equal(codeOf(await w.exec('DUAL', 'qc.release', { id: passOwnDoc.result.id })), 'SAME_PERSON', 'the receipt poster cannot release it');
  await w.ok('QCL2', 'qc.release', { id: byLead.result.id });
  // use-as-is: not the inspector, conditions required
  await receivePlate(w, 'S2', 2);
  await certVerified(w, 'S2');
  const f = await inspectPlate(w, id, 'S2', 2, plateBad, {}, 'QCLEAD');
  const asIs = { ncrNo: f.result.ncrNo, disposition: 'USE_AS_IS', reason: 'ลูกค้ายอมรับความหนา 2.5 มม.', conditions: 'ใช้กับงานลูกค้า X เท่านั้น' };
  assert.equal(codeOf(await w.exec('QCLEAD', 'ncr.disposition', asIs)), 'SAME_PERSON');
  assert.equal(codeOf(await w.exec('QCL2', 'ncr.disposition', { ...asIs, conditions: '' })), 'REQUIRED');
  const u = await w.ok('QCL2', 'ncr.disposition', asIs);
  s = await w.state();
  assert.equal(qty(s, { code: 'TST-PLATE', lot: 'S2', status: 'AVAILABLE' }), 2);
  assert.match(s.tables.documents[u.result.docNo].lines[0].remark, /ใช้กับงานลูกค้า X เท่านั้น/);
  assert.deepEqual([s.tables.ncrs[f.result.ncrNo].dispositionBy, s.tables.ncrs[f.result.ncrNo].conditions], ['QCL2', asIs.conditions]);
  // quarantined by ≠ released by
  await w.ok('QCLEAD', 'lot.quarantine', { code: 'TST-PLATE', lot: 'S2', reason: 'ลูกค้าแจ้งปัญหาซ้ำ' });
  assert.equal(codeOf(await w.exec('QCLEAD', 'lot.release', { code: 'TST-PLATE', lot: 'S2', reason: 'ตรวจสอบแล้ว' })), 'SAME_PERSON');
  await w.ok('QCL2', 'lot.release', { code: 'TST-PLATE', lot: 'S2', reason: 'ตรวจสอบแล้ว' });
  // the policy switch turns the check off (settings are changed by an authorised person)
  await w.ok('ADMIN', 'settings.update', { patch: { policies: { sod: false } } });
  await receivePlate(w, 'S3', 1);
  await certVerified(w, 'S3');
  const self = await inspectPlate(w, id, 'S3', 1, plateOk, {}, 'QCLEAD');
  assert.equal((await w.exec('QCLEAD', 'qc.release', { id: self.result.id })).ok, true);
});

test('ยกเลิก/ย้อนกลับ: ประวัติไม่หาย ยอดกลับถูกต้อง และต้องตรวจใหม่', async () => {
  const w = await world();
  const plan = await approvedPlan(w, 'TST-PLATE', 'INCOMING', PLATE_CHARS);
  const rr = await receivePlate(w, 'U1', 6);
  await certVerified(w, 'U1');
  const fail = await inspectPlate(w, plan, 'U1', 2, plateBad, { sourceDoc: rr });
  // a status change cannot be cancelled by hand
  let s = await w.state();
  const seq = s.seq;
  assert.deepEqual(codesOf(await w.exec('LEAD', 'doc.cancel', { docNo: fail.result.docNo, reason: 'ทดสอบ' })), ['QS_NO_CANCEL']);
  // the receipt cannot be cancelled while part of it sits in quarantine
  assert.equal(codeOf(await w.exec('LEAD', 'doc.cancel', { docNo: rr, reason: 'รับผิด' })), 'CANNOT_REVERSE');
  s = await w.state();
  assert.equal(s.seq, seq);
  // SCRAP then cancel the SC: stock back in quarantine and the NCR waits for a decision again (history kept)
  const sc = await w.ok('QCLEAD', 'ncr.disposition', { ncrNo: fail.result.ncrNo, disposition: 'SCRAP', reason: 'ความหนาต่ำ' });
  await w.ok('LEAD', 'doc.cancel', { docNo: sc.result.docNo, reason: 'ผู้ขายยอมรับคืน ไม่ต้องตัดทิ้ง' });
  s = await w.state();
  assert.equal(qty(s, { code: 'TST-PLATE', lot: 'U1', status: 'QUARANTINE' }), 2);
  const n = s.tables.ncrs[fail.result.ncrNo];
  assert.deepEqual([n.status, n.disposition, n.docNo], ['OPEN', '', '']);
  assert.deepEqual(n.history.map((h) => h.action), ['OPEN', 'DISPOSITION', 'UNDO']);
  assert.match(n.history[2].detail, new RegExp(sc.result.docNo));
  assert.equal(s.tables.documents[sc.result.docNo].status, 'CANCELLED');
  const ret = await w.ok('QCLEAD', 'ncr.disposition', { ncrNo: fail.result.ncrNo, disposition: 'RETURN', reason: 'ส่งคืนผู้ขาย' });
  await w.ok('QCLEAD', 'ncr.close', { ncrNo: fail.result.ncrNo });
  assert.equal(codeOf(await w.exec('LEAD', 'doc.cancel', { docNo: ret.result.docNo, reason: 'ทดสอบ' })), 'NCR_CLOSED');
  // a PASS waiting for release, then the lot is quarantined and released: back to รอตรวจ, the old PASS is void
  const pass = await inspectPlate(w, plan, 'U1', 4, plateOk, { sourceDoc: rr });
  await w.ok('QC1', 'lot.quarantine', { code: 'TST-PLATE', lot: 'U1', reason: 'ผู้ขายแจ้งเรียกคืน heat นี้' });
  s = await w.state();
  assert.equal(s.tables.inspections[pass.result.id].status, 'VOID');
  const rel = await w.ok('QCLEAD', 'lot.release', { code: 'TST-PLATE', lot: 'U1', reason: 'ผู้ขายยืนยันว่าไม่ใช่ heat ที่เรียกคืน' });
  s = await w.state();
  assert.equal(rel.result.moved, 4);
  assert.equal(qty(s, { code: 'TST-PLATE', lot: 'U1', status: 'QC_HOLD' }), 4, 'กลับไปรอตรวจ ไม่ใช่ใช้ได้ทันที');
  assert.equal(qty(s, { code: 'TST-PLATE', lot: 'U1', status: 'AVAILABLE' }), 0);
  assert.equal(s.tables.lots['TST-PLATE|U1'].status, 'ACTIVE');
  assert.deepEqual(s.tables.lots['TST-PLATE|U1'].history.map((h) => h.action).filter((a) => a !== 'RECEIVE'),
    ['UPDATE', 'VERIFY_CERT', 'QUARANTINE', 'RELEASE']);
  assert.equal(codeOf(await w.exec('QCLEAD', 'qc.release', { id: pass.result.id })), 'BAD_STATE');
  const again = await inspectPlate(w, plan, 'U1', 4, plateOk);
  await w.ok('QCLEAD', 'qc.release', { id: again.result.id });
  s = await w.state();
  assert.equal(qty(s, { code: 'TST-PLATE', lot: 'U1', status: 'AVAILABLE' }), 4);
  // stock of an open NCR stays in quarantine when the lot is released
  const rr2 = await receivePlate(w, 'U2', 5);
  const f2 = await inspectPlate(w, plan, 'U2', 2, plateBad, { sourceDoc: rr2 });
  await w.ok('QC1', 'lot.quarantine', { code: 'TST-PLATE', lot: 'U2', reason: 'พบปัญหาในบางแผ่น กักทั้ง heat' });
  s = await w.state();
  assert.equal(qty(s, { code: 'TST-PLATE', lot: 'U2', status: 'QUARANTINE' }), 5);
  await w.ok('QCLEAD', 'lot.release', { code: 'TST-PLATE', lot: 'U2', reason: 'คัดแยกแล้ว' });
  s = await w.state();
  assert.deepEqual([qty(s, { code: 'TST-PLATE', lot: 'U2', status: 'QUARANTINE' }), qty(s, { code: 'TST-PLATE', lot: 'U2', status: 'QC_HOLD' })], [2, 3]);
  // nobody takes NCR stock outside its decision
  assert.equal(codeOf(await w.exec('ADMIN', 'doc.post', { type: 'SC', remark: 'ตัดทิ้ง', lines: [{ code: 'TST-PLATE', qty: 1, wh: 'A', bin: 'A-01', lot: 'U2', status: 'QUARANTINE' }] })), 'NCR_HELD');
  assert.equal(s.tables.ncrs[f2.result.ncrNo].status, 'OPEN');
  // cancelling a receipt voids its inspection waiting for release; the lot row stays with the history
  const rr3 = await receivePlate(w, 'U3', 2);
  const p3 = await inspectPlate(w, plan, 'U3', 2, plateOk, { sourceDoc: rr3 });
  await w.ok('LEAD', 'doc.cancel', { docNo: rr3, reason: 'รับผิดรายการ' });
  s = await w.state();
  assert.equal(s.tables.inspections[p3.result.id].status, 'VOID');
  assert.equal(qty(s, { code: 'TST-PLATE', lot: 'U3' }), 0);
  assert.deepEqual(s.tables.lots['TST-PLATE|U3'].history.map((h) => h.action), ['RECEIVE', 'RECEIPT_CANCELLED']);
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
});

test('ข้อมูลผิดถูกปฏิเสธและไม่เปลี่ยนอะไร', async () => {
  const w = await world();
  const plan = await approvedPlan(w, 'TST-PLATE', 'INCOMING', PLATE_CHARS);
  const draft = (await w.ok('ENG', 'qc.plan.save', { code: 'TST-PLATE', stage: 'INCOMING', sourceRef: 'WI-QC-02', chars: PLATE_CHARS })).result.id;
  const fgPlan = await approvedPlan(w, 'TST-FG', 'FINAL', FG_CHARS);
  const rr = await receivePlate(w, 'B1', 3);
  const rrJob = (await w.ok('LEAD', 'doc.post', { type: 'RR', job: 'JOB-1', lines: [{ code: 'TST-PLATE', qty: 1, wh: 'A', bin: 'A-02', lot: 'B3' }] })).result.docNo;
  await stockIn(w, 'TST-001', 'A', 'A-01', 5);
  const p0 = { code: 'TST-PLATE', stage: 'INCOMING', sourceRef: 'WI-QC-01', chars: PLATE_CHARS };
  const s0 = await w.state();
  const seq = s0.seq;
  const cases = [
    ['ENG', 'qc.plan.save', { ...p0, sourceRef: '' }, 'REQUIRED'],
    ['ENG', 'qc.plan.save', { ...p0, stage: 'LATER' }, 'BAD_VALUE'],
    ['ENG', 'qc.plan.save', { ...p0, chars: [] }, 'REQUIRED'],
    ['ENG', 'qc.plan.save', { ...p0, chars: [{ name: 'หนา', kind: 'measure', min: 3.2, max: 2.8 }] }, 'BAD_VALUE'],
    ['ENG', 'qc.plan.save', { ...p0, chars: [{ name: 'หนา', kind: 'measure' }] }, 'REQUIRED'],
    ['ENG', 'qc.plan.save', { ...p0, chars: [{ name: 'หนา', kind: 'measure', min: 'สาม' }] }, 'BAD_VALUE'],
    ['ENG', 'qc.plan.save', { ...p0, chars: [{ name: 'หนา', kind: 'check' }, { name: 'หนา ', kind: 'check' }] }, 'DUPLICATE'],
    ['ENG', 'qc.plan.save', { ...p0, chars: [{ name: 'หนา', kind: 'weight' }] }, 'BAD_VALUE'],
    ['ENG', 'qc.plan.save', { ...p0, code: 'NO-SUCH' }, 'NOT_FOUND'],
    ['ENG', 'qc.plan.save', { ...p0, id: plan }, 'LOCKED'],
    ['ENG', 'qc.plan.save', { ...p0, id: draft, stage: 'FINAL' }, 'BAD_VALUE'],
    ['QCLEAD', 'qc.plan.approve', { id: 'QP-99999' }, 'NOT_FOUND'],
    ['QCLEAD', 'qc.plan.approve', { id: plan }, 'BAD_STATE'],
  ];
  const ins = { stage: 'INCOMING', code: 'TST-PLATE', wh: 'A', bin: 'A-01', lot: 'B1', qty: 1, planId: plan, results: plateOk };
  cases.push(
    ['QC1', 'qc.inspect', { ...ins, stage: 'SOMETIME' }, 'BAD_VALUE'],
    ['QC1', 'qc.inspect', { ...ins, planId: 'QP-99999' }, 'NOT_FOUND'],
    ['QC1', 'qc.inspect', { ...ins, planId: fgPlan }, 'PLAN_MISMATCH'],
    ['QC1', 'qc.inspect', { ...ins, planId: draft }, 'PLAN_NOT_APPROVED'],
    ['QC1', 'qc.inspect', { ...ins, results: [{ char: 'ความหนา', value: 3 }] }, 'MISSING_RESULT'],
    ['QC1', 'qc.inspect', { ...ins, results: [{ char: 'ความหนา', value: 'สามมิล' }, { char: 'ผิว', value: 'ผ่าน' }] }, 'BAD_VALUE'],
    ['QC1', 'qc.inspect', { ...ins, results: [...plateOk, { char: 'ความแข็ง', value: 50 }] }, 'UNKNOWN_CHAR'],
    ['QC1', 'qc.inspect', { ...ins, results: [...plateOk, { char: 'C1', value: 3 }] }, 'DUPLICATE'],
    ['QC1', 'qc.inspect', { ...ins, qty: 0 }, 'BAD_QTY'],
    ['QC1', 'qc.inspect', { ...ins, qty: 'สาม' }, 'BAD_QTY'],
    ['QC1', 'qc.inspect', { ...ins, qty: 4 }, 'NOT_ENOUGH'],
    ['QC1', 'qc.inspect', { ...ins, bin: 'A-02' }, 'NOT_ENOUGH'],
    ['QC1', 'qc.inspect', { ...ins, lot: '' }, 'LOT_REQUIRED'],
    ['QC1', 'qc.inspect', { ...ins, code: 'TST-001', lot: 'X' }, 'LOT_NOT_TRACKED'],
    ['QC1', 'qc.inspect', { ...ins, fromStatus: 'AVAILABLE' }, 'BAD_STATUS'],
    ['QC1', 'qc.inspect', { ...ins, wh: 'Z' }, 'NOT_FOUND'],
    ['QC1', 'qc.inspect', { ...ins, wh: '' }, 'REQUIRED'],
    ['QC1', 'qc.inspect', { ...ins, bin: 'NOPE' }, 'NOT_FOUND'],
    ['QC1', 'qc.inspect', { ...ins, photos: [{ name: 'รูป', url: 'data:image/png;base64,AAAA' }] }, 'BAD_VALUE'],
    ['QC1', 'qc.inspect', { ...ins, photos: 'รูป.jpg' }, 'BAD_VALUE'],
    ['QC1', 'qc.inspect', { ...ins, photos: [{ name: 'รูป', url: 'javascript:alert(1)' }] }, 'BAD_VALUE'],
    ['QC1', 'qc.inspect', { ...ins, qty: 1, unit: 'ลัง' }, 'NO_UNIT'],
    ['QC1', 'qc.inspect', { ...ins, sourceDoc: 'RR6911-9999' }, 'NOT_FOUND'],
    ['QC1', 'qc.inspect', { ...ins, lot: 'B2', sourceDoc: rr }, 'NOT_IN_DOC'],
    ['QC1', 'qc.inspect', { ...ins, bin: 'A-02', lot: 'B3', sourceDoc: rrJob, jobNo: 'JOB-77' }, 'JOB_MISMATCH'],
    ['QC1', 'qc.inspect', { ...ins, reinspectionOf: 'IN-99999' }, 'NOT_FOUND'],
    ['QC1', 'qc.inspect', { ...ins, stage: 'IN_PROCESS' }, 'REQUIRED'],
    ['QC1', 'qc.inspect', { ...ins, stage: 'IN_PROCESS', jobNo: 'JOB-1' }, 'PLAN_MISMATCH'],
    ['STORE1', 'lot.update', { code: 'TST-001', lot: 'X', note: 'x' }, 'LOT_NOT_TRACKED'],
    ['STORE1', 'lot.update', { code: 'TST-PLATE', lot: 'NEVER', note: 'x' }, 'NOT_FOUND'],
    ['STORE1', 'lot.update', { code: 'TST-PLATE', lot: '', note: 'x' }, 'REQUIRED'],
    ['STORE1', 'lot.update', { code: 'TST-PLATE', lot: 'B1', cert: { no: ' ' } }, 'REQUIRED'],
    ['STORE1', 'lot.update', { code: 'TST-PLATE', lot: 'B1' }, 'NO_CHANGE'],
    ['STORE1', 'lot.update', { code: 'TST-PLATE', lot: 'B1', cert: { no: 'MTC-X', file: 'javascript:alert(1)' } }, 'BAD_VALUE'],
    ['QC1', 'lot.verifyCert', { code: 'TST-PLATE', lot: 'B1' }, 'NO_CERT'],
    ['QC1', 'lot.quarantine', { code: 'TST-PLATE', lot: 'B1', reason: '' }, 'REQUIRED'],
    ['QC1', 'lot.quarantine', { code: 'TST-PLATE', lot: 'NEVER', reason: 'ทดสอบเหตุผล' }, 'NOT_FOUND'],
    ['QCLEAD', 'lot.release', { code: 'TST-PLATE', lot: 'B1', reason: 'ทดสอบเหตุผล' }, 'NOT_QUARANTINED'],
    ['QCLEAD', 'qc.release', { id: 'IN-99999' }, 'NOT_FOUND'],
    ['QCLEAD', 'ncr.disposition', { ncrNo: 'NCR6911-9999', disposition: 'SCRAP', reason: 'ทดสอบเหตุผล' }, 'NOT_FOUND'],
    ['QCLEAD', 'ncr.close', { ncrNo: 'NCR6911-9999' }, 'NOT_FOUND'],
    ['QC1', 'ncr.open', { code: 'TST-PLATE', wh: 'A', bin: 'A-01', lot: 'B1', qty: 1, defect: 'ไม่มีของกักกัน' }, 'NOT_ENOUGH'],
    ['QC1', 'ncr.open', { code: 'TST-PLATE', wh: 'A', bin: 'A-01', lot: 'B1', qty: 1, defect: '' }, 'REQUIRED'],
    ['LEAD', 'doc.post', { type: 'SC', lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01' }] }, 'REQUIRED'],
  );
  for (const [user, kind, payload, want] of cases) {
    const r = await w.exec(user, kind, payload);
    assert.equal(codeOf(r), want, `${kind} ${JSON.stringify(payload).slice(0, 120)} → ${JSON.stringify(r.errors)}`);
  }
  let s = await w.state();
  assert.equal(s.seq, seq, 'no refused command changed anything');
  // states: a FAIL makes an NCR; deciding needs a known disposition and a reason, and only once
  const f = await w.ok('QC1', 'qc.inspect', { ...ins, qty: 1, results: plateBad });
  const after = (await w.state()).seq;
  for (const [payload, want] of [
    [{ ncrNo: f.result.ncrNo, disposition: 'KEEP', reason: 'ทดสอบเหตุผล' }, 'BAD_VALUE'],
    [{ ncrNo: f.result.ncrNo, disposition: 'SCRAP', reason: '' }, 'REQUIRED'],
  ]) assert.equal(codeOf(await w.exec('QCLEAD', 'ncr.disposition', payload)), want);
  assert.equal(codeOf(await w.exec('QCLEAD', 'ncr.close', { ncrNo: f.result.ncrNo })), 'NOT_DISPOSITIONED');
  const pass = await w.ok('QC1', 'qc.inspect', { ...ins, qty: 2 });
  await w.ok('STORE1', 'lot.update', { code: 'TST-PLATE', lot: 'B1', cert: { no: 'MTC-B1' } });
  await w.ok('QC1', 'lot.verifyCert', { code: 'TST-PLATE', lot: 'B1' });
  assert.equal(codeOf(await w.exec('QC1', 'lot.verifyCert', { code: 'TST-PLATE', lot: 'B1' })), 'ALREADY_VERIFIED');
  assert.equal(codeOf(await w.exec('QCLEAD', 'qc.release', { id: pass.result.id, qty: 3 })), 'TOO_MUCH');
  assert.equal(codeOf(await w.exec('QCLEAD', 'qc.release', { id: pass.result.id, qty: -1 })), 'BAD_QTY');
  await w.ok('QCLEAD', 'ncr.disposition', { ncrNo: f.result.ncrNo, disposition: 'SCRAP', reason: 'ทดสอบเหตุผล' });
  assert.equal(codeOf(await w.exec('QCLEAD', 'ncr.disposition', { ncrNo: f.result.ncrNo, disposition: 'RETURN', reason: 'ทดสอบเหตุผล' })), 'BAD_STATE');
  s = await w.state();
  assert.equal(s.seq, after + 4);
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
});

// ---------------------------------------------------------------------------------------------------------------
// supporting behaviour
// ---------------------------------------------------------------------------------------------------------------
test('ล็อต: รับเข้าสร้างล็อตอัตโนมัติ แก้ใบรับรองแล้วต้องตรวจใหม่ ประวัติครบ', async () => {
  const w = await world();
  const rr = await receivePlate(w, 'C1', 2, withPo('PO-1'));
  let s = await w.state();
  const lot = s.tables.lots['TST-PLATE|C1'];
  assert.deepEqual([lot.kind, lot.docNo, lot.docType, lot.poNo, lot.status, lot.cert.verified], ['heat', rr, 'RR', poOf('PO-1'), 'ACTIVE', false]);
  await w.ok('STORE1', 'lot.update', { code: 'TST-PLATE', lot: 'C1', cert: { no: 'MTC-1', file: 'https://files.example.invalid/mtc1.pdf' }, note: 'ผู้ขาย A' });
  await w.ok('QC1', 'lot.verifyCert', { code: 'TST-PLATE', lot: 'C1' });
  s = await w.state();
  assert.deepEqual([s.tables.lots['TST-PLATE|C1'].cert.verified, s.tables.lots['TST-PLATE|C1'].cert.verifiedBy], [true, 'QC1']);
  await w.ok('STORE2', 'lot.update', { code: 'TST-PLATE', lot: 'C1', cert: { no: 'MTC-2' } });
  s = await w.state();
  const c = s.tables.lots['TST-PLATE|C1'];
  assert.deepEqual([c.cert.no, c.cert.file, c.cert.verified, c.cert.enteredBy], ['MTC-2', '', false, 'STORE2']);
  assert.deepEqual(c.history.map((h) => h.action), ['RECEIVE', 'UPDATE', 'VERIFY_CERT', 'UPDATE']);
  assert.match(c.history[3].detail, /MTC-1 \(ตรวจแล้วโดย QC1\) → MTC-2/);
  // a second receipt of the same heat adds to the history of the same lot
  await receivePlate(w, 'C1', 1);
  s = await w.state();
  assert.equal(s.tables.lots['TST-PLATE|C1'].docNo, rr);
  assert.equal(s.tables.lots['TST-PLATE|C1'].history.filter((h) => h.action === 'RECEIVE').length, 2);
  // the tables are in the data dictionary with Thai labels
  for (const t of ['lots', 'qc_plans', 'inspections', 'ncrs']) {
    const def = RRS.schema.tables[t];
    assert.equal(def.phase, 5);
    assert.ok(/[฀-๿]/.test(def.label), t);
    for (const f of def.fields) assert.ok(f.label && f.label.length > 1, t + '.' + f.name);
  }
  assert.deepEqual(RRS.schema.tables.lots.key, ['code', 'lot']);
  for (const t of ['SC', 'DL', 'QS', 'RV']) assert.equal(RRS.inventory.DOC_TYPES[t].express, false, t);
  assert.deepEqual(RRS.inventory.DOC_TYPES.DL.outStatuses, undefined, 'DL takes AVAILABLE stock only');
});

test('คิวงาน QC: อายุของรอตรวจ กักกัน รอแก้ไข และงานค้าง', async () => {
  const w = await world();
  const plan = await approvedPlan(w, 'TST-PLATE', 'INCOMING', PLATE_CHARS);
  await receivePlate(w, 'Q1', 5);
  const f = await inspectPlate(w, plan, 'Q1', 2, plateBad);
  const p = await inspectPlate(w, plan, 'Q1', 1, plateOk);
  const s = await w.state();
  const q = Q.qcQueue(s, '2026-11-05');
  assert.deepEqual(q.totals, { QC_HOLD: 3, QUARANTINE: 2, REWORK: 0 });
  const hold = q.balances.find((b) => b.status === 'QC_HOLD');
  assert.deepEqual([hold.qty, hold.ageDays, hold.waitingRelease, hold.toInspect, hold.certRequired, hold.certVerified], [3, 3, 1, 2, true, false]);
  assert.equal(hold.inspections[0].id, p.result.id);
  const quar = q.balances.find((b) => b.status === 'QUARANTINE');
  assert.deepEqual([quar.qty, quar.ncrHeld, quar.ncrs[0].ncrNo], [2, 2, f.result.ncrNo]);
  assert.deepEqual(q.inspections.map((i) => i.id), [p.result.id]);
  assert.deepEqual(q.ncrs.map((n) => n.ncrNo), [f.result.ncrNo]);
  assert.equal(Q.qcQueue(s).balances[0].ageDays, null, 'no today → no age (pure helper)');
  assert.equal(Q.planFor(s, 'TST-PLATE', 'INCOMING').id, plan);
  assert.equal(Q.planFor(s, 'TST-PLATE', 'FINAL'), null);
  assert.equal(Q.isLotQuarantined(s, 'TST-PLATE', 'Q1'), false);
});

test('ตรวจระหว่างผลิต: ผูกใบงาน ไม่มีของในคลัง NCR แก้ไขแล้วตรวจซ้ำและปิด', async () => {
  const w = await world();
  const plan = await approvedPlan(w, 'TST-FG', 'IN_PROCESS', [{ name: 'แนวเชื่อม', kind: 'check' }]);
  const base = { stage: 'IN_PROCESS', code: 'TST-FG', qty: 1, planId: plan };
  assert.equal(codeOf(await w.exec('QC1', 'qc.inspect', { ...base, results: [{ char: 'แนวเชื่อม', value: 'ผ่าน' }] })), 'REQUIRED');
  const before = JSON.stringify((await w.state()).tables.balances);
  const ok = await w.ok('QC1', 'qc.inspect', { ...base, jobNo: 'JOB-5', results: [{ char: 'แนวเชื่อม', value: 'ผ่าน' }] });
  const rel = await w.ok('QCLEAD', 'qc.release', { id: ok.result.id });
  assert.equal(rel.result.docNo, '');
  const bad = await w.ok('QC1', 'qc.inspect', { ...base, jobNo: 'JOB-5', results: [{ char: 'แนวเชื่อม', value: 'ไม่ผ่าน' }], note: 'รอยเชื่อมไม่เต็ม' });
  let s = await w.state();
  assert.equal(JSON.stringify(s.tables.balances), before, 'an in-process inspection moves no stock');
  const ncr = s.tables.ncrs[bad.result.ncrNo];
  assert.deepEqual([ncr.stockHeld, ncr.jobNo, ncr.description], [false, 'JOB-5', 'รอยเชื่อมไม่เต็ม']);
  assert.equal(codeOf(await w.exec('QCLEAD', 'ncr.disposition', { ncrNo: ncr.ncrNo, disposition: 'RETURN', reason: 'คืนไม่ได้' })), 'NO_STOCK');
  const d = await w.ok('ENG', 'ncr.disposition', { ncrNo: ncr.ncrNo, disposition: 'REWORK', reason: 'เชื่อมซ่อม' });
  assert.equal(d.result.docNo, '');
  const re = await w.ok('QC1', 'qc.inspect', { ...base, jobNo: 'JOB-5', reinspectionOf: bad.result.id, results: [{ char: 'แนวเชื่อม', value: true }] });
  assert.equal(re.result.result, 'PASS');
  await w.ok('ENG', 'ncr.close', { ncrNo: ncr.ncrNo, note: 'ซ่อมแล้วผ่าน' });
  s = await w.state();
  assert.equal(s.tables.ncrs[ncr.ncrNo].status, 'CLOSED');
  const tj = Q.traceJob(s, 'JOB-5');
  assert.deepEqual(tj.inspections.map((i) => i.result), ['PASS', 'FAIL', 'PASS']);
  assert.deepEqual(tj.ncrs.map((n) => n.ncrNo), [ncr.ncrNo]);
});

// ---------------------------------------------------------------------------------------------------------------
// independent review: gaps found after the first build (each test failed before the fix)
// ---------------------------------------------------------------------------------------------------------------
const BOLT_CHARS = [{ name: 'ความยาว', kind: 'measure', nominal: 50, min: 49.5, max: 50.5, unit: 'มม.' }];
const boltOk = [{ char: 'C1', value: 50 }];
const boltBad = [{ char: 'C1', value: 52 }];
/** A lot-tracked bought part that is inspected on receipt (no material certificate), with a box of 50. */
async function boltWorld() {
  const w = await world();
  await w.ok('ENG', 'item.upsert', { code: 'QC-BOLT', name: 'สลักทดสอบ', baseUnit: 'ตัว', type: 'BUY', trackLot: 'lot', qcIncoming: true });
  await w.ok('ENG', 'item.unit', { code: 'QC-BOLT', unit: 'กล่อง', factor: 50 });
  const plan = await approvedPlan(w, 'QC-BOLT', 'INCOMING', BOLT_CHARS);
  return { w, plan };
}
async function rrBolt(w, lot, qty, extra = {}, user = 'LEAD') {
  return (await w.ok(user, 'doc.post', { type: 'RR', lines: [{ code: 'QC-BOLT', qty, wh: 'A', bin: 'A-01', lot, ...extra }] })).result.docNo;
}
function inspBolt(w, plan, lot, n, results, extra = {}, user = 'QC1') {
  return w.exec(user, 'qc.inspect', { stage: 'INCOMING', code: 'QC-BOLT', wh: 'A', bin: 'A-01', lot, qty: n, planId: plan, results, ...extra });
}

test('รีวิว: ล็อตที่ถูกกักระหว่างโอน รับปลายทางแล้วเป็นกักกัน (ปลดระหว่างทาง = รอตรวจ)', async () => {
  const { w } = await boltWorld();
  await stockIn(w, 'QC-BOLT', 'A', 'A-01', 10, { lot: 'T1', status: 'AVAILABLE' });
  const tr = (await w.ok('STORE1', 'doc.post', { type: 'TR', lines: [{ code: 'QC-BOLT', qty: 4, wh: 'A', bin: 'A-01', lot: 'T1', toWh: 'B', toBin: 'B-01' }] })).result.docNo;
  const q = await w.ok('QC1', 'lot.quarantine', { code: 'QC-BOLT', lot: 'T1', reason: 'ผู้ขายแจ้งเรียกคืนล็อต' });
  assert.deepEqual([q.result.moved, q.result.inTransit], [6, 4]);
  const rec = await w.ok('STORE2', 'transfer.receive', { docNo: tr });
  assert.ok(rec.warnings.some((x) => x.includes('กักกัน')));
  let s = await w.state();
  assert.equal(qty(s, { code: 'QC-BOLT', lot: 'T1', status: 'AVAILABLE' }), 0, 'nothing of a quarantined lot is free to reserve');
  assert.equal(qty(s, { code: 'QC-BOLT', wh: 'B', lot: 'T1', status: 'QUARANTINE' }), 4);
  assert.match(RRS.inventory.history(s, { docNo: tr }).find((m) => m.wh === 'B').remark, /ล็อตถูกกักกัน/, 'the movement says why it landed in quarantine');
  // quarantined and released while in transit: the arriving stock must be inspected again like the rest of the lot
  await stockIn(w, 'QC-BOLT', 'A', 'A-01', 10, { lot: 'T2', status: 'AVAILABLE' });
  const tr2 = (await w.ok('STORE1', 'doc.post', { type: 'TR', lines: [{ code: 'QC-BOLT', qty: 3, wh: 'A', bin: 'A-01', lot: 'T2', toWh: 'B', toBin: 'B-01' }] })).result.docNo;
  await w.ok('QC1', 'lot.quarantine', { code: 'QC-BOLT', lot: 'T2', reason: 'สงสัยผิดสเปก' });
  await w.ok('QCLEAD', 'lot.release', { code: 'QC-BOLT', lot: 'T2', reason: 'ผู้ขายยืนยันว่าไม่ใช่ล็อตที่มีปัญหา' });
  await w.ok('STORE2', 'transfer.receive', { docNo: tr2 });
  s = await w.state();
  assert.deepEqual([qty(s, { code: 'QC-BOLT', lot: 'T2', status: 'QC_HOLD' }), qty(s, { code: 'QC-BOLT', lot: 'T2', status: 'AVAILABLE' })], [10, 0]);
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
});

test('รีวิว: ยกเลิกเอกสารไม่ปลดของกักกัน ไม่ทำให้ NCR ลอย และผลตรวจที่ไม่มีของรองรับเป็นโมฆะ', async () => {
  const { w, plan } = await boltWorld();
  // a cancelled issue of a lot quarantined afterwards comes back quarantined
  await stockIn(w, 'QC-BOLT', 'A', 'A-01', 10, { lot: 'K1', status: 'AVAILABLE' });
  const pd = (await w.ok('STORE1', 'doc.post', { type: 'PD', job: 'JOB-1', lines: [{ code: 'QC-BOLT', qty: 4, wh: 'A', bin: 'A-01', lot: 'K1' }] })).result.docNo;
  await w.ok('QC1', 'lot.quarantine', { code: 'QC-BOLT', lot: 'K1', reason: 'ผู้ขายแจ้งเรียกคืนล็อต' });
  const c = await w.ok('LEAD', 'doc.cancel', { docNo: pd, reason: 'เบิกผิดงาน' });
  let s = await w.state();
  assert.deepEqual([qty(s, { code: 'QC-BOLT', lot: 'K1', status: 'AVAILABLE' }), qty(s, { code: 'QC-BOLT', lot: 'K1', status: 'QUARANTINE' })], [0, 10]);
  assert.ok(c.warnings.some((x) => x.includes('กักกัน')));
  assert.equal(docsOf(s, 'QS').length, 2, 'the way back into quarantine is a status-change document');
  // a receipt cannot be cancelled while an open NCR holds its quarantined stock
  const rr = await rrBolt(w, 'K1', 2, { wh: 'B', bin: 'B-01' });
  const ncr = await w.ok('QC1', 'ncr.open', { code: 'QC-BOLT', wh: 'B', bin: 'B-01', lot: 'K1', qty: 2, defect: 'ล็อตเรียกคืน' });
  s = await w.state();
  const seq = s.seq;
  assert.equal(codeOf(await w.exec('LEAD', 'doc.cancel', { docNo: rr, reason: 'รับผิด' })), 'NCR_HELD');
  s = await w.state();
  assert.equal(s.seq, seq);
  assert.equal(s.tables.ncrs[ncr.result.ncrNo].status, 'OPEN');
  // a PASS without a source document loses its stock when the receipt is cancelled: void, never released on new stock
  const rr1 = await rrBolt(w, 'K2', 6);
  const pass = await inspBolt(w, plan, 'K2', 6, boltOk);
  assert.equal(pass.ok, true, JSON.stringify(pass.errors));
  await w.ok('LEAD', 'doc.cancel', { docNo: rr1, reason: 'คีย์ซ้ำ' });
  s = await w.state();
  assert.equal(s.tables.inspections[pass.result.id].status, 'VOID');
  await rrBolt(w, 'K2', 6); // a new delivery of the same lot number
  assert.equal(codeOf(await w.exec('QCLEAD', 'qc.release', { id: pass.result.id })), 'BAD_STATE');
  s = await w.state();
  assert.deepEqual([qty(s, { code: 'QC-BOLT', lot: 'K2', status: 'QC_HOLD' }), qty(s, { code: 'QC-BOLT', lot: 'K2', status: 'AVAILABLE' })], [6, 0]);
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
});

test('รีวิว: ตรวจซ้ำต้องตรวจของที่แก้ไขตาม NCR นั้นจริง และปิด NCR ได้เมื่อตรวจซ้ำครบ', async () => {
  const { w, plan } = await boltWorld();
  const rr = await rrBolt(w, 'R1', 10);
  const f1 = await inspBolt(w, plan, 'R1', 3, boltBad, { sourceDoc: rr });
  const f2 = await inspBolt(w, plan, 'R1', 2, boltBad, { sourceDoc: rr });
  const n1 = f1.result.ncrNo;
  const n2 = f2.result.ncrNo;
  await w.ok('QCLEAD', 'ncr.disposition', { ncrNo: n1, disposition: 'REWORK', reason: 'ตัดความยาวใหม่' });
  // the re-inspection must look at the reworked pieces, not at the 5 still waiting for their first inspection
  assert.equal(codeOf(await inspBolt(w, plan, 'R1', 3, boltOk, { reinspectionOf: f1.result.id })), 'REINSPECT_STATE');
  // NCR 2 is not decided yet: its pieces are in quarantine – the reworked pieces of NCR 1 cannot be booked to it
  assert.equal(codeOf(await inspBolt(w, plan, 'R1', 2, boltOk, { fromStatus: 'REWORK', reinspectionOf: n2 })), 'REINSPECT_STATE');
  await w.ok('QCLEAD', 'ncr.disposition', { ncrNo: n2, disposition: 'REWORK', reason: 'ตัดความยาวใหม่' });
  let s = await w.state();
  assert.equal(qty(s, { code: 'QC-BOLT', status: 'REWORK' }), 5);
  // no more than the NCR holds
  assert.equal(codeOf(await inspBolt(w, plan, 'R1', 5, boltOk, { fromStatus: 'REWORK', reinspectionOf: n1 })), 'TOO_MUCH');
  const r1 = await inspBolt(w, plan, 'R1', 1, boltOk, { fromStatus: 'REWORK', reinspectionOf: n1 });
  assert.equal(r1.ok, true, JSON.stringify(r1.errors));
  assert.equal(codeOf(await w.exec('QCLEAD', 'ncr.close', { ncrNo: n1 })), 'REINSPECTION_PENDING', '2 of 3 reworked pieces not re-inspected');
  await inspBolt(w, plan, 'R1', 2, boltOk, { fromStatus: 'REWORK', reinspectionOf: n1 });
  await w.ok('QCLEAD', 'ncr.close', { ncrNo: n1 });
  const r2 = await inspBolt(w, plan, 'R1', 2, boltOk, { fromStatus: 'REWORK', reinspectionOf: f2.result.id });
  assert.equal(r2.ok, true, JSON.stringify(r2.errors));
  await w.ok('QCLEAD', 'ncr.close', { ncrNo: n2 });
  s = await w.state();
  assert.deepEqual(s.tables.ncrs[n1].reinspections.map((x) => x.result), ['PASS', 'PASS']);
  // in-process: the re-inspection belongs to the same job
  const ip = await approvedPlan(w, 'TST-FG', 'IN_PROCESS', [{ name: 'แนวเชื่อม', kind: 'check' }]);
  const bad = await w.ok('QC1', 'qc.inspect', { stage: 'IN_PROCESS', code: 'TST-FG', qty: 1, planId: ip, jobNo: 'JOB-5', results: [{ char: 'C1', value: 'ไม่ผ่าน' }] });
  await w.ok('ENG', 'ncr.disposition', { ncrNo: bad.result.ncrNo, disposition: 'REWORK', reason: 'เชื่อมซ่อม' });
  assert.equal(codeOf(await w.exec('QC1', 'qc.inspect', { stage: 'IN_PROCESS', code: 'TST-FG', qty: 1, planId: ip, jobNo: 'JOB-6',
    reinspectionOf: bad.result.id, results: [{ char: 'C1', value: 'ผ่าน' }] })), 'JOB_MISMATCH');
  assert.equal(codeOf(await w.exec('ENG', 'ncr.close', { ncrNo: bad.result.ncrNo })), 'REINSPECTION_PENDING');
  // a stock NCR is not re-inspected as in-process work (no stock would be looked at)
  const f3 = await inspBolt(w, plan, 'R1', 1, boltBad);
  await w.ok('QCLEAD', 'ncr.disposition', { ncrNo: f3.result.ncrNo, disposition: 'REWORK', reason: 'แก้เกลียว' });
  const ipBolt = await approvedPlan(w, 'QC-BOLT', 'IN_PROCESS', BOLT_CHARS);
  assert.equal(codeOf(await w.exec('QC1', 'qc.inspect', { stage: 'IN_PROCESS', code: 'QC-BOLT', lot: 'R1', qty: 1, planId: ipBolt, jobNo: 'JOB-5',
    reinspectionOf: f3.result.ncrNo, results: boltOk })), 'REINSPECT_MISMATCH');
  s = await w.state();
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
});

test('รีวิว: ของรอแก้ไขของ NCR ออกจากคลังได้ทางตรวจซ้ำเท่านั้น', async () => {
  const { w, plan } = await boltWorld();
  await rrBolt(w, 'W1', 4);
  const f = await inspBolt(w, plan, 'W1', 4, boltBad);
  await w.ok('QCLEAD', 'ncr.disposition', { ncrNo: f.result.ncrNo, disposition: 'REWORK', reason: 'แก้ไขความยาว' });
  const s0 = await w.state();
  const line = { code: 'QC-BOLT', qty: 1, wh: 'A', bin: 'A-01', lot: 'W1', status: 'REWORK' };
  assert.equal(codeOf(await w.exec('STORE1', 'doc.post', { type: 'RV', remark: 'คืนผู้ขาย', lines: [line] })), 'NCR_HELD');
  assert.equal(codeOf(await w.exec('ADMIN', 'doc.post', { type: 'SC', remark: 'ตัดทิ้ง', lines: [line] })), 'NCR_HELD');
  const s = await w.state();
  assert.equal(s.seq, s0.seq);
  assert.equal(qty(s, { code: 'QC-BOLT', status: 'REWORK' }), 4);
});

test('รีวิว: หน่วยที่มีตัวคูณในการตรวจ ปล่อยผ่าน และเปิด NCR', async () => {
  const { w, plan } = await boltWorld();
  await rrBolt(w, 'U1', 2, { unit: 'กล่อง' });
  let s = await w.state();
  assert.equal(qty(s, { code: 'QC-BOLT', status: 'QC_HOLD' }), 100);
  assert.equal(codeOf(await inspBolt(w, plan, 'U1', 1, boltOk, { unit: 'ลัง' })), 'NO_UNIT');
  const i = await inspBolt(w, plan, 'U1', 1, boltOk, { unit: 'กล่อง' });
  assert.equal(i.ok, true, JSON.stringify(i.errors));
  s = await w.state();
  assert.equal(s.tables.inspections[i.result.id].qty, 50, 'stored in the base unit');
  const r = await w.ok('QCLEAD', 'qc.release', { id: i.result.id, qty: 0.5, unit: 'กล่อง' });
  assert.equal(r.result.qty, 25);
  await w.ok('QCLEAD', 'qc.release', { id: i.result.id });
  const f = await inspBolt(w, plan, 'U1', 1, boltBad, { unit: 'กล่อง' });
  s = await w.state();
  assert.deepEqual([qty(s, { code: 'QC-BOLT', status: 'AVAILABLE' }), qty(s, { code: 'QC-BOLT', status: 'QUARANTINE' }),
    qty(s, { code: 'QC-BOLT', status: 'QC_HOLD' }), s.tables.ncrs[f.result.ncrNo].qty], [50, 50, 0, 50]);
  await w.ok('QC1', 'lot.quarantine', { code: 'QC-BOLT', lot: 'U1', reason: 'ทั้งล็อตต้องคัดแยก' });
  assert.equal(codeOf(await w.exec('QC1', 'ncr.open', { code: 'QC-BOLT', wh: 'A', bin: 'A-01', lot: 'U1', qty: 2, unit: 'กล่อง', defect: 'ทั้งกล่อง' })), 'NOT_ENOUGH');
  const o = await w.ok('QC1', 'ncr.open', { code: 'QC-BOLT', wh: 'A', bin: 'A-01', lot: 'U1', qty: 1, unit: 'กล่อง', defect: 'ทั้งกล่อง' });
  s = await w.state();
  assert.equal(s.tables.ncrs[o.result.ncrNo].qty, 50);
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
});

test('รีวิว: แยกหน้าที่ – ผู้เปิด NCR ตัดสินเองไม่ได้ ผู้รับเข้าตรวจ/ปล่อยของตัวเองไม่ได้แม้ไม่อ้างเอกสาร', async () => {
  const { w, plan } = await boltWorld();
  await w.ok('ADMIN', 'user.upsert', { id: 'DUAL', name: 'หัวหน้าสโตร์ที่เป็น QC ด้วย', roles: ['store_lead', 'qc'] });
  // the person who raised the NCR does not decide it
  await rrBolt(w, 'D1', 5);
  const f = await inspBolt(w, plan, 'D1', 2, boltBad, {}, 'QCLEAD');
  assert.equal(codeOf(await w.exec('QCLEAD', 'ncr.disposition', { ncrNo: f.result.ncrNo, disposition: 'SCRAP', reason: 'ยาวเกิน' })), 'SAME_PERSON');
  await w.ok('ENG', 'ncr.disposition', { ncrNo: f.result.ncrNo, disposition: 'SCRAP', reason: 'ยาวเกิน' });
  // receipt poster ≠ inspector even when no source document is given; the source document must be the one at that place
  const lead = await rrBolt(w, 'D2', 3);
  const own = await rrBolt(w, 'D2', 4, { bin: 'A-02' }, 'DUAL');
  const at02 = { bin: 'A-02' };
  assert.equal(codeOf(await inspBolt(w, plan, 'D2', 4, boltOk, at02, 'DUAL')), 'SAME_PERSON');
  assert.equal(codeOf(await inspBolt(w, plan, 'D2', 4, boltOk, { ...at02, sourceDoc: lead }, 'DUAL')), 'NOT_IN_DOC');
  // the stage follows the document: a receipt is inspected on receipt
  const fin = await approvedPlan(w, 'QC-BOLT', 'FINAL', BOLT_CHARS);
  assert.equal(codeOf(await w.exec('QC1', 'qc.inspect', { stage: 'FINAL', code: 'QC-BOLT', wh: 'A', bin: 'A-02', lot: 'D2', qty: 4, planId: fin,
    results: boltOk, sourceDoc: own })), 'STAGE_MISMATCH');
  // inspected by someone else without naming the receipt: its poster still cannot release it
  const p = await inspBolt(w, plan, 'D2', 4, boltOk, at02);
  assert.equal(p.ok, true, JSON.stringify(p.errors));
  await w.ok('ADMIN', 'user.upsert', { id: 'DUAL', name: 'หัวหน้าสโตร์ที่เป็น QC ด้วย', roles: ['store_lead', 'qc_lead'] });
  assert.equal(codeOf(await w.exec('DUAL', 'qc.release', { id: p.result.id })), 'SAME_PERSON');
  const s = await w.state();
  assert.equal(Q.releaseCheck(s, p.result.id, 'DUAL')[0].code, 'SAME_PERSON');
  await w.ok('QCLEAD', 'qc.release', { id: p.result.id });
});

test('รีวิว: ปลดกักกันล็อตต้องมีสิทธิ์ทุกคลังที่มีของล็อตนั้น', async () => {
  const { w, plan } = await boltWorld();
  await rrBolt(w, 'Q1', 3);
  await inspBolt(w, plan, 'Q1', 3, boltBad); // all 3 in quarantine under an open NCR
  await w.ok('LEAD', 'lot.quarantine', { code: 'QC-BOLT', lot: 'Q1', reason: 'กักทั้งล็อตระหว่างสอบสวน' });
  await w.ok('ADMIN', 'user.upsert', { id: 'QCLB', name: 'หัวหน้า QC คลัง B', roles: ['qc_lead'], warehouses: ['B'] });
  assert.equal(codeOf(await w.exec('QCLB', 'lot.release', { code: 'QC-BOLT', lot: 'Q1', reason: 'สอบสวนแล้ว' })), 'NO_PERMISSION');
  await w.ok('QCLEAD', 'lot.release', { code: 'QC-BOLT', lot: 'Q1', reason: 'สอบสวนแล้ว' });
});

// ---------------------------------------------------------------------------------------------------------------
// independent review, round 2 (each test failed against the module before its fix, unless noted as a regression guard)
// ---------------------------------------------------------------------------------------------------------------
test('รีวิว 2: ของกักกันออกจากคลังได้ด้วยการตัดสิน NCR – คืนผู้ขายตรงต้องมีสิทธิ์ตัดสิน และแยกบรรทัดก็เอาของของ NCR ไม่ได้', async () => {
  const { w, plan } = await boltWorld();
  await rrBolt(w, 'Z1', 5);
  const f = await inspBolt(w, plan, 'Z1', 2, boltBad); // 2 in quarantine under an open NCR
  await w.ok('QC1', 'lot.quarantine', { code: 'QC-BOLT', lot: 'Z1', reason: 'ผู้ขายแจ้งปัญหาทั้งล็อต' }); // the other 3 too
  const s0 = await w.state();
  assert.equal(qty(s0, { code: 'QC-BOLT', lot: 'Z1', status: 'QUARANTINE' }), 5);
  const line = (n) => ({ code: 'QC-BOLT', qty: n, wh: 'A', bin: 'A-01', lot: 'Z1', status: 'QUARANTINE' });
  // a return to the supplier is a decision (plan 4): a store clerk / store lead cannot post it straight from quarantine
  assert.equal(codeOf(await w.exec('STORE1', 'doc.post', { type: 'RV', remark: 'คืนผู้ขาย', lines: [line(1)] })), 'NCR_REQUIRED');
  assert.equal(codeOf(await w.exec('LEAD', 'doc.post', { type: 'RV', remark: 'คืนผู้ขาย', lines: [line(3)] })), 'NCR_REQUIRED');
  // the NCR's pieces cannot be taken by splitting them over two lines (3 free + 2 of the NCR)
  assert.equal(codeOf(await w.exec('ADMIN', 'doc.post', { type: 'SC', remark: 'ตัดทิ้ง', lines: [line(2), line(2)] })), 'NCR_HELD');
  assert.equal(codeOf(await w.exec('ADMIN', 'doc.post', { type: 'RV', remark: 'คืนผู้ขาย', lines: [line(3), line(1)] })), 'NCR_HELD');
  let s = await w.state();
  assert.equal(s.seq, s0.seq, 'nothing was saved');
  // the free part by someone who may decide NCRs; the NCR's part through its decision
  await w.ok('ADMIN', 'doc.post', { type: 'SC', remark: 'ตัดทิ้งส่วนที่ไม่มี NCR', lines: [line(1), line(2)] });
  const ret = await w.ok('QCLEAD', 'ncr.disposition', { ncrNo: f.result.ncrNo, disposition: 'RETURN', reason: 'ยาวเกินเกณฑ์ ผู้ขายรับคืน' });
  s = await w.state();
  assert.equal(s.tables.documents[ret.result.docNo].type, 'RV');
  assert.equal(qty(s, { code: 'QC-BOLT', lot: 'Z1' }), 0);
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
});

test('รีวิว 2: ยกเลิกใบรับแรกของล็อต – ล็อตชี้ใบรับและ PO ที่ยังอยู่ (คืนผู้ขายอ้าง PO ที่ถูก)', async () => {
  const { w, plan } = await boltWorld();
  const rr1 = await rrBolt(w, 'P1', 2, withPo('PO-OLD'));
  await w.ok('LEAD', 'doc.cancel', { docNo: rr1, reason: 'คีย์ผิดใบสั่งซื้อ' });
  let s = await w.state();
  assert.equal(s.tables.lots['QC-BOLT|P1'].docNo, '', 'no receipt of the lot stands');
  const rr2 = await rrBolt(w, 'P1', 2, withPo('PO-NEW'));
  s = await w.state();
  const lot = s.tables.lots['QC-BOLT|P1'];
  assert.deepEqual([lot.docNo, lot.docType, lot.poNo], [rr2, 'RR', poOf('PO-NEW')]);
  assert.deepEqual(lot.history.map((h) => h.action), ['RECEIVE', 'RECEIPT_CANCELLED', 'RECEIVE'], 'history keeps both receipts and the cancel');
  assert.equal(Q.trace(s, { code: 'QC-BOLT', lot: 'P1' }).lot.docNo, rr2);
  const f = await inspBolt(w, plan, 'P1', 1, boltBad, { sourceDoc: rr2 });
  const ret = await w.ok('QCLEAD', 'ncr.disposition', { ncrNo: f.result.ncrNo, disposition: 'RETURN', reason: 'ยาวเกินเกณฑ์ คืนผู้ขาย' });
  s = await w.state();
  assert.equal(s.tables.documents[ret.result.docNo].lines[0].poNo, poOf('PO-NEW'));
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
});

test('รีวิว 2: ยกเลิกใบโอนระหว่างทางของล็อตที่ถูกกัก – ของกลับต้นทางเป็นกักกัน', async () => {
  const { w } = await boltWorld();
  await stockIn(w, 'QC-BOLT', 'A', 'A-01', 10, { lot: 'X1', status: 'AVAILABLE' });
  const tr = (await w.ok('STORE1', 'doc.post', { type: 'TR', lines: [{ code: 'QC-BOLT', qty: 4, wh: 'A', bin: 'A-01', lot: 'X1', toWh: 'B', toBin: 'B-01' }] })).result.docNo;
  await w.ok('QC1', 'lot.quarantine', { code: 'QC-BOLT', lot: 'X1', reason: 'ผู้ขายแจ้งเรียกคืนล็อต' });
  const c = await w.ok('LEAD', 'doc.cancel', { docNo: tr, reason: 'โอนผิดคลัง' });
  assert.ok(c.warnings.some((x) => x.includes('กักกัน')));
  const s = await w.state();
  assert.deepEqual([qty(s, { code: 'QC-BOLT', lot: 'X1', status: 'AVAILABLE' }), qty(s, { code: 'QC-BOLT', wh: 'A', lot: 'X1', status: 'QUARANTINE' }),
    qty(s, { code: 'QC-BOLT', wh: RRS.TRANSIT, lot: 'X1' })], [0, 10, 0]);
  assert.equal(codeOf(await w.exec('STORE1', 'doc.post', { type: 'PD', lines: [{ code: 'QC-BOLT', qty: 1, wh: 'A', bin: 'A-01', lot: 'X1' }] })), 'LOT_QUARANTINED');
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
});

test('รีวิว 2: ผลผ่านผูกกับฉบับแบบ – แบบเปลี่ยนหลังตรวจ ปล่อยผลเดิมไม่ได้ ตรวจใหม่ตามแผนฉบับใหม่ได้', async () => {
  const w = await world();
  await w.ok('ENG', 'item.upsert', { code: 'QC-REV', name: 'ขาค้ำทดสอบ', baseUnit: 'ชิ้น', type: 'PART', trackLot: 'lot', qcIncoming: true, drawingNo: 'DWG-200', drawingRev: 'A' });
  const chars = (nom) => [{ name: 'ความยาว', kind: 'measure', nominal: nom, min: nom - 0.5, max: nom + 0.5, unit: 'มม.' }];
  const planA = await approvedPlan(w, 'QC-REV', 'INCOMING', chars(100), { drawingRev: 'A', sourceRef: 'DWG-200 rev A' });
  await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'QC-REV', qty: 4, wh: 'A', bin: 'A-01', lot: 'R1' }] });
  const insp = (planId, value) => w.exec('QC1', 'qc.inspect', { stage: 'INCOMING', code: 'QC-REV', wh: 'A', bin: 'A-01', lot: 'R1', qty: 4, planId,
    results: [{ char: 'C1', value }] });
  const pass = await insp(planA, 100);
  assert.equal(pass.result.result, 'PASS');
  // the drawing goes to rev B before the release
  await w.ok('ENG', 'bom.upsert', { product: 'QC-REV', rev: 'B', lines: [{ code: 'TST-001', qty: 1 }] });
  await w.ok('ENG', 'bom.approve', { product: 'QC-REV', rev: 'B' });
  let s = await w.state();
  assert.equal(codeOf(await w.exec('QCLEAD', 'qc.release', { id: pass.result.id })), 'REV_CHANGED');
  const qb = Q.qcQueue(s, '2026-11-02').balances.find((b) => b.code === 'QC-REV');
  assert.deepEqual([qb.waitingRelease, qb.toInspect, qb.staleRev], [0, 4, [pass.result.id]], 'the queue asks for a new inspection');
  assert.ok(Q.releaseCheck(s, pass.result.id, 'QCLEAD').some((x) => x.code === 'REV_CHANGED'));
  assert.equal(qty(s, { code: 'QC-REV', status: 'AVAILABLE' }), 0);
  // inspected again against the plan of rev B: the old PASS does not block it and becomes void
  const planB = await approvedPlan(w, 'QC-REV', 'INCOMING', chars(98), { drawingRev: 'B', sourceRef: 'DWG-200 rev B' });
  const again = await insp(planB, 98);
  assert.equal(again.ok, true, JSON.stringify(again.errors));
  s = await w.state();
  assert.equal(s.tables.inspections[pass.result.id].status, 'VOID');
  assert.match(s.tables.inspections[pass.result.id].voidReason, /ฉบับ/);
  await w.ok('QCLEAD', 'qc.release', { id: again.result.id });
  s = await w.state();
  assert.deepEqual([qty(s, { code: 'QC-REV', status: 'AVAILABLE' }), qty(s, { code: 'QC-REV', status: 'QC_HOLD' })], [4, 0]);
  assert.equal(s.tables.inspections[again.result.id].planRev, 'B');
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
});

test('รีวิว 2: ตรวจซ้ำของ NCR ที่เปิดจากของกักกัน ต้องตรวจที่ตำแหน่งของ NCR นั้น และปิดได้เมื่อตรวจครบ', async () => {
  const { w, plan } = await boltWorld();
  await stockIn(w, 'QC-BOLT', 'A', 'A-01', 6, { lot: 'N1', status: 'AVAILABLE' });
  await stockIn(w, 'QC-BOLT', 'A', 'A-02', 2, { lot: 'N1', status: 'AVAILABLE' });
  await w.ok('QC1', 'lot.quarantine', { code: 'QC-BOLT', lot: 'N1', reason: 'ลูกค้าแจ้งเกลียวเสีย' });
  const n1 = (await w.ok('QC1', 'ncr.open', { code: 'QC-BOLT', wh: 'A', bin: 'A-01', lot: 'N1', qty: 4, defect: 'เกลียวเสีย' })).result.ncrNo;
  const n2 = (await w.ok('QC1', 'ncr.open', { code: 'QC-BOLT', wh: 'A', bin: 'A-02', lot: 'N1', qty: 2, defect: 'เกลียวเสีย' })).result.ncrNo;
  await w.ok('QCLEAD', 'ncr.disposition', { ncrNo: n1, disposition: 'REWORK', reason: 'ต๊าปเกลียวใหม่' });
  await w.ok('QCLEAD', 'ncr.disposition', { ncrNo: n2, disposition: 'REWORK', reason: 'ต๊าปเกลียวใหม่' });
  await w.ok('QCLEAD', 'lot.release', { code: 'QC-BOLT', lot: 'N1', reason: 'คัดแยกของเสียออกแล้ว' });
  let s = await w.state();
  assert.deepEqual([qty(s, { code: 'QC-BOLT', status: 'REWORK' }), qty(s, { code: 'QC-BOLT', status: 'QC_HOLD' })], [6, 2]);
  // the reworked pieces of NCR 1 are in A-01: the two at A-02 belong to NCR 2
  assert.equal(codeOf(await inspBolt(w, plan, 'N1', 2, boltOk, { bin: 'A-02', fromStatus: 'REWORK', reinspectionOf: n1 })), 'REINSPECT_MISMATCH');
  const r1 = await inspBolt(w, plan, 'N1', 4, boltOk, { fromStatus: 'REWORK', reinspectionOf: n1 });
  assert.equal(r1.ok, true, JSON.stringify(r1.errors));
  await w.ok('QCLEAD', 'qc.release', { id: r1.result.id });
  await w.ok('QCLEAD', 'ncr.close', { ncrNo: n1, note: 'ต๊าปใหม่แล้วผ่าน' });
  assert.equal(codeOf(await w.exec('QCLEAD', 'ncr.close', { ncrNo: n2 })), 'REINSPECTION_PENDING');
  s = await w.state();
  assert.deepEqual([qty(s, { code: 'QC-BOLT', lot: 'N1', status: 'AVAILABLE' }), qty(s, { code: 'QC-BOLT', lot: 'N1', status: 'REWORK' })], [4, 2]);
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
});

test('รีวิว 2: ยอดไม่คลาดหลังหลายขั้น – ปล่อยบางส่วน กักล็อต ปลด ของที่เบิกไปก่อนกลับมา (ยกเลิก/คืนจากงาน) ต้องตรวจใหม่', async () => {
  const w = await world();
  const plan = await approvedPlan(w, 'TST-PLATE', 'INCOMING', PLATE_CHARS);
  const rr = await receivePlate(w, 'H9', 10);
  await certVerified(w, 'H9');
  const p = await inspectPlate(w, plan, 'H9', 10, plateOk, { sourceDoc: rr });
  await w.ok('QCLEAD', 'qc.release', { id: p.result.id, qty: 4 });
  const pdOf = async (job, n) => (await w.ok('STORE1', 'doc.post', { type: 'PD', job, lines: [{ code: 'TST-PLATE', qty: n, wh: 'A', bin: 'A-01', lot: 'H9' }] })).result.docNo;
  const rtOf = (job, n) => w.ok('STORE1', 'doc.post', { type: 'RT', job, lines: [{ code: 'TST-PLATE', qty: n, wh: 'A', bin: 'A-01', lot: 'H9' }] });
  const pd = await pdOf('JOB-9', 1);
  await pdOf('JOB-8', 1);
  let s = await w.state();
  assert.deepEqual([qty(s, { code: 'TST-PLATE', status: 'AVAILABLE' }), qty(s, { code: 'TST-PLATE', status: 'QC_HOLD' })], [2, 6]);
  const q = await w.ok('QC1', 'lot.quarantine', { code: 'TST-PLATE', lot: 'H9', reason: 'ผู้ขายแจ้งเรียกคืน heat' });
  assert.equal(q.result.moved, 8);
  s = await w.state();
  assert.deepEqual([s.tables.inspections[p.result.id].status, s.tables.inspections[p.result.id].releasedQty], ['VOID', 4], 'the 4 released stay on record');
  assert.equal(codeOf(await w.exec('QCLEAD', 'qc.release', { id: p.result.id })), 'BAD_STATE');
  await w.ok('QCLEAD', 'lot.release', { code: 'TST-PLATE', lot: 'H9', reason: 'ผู้ขายยืนยันว่าไม่ใช่ heat ที่เรียกคืน' });
  // the piece issued before the quarantine comes back: the rest of the heat is being inspected again, so is it
  const c = await w.ok('LEAD', 'doc.cancel', { docNo: pd, reason: 'เบิกผิดงาน' });
  assert.ok(c.warnings.some((x) => x.includes('ตรวจใหม่')));
  const rt = await rtOf('JOB-8', 1); // the piece at job 8 during the quarantine comes back
  assert.ok(rt.warnings.some((x) => x.includes('ตรวจใหม่')));
  s = await w.state();
  assert.deepEqual([qty(s, { code: 'TST-PLATE', status: 'AVAILABLE' }), qty(s, { code: 'TST-PLATE', status: 'QC_HOLD' }), qty(s, { code: 'TST-PLATE', status: 'QUARANTINE' })], [0, 10, 0]);
  const again = await inspectPlate(w, plan, 'H9', 10, plateOk);
  await w.ok('QCLEAD', 'qc.release', { id: again.result.id });
  // a piece issued after that comes back as it left
  const pd2 = await pdOf('JOB-9', 2);
  await w.ok('LEAD', 'doc.cancel', { docNo: pd2, reason: 'เบิกเกิน' });
  await pdOf('JOB-7', 1);
  const rt7 = await rtOf('JOB-7', 1);
  assert.ok(!rt7.warnings.some((x) => x.includes('ตรวจใหม่')), 'issued after the release: comes back usable');
  assert.equal(codeOf(await w.exec('LEAD', 'doc.cancel', { docNo: pd2, reason: 'ซ้ำ' })), 'ALREADY_CANCELLED');
  s = await w.state();
  assert.deepEqual([qty(s, { code: 'TST-PLATE', status: 'AVAILABLE' }), qty(s, { code: 'TST-PLATE', status: 'QC_HOLD' })], [10, 0]);
  const moves = RRS.inventory.history(s, { code: 'TST-PLATE', lot: 'H9' });
  assert.equal(RRS.util.round(moves.reduce((x, m) => x + m.qty, 0)), 10);
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
});

test('รีวิว 2 (กันถอยหลัง): ตัดสินแล้วยกเลิกซ้ำหลายรอบ – ยอดและประวัติ NCR ถูก คำขอซ้ำไม่ทำซ้ำ', async () => {
  const { w, plan } = await boltWorld();
  const rr = await rrBolt(w, 'V1', 6);
  const f = await inspBolt(w, plan, 'V1', 3, boltBad, { sourceDoc: rr });
  const ncrNo = f.result.ncrNo;
  const scs = [];
  for (let i = 0; i < 2; i++) {
    const sc = await w.ok('QCLEAD', 'ncr.disposition', { ncrNo, disposition: 'SCRAP', reason: 'ยาวเกิน ใช้ไม่ได้' });
    scs.push(sc.result.docNo);
    await w.ok('LEAD', 'doc.cancel', { docNo: sc.result.docNo, reason: 'ผู้ขายจะรับคืน' });
  }
  assert.equal(codeOf(await w.exec('LEAD', 'doc.cancel', { docNo: scs[0], reason: 'ซ้ำ' })), 'ALREADY_CANCELLED');
  let s = await w.state();
  assert.equal(s.tables.ncrs[ncrNo].status, 'OPEN');
  assert.equal(qty(s, { code: 'QC-BOLT', lot: 'V1', status: 'QUARANTINE' }), 3);
  const ret = await w.ok('QCLEAD', 'ncr.disposition', { ncrNo, disposition: 'RETURN', reason: 'คืนผู้ขาย' });
  const c1 = await w.ok('QCLEAD', 'ncr.close', { ncrNo, note: 'ผู้ขายรับแล้ว' }, 'req-close-v1');
  const c2 = await w.exec('QCLEAD', 'ncr.close', { ncrNo, note: 'ผู้ขายรับแล้ว' }, 'req-close-v1');
  assert.equal(c2.ok, true);
  s = await w.state();
  const n = s.tables.ncrs[ncrNo];
  assert.deepEqual(n.history.map((h) => h.action), ['OPEN', 'DISPOSITION', 'UNDO', 'DISPOSITION', 'UNDO', 'DISPOSITION', 'CLOSE']);
  assert.deepEqual([n.docNo, n.docType, n.closedBy], [ret.result.docNo, 'RV', 'QCLEAD']);
  assert.ok(c1.ok);
  assert.deepEqual([qty(s, { code: 'QC-BOLT', lot: 'V1', status: 'QUARANTINE' }), qty(s, { code: 'QC-BOLT', lot: 'V1', status: 'QC_HOLD' }),
    qty(s, { code: 'QC-BOLT', lot: 'V1' })], [0, 3, 3]);
  assert.deepEqual(RRS.inventory.verifyBalances(s), []);
});
