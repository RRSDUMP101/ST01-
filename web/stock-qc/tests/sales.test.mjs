// Sales Office → stock-qc jobs (src/engine/sales.js): bridge commands become `jobs` rows keyed by workspace +
// productionJobId, the planner maps them to an APPROVED BOM with the number of sets they confirm, and statusFor()
// builds the status Sales Office's bridge validates. Only the base files + planning.js + sales.js are loaded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

process.env.RRS_ENGINE_ONLY = 'planning.js,sales.js';
const { RRS, world, stockIn } = await import('./helpers.mjs');

const S = RRS.sales;
const P = RRS.planning;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const codeOf = (r) => (r.ok ? (r.duplicate ? 'DUPLICATE' : 'OK') : r.errors[0].code);
const NOW = '2026-11-02T03:00:00.000Z';

/** A bridge command exactly as Sales Office builds it (partlist-store.ts preparePartListCommands). */
function command(ws, jobId, version, over = {}, envelope = {}) {
  const payload = Object.assign({
    orderNumber: 'SO6911-0001', customerId: 'cust-001', dealId: 'deal-001', customerName: 'บริษัท ลูกค้าลับ จำกัด',
    vehicle: 'ISUZU FRR 6 ล้อ', items: [{ lineId: 'line-1', description: 'กระบะดั๊มพ์ 6 คิว', qty: '2', unit: 'set', productId: 'prod-9' }],
    due: '2026-11-30', owner: 'เซลส์ทดสอบ', release: { allowed: false, blockers: ['รอรับมัดจำครบยอด'], drawingRevision: null,
      bomRevision: null, bomFingerprint: null }, cancelled: false,
  }, over);
  const payloadHash = sha(JSON.stringify(payload));
  return Object.assign({ schemaVersion: 1, commandId: 'pl:' + sha(JSON.stringify([ws, jobId, version, payloadHash])), workspace: ws,
    orderId: 'order-' + jobId.replace(/^production:/, ''), productionJobId: jobId, version, type: 'upsert_draft', payloadHash, payload }, envelope);
}
const rq = (c) => 'so.' + c.workspace + '.' + sha(c.commandId).slice(0, 40);
function sync(w, c, opts = {}) {
  const user = opts.user || 'ADMIN';
  return w.ledgerFor(user).execute({ kind: 'sales.syncJob', payload: c, requestId: opts.requestId || rq(c) },
    { user, via: opts.via === undefined ? 'sales-bridge:' + c.workspace : opts.via });
}
async function syncOk(w, c, opts) {
  const r = await sync(w, c, opts);
  if (!r.ok) throw new Error('sales.syncJob: ' + JSON.stringify(r.errors));
  return r;
}
const keyOf = (ws, id) => S.jobKeyFor(ws, id);

/** Sales Office's bridgePOST validateStatus() + schema rules (lib/rrs/partlist-bridge.ts, operations-schema.ts). */
function soAccepts(s) {
  const num = (v) => typeof v === 'number' && isFinite(v) && v >= 0;
  const known = (v) => v === null || num(v);
  assert.ok(typeof s.externalJobId === 'string' && s.externalJobId.length >= 1 && s.externalJobId.length <= 500);
  assert.ok(Number.isInteger(s.sourceVersion) && s.sourceVersion > 0);
  assert.ok(s.bomFingerprint === null || /^[a-f0-9]{64}$/.test(s.bomFingerprint));
  assert.ok(['unknown', 'ready', 'short'].includes(s.materialStatus));
  assert.ok(Array.isArray(s.parts) && s.parts.length <= 2000);
  assert.equal(new Set(s.parts.map((p) => p.partId)).size, s.parts.length, 'partId ซ้ำ');
  for (const p of s.parts) {
    assert.ok(num(p.required) && known(p.reserved) && known(p.shortage) && typeof p.unit === 'string');
    assert.ok(!(p.reserved !== null && p.reserved > p.required), 'reserved > required');
    assert.ok(!(p.shortage !== null && p.shortage > p.required), 'shortage > required');
    assert.ok(!(p.completed != null && p.completed > p.required), 'completed > required');
  }
  for (const k of ['good', 'scrap', 'rework']) assert.ok(known(s[k]));
  assert.ok(Array.isArray(s.blockers) && s.blockers.length <= 100 && s.blockers.every((b) => typeof b === 'string' && b.length <= 500));
  assert.ok(isFinite(Date.parse(s.observedAt)));
  if (s.revisionApproved) assert.ok(s.bomRevision && s.drawingRevision && s.bomFingerprint && s.revisionEvidence && s.revisionEvidence.trim());
  if (s.materialStatus === 'ready') assert.ok(s.parts.length && s.parts.every((p) => p.reserved !== null && p.reserved >= p.required && p.shortage === 0));
  return true;
}

