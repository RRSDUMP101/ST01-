// Phase 6 – pilot run, reports and rollout (file 01): acceptance criteria, reports, offcut register, UAT, backup.
// Builds stock with core/master/inventory commands and Phase 6 commands only; tables of modules written in
// parallel (jobs, reservations, count_sessions, inspections, ncrs, lots) are put straight into a copy of the state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RRS, world, stockIn } from './helpers.mjs';

const R = RRS.reports;
const clone = (s) => JSON.parse(JSON.stringify(s));
const byId = (rows, k, v) => rows.find((r) => r[k] === v);
const THAI = /[฀-๿]/;
const engineDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'engine');

/** A command run against a given state without saving (for states with rows put in by hand). */
const dry = (state, user, kind, payload, now = '2026-11-30T03:00:00.000Z') => RRS.core.prepare(state, { kind, payload }, { now, user });
const code = (r) => (r.ok ? 'OK' : r.errors[0].code);

async function plateWorld(opts) {
  const w = await world(opts);
  await w.ok('LEAD', 'master.import', { items: [
    { code: 'TST-SHEET', name: 'แผ่นเหล็ก SS400 3 มม.', baseUnit: 'แผ่น', type: 'RM', material: 'SS400', thickness: 3, width: 1220, length: 2440, trackLot: 'heat' },
    { code: 'TST-SHEET45', name: 'แผ่นเหล็ก SS400 4.5 มม.', baseUnit: 'แผ่น', type: 'RM', material: 'SS400', thickness: 4.5, width: 1220, length: 2440 },
    { code: 'TST-SPHC', name: 'แผ่น SPHC 3 มม.', baseUnit: 'แผ่น', type: 'RM', material: 'SPHC', thickness: 3, width: 1219, length: 2438 },
  ] });
  await stockIn(w, 'TST-SHEET', 'A', 'A-01', 5, { lot: 'H-77' });
  await stockIn(w, 'TST-SPHC', 'A', 'A-01', 2);
  return w;
}

// =================================================================================================================
// Acceptance criteria of Phase 6
// =================================================================================================================
test('P6-1 ไม่มีข้อผิดพลาดรุนแรงที่ทำให้ยอดคลาดเคลื่อน ตัดซ้ำ หรือปล่อยของกักกัน: ทดลองครบวงจรแล้วตรวจยอดประจำวันผ่าน', async () => {
  const w = await world();
  // รับ (ของต้องตรวจเข้ารอตรวจ) – จัดเก็บ – เบิก (ส่งซ้ำ) – ผลิต (รอตรวจ) – คืน – โอน/รับโอน – ยกเลิก
  const rr = await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'TST-PLATE', qty: 5, wh: 'A', bin: 'A-01', lot: 'H1' }] });
  await stockIn(w, 'TST-001', 'A', 'A-01', 20);
  const pd = { type: 'PD', lines: [{ code: 'TST-001', qty: 5, wh: 'A', bin: 'A-01' }] };
  await w.ok('STORE1', 'doc.post', pd, 'phone-pd-1');
  const again = await w.exec('STORE1', 'doc.post', pd, 'phone-pd-1');
  assert.equal(again.duplicate, true);
  await w.ok('LEAD', 'doc.post', { type: 'FR', lines: [{ code: 'TST-FG', qty: 2, wh: 'A', bin: 'A-02' }] });
  await w.ok('STORE1', 'doc.post', { type: 'RT', lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01' }] });
  const tr = await w.ok('STORE1', 'doc.post', { type: 'TR', lines: [{ code: 'TST-001', qty: 4, wh: 'A', bin: 'A-01', toWh: 'B', toBin: 'B-01' }] });
  await w.ok('STORE2', 'transfer.receive', { docNo: tr.result.docNo });
  const ou = await w.ok('STORE1', 'doc.post', { type: 'OU', lines: [{ code: 'TST-001', qty: 1, wh: 'B', bin: 'B-01' }] });
  await w.ok('LEAD', 'doc.cancel', { docNo: ou.result.docNo, reason: 'ทดสอบยกเลิก' });
  // ของรอตรวจเบิกไม่ได้; ยกเลิกใบรับของรอตรวจทั้งใบได้ (ไม่ใช่การปล่อยของกักกัน)
  const held = await w.exec('STORE1', 'doc.post', { type: 'PD', lines: [{ code: 'TST-PLATE', qty: 1, wh: 'A', bin: 'A-01', lot: 'H1', status: 'QC_HOLD' }] });
  assert.equal(held.errors[0].code, 'BAD_STATUS');
  const rr2 = await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'TST-PLATE', qty: 1, wh: 'A', bin: 'A-02', lot: 'H2' }] });
  await w.ok('LEAD', 'doc.cancel', { docNo: rr2.result.docNo, reason: 'รับผิดใบ' });

  const s = clone(await w.state());
  assert.equal(RRS.q.qty(s, { code: 'TST-001', wh: 'A' }), 12);
  assert.equal(RRS.q.qty(s, { code: 'TST-001', wh: 'B' }), 4);
  const chk = R.dailyCheck(s);
  assert.deepEqual(chk.problems, []);
  assert.equal(chk.ok, true);
  assert.ok(chk.checks.every((c) => c.ok && THAI.test(c.label)));
  assert.ok(chk.requests.count >= 1);
  assert.deepEqual(chk.quarantineLeaks, []);
  assert.deepEqual(chk.doublePosted, []);
  // งานรอ QC เห็นของรอตรวจทั้งสองรายการ
  const qp = R.qcPending(s, { today: '2026-11-02' });
  assert.deepEqual(qp.rows.map((r) => [r.code, r.status, r.qty]).sort(), [['TST-FG', 'QC_HOLD', 2], ['TST-PLATE', 'QC_HOLD', 5]]);
  assert.ok(rr.result.docNo);
  // ผลตรวจประจำวันถูกบันทึกโดยระบบ (ผู้ใช้ส่งได้แค่หมายเหตุ)
  const dc = await w.ok('LEAD', 'daily.check', { note: 'ปิดวัน', ok: false, problems: ['ปลอม'] });
  const s2 = await w.state();
  const row = s2.tables.daily_checks[dc.result.id];
  assert.equal(row.ok, true);
  assert.deepEqual(row.problems, []);
  assert.equal(row.by, 'LEAD');
  assert.equal(row.date, '2026-11-02');
  assert.equal(row.seq, s.seq);
});

test('P6-1 ไม่มีข้อผิดพลาดรุนแรง…: ตรวจยอดประจำวันจับยอดคลาดเคลื่อน ตัดซ้ำ ของกักกันหลุด ติดลบไม่อนุมัติ และยกเลิกไม่กลับยอด', async () => {
  const w = await world();
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  await stockIn(w, 'TST-001', 'A', 'A-02', 3, { status: 'QUARANTINE' });
  const pd = await w.ok('STORE1', 'doc.post', { type: 'PD', lines: [{ code: 'TST-001', qty: 2, wh: 'A', bin: 'A-01' }] });
  // ยอดติดลบที่อนุมัติแล้ว – แสดงพร้อมเอกสาร แต่ไม่ใช่ปัญหา
  await w.ok('ADMIN', 'settings.update', { patch: { policies: { negativeStock: 'approve' } } });
  const draft = await w.ok('STORE1', 'doc.saveDraft', { type: 'OU', lines: [{ code: 'TST-002', qty: 2, wh: 'A', bin: 'A-01' }] });
  await w.ok('STORE1', 'doc.requestOverride', { docNo: draft.result.docNo, reason: 'ของมาแล้วยังไม่ลงระบบ' });
  await w.ok('LEAD', 'doc.approveOverride', { docNo: draft.result.docNo });
  const base = await w.state();
  const ok = R.dailyCheck(base);
  assert.equal(ok.ok, true, ok.problems.join('; '));
  assert.equal(ok.negatives.length, 1);
  assert.equal(ok.negatives[0].approved, true);
  assert.equal(ok.negatives[0].docs[0].docNo, draft.result.docNo);
  assert.equal(ok.negatives[0].docs[0].approvedBy, 'LEAD');

  const pdMove = RRS.inventory.history(base, { docNo: pd.result.docNo })[0];
  const k = RRS.balanceKey(pdMove);
  // (ก) ยอดคลาดเคลื่อน
  const s1 = clone(base);
  s1.tables.balances[k].qty += 1;
  const c1 = R.dailyCheck(s1);
  assert.equal(c1.ok, false);
  assert.equal(c1.balanceDiffs.length, 1);
  assert.equal(c1.checks.find((c) => c.id === 'balances').ok, false);
  // (ข) ตัดซ้ำ: เอกสารเดิมตัดยอดอีกครั้งใน commit อื่น
  const s2 = clone(base);
  s2.tables.movements['999.1'] = Object.assign({}, pdMove, { id: '999.1', seq: 999 });
  s2.tables.balances[k].qty += pdMove.qty;
  const c2 = R.dailyCheck(s2);
  assert.equal(c2.ok, false);
  assert.deepEqual(c2.balanceDiffs, []);
  assert.equal(c2.doublePosted[0].docNo, pd.result.docNo);
  assert.match(c2.problems.join(' '), /บันทึก 2 ครั้ง/);
  // (ข) ตัดซ้ำในบรรทัดเดียวกัน (commit เดียว)
  const s3 = clone(base);
  s3.tables.movements[`${pdMove.seq}.99`] = Object.assign({}, pdMove, { id: `${pdMove.seq}.99` });
  s3.tables.balances[k].qty += pdMove.qty;
  assert.match(R.dailyCheck(s3).problems.join(' '), /บรรทัด 1 ตัดยอดมากกว่า 1 ครั้ง/);
  // (ค) ของกักกันถูกเบิกออกด้วยเอกสารที่ไม่ใช่ QS/SC/RV
  const s4 = clone(base);
  const qk = RRS.balanceKey({ code: 'TST-001', wh: 'A', bin: 'A-02', status: 'QUARANTINE', lot: '' });
  s4.tables.movements['998.1'] = { id: '998.1', seq: 998, at: '2026-11-02T05:00:00.000Z', date: '2026-11-02', docType: 'PD', docNo: 'PD-FAKE',
    line: 1, code: 'TST-001', wh: 'A', bin: 'A-02', status: 'QUARANTINE', lot: '', qty: -1, balanceAfter: 2, job: '', by: 'STORE1', reversalOf: '', remark: '' };
  s4.tables.balances[qk].qty = 2;
  const c4 = R.dailyCheck(s4);
  assert.equal(c4.ok, false);
  assert.equal(c4.quarantineLeaks.length, 1);
  assert.equal(c4.quarantineLeaks[0].docNo, 'PD-FAKE');
  assert.match(c4.problems.join(' '), /กักกัน TST-001 ออก 1/);
  // ทางที่ถูกต้อง (QS/SC/RV) ไม่นับเป็นปัญหา
  const s4b = clone(base);
  s4b.tables.movements['998.1'] = Object.assign({}, s4.tables.movements['998.1'], { docType: 'SC', docNo: 'SC-OK' });
  s4b.tables.balances[qk].qty = 2;
  assert.equal(R.dailyCheck(s4b).ok, true);
  // (ง) ติดลบโดยไม่มีเอกสารอนุมัติ
  const s5 = clone(base);
  const nk = RRS.balanceKey({ code: 'TST-002', wh: 'B', bin: 'B-01', status: 'AVAILABLE', lot: '' });
  s5.tables.balances[nk] = { code: 'TST-002', wh: 'B', bin: 'B-01', status: 'AVAILABLE', lot: '', qty: -1 };
  s5.tables.movements['997.1'] = Object.assign({}, s4.tables.movements['998.1'], { id: '997.1', seq: 997, docType: 'OU', docNo: 'OU-NOAPPROVAL',
    code: 'TST-002', wh: 'B', bin: 'B-01', status: 'AVAILABLE', qty: -1, balanceAfter: -1 });
  const c5 = R.dailyCheck(s5);
  assert.equal(c5.ok, false);
  assert.equal(c5.negatives.find((n) => n.code === 'TST-002' && n.wh === 'B').approved, false);
  // (จ) เอกสารยกเลิกแล้วแต่ยอดไม่กลับ
  const s6 = clone(base);
  s6.tables.documents[pd.result.docNo].status = 'CANCELLED';
  const c6 = R.dailyCheck(s6);
  assert.equal(c6.cancelNotReversed[0].docNo, pd.result.docNo);
  // ข้อมูลที่ตรวจไม่ผ่าน ยอมรับยอดไม่ได้ (คำสั่งไม่เปลี่ยนอะไร)
  const sign = dry(s1, 'LEAD', 'uat.signoff', { area: 'store', decision: 'ACCEPT' });
  assert.equal(code(sign), 'INTEGRITY');
  assert.equal(code(dry(base, 'LEAD', 'uat.signoff', { area: 'store', decision: 'ACCEPT' })), 'OK');
});