/** World + TST-FG rev A = TST-001 × 2 + TST-002 × 1 (approved). */
async function plant() {
  const w = await world();
  await w.ok('ENG', 'bom.upsert', { product: 'TST-FG', rev: 'A', lines: [{ code: 'TST-001', qty: 2 }, { code: 'TST-002', qty: 1 }] });
  await w.ok('ENG', 'bom.approve', { product: 'TST-FG', rev: 'A' });
  return w;
}

test('รับใบงานจาก SO: เก็บรหัสตรงตัว ไม่เก็บชื่อลูกค้า และ Domestic/Export เป็นคนละใบงาน', async () => {
  const w = await plant();
  const c = command('domestic', 'production:ord-1', 1);
  const r = await syncOk(w, c);
  const key = keyOf('domestic', 'production:ord-1');
  assert.equal(key, 'SO-DOMESTIC-PRODUCTION:ORD-1');
  assert.equal(r.result.jobNo, key);
  assert.equal(r.result.created, true);
  let s = await w.state();
  const job = s.tables.jobs[key];
  assert.equal(job.source, 'sales');
  assert.equal(job.workspace, 'domestic');
  assert.equal(job.productionJobId, 'production:ord-1', 'รหัสจาก Sales Office เก็บตรงตัว');
  assert.equal(job.orderId, 'order-ord-1');
  assert.equal(job.customerId, 'cust-001');
  assert.equal(job.dealId, 'deal-001');
  assert.equal(job.orderNumber, 'SO6911-0001');
  assert.equal(job.soNo, 'SO6911-0001');
  assert.equal(job.salesCommandId, c.commandId);
  assert.equal(job.salesVersion, 1);
  assert.equal(job.salesPayloadHash, c.payloadHash);
  assert.deepEqual(job.salesItems, c.payload.items);
  assert.equal(job.salesItems[0].qty, '2');
  assert.deepEqual(job.salesRelease, c.payload.release);
  assert.equal(job.dueDate, '2026-11-30');
  assert.equal(job.status, 'OPEN');
  assert.equal(job.product, '');
  assert.equal(job.qty, 0, 'จำนวนชุดยังไม่ทราบ – ไม่เดาจาก SO');
  assert.deepEqual(job.lines, []);
  const text = JSON.stringify(s);
  assert.ok(!text.includes('บริษัท ลูกค้าลับ'), 'ไม่เก็บชื่อลูกค้า');
  assert.ok(!text.includes('เซลส์ทดสอบ'), 'ไม่เก็บชื่อผู้รับผิดชอบฝั่งขาย');
  // the same productionJobId in Export is another job
  const e = command('export', 'production:ord-1', 1, { orderNumber: 'EX-0001' });
  await syncOk(w, e);
  s = await w.state();
  const ex = s.tables.jobs[keyOf('export', 'production:ord-1')];
  assert.equal(ex.workspace, 'export');
  assert.equal(ex.orderNumber, 'EX-0001');
  assert.equal(s.tables.jobs[key].orderNumber, 'SO6911-0001');
  assert.deepEqual(S.jobs(s, { workspace: 'domestic' }).map((j) => j.jobNo), [key]);
  assert.equal(S.jobs(s).length, 2);
  // status before mapping: unknown, no parts, the blocker says what is missing
  const st = S.statusFor(s, key, 0, { now: NOW });
  assert.ok(soAccepts(st));
  assert.equal(st.externalJobId, key);
  assert.equal(st.sourceVersion, 1);
  assert.equal(st.materialStatus, 'unknown');
  assert.deepEqual(st.parts, []);
  assert.equal(st.revisionApproved, false);
  assert.equal(st.bomFingerprint, null);
  assert.equal(st.good, null, 'ไม่ทราบผล QC = null ไม่ใช่ 0');
  assert.ok(st.blockers.some((b) => /ยังไม่ได้ผูกใบงาน/.test(b)));
  assert.ok(st.blockers.includes('รอ Sales Office อนุญาตเริ่มผลิต'));
  assert.equal(S.statusFor(s, 'NO-SUCH-JOB', 0), null);
  // the audit row says who ran it and through which connector
  const audit = Object.values(s.tables.audit).find((a) => a.kind === 'sales.syncJob');
  assert.equal(audit.via, 'sales-bridge:domestic');
  assert.equal(audit.by, 'ADMIN');
});