test('P6-2 สโตร์/QC/บัญชียอมรับยอดและขั้นตอน: ลงนามตามบทบาท คนละคนต่อฝ่าย และยอดในรายงานตรงกับยอดในระบบ', async () => {
  const w = await world();
  await w.ok('LEAD', 'item.upsert', { code: 'TST-001', name: 'ชิ้นทดสอบ 1', baseUnit: 'ชิ้น', type: 'PART', unitCost: 25 });
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  await stockIn(w, 'TST-001', 'B', 'B-01', 4);
  await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'TST-PLATE', qty: 3, wh: 'A', bin: 'A-02', lot: 'H9' }] });
  const s = await w.state();
  // ยอดที่ฝ่ายต่าง ๆ ยอมรับ = ยอดในระบบ
  const rep = R.stockByLocation(s);
  const sum = RRS.inventory.summary(s);
  for (const c of Object.keys(sum)) assert.equal(rep.totals.qtyByCode[c], sum[c].total, c);
  assert.equal(rep.totals.value, 350);

  assert.equal(code(await w.exec('STORE1', 'uat.signoff', { area: 'store', decision: 'ACCEPT' })), 'NO_PERMISSION');
  assert.equal(code(await w.exec('QCLEAD', 'uat.signoff', { area: 'store', decision: 'ACCEPT' })), 'NOT_AREA_ROLE');
  assert.equal(code(await w.exec('ADMIN', 'uat.signoff', { area: 'accounting', decision: 'ACCEPT' })), 'NOT_AREA_ROLE');
  assert.equal(code(await w.exec('LEAD', 'uat.signoff', { area: 'warehouse', decision: 'ACCEPT' })), 'BAD_VALUE');
  assert.equal(code(await w.exec('LEAD', 'uat.signoff', { area: 'store', decision: 'MAYBE' })), 'BAD_VALUE');
  assert.equal(code(await w.exec('ACC', 'uat.signoff', { area: 'accounting', decision: 'REJECT' })), 'REQUIRED');
  await w.ok('ACC', 'uat.signoff', { area: 'accounting', decision: 'REJECT', note: 'รอปิดยอดเดือนก่อน' });
  await w.ok('LEAD', 'uat.signoff', { area: 'store', decision: 'ACCEPT', note: 'ยอดคลัง A/B ตรงกับนับจริง' });
  await w.ok('QCLEAD', 'uat.signoff', { area: 'qc', decision: 'ACCEPT' });
  let s2 = await w.state();
  const ro = { id: 'X', owner: 'LEAD', team: [], rollbackPlan: '' };
  let sg = R.rolloutReadiness(s2, { rollout: ro }).checks.find((c) => c.id === 'signoff');
  assert.equal(sg.ok, false);
  assert.match(sg.detail, /บัญชี/);
  const acc = await w.ok('ACC', 'uat.signoff', { area: 'accounting', decision: 'ACCEPT', note: 'ยอดตรงกับ Express ณ วันตัดยอด' });
  s2 = await w.state();
  const row = s2.tables.uat_signoffs[acc.result.id];
  assert.equal(row.by, 'ACC');
  assert.equal(row.role, 'accounting');
  assert.ok(row.at);
  assert.equal(row.uat.total, R.UAT_CRITERIA.length);
  sg = R.rolloutReadiness(s2, { rollout: ro }).checks.find((c) => c.id === 'signoff');
  assert.equal(sg.ok, true, sg.detail);
  // คนเดียวมีสองบทบาท ลงนามแทนสองฝ่ายไม่ได้
  const w2 = await world();
  await w2.ok('ADMIN', 'user.upsert', { id: 'DUAL', name: 'สองบทบาท', roles: ['store_lead', 'accounting'] });
  await w2.ok('DUAL', 'uat.signoff', { area: 'store', decision: 'ACCEPT' });
  assert.equal(code(await w2.exec('DUAL', 'uat.signoff', { area: 'accounting', decision: 'ACCEPT' })), 'SAME_PERSON');
});

test('P6-3 กู้ข้อมูลได้: เล่นซ้ำไฟล์สำรองได้ข้อมูลเท่าระบบจริง และบันทึกผลทดสอบกู้คืนพร้อมผู้ทดสอบ/เวลา', async () => {
  const w = await world();
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  const tr = await w.ok('STORE1', 'doc.post', { type: 'TR', lines: [{ code: 'TST-001', qty: 3, wh: 'A', bin: 'A-01', toWh: 'B' }] });
  await w.ok('STORE2', 'transfer.receive', { docNo: tr.result.docNo, lines: [{ line: 1, qty: 1 }] });
  const live = clone(await w.state());
  const file = JSON.stringify({ commits: w.store.commits });
  const v = R.verifyBackup(file, { compare: live, keepState: true });
  assert.deepEqual(v.problems, []);
  assert.equal(v.ok, true);
  assert.equal(v.commits, live.seq);
  assert.equal(v.head, live.head);
  assert.equal(v.fingerprint, R.fingerprint(live));
  assert.deepEqual(v.state.tables.balances, live.tables.balances);
  assert.equal(v.tables.movements, Object.keys(live.tables.movements).length);

  assert.equal(code(await w.exec('STORE1', 'backup.recordTest', { commits: v.commits, head: v.head, result: 'OK' })), 'NO_PERMISSION');
  const bt = await w.ok('ACC', 'backup.recordTest', { commits: v.commits, head: v.head, result: 'OK', fingerprint: v.fingerprint, note: 'กู้ลงเครื่องทดสอบ' });
  let s = await w.state();
  const row = s.tables.backup_tests[bt.result.id];
  assert.equal(row.by, 'ACC');
  assert.equal(row.result, 'OK');
  assert.equal(row.commits, live.seq);
  assert.match(row.at, /^2026-11-02T/);
  // ไฟล์ที่ไม่ตรงกับระบบ / ข้อมูลผิดรูปแบบ ไม่ถูกบันทึก
  const seq = s.seq;
  assert.equal(code(await w.exec('ACC', 'backup.recordTest', { commits: s.seq, head: 'a'.repeat(64), result: 'OK' })), 'HEAD_MISMATCH');
  assert.equal(code(await w.exec('ACC', 'backup.recordTest', { commits: s.seq + 5, head: s.head, result: 'OK' })), 'HEAD_MISMATCH');
  assert.equal(code(await w.exec('ACC', 'backup.recordTest', { commits: 3, head: 'xyz', result: 'OK' })), 'BAD_VALUE');
  assert.equal(code(await w.exec('ACC', 'backup.recordTest', { commits: -1, head: s.head, result: 'OK' })), 'BAD_VALUE');
  assert.equal(code(await w.exec('ACC', 'backup.recordTest', { commits: s.seq, head: s.head, result: 'MAYBE' })), 'BAD_VALUE');
  assert.equal(code(await w.exec('ACC', 'backup.recordTest', { commits: s.seq, head: s.head, result: 'OK', problems: ['ยอดไม่ตรง'] })), 'BAD_VALUE');
  assert.equal(code(await w.exec('ACC', 'backup.recordTest', { commits: s.seq, head: s.head, result: 'FAIL' })), 'REQUIRED');
  assert.equal((await w.state()).seq, seq);
  // ผลไม่ผ่านก็เก็บเป็นหลักฐานได้; ไฟล์เก่ากว่าระบบได้คำเตือน
  await w.ok('MGR', 'backup.recordTest', { commits: s.seq, head: s.head, result: 'FAIL', problems: ['ไฟล์ขาดช่วง'] });
  const old = await w.ok('ACC', 'backup.recordTest', { commits: 5, head: w.store.commits[4].hash, result: 'OK' });
  assert.equal(old.warnings.length, 1);
});

test('P6-3 กู้ข้อมูลได้: ไฟล์สำรองที่ถูกแก้ ขาดช่วง สลับลำดับ คนละประวัติ หรืออ่านไม่ได้ ถูกตรวจพบ', async () => {
  const w = await world();
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  await w.ok('STORE1', 'doc.post', { type: 'PD', lines: [{ code: 'TST-001', qty: 4, wh: 'A', bin: 'A-01' }] });
  const commits = clone(w.store.commits);
  const n = commits.length;
  const live = clone(await w.state());
  // แก้ยอดในไฟล์
  const t = clone(commits);
  const ci = t.findIndex((c) => c.effects.some((e) => e.t === 'balances'));
  t[ci].effects.find((e) => e.t === 'balances').v.qty = 999;
  const vt = R.verifyBackup(t);
  assert.equal(vt.ok, false);
  assert.match(vt.problems[0], /ลายนิ้วมือไม่ตรง/);
  assert.equal(vt.commits, ci);
  // ขาดช่วง / สลับลำดับ
  assert.match(R.verifyBackup(commits.filter((c, i) => i !== 2)).problems[0], /ไม่ต่อจากลำดับ 2/);
  const sw = clone(commits);
  [sw[3], sw[4]] = [sw[4], sw[3]];
  assert.equal(R.verifyBackup(sw).ok, false);
  // คนละประวัติ: commit ลำดับเดียวกันจากอีกระบบ
  const w2 = await world();
  await stockIn(w2, 'TST-001', 'A', 'A-01', 7);
  await stockIn(w2, 'TST-001', 'A', 'A-01', 1);
  const mixed = commits.slice(0, n - 1).concat([clone(w2.store.commits[n - 1])]);
  assert.equal(mixed[n - 1].seq, n);
  assert.notEqual(mixed[n - 1].prev, commits[n - 2].hash);
  assert.match(R.verifyBackup(mixed).problems[0], /คนละประวัติ/);
  // อ่านไม่ได้ / ว่าง / ไม่ใช่ commit
  assert.equal(R.verifyBackup('not json').ok, false);
  assert.equal(R.verifyBackup([]).ok, false);
  assert.match(R.verifyBackup([null]).problems[0], /ไม่ใช่ commit/);
  assert.equal(R.verifyBackup({}).ok, false);
  // กู้ได้ไม่ครบเทียบกับระบบจริง
  const part = R.verifyBackup(commits.slice(0, n - 1), { compare: live });
  assert.equal(part.ok, false);
  assert.match(part.problems[0], new RegExp(`กู้ได้ถึงลำดับ ${n - 1}`));
  assert.equal(R.verifyBackup(commits, { compare: live }).ok, true);
});