test('รับเฉพาะจากตัวเชื่อม มีสิทธิ์ และข้อมูลถูกต้อง – ผิดข้อเดียวไม่บันทึกอะไร', async () => {
  const w = await plant();
  const c = command('domestic', 'production:ord-2', 1);
  assert.equal(codeOf(await sync(w, c, { via: '' })), 'BRIDGE_ONLY');
  assert.equal(codeOf(await sync(w, c, { via: 'PLAN' })), 'BRIDGE_ONLY');
  assert.equal(codeOf(await sync(w, c, { via: 'sales-bridge:export' })), 'BAD_COMMAND', 'คำสั่ง domestic จากตัวเชื่อม export');
  assert.equal(codeOf(await sync(w, c, { user: 'VIEW' })), 'NO_PERMISSION');
  assert.equal(codeOf(await sync(w, c, { user: 'STORE1' })), 'NO_PERMISSION');
  const tampered = JSON.parse(JSON.stringify(c));
  tampered.payload.items[0].qty = '20';
  assert.equal(codeOf(await sync(w, tampered)), 'PAYLOAD_HASH');
  const bad = [
    command('domestic', 'production:ord-2', 1, {}, { schemaVersion: 2 }),
    command('domestic', 'production:ord-2', 1, {}, { type: 'delete' }),
    command('domestic', 'production:ord-2', 1, {}, { workspace: 'live' }),
    command('domestic', 'production ord 2', 1),
    command('domestic', 'production:ord-2', 0),
    command('domestic', 'production:ord-2', 1.5),
    command('domestic', 'production:ord-2', 1, {}, { payloadHash: 'abc' }),
    command('domestic', 'production:ord-2', 1, { items: [] }),
    command('domestic', 'production:ord-2', 1, { items: [{ lineId: 'a', description: '', qty: '1', unit: '', productId: '' }, { lineId: 'a', description: '', qty: '1', unit: '', productId: '' }] }),
    command('domestic', 'production:ord-2', 1, { release: undefined }),
    command('domestic', 'production:ord-2', 1, { release: { allowed: 'yes', blockers: [] } }),
    command('domestic', 'production:ord-2', 1, { release: { allowed: false, blockers: [], bomFingerprint: 'not-a-hash' } }),
    command('domestic', 'production:ord-2', 1, { cancelled: 'no' }),
    command('domestic', 'production:ord-2', 1, { orderNumber: '' }),
    command('domestic', 'production:ord-2', 1, { customerName: { x: 1 } }),
    command('domestic', 'production:ord-2', 1, { items: [{ lineId: 'x'.repeat(10), description: 'D'.repeat(260000), qty: '1', unit: 'set', productId: '' }] }),
  ];
  for (const [i, b] of bad.entries()) {
    const r = await sync(w, b, { requestId: 'bad-command-' + i, via: 'sales-bridge:domestic' });
    assert.equal(codeOf(r), 'BAD_COMMAND', 'case ' + i + ' ' + JSON.stringify(r.errors));
    assert.match(r.errors[0].message, /Sales Office/);
  }
  const s = await w.state();
  assert.equal(S.jobs(s).length, 0, 'ไม่มีใบงานเกิดจากคำสั่งที่ไม่ผ่าน');
});

test('ฉบับเก่าหรือซ้ำไม่ทับฉบับใหม่ และรหัสงานเดิมเปลี่ยน SO ไม่ได้', async () => {
  const w = await plant();
  const id = 'production:ord-3';
  const key = keyOf('domestic', id);
  const v1 = command('domestic', id, 1);
  await syncOk(w, v1);
  const v3 = command('domestic', id, 3, { due: '2026-12-15', release: { allowed: true, blockers: [], drawingRevision: 'A', bomRevision: 'A', bomFingerprint: null } });
  const r3 = await syncOk(w, v3);
  assert.equal(r3.result.created, false);
  const v2 = command('domestic', id, 2, { due: '2026-11-01' });
  const old = await sync(w, v2);
  assert.equal(codeOf(old), 'OLDER_VERSION');
  assert.match(old.errors[0].message, /ฉบับ 3/);
  assert.equal(codeOf(await sync(w, v3, { requestId: 'another-request-id' })), 'OLDER_VERSION', 'ฉบับเดิมซ้ำด้วยคำขออื่น');
  assert.equal(codeOf(await sync(w, v3)), 'DUPLICATE', 'คำขอเดิมข้อมูลเดิม = ทำครั้งเดียว');
  const reused = await sync(w, v2, { requestId: rq(v3) });
  assert.equal(codeOf(reused), 'REQUEST_REUSED');
  let s = await w.state();
  const job = s.tables.jobs[key];
  assert.equal(job.salesVersion, 3);
  assert.equal(job.salesCommandId, v3.commandId);
  assert.equal(job.dueDate, '2026-12-15');
  assert.equal(job.salesRelease.allowed, true);
  assert.equal(job.log.length, 2);
  // the same productionJobId with another SO id is refused (IDs are never re-bound)
  const moved = command('domestic', id, 4, {}, { orderId: 'order-other' });
  assert.equal(codeOf(await sync(w, moved)), 'MAPPING_CONFLICT');
  // a job created by hand with the same key is never taken over
  await w.ok('PLAN', 'job.create', { jobNo: 'SO-DOMESTIC-HANDMADE', soNo: 'SO-X', lines: [{ code: 'TST-001', qty: 1 }], dueDate: '2026-11-20' });
  assert.equal(codeOf(await sync(w, command('domestic', 'handmade', 1))), 'MAPPING_CONFLICT');
  s = await w.state();
  assert.equal(s.tables.jobs[key].salesVersion, 3);
  assert.equal(s.tables.jobs['SO-DOMESTIC-HANDMADE'].source, undefined);
});

test('ผูก BOM: ต้องเป็นฉบับที่อนุมัติ และต้องยืนยันจำนวนชุดเอง (จำนวนใน SO แสดงเท่านั้น)', async () => {
  const w = await plant();
  const id = 'production:ord-4';
  const key = keyOf('domestic', id);
  await syncOk(w, command('domestic', id, 1));
  const map = (p, user = 'PLAN') => w.exec(user, 'sales.mapJob', Object.assign({ jobKey: key }, p));
  assert.equal(codeOf(await map({ product: 'TST-FG' })), 'REQUIRED', 'ไม่มีจำนวนชุด = ไม่เดาจาก SO');
  assert.match((await map({ product: 'TST-FG' })).errors[0].message, /ไม่เดาจำนวนจาก SO/);
  assert.equal(codeOf(await map({ product: 'TST-FG', qty: 0 })), 'BAD_QTY');
  assert.equal(codeOf(await map({ product: 'TST-002', qty: 1 })), 'NO_BOM');
  await w.ok('ENG', 'bom.upsert', { product: 'TST-FG', rev: 'B', lines: [{ code: 'TST-001', qty: 3 }] });
  assert.equal(codeOf(await map({ product: 'TST-FG', bomRev: 'B', qty: 1 })), 'BOM_NOT_APPROVED');
  assert.equal(codeOf(await map({ product: 'NOPE', qty: 1 })), 'NOT_FOUND');
  assert.equal(codeOf(await map({ product: 'TST-FG', qty: 1 }, 'STORE1')), 'NO_PERMISSION');
  await w.ok('PLAN', 'job.create', { jobNo: 'JB-HAND', soNo: 'SO-H', lines: [{ code: 'TST-001', qty: 1 }], dueDate: '2026-11-20' });
  assert.equal(codeOf(await w.exec('PLAN', 'sales.mapJob', { jobKey: 'JB-HAND', product: 'TST-FG', qty: 1 })), 'NOT_SALES');
  const r = await w.ok('PLAN', 'sales.mapJob', { jobKey: key, product: 'TST-FG', qty: 3 });
  assert.equal(r.result.bomRev, 'A');
  assert.equal(r.result.lines, 2);
  assert.match(r.result.fingerprint, /^[a-f0-9]{64}$/);
  const s = await w.state();
  const job = s.tables.jobs[key];
  assert.equal(job.product, 'TST-FG');
  assert.equal(job.bomRev, 'A');
  assert.equal(job.qty, 3, 'จำนวนที่ฝ่ายวางแผนยืนยัน ไม่ใช่ 2 ใน SO');
  assert.equal(job.salesItems[0].qty, '2', 'รายการ SO ไม่ถูกแก้');
  assert.deepEqual(job.lines.map((l) => [l.line, l.code, l.required, l.toMake, !!l.output]),
    [[0, 'TST-FG', 0, 3, true], [1, 'TST-001', 6, 0, false], [2, 'TST-002', 3, 0, false]]);
  assert.equal(job.mappedBy, 'PLAN');
  assert.equal(job.salesChanged, false);
  // planning commands work on the job as on any other job
  const rs = await w.exec('PLAN', 'reserve.create', { jobNo: key, code: 'TST-001', wh: 'A', qty: 1 });
  assert.equal(codeOf(rs), 'NO_FREE');
});