test('P6-4 ตัวชี้วัดตรงตามเป้าหมายที่ตกลงใน Phase 0: คำนวณค่าจริงเทียบค่าก่อนเริ่มและเป้าหมาย', async () => {
  const w = await world();
  await w.ok('LEAD', 'item.upsert', { code: 'TST-003', name: 'ชิ้นทดสอบ 3', baseUnit: 'ชิ้น', type: 'PART' });
  for (const k of [['count_accuracy', 85, 95], ['qc_wait', 48, 24], ['fpy', 80, 90], ['repeat_ncr', 5, 1], ['shortage', 10, 2]]) {
    await w.ok('MGR', 'kpi.record', { id: k[0], baseline: k[1], target: k[2], measuredOn: '2026-10-31', note: 'ค่าตั้งต้นก่อนทดลอง' });
  }
  assert.equal(code(await w.exec('STORE1', 'kpi.record', { id: 'fpy', baseline: 1, target: 2 })), 'NO_PERMISSION');
  const r1 = await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'TST-PLATE', qty: 2, wh: 'A', bin: 'A-01', lot: 'H1' }] });
  const r2 = await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'TST-PLATE', qty: 2, wh: 'A', bin: 'A-01', lot: 'H2' }] });
  const s = clone(await w.state());
  const at1 = RRS.inventory.history(s, { docNo: r1.result.docNo })[0].at;
  const at2 = RRS.inventory.history(s, { docNo: r2.result.docNo })[0].at;
  const plus = (iso, h) => new Date(Date.parse(iso) + h * 3600e3).toISOString();
  s.tables.inspections = {
    'IN-00001': { id: 'IN-00001', stage: 'INCOMING', code: 'TST-PLATE', wh: 'A', bin: 'A-01', lot: 'H1', fromStatus: 'QC_HOLD', sourceDoc: r1.result.docNo, at: plus(at1, 10), result: 'PASS', status: 'RELEASED', reinspectionOf: '' },
    'IN-00002': { id: 'IN-00002', stage: 'INCOMING', code: 'TST-PLATE', wh: 'A', bin: 'A-01', lot: 'H2', fromStatus: 'QC_HOLD', sourceDoc: r2.result.docNo, at: plus(at2, 14), result: 'PASS', status: 'RELEASED', reinspectionOf: '' },
  };
  const lines = [];
  for (let i = 0; i < 20; i++) lines.push({ code: 'TST-001', bin: `X${i}`, system: 10, counted: i === 0 ? 20 : 10, final: { counted: i === 0 ? 20 : 10, system: 10 } });
  s.tables.count_sessions = { 'CT-00001': { id: 'CT-00001', wh: 'A', status: 'APPROVED', approvedAt: '2026-11-10T03:00:00.000Z', approvedBy: 'LEAD', lines } };
  s.tables.ncrs = {
    'NCR-1': { ncrNo: 'NCR-1', code: 'TST-PLATE', defect: 'รอยร้าว', createdAt: '2026-11-03T03:00:00.000Z', status: 'CLOSED' },
    'NCR-2': { ncrNo: 'NCR-2', code: 'TST-PLATE', defect: 'รอยร้าว', createdAt: '2026-11-12T03:00:00.000Z', status: 'OPEN' },
  };
  s.tables.jobs = { J1: { jobNo: 'J1', status: 'OPEN', lines: [{ line: 1, code: 'TST-001', required: 5, issued: 0 }, { line: 2, code: 'TST-002', required: 1, issued: 0 },
    { line: 3, code: 'TST-003', required: 2, issued: 1 }] } };
  const k = R.kpiActuals(s, { today: '2026-11-20' });
  assert.deepEqual(k.period, { from: '2026-11-01', to: '2026-11-20' });
  const get = (id) => byId(k.rows, 'id', id);
  assert.deepEqual([get('count_accuracy').actual, get('count_accuracy').met, get('count_accuracy').improved], [95, true, true]);
  assert.deepEqual([get('qc_wait').actual, get('qc_wait').met, get('qc_wait').baseline, get('qc_wait').target], [12, true, 48, 24]);
  assert.deepEqual([get('fpy').actual, get('fpy').met], [100, true]);
  assert.deepEqual([get('repeat_ncr').actual, get('repeat_ncr').met], [1, true]);
  assert.deepEqual([get('shortage').actual, get('shortage').met, get('shortage').improved], [3, false, true]);
  assert.equal(get('issue_lead').actual, null);
  assert.equal(get('issue_lead').met, null);
  assert.equal(k.totals.met, 4);
  assert.equal(k.totals.notMet, 1);
  assert.ok(k.cols.every((c) => THAI.test(c.label)));
  // นอกช่วงเวลา = ยังวัดไม่ได้ (ไม่เดาค่า)
  const dec = R.kpiActuals(s, { today: '2026-12-15' });
  assert.equal(byId(dec.rows, 'id', 'fpy').actual, null);
  assert.equal(byId(dec.rows, 'id', 'fpy').met, null);
  // ตัวชี้วัดถึงเป้าเป็นข้อมูลประกอบในความพร้อมขยายผล
  const rd = R.rolloutReadiness(s, { rollout: { id: 'X', team: [] }, today: '2026-11-20' });
  const kc = rd.checks.find((c) => c.id === 'kpi');
  assert.equal(kc.required, false);
  assert.equal(kc.ok, false);
  assert.match(kc.detail, /ของขาด/);
});

test('P6-5 มีผู้รับผิดชอบและแผนย้อนกลับก่อนขยาย: แผนขยายผลต้องพร้อมครบ ผู้อนุมัติไม่ใช่ผู้เสนอ และย้อนกลับได้', async () => {
  const w = await world();
  await w.ok('LEAD', 'item.upsert', { code: 'TST-001', name: 'ชิ้นทดสอบ 1', baseUnit: 'ชิ้น', type: 'PART', group: 'กระบะ-01' });
  await stockIn(w, 'TST-001', 'A', 'A-01', 5);
  const plan = { title: 'ขยายกลุ่มกระบะ-01 ไปคลัง B', groups: ['กระบะ-01'], warehouses: ['b'], owner: 'LEAD', team: ['STORE1', 'QC1'],
    rollbackPlan: 'ปิดสวิตช์กลุ่มทดลอง กู้ข้อมูลจากสำรองล่าสุด แล้วคีย์เอกสารหลังตัดยอดซ้ำในระบบเดิม' };
  const before = (await w.state()).seq;
  assert.equal(code(await w.exec('LEAD', 'rollout.propose', { ...plan, owner: '' })), 'REQUIRED');
  assert.equal(code(await w.exec('LEAD', 'rollout.propose', { ...plan, owner: 'NOBODY' })), 'REQUIRED');
  assert.equal(code(await w.exec('LEAD', 'rollout.propose', { ...plan, rollbackPlan: 'กู้คืน' })), 'REQUIRED');
  assert.equal(code(await w.exec('LEAD', 'rollout.propose', { ...plan, groups: [], warehouses: [] })), 'REQUIRED');
  assert.equal(code(await w.exec('LEAD', 'rollout.propose', { ...plan, warehouses: ['Z'] })), 'NOT_FOUND');
  assert.equal(code(await w.exec('LEAD', 'rollout.propose', { ...plan, team: [] })), 'REQUIRED');
  assert.equal(code(await w.exec('LEAD', 'rollout.propose', { ...plan, team: ['GHOST'] })), 'NOT_FOUND');
  assert.equal(code(await w.exec('LEAD', 'rollout.propose', { ...plan, phases: [9] })), 'BAD_VALUE');
  assert.equal(code(await w.exec('VIEW', 'rollout.propose', plan)), 'NO_PERMISSION');
  assert.equal((await w.state()).seq, before);
  const p1 = await w.ok('LEAD', 'rollout.propose', plan);
  const id = p1.result.id;
  assert.equal(id, 'RO-00001');
  // ยังไม่พร้อม: ไม่มีผลกู้ข้อมูล UAT การยอมรับ และการอบรม
  assert.equal(code(await w.exec('STORE1', 'rollout.approve', { id })), 'NO_PERMISSION');
  const nr = await w.exec('MGR', 'rollout.approve', { id });
  assert.equal(code(nr), 'NOT_READY');
  let s = await w.state();
  const fail = R.rolloutReadiness(s, { id, today: '2026-11-02' }).checks.filter((c) => c.required && !c.ok).map((c) => c.id);
  assert.deepEqual(fail, ['backup', 'uat', 'signoff', 'training']);
  // เตรียมความพร้อม
  const v = R.verifyBackup(w.store.commits, { compare: s });
  await w.ok('ACC', 'backup.recordTest', { commits: v.commits, head: v.head, result: 'OK', note: 'กู้ลงเครื่องสำรอง' });
  for (const c of R.UAT_CRITERIA) await w.ok('QC1', 'uat.record', { id: c.id, status: 'PASS', evidence: c.auto });
  await w.ok('LEAD', 'training.record', { userId: 'STORE1', role: 'store', topic: 'รับ–เบิก–โอน และกรณีผิดพลาด' });
  s = await w.state();
  let rd = R.rolloutReadiness(s, { id, today: '2026-11-02' });
  assert.match(rd.checks.find((c) => c.id === 'training').detail, /QC1/);
  await w.ok('LEAD', 'training.record', { userId: 'QC1', role: 'qc', topic: 'ตรวจรับและกักกัน' });
  await w.ok('LEAD', 'uat.signoff', { area: 'store', decision: 'ACCEPT' });
  await w.ok('QCLEAD', 'uat.signoff', { area: 'qc', decision: 'ACCEPT' });
  await w.ok('ACC', 'uat.signoff', { area: 'accounting', decision: 'ACCEPT' });
  s = await w.state();
  rd = R.rolloutReadiness(s, { id, today: '2026-11-02' });
  assert.equal(rd.ok, true, rd.problems.join(' | '));
  // ผู้เสนอแผนอนุมัติแผนของตัวเองไม่ได้
  const own = await w.ok('MGR', 'rollout.propose', { ...plan, title: 'แผนของผู้บริหาร', groups: [], warehouses: ['B'] });
  assert.equal(code(await w.exec('MGR', 'rollout.approve', { id: own.result.id })), 'SAME_PERSON');
  await w.ok('MGR', 'rollout.approve', { id });
  s = await w.state();
  let r = s.tables.rollouts[id];
  assert.equal(r.status, 'APPROVED');
  assert.equal(r.approvedBy, 'MGR');
  assert.ok(r.approvedAt);
  assert.ok(r.readiness.every((c) => c.ok || c.id === 'kpi'));
  assert.deepEqual(s.tables.settings.main.pilot.groups, ['กระบะ-01']);
  assert.deepEqual(s.tables.settings.main.pilot.warehouses, ['B']);
  assert.equal(code(await w.exec('MGR', 'rollout.approve', { id })), 'BAD_STATE');
  // แผนที่สองครอบคลุมคลัง B ด้วย – ย้อนกลับแผนแรกแล้วคลัง B ยังอยู่ แต่กลุ่มกระบะ-01 ออก
  await w.ok('ADMIN', 'rollout.approve', { id: own.result.id });
  assert.equal(code(await w.exec('MGR', 'rollout.rollback', { id })), 'REQUIRED');
  await w.ok('MGR', 'rollout.rollback', { id, reason: 'พบยอดคลัง B ไม่ตรงหลังขยาย' });
  s = await w.state();
  r = s.tables.rollouts[id];
  assert.equal(r.status, 'ROLLED_BACK');
  assert.equal(r.rolledBackBy, 'MGR');
  assert.deepEqual(r.history.map((h) => h.action), ['PROPOSE', 'APPROVE', 'ROLLBACK']);
  assert.deepEqual(s.tables.settings.main.pilot.groups, []);
  assert.deepEqual(s.tables.settings.main.pilot.warehouses, ['B']);
  assert.equal(code(await w.exec('MGR', 'rollout.rollback', { id, reason: 'ซ้ำ' })), 'BAD_STATE');
  // ไม่อนุมัติ
  const p3 = await w.ok('LEAD', 'rollout.propose', { ...plan, warehouses: [] });
  assert.equal(code(await w.exec('MGR', 'rollout.reject', { id: p3.result.id })), 'REQUIRED');
  await w.ok('MGR', 'rollout.reject', { id: p3.result.id, reason: 'รอผลทดลองเดือนหน้า' });
  s = await w.state();
  assert.equal(s.tables.rollouts[p3.result.id].status, 'REJECTED');
  assert.equal(s.tables.rollouts[p3.result.id].rejectedBy, 'MGR');
  assert.equal(code(await w.exec('MGR', 'rollout.approve', { id: p3.result.id })), 'BAD_STATE');
});

// =================================================================================================================
// Plan item 2 – reports
// =================================================================================================================
test('รายงานยอดตามคลัง/ช่องเก็บ/สถานะ พร้อมมูลค่าอ้างอิงและหมายเหตุว่ามูลค่ายึดข้อตกลงกับบัญชี/Express', async () => {
  const w = await world();
  await w.ok('LEAD', 'item.upsert', { code: 'TST-001', name: 'ชิ้นทดสอบ 1', baseUnit: 'ชิ้น', type: 'PART', unitCost: 10 });
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  await stockIn(w, 'TST-001', 'B', 'B-01', 3);
  await stockIn(w, 'TST-002', 'A', 'A-02', 4);
  await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'TST-PLATE', qty: 2, wh: 'A', bin: 'A-01', lot: 'H1' }] });
  await w.ok('STORE1', 'doc.post', { type: 'TR', lines: [{ code: 'TST-001', qty: 2, wh: 'A', bin: 'A-01', toWh: 'B', toBin: 'B-01' }] });
  const s = await w.state();
  const r = R.stockByLocation(s);
  assert.equal(r.rows.length, 5);
  const a01 = r.rows.find((x) => x.code === 'TST-001' && x.wh === 'A');
  assert.deepEqual([a01.bin, a01.qty, a01.unit, a01.name, a01.statusLabel, a01.value], ['A-01', 8, 'ชิ้น', 'ชิ้นทดสอบ 1', 'ใช้ได้', 80]);
  const plate = r.rows.find((x) => x.code === 'TST-PLATE');
  assert.deepEqual([plate.status, plate.statusLabel, plate.lot], ['QC_HOLD', 'รอตรวจ', 'H1']);
  assert.equal(r.rows[r.rows.length - 1].wh, RRS.TRANSIT);
  assert.equal(r.rows[r.rows.length - 1].whName, 'ระหว่างโอน');
  assert.equal(r.totals.value, 130);
  assert.deepEqual(r.totals.byWh, { A: 80, B: 30, [RRS.TRANSIT]: 20 });
  assert.equal(r.totals.qtyByCode['TST-001'], RRS.q.qty(s, { code: 'TST-001' }));
  assert.match(r.note, /บัญชี\/Express/);
  assert.ok(r.cols.every((c) => THAI.test(c.label) && c.key in a01));
  assert.equal(R.stockByLocation(s, { wh: 'B' }).rows.length, 1);
  assert.equal(R.stockByLocation(s, { includeTransit: false }).rows.length, 4);
  assert.equal(R.stockByLocation(s, { status: 'QC_HOLD' }).rows.length, 1);
});

test('รายงานของขาด/เกิน: เทียบยอดพร้อมใช้กับ Min/Max และความต้องการจากใบงานที่เปิด', async () => {
  const w = await world();
  await w.ok('LEAD', 'master.import', { items: [
    { code: 'TST-001', name: 'ชิ้นทดสอบ 1', baseUnit: 'ชิ้น', type: 'PART', minQty: 5, maxQty: 20 },
    { code: 'TST-002', name: 'ชิ้นทดสอบ 2', baseUnit: 'ชิ้น', type: 'PART', minQty: 10 },
    { code: 'TST-003', name: 'ชิ้นทดสอบ 3', baseUnit: 'ชิ้น', type: 'PART', maxQty: 3 },
  ] });
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  await stockIn(w, 'TST-002', 'A', 'A-01', 4);
  await stockIn(w, 'TST-003', 'B', 'B-01', 5);
  await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'TST-PLATE', qty: 2, wh: 'A', bin: 'A-01', lot: 'H1' }] });
  const s = clone(await w.state());
  s.tables.jobs = {
    J1: { jobNo: 'J1', status: 'IN_PROGRESS', lines: [{ line: 0, code: 'TST-FG', output: true, required: 0, issued: 0, toMake: 2 },
      { line: 1, code: 'TST-001', required: 10, issued: 2 }, { line: 2, code: 'TST-002', required: 6, issued: 0 }] },
    J2: { jobNo: 'J2', status: 'DONE', lines: [{ line: 1, code: 'TST-003', required: 50, issued: 0 }] },
    J3: { jobNo: 'J3', status: 'CANCELLED', lines: [{ line: 1, code: 'TST-002', required: 99, issued: 0 }] },
  };
  s.tables.reservations = {
    'RS-00001': { id: 'RS-00001', jobNo: 'J1', code: 'TST-001', wh: 'A', qty: 6, issued: 2, status: 'PARTIAL' },
    'RS-00002': { id: 'RS-00002', jobNo: 'J1', code: 'TST-001', wh: 'A', qty: 5, issued: 0, status: 'RELEASED' },
  };
  const r = R.shortageExcess(s);
  assert.deepEqual(r.rows.map((x) => [x.code, x.status]), [['TST-002', 'SHORT'], ['TST-001', 'BELOW_MIN'], ['TST-003', 'OVER_MAX'], ['TST-PLATE', 'OK']]);
  const t1 = byId(r.rows, 'code', 'TST-001');
  assert.deepEqual([t1.available, t1.reserved, t1.demand, t1.projected, t1.belowMinQty, t1.statusLabel, t1.jobs], [10, 4, 8, 2, 3, 'ต่ำกว่า Min', ['J1']]);
  const t2 = byId(r.rows, 'code', 'TST-002');
  assert.deepEqual([t2.demand, t2.shortQty, t2.statusLabel], [6, 2, 'ขาด']);
  assert.deepEqual([byId(r.rows, 'code', 'TST-003').excessQty, byId(r.rows, 'code', 'TST-003').statusLabel], [2, 'เกิน Max']);
  assert.equal(byId(r.rows, 'code', 'TST-PLATE').qcHold, 2);
  assert.equal(byId(r.rows, 'code', 'TST-PLATE').available, 0);
  assert.deepEqual(r.totals, { items: 4, short: 1, belowMin: 1, overMax: 1, ok: 1 });
  assert.equal(R.shortageExcess(s, { onlyProblems: true }).rows.length, 3);
  const b = R.shortageExcess(s, { wh: 'B', code: 'TST-001' });
  assert.equal(b.rows[0].status, 'SHORT');
  assert.match(b.note, /ทั้งบริษัท/);
  assert.ok(r.cols.every((c) => THAI.test(c.label) || /Min|Max/.test(c.label)));
});

test('ของไม่เคลื่อนไหวตามจำนวนวันในนโยบาย และอายุสต็อก (ล็อตใช้วันรับของล็อตเมื่อมี)', async () => {
  const w = await world({ start: '2026-01-01T01:00:00.000Z' });
  await stockIn(w, 'TST-001', 'A', 'A-01', 5);
  await stockIn(w, 'TST-002', 'A', 'A-01', 5);
  w.clock.set('2026-05-01T01:00:00.000Z');
  await w.ok('STORE1', 'doc.post', { type: 'PD', lines: [{ code: 'TST-002', qty: 1, wh: 'A', bin: 'A-01' }] });
  await stockIn(w, 'TST-003X', 'B', 'B-01', 1).catch(() => null); // unknown item – refused, changes nothing
  await stockIn(w, 'TST-001', 'B', 'B-01', 2);
  w.clock.set('2026-06-20T01:00:00.000Z');
  await stockIn(w, 'TST-FG', 'B', 'B-01', 1);
  await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'TST-PLATE', qty: 1, wh: 'A', bin: 'A-02', lot: 'H1' }] });
  let s = await w.state();
  const nm = R.nonMoving(s, { today: '2026-06-30' });
  assert.equal(nm.days, 90);
  assert.deepEqual(nm.rows.map((r) => r.code), []);
  // TST-001 เคลื่อนไหวล่าสุด 2026-05-01 (รับเข้าคลัง B)
  const nm30 = R.nonMoving(s, { today: '2026-06-30', days: 30 });
  assert.deepEqual(nm30.rows.map((r) => [r.code, r.lastMoveDate, r.idleDays, r.qty]), [['TST-001', '2026-05-01', 60, 7], ['TST-002', '2026-05-01', 60, 4]]);
  assert.deepEqual(R.nonMoving(s, { today: '2026-06-30', days: 30, wh: 'A' }).rows.map((r) => [r.code, r.lastMoveDate]), [['TST-001', '2026-01-01'], ['TST-002', '2026-05-01']]);
  await w.ok('ADMIN', 'settings.update', { patch: { policies: { nonMovingDays: 200 } } });
  s = await w.state();
  const pol = R.nonMoving(s, { today: '2026-10-20', wh: 'A' });
  assert.equal(pol.days, 200);
  assert.deepEqual(pol.rows.map((r) => [r.code, r.idleDays]), [['TST-001', 292]]);
  assert.ok(pol.cols.every((c) => THAI.test(c.label)));

  const s2 = clone(s);
  s2.tables.lots = { 'TST-PLATE|H1': { code: 'TST-PLATE', lot: 'H1', receivedAt: '2025-12-01T03:00:00.000Z', status: 'ACTIVE' } };
  const ag = R.aging(s2, { today: '2026-06-30' });
  const find = (c, wh) => ag.rows.find((r) => r.code === c && r.wh === wh);
  assert.deepEqual([find('TST-001', 'A').days, find('TST-001', 'A').bucket], [180, '91-180']);
  assert.deepEqual([find('TST-001', 'B').days, find('TST-001', 'B').bucket], [60, '31-90']);
  assert.deepEqual([find('TST-FG', 'B').days, find('TST-FG', 'B').bucket], [10, '0-30']);
  assert.deepEqual([find('TST-PLATE', 'A').days, find('TST-PLATE', 'A').bucket, find('TST-PLATE', 'A').sinceFrom], [211, '>180', 'lot']);
  assert.equal(ag.totals.buckets['91-180'].rows, 2);
  assert.equal(ag.totals.buckets['0-30'].rows, 1);
  assert.equal(ag.totals.buckets['>180'].rows, 1);
  assert.equal(ag.rows[0].code, 'TST-PLATE');
  // ไม่มีข้อมูลล็อต ใช้วันรับเข้าล่าสุดของยอด
  const noLots = clone(s);
  delete noLots.tables.lots; // the quality module (when loaded) creates lot rows on receipt
  assert.equal(R.aging(noLots, { today: '2026-06-30', code: 'TST-PLATE' }).rows[0].sinceFrom, 'lastIn');
});