test('สถานะวัตถุดิบ: ready เฉพาะเมื่อทุกบรรทัดจอง/เบิกครบและไม่ขาด – ตรงกฎที่ Sales Office ตรวจ', async () => {
  const w = await plant();
  const id = 'production:ord-5';
  const key = keyOf('domestic', id);
  await syncOk(w, command('domestic', id, 1));
  await w.ok('PLAN', 'sales.mapJob', { jobKey: key, product: 'TST-FG', qty: 3 });
  // nothing in stock → short
  let st = S.statusFor(await w.state(), key, 0, { now: NOW });
  assert.ok(soAccepts(st));
  assert.equal(st.materialStatus, 'short');
  assert.deepEqual(st.parts.map((p) => [p.partId, p.required, p.reserved, p.shortage, p.unit, p.completed]),
    [['TST-001', 6, 0, 6, 'ชิ้น', 0], ['TST-002', 3, 0, 3, 'ชิ้น', 0]]);
  assert.ok(st.blockers.includes('TST-001 ขาด 6 ชิ้น'));
  assert.equal(st.revisionApproved, true);
  assert.equal(st.bomRevision, 'A');
  assert.equal(st.drawingRevision, 'A');
  assert.match(st.bomFingerprint, /^[a-f0-9]{64}$/);
  assert.match(st.revisionEvidence, /อนุมัติในระบบสต็อกโดย ENG/);
  // enough free stock but not reserved: not ready, not short
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  await stockIn(w, 'TST-002', 'A', 'A-01', 3);
  st = S.statusFor(await w.state(), key, 1, { now: NOW });
  assert.ok(soAccepts(st));
  assert.equal(st.materialStatus, 'unknown');
  assert.deepEqual(st.parts.map((p) => [p.reserved, p.shortage]), [[0, 0], [0, 0]]);
  assert.ok(st.blockers.includes('TST-001 ยังไม่ได้จอง 6 ชิ้น'));
  // one line reserved: still not ready
  await w.ok('PLAN', 'reserve.create', { jobNo: key, code: 'TST-001', wh: 'A', qty: 6 });
  st = S.statusFor(await w.state(), key, 2, { now: NOW });
  assert.equal(st.materialStatus, 'unknown');
  assert.equal(st.parts[0].reserved, 6);
  // every line reserved in full → ready
  await w.ok('PLAN', 'reserve.create', { jobNo: key, code: 'TST-002', wh: 'A', qty: 3 });
  st = S.statusFor(await w.state(), key, 3, { now: NOW });
  assert.ok(soAccepts(st));
  assert.equal(st.materialStatus, 'ready');
  assert.ok(!st.blockers.some((b) => /ขาด|ยังไม่ได้จอง/.test(b)));
  // issuing against the job keeps the line covered (issued counts as secured); reserved never exceeds required
  await w.ok('STORE1', 'doc.post', { type: 'PD', job: key, lines: [{ code: 'TST-001', qty: 6, wh: 'A', bin: 'A-01' }] });
  await w.ok('STORE1', 'doc.post', { type: 'PD', job: key, lines: [{ code: 'TST-001', qty: 2, wh: 'A', bin: 'A-01' }] });
  st = S.statusFor(await w.state(), key, 4, { now: NOW });
  assert.ok(soAccepts(st));
  assert.equal(st.materialStatus, 'ready');
  assert.equal(st.parts[0].reserved, 6, 'เบิกเกินแผน ยังรายงานไม่เกินที่ต้องใช้');
  // a newer BOM approved → the job's revision is no longer the approved one
  await w.ok('ENG', 'bom.upsert', { product: 'TST-FG', rev: 'B', lines: [{ code: 'TST-001', qty: 3 }] });
  await w.ok('ENG', 'bom.approve', { product: 'TST-FG', rev: 'B' });
  st = S.statusFor(await w.state(), key, 5, { now: NOW });
  assert.ok(soAccepts(st));
  assert.equal(st.revisionApproved, false);
  assert.equal(st.revisionEvidence, null);
  assert.ok(st.blockers.some((b) => /ไม่ใช่ฉบับที่อนุมัติ \(ฉบับที่อนุมัติ: B\)/.test(b)));
  // finished pieces are reported as completed, capped by required
  assert.equal(st.parts[1].completed, 0);
});