test('ความแม่นยำการนับจากรอบนับที่อนุมัติ: บรรทัดในเกณฑ์ (|ต่าง| ≤ max(จำนวน, % ของยอดระบบ)) ต่อบรรทัดที่นับ', async () => {
  const w = await world();
  const s = clone(await w.state());
  s.tables.count_sessions = {
    'CT-00001': { id: 'CT-00001', wh: 'A', status: 'APPROVED', approvedAt: '2026-11-05T03:00:00.000Z', approvedBy: 'LEAD', lines: [
      { code: 'TST-001', bin: 'A-01', system: 100, counted: 101, final: { counted: 101, system: 100 } },
      { code: 'TST-002', bin: 'A-01', system: 10, counted: 13, recounts: [{ counted: 10, system: 10 }], final: { counted: 10, system: 10 } },
      { code: 'TST-FG', bin: 'A-02', system: 10, counted: 7, final: { counted: 7, system: 10 } },
      { code: 'TST-PLATE', bin: 'A-02', system: 4, counted: null, final: null },
    ] },
    'CT-00002': { id: 'CT-00002', wh: 'B', status: 'APPROVED', approvedAt: '2026-11-20T03:00:00.000Z', approvedBy: 'ACC', lines: [
      { code: 'TST-001', bin: 'B-01', system: 0, counted: 0, final: { counted: 0, system: 0 } },
      { code: 'TST-002', bin: 'B-01', system: 50, counted: 51, final: { counted: 51, system: 50 } },
    ] },
    'CT-00003': { id: 'CT-00003', wh: 'A', status: 'SUBMITTED', lines: [{ code: 'TST-001', system: 1, counted: 50 }] },
    'CT-00004': { id: 'CT-00004', wh: 'A', status: 'APPROVED', approvedAt: '2026-10-15T03:00:00.000Z', approvedBy: 'LEAD', lines: [
      { code: 'TST-001', bin: 'A-01', system: 5, counted: 9, final: { counted: 9, system: 5 } }] },
  };
  const all = R.countAccuracy(s);
  assert.deepEqual(all.rows.map((r) => [r.id, r.lines, r.within, r.accuracy]), [['CT-00004', 1, 0, 0], ['CT-00001', 3, 2, 66.7], ['CT-00002', 2, 2, 100]]);
  assert.deepEqual([all.totals.lines, all.totals.within, all.totals.accuracy], [6, 4, 66.7]);
  assert.deepEqual(all.misses.map((m) => [m.session, m.code, m.diff]), [['CT-00004', 'TST-001', 4], ['CT-00001', 'TST-FG', -3]]);
  const nov = R.countAccuracy(s, { from: '2026-11-01', to: '2026-11-30' });
  assert.deepEqual([nov.totals.sessions, nov.totals.lines, nov.totals.accuracy], [2, 5, 80]);
  assert.equal(R.countAccuracy(s, { wh: 'B' }).totals.accuracy, 100);
  s.tables.settings.main.policies.recountPct = 5;
  s.tables.settings.main.policies.recountQty = 3;
  assert.equal(R.countAccuracy(s, { from: '2026-11-01' }).rows[0].accuracy, 100);
  assert.match(R.countAccuracy(s).totals.rule, /3 หน่วย, 5%/);
});

test('งานรอ QC: ของรอตรวจ/กักกัน/รอแก้ไข พร้อมอายุนับจากเข้าสถานะ ผลตรวจที่รอปล่อย และ NCR ที่ยังเปิด', async () => {
  const w = await world({ start: '2026-11-01T01:00:00.000Z' });
  await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'TST-PLATE', qty: 3, wh: 'A', bin: 'A-01', lot: 'H1' }] });
  w.clock.set('2026-11-02T01:00:00.000Z');
  const bad = await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'TST-PLATE', qty: 2, wh: 'B', bin: 'B-01', lot: 'H2' }] });
  w.clock.set('2026-11-03T01:00:00.000Z');
  await w.ok('LEAD', 'doc.cancel', { docNo: bad.result.docNo, reason: 'รับผิดคลัง' });
  w.clock.set('2026-11-05T01:00:00.000Z');
  await stockIn(w, 'TST-001', 'A', 'A-02', 2, { status: 'QUARANTINE' });
  w.clock.set('2026-11-06T01:00:00.000Z');
  await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'TST-PLATE', qty: 2, wh: 'A', bin: 'A-01', lot: 'H1' }] });
  w.clock.set('2026-11-07T01:00:00.000Z');
  await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'TST-PLATE', qty: 1, wh: 'B', bin: 'B-01', lot: 'H2' }] });
  w.clock.set('2026-11-08T01:00:00.000Z');
  await stockIn(w, 'TST-002', 'B', 'B-01', 1, { status: 'REWORK' });
  const s = clone(await w.state());
  s.tables.inspections = {
    'IN-00001': { id: 'IN-00001', stage: 'INCOMING', code: 'TST-PLATE', wh: 'A', bin: 'A-01', lot: 'H1', qty: 3, result: 'PASS', status: 'OPEN', inspector: 'QC1', at: '2026-11-04T03:00:00.000Z' },
    'IN-00002': { id: 'IN-00002', stage: 'INCOMING', code: 'TST-PLATE', wh: 'A', lot: 'H1', qty: 1, result: 'PASS', status: 'RELEASED', at: '2026-11-04T03:00:00.000Z' },
  };
  s.tables.ncrs = {
    'NCR-1': { ncrNo: 'NCR-1', code: 'TST-001', wh: 'A', bin: 'A-02', qty: 2, defect: 'สนิม', status: 'OPEN', createdAt: '2026-11-05T02:00:00.000Z' },
    'NCR-2': { ncrNo: 'NCR-2', code: 'TST-001', wh: 'A', qty: 1, defect: 'สนิม', status: 'CLOSED', createdAt: '2026-11-01T02:00:00.000Z' },
  };
  const firstIn = RRS.inventory.history(s, { code: 'TST-PLATE', wh: 'A' }).slice(-1)[0].at;
  const r = R.qcPending(s, { today: '2026-11-10', now: new Date(Date.parse(firstIn) + 216 * 3600e3).toISOString() });
  assert.deepEqual(r.rows.map((x) => [x.status, x.code, x.wh, x.qty, x.sinceDate, x.ageDays]), [
    ['QUARANTINE', 'TST-001', 'A', 2, '2026-11-05', 5],
    ['QC_HOLD', 'TST-PLATE', 'A', 5, '2026-11-01', 9],
    ['QC_HOLD', 'TST-PLATE', 'B', 1, '2026-11-07', 3],
    ['REWORK', 'TST-002', 'B', 1, '2026-11-08', 2],
  ]);
  assert.deepEqual(r.rows[1].inspections, ['IN-00001']);
  assert.deepEqual(r.rows[0].ncrs, ['NCR-1']);
  assert.equal(r.rows[1].ageHours, 216);
  assert.deepEqual(r.totals, { rows: 4, qcHold: 2, quarantine: 1, rework: 1, oldestDays: 9, openInspections: 1, openNcrs: 1 });
  assert.equal(r.inspections[0].ageDays, 6);
  assert.equal(r.ncrs[0].ncrNo, 'NCR-1');
  assert.ok(r.cols.concat(r.colsInspections, r.colsNcrs).every((c) => THAI.test(c.label) || c.label === 'NCR'));
});

test('อัตราผ่าน QC ครั้งแรก (FPY) ต่อขั้นตอนและรหัส และเวลารอ QC เฉลี่ยจากของเข้ารอตรวจถึงผลตรวจ', async () => {
  const w = await world();
  const r1 = await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'TST-PLATE', qty: 2, wh: 'A', bin: 'A-01', lot: 'H1' }] });
  const r2 = await w.ok('LEAD', 'doc.post', { type: 'RR', lines: [{ code: 'TST-PLATE', qty: 2, wh: 'A', bin: 'A-01', lot: 'H2' }] });
  const s = clone(await w.state());
  const at1 = RRS.inventory.history(s, { docNo: r1.result.docNo })[0].at;
  const at2 = RRS.inventory.history(s, { docNo: r2.result.docNo })[0].at;
  const plus = (iso, h) => new Date(Date.parse(iso) + h * 3600e3).toISOString();
  const ins = (id, o) => Object.assign({ id, wh: 'A', bin: 'A-01', fromStatus: 'QC_HOLD', reinspectionOf: '', status: 'RELEASED' }, o);
  s.tables.inspections = {
    'IN-1': ins('IN-1', { stage: 'INCOMING', code: 'TST-PLATE', lot: 'H1', sourceDoc: r1.result.docNo, at: plus(at1, 4), result: 'PASS' }),
    'IN-2': ins('IN-2', { stage: 'INCOMING', code: 'TST-PLATE', lot: 'H2', sourceDoc: '', at: plus(at2, 10), result: 'FAIL', status: 'NCR' }),
    'IN-3': ins('IN-3', { stage: 'INCOMING', code: 'TST-PLATE', lot: 'H2', fromStatus: 'REWORK', reinspectionOf: 'IN-2', at: plus(at2, 30), result: 'PASS' }),
    'IN-4': ins('IN-4', { stage: 'FINAL', code: 'TST-FG', lot: '', bin: '', at: plus(at2, 5), result: 'PASS' }),
    'IN-5': ins('IN-5', { stage: 'INCOMING', code: 'TST-PLATE', lot: 'H1', at: plus(at1, 1), result: 'FAIL', status: 'VOID' }),
    'IN-6': { id: 'IN-6', stage: 'IN_PROCESS', code: 'TST-001', wh: '', at: plus(at2, 2), result: 'PASS', status: 'RELEASED', reinspectionOf: '' },
    'IN-7': ins('IN-7', { stage: 'INCOMING', code: 'TST-PLATE', lot: 'H2', fromStatus: 'REWORK', reinspectionOf: '', reinspectionNcr: 'NCR-9', at: plus(at2, 40), result: 'FAIL' }),
  };
  const f = R.fpy(s);
  assert.deepEqual(f.rows.map((r) => [r.stage, r.code, r.first, r.pass, r.fpy]), [
    ['INCOMING', 'TST-PLATE', 2, 1, 50], ['IN_PROCESS', 'TST-001', 1, 1, 100], ['FINAL', 'TST-FG', 1, 1, 100]]);
  assert.deepEqual([f.totals.first, f.totals.pass, f.totals.fpy, f.totals.byStage.INCOMING.fpy], [4, 3, 75, 50]);
  assert.equal(f.totals.qcWaitHours, 7);
  const q = R.qcWait(s);
  assert.deepEqual(q.rows.map((r) => [r.id, r.docNo, r.hours]), [['IN-1', r1.result.docNo, 4], ['IN-2', r2.result.docNo, 10]]);
  assert.deepEqual([q.totals.n, q.totals.avgHours, q.totals.maxHours, q.totals.unmatched], [2, 7, 10, 1]);
  assert.deepEqual(R.fpy(s, { stage: 'INCOMING' }).rows.length, 1);
  assert.equal(R.fpy(s, { from: '2026-12-01' }).totals.fpy, null);
  assert.ok(f.cols.concat(q.cols).every((c) => THAI.test(c.label)));
});

test('ปัญหาซ้ำ: NCR รหัสเดียวกัน ข้อบกพร่องเดียวกัน ตั้งแต่ 2 ครั้งในช่วงเวลา ถูกระบุว่าซ้ำ', async () => {
  const w = await world();
  const s = clone(await w.state());
  const n = (no, c, d, at, st = 'OPEN') => ({ ncrNo: no, code: c, defect: d, createdAt: at, status: st });
  s.tables.ncrs = {
    N1: n('N1', 'TST-PLATE', 'รอยร้าว', '2026-11-02T03:00:00.000Z'),
    N2: n('N2', 'TST-PLATE', ' รอยร้าว ', '2026-11-10T03:00:00.000Z', 'CLOSED'),
    N3: n('N3', 'TST-PLATE', 'สนิม', '2026-11-05T03:00:00.000Z'),
    N4: n('N4', 'TST-001', 'รอยร้าว', '2026-11-06T03:00:00.000Z'),
    N5: n('N5', 'TST-PLATE', 'รอยร้าว', '2026-10-20T03:00:00.000Z'),
  };
  const all = R.repeatIssues(s);
  assert.deepEqual([all.rows[0].code, all.rows[0].defect, all.rows[0].count, all.rows[0].repeat, all.rows[0].ncrNos], ['TST-PLATE', 'รอยร้าว', 3, true, ['N1', 'N2', 'N5']]);
  assert.deepEqual([all.totals.groups, all.totals.repeats, all.totals.repeatNcrs, all.totals.occurrences], [3, 1, 3, 2]);
  const nov = R.repeatIssues(s, { from: '2026-11-01', to: '2026-11-30' });
  assert.deepEqual([nov.rows[0].count, nov.rows[0].open, nov.rows[0].firstDate, nov.rows[0].lastDate, nov.rows[0].repeatLabel], [2, 1, '2026-11-02', '2026-11-10', 'ซ้ำ']);
  assert.equal(nov.rows.filter((r) => r.repeat).length, 1);
  assert.equal(R.repeatIssues(s, { from: '2026-11-01', minCount: 3 }).totals.repeats, 0);
  assert.ok(all.cols.every((c) => THAI.test(c.label)));
});