test('SO ยกเลิก: ใบงานยกเลิกและปล่อยของจอง – เปิดใหม่ได้เฉพาะงานที่ Sales Office ยกเลิก', async () => {
  const w = await plant();
  const id = 'production:ord-6';
  const key = keyOf('export', id);
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  await stockIn(w, 'TST-002', 'A', 'A-01', 5);
  await syncOk(w, command('export', id, 1));
  await w.ok('PLAN', 'sales.mapJob', { jobKey: key, product: 'TST-FG', qty: 2 });
  const ra = (await w.ok('PLAN', 'reserve.create', { jobNo: key, code: 'TST-001', wh: 'A', qty: 4 })).result.id;
  const rb = (await w.ok('PLAN', 'reserve.create', { jobNo: key, code: 'TST-002', wh: 'A', qty: 2 })).result.id;
  let s = await w.state();
  assert.equal(P.free(s, 'TST-001', 'A'), 6);
  const r = await syncOk(w, command('export', id, 2, { cancelled: true }));
  assert.equal(r.result.status, 'CANCELLED');
  assert.deepEqual(r.result.released.map((x) => [x.id, x.qty]), [[ra, 4], [rb, 2]]);
  s = await w.state();
  const job = s.tables.jobs[key];
  assert.equal(job.status, 'CANCELLED');
  assert.equal(job.cancelled, true);
  assert.equal(job.cancelledBySales, true);
  assert.match(job.cancelReason, /Sales Office ยกเลิก/);
  assert.equal(s.tables.reservations[ra].status, 'RELEASED');
  assert.equal(s.tables.reservations[ra].releasedQty, 4);
  assert.match(s.tables.reservations[ra].reason, /Sales Office ยกเลิก SO/);
  assert.equal(P.free(s, 'TST-001', 'A'), 10, 'ของจองกลับเป็นของพร้อมเบิก');
  let st = S.statusFor(s, key, 0, { now: NOW });
  assert.ok(soAccepts(st));
  assert.equal(st.materialStatus, 'unknown');
  assert.ok(st.blockers.includes('Sales Office ยกเลิก SO นี้แล้ว'));
  assert.equal(codeOf(await w.exec('PLAN', 'sales.mapJob', { jobKey: key, product: 'TST-FG', qty: 1 })), 'JOB_CLOSED');
  assert.equal(codeOf(await w.exec('PLAN', 'reserve.create', { jobNo: key, code: 'TST-001', wh: 'A', qty: 1 })), 'JOB_CLOSED');
  // Sales Office opens the SO again
  await syncOk(w, command('export', id, 3));
  s = await w.state();
  assert.equal(s.tables.jobs[key].status, 'OPEN');
  assert.equal(s.tables.jobs[key].cancelled, false);
  assert.equal(s.tables.jobs[key].cancelReason, '');
  // a planner cancels it in stock-qc; a later SO version does not reopen it
  await w.ok('PLAN', 'job.cancel', { jobNo: key, reason: 'ลูกค้าเปลี่ยนแผน' });
  await syncOk(w, command('export', id, 4, { due: '2026-12-01' }));
  s = await w.state();
  assert.equal(s.tables.jobs[key].status, 'CANCELLED');
  assert.equal(s.tables.jobs[key].salesVersion, 4);
  st = S.statusFor(s, key, 1, { now: NOW });
  assert.ok(st.blockers.includes('ใบงานถูกยกเลิกในระบบสต็อก'));
  assert.equal(st.materialStatus, 'unknown');
});

test('ยกเลิกทั้งที่เบิกของไปแล้ว: บันทึกของค้างให้คืน ไม่ลบประวัติ', async () => {
  const w = await plant();
  const id = 'production:ord-7';
  const key = keyOf('domestic', id);
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  await syncOk(w, command('domestic', id, 1));
  await w.ok('PLAN', 'sales.mapJob', { jobKey: key, product: 'TST-FG', qty: 1 });
  await w.ok('PLAN', 'reserve.create', { jobNo: key, code: 'TST-001', wh: 'A', qty: 2 });
  await w.ok('STORE1', 'doc.post', { type: 'PD', job: key, lines: [{ code: 'TST-001', qty: 2, wh: 'A', bin: 'A-01' }] });
  const r = await syncOk(w, command('domestic', id, 2, { cancelled: true }));
  assert.ok(r.warnings.some((x) => /ของเบิกค้าง/.test(x)));
  const s = await w.state();
  const job = s.tables.jobs[key];
  assert.equal(job.status, 'CANCELLED');
  assert.deepEqual(job.forced.outstanding, [{ line: 1, code: 'TST-001', issued: 2 }]);
  const st = S.statusFor(s, key, 0, { now: NOW });
  assert.ok(st.blockers.includes('มีของเบิกค้างจากงานที่ยกเลิก – ต้องคืนเข้าคลัง (RT)'));
  assert.equal(st.parts[0].shortage, 0);
  // the store returns the material against the cancelled job
  await w.ok('STORE1', 'doc.post', { type: 'RT', job: key, lines: [{ code: 'TST-001', qty: 2, wh: 'A', bin: 'A-01' }] });
  assert.equal((await w.state()).tables.jobs[key].lines[1].issued, 0);
});

test('SO เปลี่ยนรายการหลังผูก BOM → ต้องผูกใหม่; วันกำหนดใหม่ย้ายวันต้องใช้ของจอง', async () => {
  const w = await plant();
  const id = 'production:ord-8';
  const key = keyOf('domestic', id);
  await stockIn(w, 'TST-001', 'A', 'A-01', 10);
  await syncOk(w, command('domestic', id, 1));
  await w.ok('PLAN', 'sales.mapJob', { jobKey: key, product: 'TST-FG', qty: 2 });
  const rid = (await w.ok('PLAN', 'reserve.create', { jobNo: key, code: 'TST-001', wh: 'A', qty: 4 })).result.id;
  let s = await w.state();
  assert.equal(s.tables.reservations[rid].needDate, '2026-11-30');
  const items = [{ lineId: 'line-1', description: 'กระบะดั๊มพ์ 6 คิว', qty: '3', unit: 'set', productId: 'prod-9' }];
  const r = await syncOk(w, command('domestic', id, 2, { items, due: '2026-12-10T10:00:00+07:00' }));
  assert.ok(r.result.changes.includes('รายการ SO เปลี่ยน'));
  s = await w.state();
  const job = s.tables.jobs[key];
  assert.equal(job.salesChanged, true);
  assert.equal(job.qty, 2, 'จำนวนชุดไม่เปลี่ยนเองตาม SO');
  assert.equal(job.dueDate, '2026-12-10');
  assert.equal(s.tables.reservations[rid].needDate, '2026-12-10', 'ของจองตามวันกำหนดใหม่');
  let st = S.statusFor(s, key, 0, { now: NOW });
  assert.ok(st.blockers.includes('รายการใน SO เปลี่ยนหลังผูก BOM – ฝ่ายวางแผนต้องตรวจและผูกใหม่'));
  assert.equal(codeOf(await w.exec('PLAN', 'sales.mapJob', { jobKey: key, product: 'TST-FG', qty: 3 })), 'HAS_RESERVATIONS');
  await w.ok('PLAN', 'reserve.release', { id: rid, reason: 'SO เปลี่ยนจำนวน' });
  await w.ok('PLAN', 'sales.mapJob', { jobKey: key, product: 'TST-FG', qty: 3 });
  s = await w.state();
  assert.equal(s.tables.jobs[key].salesChanged, false);
  assert.equal(s.tables.jobs[key].lines[1].required, 6);
  st = S.statusFor(s, key, 0, { now: NOW });
  assert.ok(!st.blockers.some((b) => /เปลี่ยนหลังผูก/.test(b)));
  // the same SO lines again (a later version with only the due date changed) do not raise the flag
  await syncOk(w, command('domestic', id, 3, { items, due: '2026-12-11' }));
  assert.equal((await w.state()).tables.jobs[key].salesChanged, false);
  // an unreadable due date is a warning, the job has no due date then
  const odd = await syncOk(w, command('domestic', id, 4, { items, due: 'ปลายเดือน' }));
  assert.ok(odd.warnings.some((x) => /อ่านไม่ได้/.test(x)));
  assert.equal((await w.state()).tables.jobs[key].dueDate, '');
});