// =================================================================================================================
// Plan item 3 – offcut register
// =================================================================================================================
test('ทะเบียนเศษเหล็ก: บันทึกขนาด วัสดุ ความหนา ตำแหน่ง QR และล็อตต้นทาง แล้วใช้ตัดและบันทึกเศษคงเหลือหลังตัด', async () => {
  const w = await plateWorld();
  const add = await w.ok('STORE1', 'offcut.add', { code: 'tst-sheet', width: 600, length: 1000, wh: 'a', bin: 'a-02', sourceLot: 'H-77', createdFrom: 'PD6911-0001' });
  assert.equal(add.result.id, 'OC-00001');
  let s = await w.state();
  const o = s.tables.offcuts['OC-00001'];
  assert.deepEqual([o.code, o.material, o.thickness, o.width, o.length, o.area, o.wh, o.bin, o.sourceLot, o.status, o.createdBy],
    ['TST-SHEET', 'SS400', 3, 600, 1000, 600000, 'A', 'A-02', 'H-77', 'AVAILABLE', 'STORE1']);
  // ทะเบียนเศษไม่เปลี่ยนยอดสต็อก
  assert.equal(RRS.q.qty(s, { code: 'TST-SHEET' }), 5);
  // ขนาดเท่าแผ่นแต่หมุนได้
  await w.ok('PROD', 'offcut.add', { code: 'TST-SHEET', width: 2440, length: 1220, wh: 'A', sourceLot: 'H-77' });
  const use = await w.ok('PROD', 'offcut.use', { id: 'oc-00001', usedFor: 'J-100 / DWG-55', remaining: [{ width: 600, length: 400 }, { width: 1000, length: 200, bin: 'A-01' }] });
  assert.deepEqual(use.result.children, ['OC-00003', 'OC-00004']);
  s = await w.state();
  const used = s.tables.offcuts['OC-00001'];
  assert.deepEqual([used.status, used.usedFor, used.usedBy, used.children], ['USED', 'J-100 / DWG-55', 'PROD', ['OC-00003', 'OC-00004']]);
  assert.ok(used.usedAt);
  const c1 = s.tables.offcuts['OC-00003'];
  const c2 = s.tables.offcuts['OC-00004'];
  assert.deepEqual([c1.parent, c1.bin, c1.sourceLot, c1.material, c1.thickness, c1.status], ['OC-00001', 'A-02', 'H-77', 'SS400', 3, 'AVAILABLE']);
  assert.deepEqual([c2.bin, c2.width, c2.length], ['A-01', 1000, 200]);
  assert.match(c1.createdFrom, /OC-00001.*J-100/);
  assert.equal(code(await w.exec('PROD', 'offcut.use', { id: 'OC-00001', usedFor: 'J-101' })), 'BAD_STATE');
  // ใช้หมดไม่มีเศษเหลือ
  await w.ok('PROD', 'offcut.use', { id: 'OC-00004', usedFor: 'J-102' });
  // ทิ้งเศษ
  assert.equal(code(await w.exec('STORE1', 'offcut.scrap', { id: 'OC-00003' })), 'REQUIRED');
  await w.ok('STORE1', 'offcut.scrap', { id: 'OC-00003', reason: 'สนิมขึ้นทั้งแผ่น' });
  s = await w.state();
  assert.deepEqual([s.tables.offcuts['OC-00003'].status, s.tables.offcuts['OC-00003'].scrappedBy], ['SCRAPPED', 'STORE1']);
  assert.equal(code(await w.exec('STORE1', 'offcut.scrap', { id: 'OC-00003', reason: 'ซ้ำ' })), 'BAD_STATE');
  const reg = R.offcuts(s);
  assert.deepEqual(reg.rows.map((r) => r.id), ['OC-00002']);
  assert.equal(R.offcuts(s, { status: 'ALL' }).rows.length, 4);
  assert.ok(reg.cols.every((c) => THAI.test(c.label)));
  // คำขอเดิมส่งซ้ำไม่สร้างเศษซ้ำ
  const p = { code: 'TST-SPHC', width: 300, length: 300, wh: 'A' };
  const a1 = await w.ok('STORE1', 'offcut.add', p, 'qr-scan-1');
  const a2 = await w.exec('STORE1', 'offcut.add', p, 'qr-scan-1');
  assert.equal(a2.duplicate, true);
  s = await w.state();
  assert.equal(Object.keys(s.tables.offcuts).length, 5);
  assert.equal(a1.result.id, 'OC-00005');
});

test('ทะเบียนเศษเหล็ก: ข้อมูลผิดรูปแบบหรือไม่ตรงทะเบียนถูกปฏิเสธและไม่เปลี่ยนข้อมูล', async () => {
  const w = await plateWorld();
  await w.ok('STORE1', 'offcut.add', { code: 'TST-SHEET', width: 600, length: 1000, wh: 'A', bin: 'A-02', sourceLot: 'H-77' });
  const seq = (await w.state()).seq;
  const ok = { code: 'TST-SHEET', width: 500, length: 500, wh: 'A', sourceLot: 'H-77' };
  const cases = [
    [{ ...ok, code: 'NO-SUCH' }, 'NOT_FOUND'],
    [{ ...ok, width: 0 }, 'BAD_VALUE'],
    [{ ...ok, length: 'abc' }, 'BAD_VALUE'],
    [{ ...ok, width: 1300, length: 2500 }, 'TOO_BIG'],
    [{ ...ok, wh: '' }, 'REQUIRED'],
    [{ ...ok, wh: 'Z' }, 'NOT_FOUND'],
    [{ ...ok, wh: RRS.TRANSIT }, 'RESERVED'],
    [{ ...ok, bin: 'NOPE' }, 'NOT_FOUND'],
    [{ ...ok, sourceLot: '' }, 'LOT_REQUIRED'],
    [{ ...ok, sourceLot: 'H-00' }, 'LOT_UNKNOWN'],
    [{ ...ok, material: 'SUS304' }, 'BAD_VALUE'],
    [{ ...ok, thickness: 6 }, 'BAD_VALUE'],
    [{ ...ok, thickness: 'หนา' }, 'BAD_VALUE'],
    [{ ...ok, parent: 'OC-99999' }, 'NOT_FOUND'],
    [{ code: 'TST-SPHC', width: 100, length: 100, wh: 'A', sourceLot: 'L1' }, 'LOT_NOT_TRACKED'],
    [{ code: 'TST-001', width: 100, length: 100, wh: 'A' }, 'REQUIRED'],
  ];
  for (const [p, c] of cases) assert.equal(code(await w.exec('STORE1', 'offcut.add', p)), c, JSON.stringify(p));
  const useCases = [
    [{ id: 'OC-99999', usedFor: 'J' }, 'NOT_FOUND'],
    [{ id: 'OC-00001', usedFor: '' }, 'REQUIRED'],
    [{ id: 'OC-00001', usedFor: 'J', remaining: 'x' }, 'BAD_VALUE'],
    [{ id: 'OC-00001', usedFor: 'J', remaining: [{ width: 700, length: 1000 }] }, 'TOO_BIG'],
    [{ id: 'OC-00001', usedFor: 'J', remaining: [{ width: 600, length: 1000 }] }, 'TOO_MUCH_AREA'],
    [{ id: 'OC-00001', usedFor: 'J', remaining: [{ width: 600, length: 600 }, { width: 600, length: 400 }] }, 'TOO_MUCH_AREA'],
    [{ id: 'OC-00001', usedFor: 'J', remaining: [{ width: 100, length: -1 }] }, 'BAD_VALUE'],
    [{ id: 'OC-00001', usedFor: 'J', remaining: [{ width: 100, length: 100, bin: 'B-01' }] }, 'NOT_FOUND'],
  ];
  for (const [p, c] of useCases) assert.equal(code(await w.exec('STORE1', 'offcut.use', p)), c, JSON.stringify(p));
  assert.equal(code(await w.exec('STORE1', 'offcut.scrap', { id: 'OC-404', reason: 'x' })), 'NOT_FOUND');
  assert.equal(code(await w.exec('STORE1', 'offcut.undo', { id: 'OC-00001', reason: 'ไม่มีอะไร' })), 'BAD_STATE');
  const s = await w.state();
  assert.equal(s.seq, seq);
  assert.equal(s.tables.offcuts['OC-00001'].status, 'AVAILABLE');
});

test('เสนอใช้เศษก่อนแผ่นใหม่: วัสดุกลุ่มเดียวกัน ความหนาเท่ากัน หมุนได้ เรียงพื้นที่เล็กสุดก่อน พร้อม % เศษทิ้ง', async () => {
  const w = await plateWorld();
  const add = (p) => w.ok('STORE1', 'offcut.add', Object.assign({ wh: 'A', bin: 'A-02' }, p));
  await add({ code: 'TST-SHEET', width: 500, length: 800, sourceLot: 'H-77' }); // OC-00001 fits, 30 %
  await add({ code: 'TST-SHEET', width: 300, length: 300, sourceLot: 'H-77' }); // OC-00002 too small
  await add({ code: 'TST-SHEET', width: 750, length: 450, sourceLot: 'H-77' }); // OC-00003 fits rotated, 17 %
  await add({ code: 'TST-SHEET45', width: 1000, length: 1000 }); // OC-00004 other thickness
  await add({ code: 'TST-SPHC', width: 1000, length: 1000 }); // OC-00005 other material
  await add({ code: 'TST-SHEET', width: 1000, length: 1000, sourceLot: 'H-77' }); // OC-00006 used below
  await add({ code: 'TST-SHEET', width: 900, length: 900, wh: 'B', bin: 'B-01', sourceLot: 'H-77' }); // OC-00007 other warehouse
  await w.ok('PROD', 'offcut.use', { id: 'OC-00006', usedFor: 'J-1' });
  let s = await w.state();
  const q = { material: 'ss400', thickness: 3, width: 400, length: 700 };
  const r = R.suggestOffcuts(s, q);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.rows.map((x) => [x.id, x.rotated, x.wastePct]), [['OC-00003', true, 17], ['OC-00001', false, 30], ['OC-00007', false, 65.4]]);
  assert.match(r.advice, /OC-00003 ก่อนแผ่นใหม่/);
  assert.deepEqual(r.plates.map((p) => [p.code, p.available, p.wastePct]), [['TST-SHEET', 5, 90.6]]);
  assert.deepEqual(R.suggestOffcuts(s, { ...q, wh: 'A' }).rows.map((x) => x.id), ['OC-00003', 'OC-00001']);
  assert.deepEqual(R.suggestOffcuts(s, { code: 'TST-SHEET', width: 700, length: 400, wh: 'A' }).rows.map((x) => x.id), ['OC-00003', 'OC-00001']);
  assert.equal(R.suggestOffcuts(s, { ...q, width: 2000, length: 2000 }).rows.length, 0);
  assert.match(R.suggestOffcuts(s, { ...q, width: 1100, length: 2000 }).advice, /ใช้แผ่นใหม่ TST-SHEET/);
  assert.ok(R.suggestOffcuts(s, { ...q, width: '' }).problems.length > 0);
  assert.ok(R.suggestOffcuts(s, { width: 10, length: 10 }).problems.length > 0);
  // วัสดุที่ตกลงว่าใช้แทนกันได้ (นโยบาย) – SPHC เข้ากลุ่มเดียวกับ SS400
  await w.ok('ADMIN', 'settings.update', { patch: { policies: { materialFamilies: { SS400: 'เหล็กดำ', SPHC: 'เหล็กดำ' } } } });
  s = await w.state();
  const fam = R.suggestOffcuts(s, { ...q, wh: 'A' });
  assert.deepEqual(fam.rows.map((x) => x.id), ['OC-00003', 'OC-00001', 'OC-00005']);
  assert.deepEqual(fam.plates.map((p) => p.code).sort(), ['TST-SHEET', 'TST-SPHC']);
  assert.ok(r.cols.every((c) => THAI.test(c.label)));
});

test('เศษจากล็อตที่ถูกกักกันไม่ถูกเสนอ ใช้ไม่ได้ และบันทึกเป็นของพร้อมใช้ไม่ได้', async () => {
  const w = await plateWorld();
  await w.ok('STORE1', 'offcut.add', { code: 'TST-SHEET', width: 500, length: 800, wh: 'A', sourceLot: 'H-77' });
  await w.ok('STORE1', 'offcut.add', { code: 'TST-SPHC', width: 500, length: 800, wh: 'A' });
  const s = clone(await w.state());
  s.tables.lots = { 'TST-SHEET|H-77': { code: 'TST-SHEET', lot: 'H-77', kind: 'heat', status: 'QUARANTINED' } };
  const r = R.suggestOffcuts(s, { material: 'SS400', thickness: 3, width: 400, length: 700 });
  assert.deepEqual(r.rows, []);
  assert.deepEqual(r.blocked.map((b) => b.id), ['OC-00001']);
  assert.deepEqual(r.plates, []);
  assert.equal(code(dry(s, 'STORE1', 'offcut.use', { id: 'OC-00001', usedFor: 'J-1' })), 'LOT_QUARANTINED');
  assert.equal(code(dry(s, 'STORE1', 'offcut.add', { code: 'TST-SHEET', width: 100, length: 100, wh: 'A', sourceLot: 'H-77' })), 'LOT_QUARANTINED');
  assert.equal(code(dry(s, 'STORE1', 'offcut.use', { id: 'OC-00002', usedFor: 'J-1' })), 'OK');
});

test('ยกเลิกการตัด/การทิ้งเศษ: กลับเป็นพร้อมใช้ เศษที่เหลือเป็นยกเลิก และประวัติไม่ถูกลบ', async () => {
  const w = await plateWorld();
  await w.ok('STORE1', 'offcut.add', { code: 'TST-SHEET', width: 600, length: 1000, wh: 'A', sourceLot: 'H-77' });
  await w.ok('PROD', 'offcut.use', { id: 'OC-00001', usedFor: 'J-100', remaining: [{ width: 600, length: 400 }, { width: 300, length: 200 }] });
  await w.ok('STORE1', 'offcut.scrap', { id: 'OC-00003', reason: 'เล็กเกินใช้' });
  assert.equal(code(await w.exec('STORE1', 'offcut.undo', { id: 'OC-00001' })), 'REQUIRED');
  assert.equal(code(await w.exec('STORE1', 'offcut.undo', { id: 'OC-00001', reason: 'ตัดผิดแผ่น' })), 'BAD_STATE');
  await w.ok('STORE1', 'offcut.undo', { id: 'OC-00003', reason: 'ทิ้งผิดชิ้น' });
  let s = await w.state();
  assert.equal(s.tables.offcuts['OC-00003'].status, 'AVAILABLE');
  assert.deepEqual(s.tables.offcuts['OC-00003'].history.map((h) => h.action), ['ADD', 'SCRAP', 'UNDO_SCRAP']);
  await w.ok('LEAD', 'offcut.undo', { id: 'OC-00001', reason: 'ตัดผิดแผ่น' });
  s = await w.state();
  const o = s.tables.offcuts['OC-00001'];
  assert.deepEqual([o.status, o.usedFor, o.children], ['AVAILABLE', '', []]);
  assert.deepEqual(o.history.map((h) => h.action), ['ADD', 'USE', 'UNDO_USE']);
  assert.match(o.history[2].detail, /J-100.*PROD/);
  assert.deepEqual(['OC-00002', 'OC-00003'].map((id) => [s.tables.offcuts[id].status, s.tables.offcuts[id].voidedBy]), [['VOID', 'LEAD'], ['VOID', 'LEAD']]);
  assert.deepEqual(R.offcuts(s).rows.map((r) => r.id), ['OC-00001']);
  assert.deepEqual(R.suggestOffcuts(s, { material: 'SS400', thickness: 3, width: 100, length: 100 }).rows.map((r) => r.id), ['OC-00001']);
  assert.equal(code(await w.exec('STORE1', 'offcut.undo', { id: 'OC-00002', reason: 'x' })), 'BAD_STATE');
  // ใช้ใหม่ได้หลังยกเลิก
  await w.ok('PROD', 'offcut.use', { id: 'OC-00001', usedFor: 'J-200' });
});

// =================================================================================================================
// Plan items 1 and 4 – UAT, training, pilot issues, error manual
// =================================================================================================================
test('UAT: เกณฑ์ตรวจรับ Phase 0–6 ครบทุกข้อ รหัสคงที่ และบันทึกผลพร้อมผู้ทดสอบ/วันที่ เก็บผลเดิมไว้', async () => {
  const C = R.UAT_CRITERIA;
  const per = {};
  for (const c of C) per[c.phase] = (per[c.phase] || 0) + 1;
  assert.deepEqual(per, { 0: 3, 1: 5, 2: 4, 3: 5, 4: 5, 5: 6, 6: 5 });
  assert.equal(new Set(C.map((c) => c.id)).size, C.length);
  assert.equal(byId(C, 'id', 'P0-3').criterion, 'กู้ข้อมูลสำรองได้');
  assert.equal(byId(C, 'id', 'P1-2').criterion, 'สองคนเบิกของชิ้นสุดท้ายพร้อมกันสำเร็จได้เพียงคนเดียว');
  assert.equal(byId(C, 'id', 'P2-4').criterion, 'ของรอตรวจและของคาดว่าจะเข้าไม่ถูกเบิกเป็นของพร้อมใช้');
  assert.equal(byId(C, 'id', 'P3-4').criterion, 'มีการเบิกระหว่างนับกับอนุมัติแล้วระบบคำนวณ/บล็อกตามกติกาที่ตกลง');
  assert.equal(byId(C, 'id', 'P4-3').criterion, 'ปริมาณสั่งสอดคล้อง MOQ/แพ็ก');
  assert.equal(byId(C, 'id', 'P5-6').criterion, 'คืน/ตัดทิ้งกระทบจำนวนและประวัติถูกต้อง');
  assert.deepEqual(C.filter((c) => c.phase === 6).map((c) => c.criterion), ['ไม่มีข้อผิดพลาดรุนแรงที่ทำให้ยอดคลาดเคลื่อน ตัดซ้ำ หรือปล่อยของกักกัน',
    'สโตร์/QC/บัญชียอมรับยอดและขั้นตอน', 'กู้ข้อมูลได้', 'ตัวชี้วัดตรงตามเป้าหมายที่ตกลงใน Phase 0', 'มีผู้รับผิดชอบและแผนย้อนกลับก่อนขยาย']);
  assert.ok(Object.isFrozen(C));
  // every automated test file named by a criterion exists
  for (const c of C) assert.ok(c.auto.startsWith('tests/phase'), c.id);
  // Phase 6 test names in this file cover every Phase 6 criterion
  const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  for (const c of C.filter((x) => x.phase === 6)) assert.ok(src.indexOf(`test('${c.id} ${c.criterion}`) >= 0, c.id);

  const w = await world();
  await w.ok('QC1', 'uat.record', { id: 'p1-2', status: 'PASS', evidence: 'tests/phase1.test.mjs', criterion: 'ข้อความปลอม', phase: 4 });
  let s = await w.state();
  let u = s.tables.uat['P1-2'];
  assert.deepEqual([u.phase, u.criterion, u.status, u.tester, u.testedOn, u.history.length], [1, byId(C, 'id', 'P1-2').criterion, 'PASS', 'QC1', '2026-11-02', 0]);
  await w.ok('STORE1', 'uat.record', { id: 'P1-2', status: 'FAIL', note: 'มือถือส่งซ้ำแล้วค้าง' });
  s = await w.state();
  u = s.tables.uat['P1-2'];
  assert.deepEqual([u.status, u.tester, u.history.length, u.history[0].status, u.history[0].tester], ['FAIL', 'STORE1', 1, 'PASS', 'QC1']);
  const seq = s.seq;
  for (const [p, c] of [[{ id: 'P1-1', status: 'OK', evidence: 'x' }, 'BAD_VALUE'], [{ id: 'P1-1', status: 'PASS' }, 'REQUIRED'],
    [{ id: 'P1-1', status: 'FAIL' }, 'REQUIRED'], [{ id: '', status: 'PASS', evidence: 'abc' }, 'REQUIRED'],
    [{ id: 'P1 1!', status: 'PASS', evidence: 'abc' }, 'BAD_CODE'], [{ id: 'X-1', status: 'NOT_RUN' }, 'BAD_VALUE'],
    [{ id: 'X-1', phase: 9, criterion: 'x', status: 'NOT_RUN' }, 'BAD_VALUE'], [{ id: 'X-1', phase: 6, status: 'NOT_RUN' }, 'REQUIRED']]) {
    assert.equal(code(await w.exec('QC1', 'uat.record', p)), c, JSON.stringify(p));
  }
  assert.equal(code(await w.exec('VIEW', 'uat.record', { id: 'P1-1', status: 'PASS', evidence: 'abc' })), 'NO_PERMISSION');
  assert.equal((await w.state()).seq, seq);
  await w.ok('PLAN', 'uat.record', { id: 'P6-X1', phase: 6, criterion: 'ทดสอบเพิ่ม: ใบงานด่วนแทรกคิว', status: 'NOT_RUN' });
  s = await w.state();
  const sum = R.uatSummary(s);
  assert.deepEqual([sum.totals.total, sum.totals.pass, sum.totals.fail, sum.totals.notRun, sum.totals.allPass], [C.length + 1, 0, 1, C.length, false]);
  assert.equal(sum.byPhase[1].FAIL, 1);
  assert.equal(sum.byPhase[6].total, 6);
  assert.equal(byId(sum.rows, 'id', 'P6-X1').custom, true);
  assert.equal(R.uatSummary(s, { phases: [6] }).rows.length, 6);
  assert.ok(sum.cols.every((c) => THAI.test(c.label)));
});

test('อบรมตามบทบาท: บันทึกผู้อบรม/วันที่ ผู้อบรมต้องไม่ใช่ผู้รับการอบรม และบทบาทต้องตรงกับผู้ใช้', async () => {
  const w = await world();
  const t = await w.ok('LEAD', 'training.record', { userId: 'store1', role: 'store', topic: 'รับ–เบิก–โอน และคู่มือกรณีผิดพลาด', trainedOn: '2026-11-01' });
  const s = await w.state();
  const row = s.tables.trainings[t.result.id];
  assert.deepEqual([row.userId, row.role, row.trainer, row.trainedOn], ['STORE1', 'store', 'LEAD', '2026-11-01']);
  const seq = s.seq;
  assert.equal(code(await w.exec('LEAD', 'training.record', { userId: 'LEAD', role: 'store_lead', topic: 'อบรมตัวเอง' })), 'SAME_PERSON');
  assert.equal(code(await w.exec('LEAD', 'training.record', { userId: 'STORE1', role: 'qc', topic: 'x' })), 'BAD_VALUE');
  assert.equal(code(await w.exec('LEAD', 'training.record', { userId: 'GHOST', role: 'store', topic: 'x' })), 'NOT_FOUND');
  assert.equal(code(await w.exec('LEAD', 'training.record', { userId: 'STORE1', role: 'store', topic: '' })), 'REQUIRED');
  assert.equal(code(await w.exec('LEAD', 'training.record', { userId: 'STORE1', role: 'store', topic: 'x', trainedOn: '2027-01-01' })), 'BAD_VALUE');
  assert.equal(code(await w.exec('LEAD', 'training.record', { userId: 'STORE1', role: 'store', topic: 'x', trainedOn: '1/11/2569' })), 'BAD_VALUE');
  assert.equal(code(await w.exec('VIEW', 'training.record', { userId: 'STORE1', role: 'store', topic: 'x' })), 'NO_PERMISSION');
  assert.equal((await w.state()).seq, seq);
});