test('fingerprint ของงานเปลี่ยนเมื่อจำนวนชุดเปลี่ยน และเทียบกับ fingerprint ที่ Sales Office อนุมัติ', async () => {
  const w = await plant();
  const id = 'production:ord-9';
  const key = keyOf('domestic', id);
  await syncOk(w, command('domestic', id, 1));
  const a = (await w.ok('PLAN', 'sales.mapJob', { jobKey: key, product: 'TST-FG', qty: 2 })).result.fingerprint;
  const b = (await w.ok('PLAN', 'sales.mapJob', { jobKey: key, product: 'TST-FG', qty: 3 })).result.fingerprint;
  assert.notEqual(a, b);
  let s = await w.state();
  assert.equal(S.fingerprint(s.tables.jobs[key]), b);
  await syncOk(w, command('domestic', id, 2, { release: { allowed: true, blockers: [], drawingRevision: 'A', bomRevision: 'A', bomFingerprint: a } }));
  let st = S.statusFor(await w.state(), key, 0, { now: NOW });
  assert.ok(st.blockers.includes('BOM ที่ Sales Office อนุมัติไม่ตรงกับ BOM ของใบงานนี้'));
  assert.ok(!st.blockers.includes('รอ Sales Office อนุญาตเริ่มผลิต'));
  await syncOk(w, command('domestic', id, 3, { release: { allowed: true, blockers: [], drawingRevision: 'A', bomRevision: 'A', bomFingerprint: b } }));
  st = S.statusFor(await w.state(), key, 41, { now: '2026-11-02T05:00:00.000Z' });
  assert.ok(!st.blockers.some((x) => /ไม่ตรงกับ BOM/.test(x)));
  assert.equal(st.bomFingerprint, b);
  assert.equal(st.sourceVersion, 42);
  assert.equal(st.observedAt, '2026-11-02T05:00:00.000Z');
  const content = S.statusContent(st);
  assert.equal(content.sourceVersion, undefined);
  assert.equal(content.observedAt, undefined);
  assert.equal(content.bomFingerprint, b);
  s = await w.state();
  // replaying every commit from genesis gives the same jobs (the commits are the record)
  const replay = RRS.core.createState();
  for (const c of w.store.commits) RRS.core.reduce(replay, JSON.parse(JSON.stringify(c)));
  assert.deepEqual(replay.tables.jobs, s.tables.jobs);
});

test('รหัสชิ้นส่วนเดียวกันสองบรรทัด: รายงานเป็นหนึ่งรายการ นับของจองครั้งเดียว และไม่รายงาน ready เกินจริง', async () => {
  const w = await plant();
  const id = 'production:ord-dup';
  const key = keyOf('domestic', id);
  await syncOk(w, command('domestic', id, 1));
  await w.ok('PLAN', 'sales.mapJob', { jobKey: key, product: 'TST-FG', qty: 2 });
  await stockIn(w, 'TST-001', 'A', 'A-01', 4);
  await stockIn(w, 'TST-002', 'A', 'A-01', 2);
  await w.ok('PLAN', 'reserve.create', { jobNo: key, code: 'TST-001', wh: 'A', qty: 4 });
  await w.ok('PLAN', 'reserve.create', { jobNo: key, code: 'TST-002', wh: 'A', qty: 2 });
  const state = await w.state();
  assert.equal(S.statusFor(state, key, 0, { now: NOW }).materialStatus, 'ready');
  // the same code on a second plan line (sales.mapJob never does this; a job edited elsewhere might): TST-001 now needs
  // 4 + 2 while only 4 are reserved – one part, the reservation counted once, the rest short
  const edited = structuredClone(state);
  edited.tables.jobs[key].lines.push({ line: 9, code: 'TST-001', per: 1, required: 2, issued: 0, toMake: 0, finished: 0, received: 0, note: '' });
  const st = S.statusFor(edited, key, 1, { now: NOW });
  assert.ok(soAccepts(st));
  assert.deepEqual(st.parts.map((p) => [p.partId, p.required, p.reserved, p.shortage]), [['TST-001', 6, 4, 2], ['TST-002', 2, 2, 0]]);
  assert.equal(st.materialStatus, 'short');
  assert.ok(st.blockers.includes('TST-001 ขาด 2 ชิ้น'));
});