test('บันทึกปัญหาจากการทดลอง: ปัญหาร้ายแรงที่ค้างทำให้ขยายผลไม่ได้ และต้องปิดโดยคนละคนกับผู้แจ้ง', async () => {
  const w = await world();
  assert.equal(code(await w.exec('STORE1', 'pilot.issue', { severity: 'URGENT', description: 'ยอดไม่ตรง' })), 'BAD_VALUE');
  assert.equal(code(await w.exec('STORE1', 'pilot.issue', { severity: 'MINOR', description: 'ช้า' })), 'REQUIRED');
  const crit = await w.ok('STORE1', 'pilot.issue', { severity: 'critical', area: 'เบิก', description: 'เบิกจากมือถือแล้วยอดลดสองครั้ง', ref: 'PD6911-0003' });
  const minor = await w.ok('STORE1', 'pilot.issue', { severity: 'MINOR', description: 'ตัวอักษรเล็กบนมือถือ' });
  let s = await w.state();
  const chk = R.rolloutReadiness(s, { rollout: { id: 'X', team: [] } }).checks.find((c) => c.id === 'issues');
  assert.equal(chk.ok, false);
  assert.match(chk.detail, new RegExp(crit.result.id));
  assert.equal(code(await w.exec('STORE1', 'pilot.resolveIssue', { id: crit.result.id, resolution: 'แก้รหัสคำขอแล้ว ทดสอบซ้ำผ่าน' })), 'SAME_PERSON');
  assert.equal(code(await w.exec('LEAD', 'pilot.resolveIssue', { id: crit.result.id, resolution: 'สั้น' })), 'REQUIRED');
  await w.ok('LEAD', 'pilot.resolveIssue', { id: crit.result.id, resolution: 'แก้รหัสคำขอแล้ว ทดสอบซ้ำผ่าน' });
  await w.ok('STORE1', 'pilot.resolveIssue', { id: minor.result.id, resolution: 'ขยายตัวอักษรแล้ว' });
  assert.equal(code(await w.exec('LEAD', 'pilot.resolveIssue', { id: crit.result.id, resolution: 'ปิดซ้ำอีกครั้ง' })), 'BAD_STATE');
  assert.equal(code(await w.exec('LEAD', 'pilot.resolveIssue', { id: 'PI-404', resolution: 'ไม่มีปัญหานี้' })), 'NOT_FOUND');
  s = await w.state();
  const row = s.tables.pilot_issues[crit.result.id];
  assert.deepEqual([row.status, row.reportedBy, row.resolvedBy, row.severity], ['RESOLVED', 'STORE1', 'LEAD', 'CRITICAL']);
  assert.ok(row.resolvedAt);
  assert.equal(R.rolloutReadiness(s, { rollout: { id: 'X', team: [] } }).checks.find((c) => c.id === 'issues').ok, true);
});

test('คู่มือกรณีผิดพลาดครอบคลุมรหัสข้อผิดพลาดทุกตัวของระบบสต็อกและของ Phase 6', () => {
  const codes = new Set();
  for (const f of ['core.js', 'ledger.js', 'master.js', 'inventory.js', 'reports.js']) {
    const src = fs.readFileSync(path.join(engineDir, f), 'utf8');
    for (const m of src.matchAll(/(?:error|err)\('([A-Z_]+)'/g)) codes.add(m[1]);
    for (const m of src.matchAll(/code: '([A-Z_]+)'/g)) codes.add(m[1]);
  }
  codes.add('NO_PERMISSION');
  codes.add('SAME_PERSON');
  const guide = new Set(R.ERROR_GUIDE.map((g) => g.code));
  const missing = [...codes].filter((c) => !guide.has(c));
  assert.deepEqual(missing, []);
  for (const g of R.ERROR_GUIDE) assert.ok(THAI.test(g.title) && THAI.test(g.cause) && THAI.test(g.action) && g.who, g.code);
  assert.equal(R.errorHelp('NOT_ENOUGH').title, 'ของไม่พอ');
  assert.ok(THAI.test(R.errorHelp('SOMETHING_NEW').action));
});

// =================================================================================================================
// Google Sheet layout, data dictionary, permissions, missing tables
// =================================================================================================================
test('ส่งออกทุกตารางเป็นแท็บ Google Sheet (หัวตารางภาษาไทยจากพจนานุกรม) และพจนานุกรมข้อมูล', async () => {
  const w = await plateWorld();
  await w.ok('STORE1', 'offcut.add', { code: 'TST-SHEET', width: 600, length: 1000, wh: 'A', sourceLot: 'H-77', remark: '=HYPERLINK("http://x")' });
  for (let i = 0; i < 6; i++) await stockIn(w, 'TST-001', 'A', 'A-01', 1);
  const s = await w.state();
  const exp = R.exportTables(s);
  assert.deepEqual(Object.keys(exp), Object.keys(RRS.schema.tables));
  for (const [name, tab] of Object.entries(exp)) {
    const tb = RRS.schema.tables[name];
    assert.deepEqual(tab[0], tb.fields.map((f) => f.label).concat(['ข้อมูลอื่นนอกพจนานุกรม (JSON)']), name);
    assert.equal(tab.length - 1, Object.keys(s.tables[name] || {}).length, name);
    for (const row of tab.slice(1)) assert.equal(row.length, tab[0].length, name);
  }
  const oc = exp.offcuts;
  assert.equal(oc[0][0], 'รหัสเศษ / ข้อความ QR (OC-00001)');
  const ix = (tab, field) => RRS.schema.tables[tab].fields.findIndex((f) => f.name === field);
  assert.equal(oc[1][ix('offcuts', 'id')], 'OC-00001');
  assert.equal(oc[1][ix('offcuts', 'children')], '[]');
  assert.equal(JSON.parse(oc[1][ix('offcuts', 'history')])[0].action, 'ADD');
  assert.equal(oc[1][ix('offcuts', 'remark')], '\'=HYPERLINK("http://x")');
  assert.equal(R.exportTables(s, { safeText: false }).offcuts[1][ix('offcuts', 'remark')], '=HYPERLINK("http://x")');
  assert.equal(oc[1][ix('offcuts', 'width')], 600);
  assert.deepEqual(R.exportTables(s, { header: 'name' }).offcuts[0].slice(0, 3), ['id', 'code', 'material']);
  // fields outside the dictionary are kept in the last column
  const items = exp.items;
  const sheetRow = items.find((r) => r[0] === 'TST-SHEET');
  assert.equal(JSON.parse(sheetRow[sheetRow.length - 1]).code, 'TST-SHEET');
  // audit rows in commit order (numeric keys)
  const seqs = exp.audit.slice(1).map((r) => r[0]);
  assert.deepEqual(seqs, seqs.slice().sort((a, b) => a - b));
  assert.equal(seqs.length, s.seq);
  // data dictionary
  const dd = R.dataDictionary();
  assert.equal(dd.length, Object.values(RRS.schema.tables).reduce((n, t) => n + t.fields.length, 0));
  const idRow = dd.find((r) => r.table === 'offcuts' && r.field === 'id');
  assert.deepEqual([idRow.label, idRow.phase, idRow.type, idRow.key], ['ทะเบียนเศษเหล็กใช้ซ้ำ', 6, 'text', true]);
  for (const t of ['offcuts', 'uat', 'backup_tests', 'uat_signoffs', 'trainings', 'pilot_issues', 'daily_checks', 'rollouts']) {
    const tb = RRS.schema.tables[t];
    assert.equal(tb.phase, 6, t);
    assert.ok(THAI.test(tb.label), t);
    assert.ok(tb.fields.every((f) => THAI.test(f.label)), t);
  }
  assert.ok(dd.every((r) => r.table && r.label && r.field && r.fieldLabel));
});

test('สิทธิ์: ผู้ไม่มีสิทธิ์ทำรายการ Phase 6 ไม่ได้ และผู้ใช้จำกัดคลังทำรายการเศษได้เฉพาะคลังของตน', async () => {
  const w = await plateWorld();
  await w.ok('ADMIN', 'user.upsert', { id: 'ONLYA', name: 'สโตร์ A', roles: ['store'], warehouses: ['A'] });
  const before = (await w.state()).seq;
  const deny = [
    ['VIEW', 'offcut.add', { code: 'TST-SPHC', width: 1, length: 1, wh: 'A' }],
    ['ACC', 'offcut.add', { code: 'TST-SPHC', width: 1, length: 1, wh: 'A' }],
    ['ONLYA', 'offcut.add', { code: 'TST-SPHC', width: 1, length: 1, wh: 'B' }],
    ['VIEW', 'uat.record', { id: 'P1-1', status: 'PASS', evidence: 'abc' }],
    ['VIEW', 'uat.signoff', { area: 'store', decision: 'ACCEPT' }],
    ['STORE1', 'uat.signoff', { area: 'store', decision: 'ACCEPT' }],
    ['VIEW', 'daily.check', {}],
    ['STORE1', 'backup.recordTest', { commits: 1, head: 'a'.repeat(64), result: 'OK' }],
    ['QCLEAD', 'backup.recordTest', { commits: 1, head: 'a'.repeat(64), result: 'OK' }],
    ['STORE1', 'rollout.propose', { groups: ['x'], owner: 'LEAD', team: ['STORE1'], rollbackPlan: 'ปิดสวิตช์และกู้ข้อมูล' }],
    ['LEAD', 'rollout.approve', { id: 'RO-00001' }],
    ['QCLEAD', 'rollout.rollback', { id: 'RO-00001', reason: 'x' }],
    ['VIEW', 'pilot.issue', { severity: 'MINOR', description: 'ทดสอบสิทธิ์' }],
  ];
  for (const [u, k, p] of deny) assert.equal(code(await w.exec(u, k, p)), 'NO_PERMISSION', `${u} ${k}`);
  assert.equal((await w.state()).seq, before);
  await w.ok('ONLYA', 'offcut.add', { code: 'TST-SPHC', width: 100, length: 100, wh: 'A' });
  await w.ok('STORE2', 'offcut.add', { code: 'TST-SPHC', width: 100, length: 100, wh: 'B', bin: 'B-01' });
  assert.equal(code(await w.exec('ONLYA', 'offcut.use', { id: 'OC-00002', usedFor: 'J-1' })), 'NO_PERMISSION');
  assert.equal(code(await w.exec('ONLYA', 'offcut.scrap', { id: 'OC-00002', reason: 'x' })), 'NO_PERMISSION');
  assert.deepEqual(RRS.auth.rolesFor('rollout.approve'), ['admin', 'manager']);
  assert.ok(THAI.test(RRS.auth.PERM_LABELS['uat.signoff']));
});

test('รายงานทำงานได้แม้ตารางของโมดูลอื่นยังไม่มี (สถานะว่าง)', () => {
  const s = RRS.core.createState();
  for (const name of ['stockByLocation', 'shortageExcess', 'nonMoving', 'aging', 'countAccuracy', 'qcPending', 'fpy', 'qcWait', 'repeatIssues']) {
    const r = R[name](s, { today: '2026-11-02' });
    assert.deepEqual(r.rows, [], name);
    assert.ok(Array.isArray(r.cols) && r.cols.length > 0, name);
    assert.ok(r.totals, name);
  }
  assert.ok(R.LIST.every((x) => typeof R[x.id] === 'function' && THAI.test(x.label)));
  const chk = R.dailyCheck(s);
  assert.equal(chk.ok, true);
  const k = R.kpiActuals(s, { today: '2026-11-02' });
  assert.deepEqual(k.rows.map((r) => r.id), RRS.master.KPI_DEFAULTS.map((d) => d.id));
  assert.ok(k.rows.every((r) => r.met === null));
  assert.equal(R.uatSummary(s).totals.notRun, R.UAT_CRITERIA.length);
  assert.ok(R.suggestOffcuts(s, {}).problems.length > 0);
  assert.equal(R.verifyBackup([]).ok, false);
  assert.ok(Object.values(R.exportTables(s)).every((tab) => tab.length === 1));
  assert.equal(R.rolloutReadiness(s, { id: 'RO-404' }).ok, false);
  assert.deepEqual(R.offcuts(s).rows, []);
});
