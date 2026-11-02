// Sales Office connector (src/sales-bridge.js) against a local fake of Sales Office's Part List bridge that enforces its
// real rules (test/fake-sales.mjs). Nothing leaves the machine: the outbound router answers for https://sales.test only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { startServer, outboundRouter, replay, rid } from './helpers.mjs';
import { fakeSales } from './fake-sales.mjs';
import { packEvents, POST_BODY_BYTES, EVENTS_PER_POST } from '../src/sales-bridge.js';

const SYNC_CRON = '*/15 * * * *';
const CUSTOMER = 'บริษัท ลูกค้าห้ามเก็บ จำกัด';
const SALES_OWNER = 'พนักงานขายห้ามเก็บ';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyOf = (ws, id) => ('SO-' + ws + '-' + id).toUpperCase();

function salesSetup(over = {}, fakeSecrets) {
  const secrets = { domestic: randomBytes(24).toString('hex'), export: randomBytes(24).toString('hex') };
  const connectorId = 'stockqc-staging-' + randomBytes(3).toString('hex');
  const f = fakeSales({ connectorId, secrets: fakeSecrets || secrets });
  const ctl = { delay: 0 };
  const router = outboundRouter({ 'sales.test': async (req) => {
    if (ctl.delay) await sleep(ctl.delay);
    return f.handle(req);
  } });
  const bindings = Object.assign({ SQ_SALES_URL: 'https://sales.test', SQ_SALES_CONNECTOR_ID: connectorId, SQ_SALES_DOMESTIC_SECRET: secrets.domestic,
    SQ_SALES_EXPORT_SECRET: secrets.export, SQ_SALES_BRIDGE: 'pull_push' }, over);
  return { f, router, bindings, secrets, connectorId, ctl };
}
function soPayload(over = {}) {
  return Object.assign({ orderNumber: 'SO6911-0007', customerId: 'cust-77', dealId: 'deal-77', customerName: CUSTOMER, vehicle: 'HINO 10 ล้อ',
    items: [{ lineId: 'l-1', description: 'กระบะดั๊มพ์ 10 คิว', qty: '1', unit: 'set', productId: '' }], due: '2026-11-25', owner: SALES_OWNER,
    release: { allowed: false, blockers: ['รอรับมัดจำครบยอด'], drawingRevision: null, bomRevision: null, bomFingerprint: null }, cancelled: false }, over);
}
/** Owner starts the system; stock masters + TST-FG rev A (TST-001 × 2 + TST-002 × 1) approved. */
async function plant(s) {
  const owner = await s.ownerLogin();
  await s.ok(owner, 'system.bootstrap', { name: 'เจ้าของทดสอบ', company: 'บริษัททดสอบ', userId: 'ADMIN' });
  await s.ok(owner, 'master.import', {
    warehouses: [{ code: 'A', name: 'คลัง A' }], bins: [{ wh: 'A', code: 'A-01' }],
    items: [{ code: 'TST-001', name: 'ชิ้นทดสอบ 1', baseUnit: 'ชิ้น', type: 'PART' }, { code: 'TST-002', name: 'ชิ้นทดสอบ 2', baseUnit: 'ชิ้น', type: 'PART' },
      { code: 'TST-FG', name: 'กระบะทดสอบ', baseUnit: 'ชุด', type: 'FG' }],
  });
  await s.ok(owner, 'bom.upsert', { product: 'TST-FG', rev: 'A', lines: [{ code: 'TST-001', qty: 2 }, { code: 'TST-002', qty: 1 }] });
  await s.ok(owner, 'bom.approve', { product: 'TST-FG', rev: 'A' });
  return owner;
}
const sync = (s, cookie, body) => s.callJson('/api/sales/sync', { cookie, body: body || {} });
const resultOf = (r, ws) => r.body.results.find((x) => x.workspace === ws);
async function allText(d1) {
  const out = [];
  for (const t of ['sq_commits', 'sq_records', 'sq_bridge_commands', 'sq_bridge_events', 'sq_bridge_issues', 'sq_bridge_health', 'sq_security_events']) {
    out.push(JSON.stringify((await d1.prepare(`SELECT * FROM ${t}`).all()).results));
  }
  return out.join('\n');
}

test('ปิดเป็นค่าเริ่มต้น และตั้งค่าไม่ปลอดภัย = ไม่ส่งคำขอใด ๆ', async () => {
  const off = salesSetup({ SQ_SALES_BRIDGE: 'off' });
  off.f.addCommand('domestic', { productionJobId: 'production:so-1', orderId: 'so-1', payload: soPayload() });
  let s = await startServer({ outbound: off.router, bindings: off.bindings });
  try {
    const owner = await plant(s);
    const r = await sync(s, owner);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'BRIDGE_OFF');
    await s.scheduled(SYNC_CRON);
    const st = await s.callJson('/api/sales/status', { cookie: owner });
    assert.equal(st.status, 200);
    assert.equal(st.body.mode, 'off');
    assert.equal(st.body.schedule.active, false);
    for (const v of [off.secrets.domestic, off.secrets.export]) assert.ok(!st.text.includes(v));
    assert.equal(off.router.requests.length, 0, 'not a single request when off');
    assert.equal((await replay(s.d1)).state.tables.jobs, undefined);
  } finally {
    await s.dispose();
  }
  // the same secret for both workspaces: nothing runs (Sales Office refuses that too)
  const same = salesSetup();
  same.bindings.SQ_SALES_EXPORT_SECRET = same.bindings.SQ_SALES_DOMESTIC_SECRET;
  s = await startServer({ outbound: same.router, bindings: same.bindings });
  try {
    const owner = await plant(s);
    const r = await sync(s, owner);
    assert.equal(r.status, 200);
    for (const ws of ['domestic', 'export']) {
      assert.equal(resultOf(r, ws).code, 'NOT_CONFIGURED');
      assert.ok(resultOf(r, ws).problems.includes('SQ_SALES_SECRETS_EQUAL'));
    }
    assert.equal(same.router.requests.length, 0);
  } finally {
    await s.dispose();
  }
  // a short Export secret and an http URL
  const short = salesSetup({ SQ_SALES_EXPORT_SECRET: 'x'.repeat(31) });
  s = await startServer({ outbound: short.router, bindings: short.bindings });
  try {
    const owner = await plant(s);
    const r = await sync(s, owner);
    assert.deepEqual(resultOf(r, 'export').problems, ['SQ_SALES_EXPORT_SECRET_TOO_SHORT']);
    assert.equal(resultOf(r, 'domestic').ok, true);
    assert.ok(short.f.log.length > 0 && short.f.log.every((x) => x.mode === 'domestic'), 'only Domestic talked to Sales Office');
  } finally {
    await s.dispose();
  }
  // a mode that is not exactly pull / pull_push is off (fails closed): no request
  for (const mode of ['PULL_PUSH', ' pull', 'push', 'on', 'true']) {
    const m = salesSetup({ SQ_SALES_BRIDGE: mode });
    m.f.addCommand('domestic', { productionJobId: 'production:so-1', orderId: 'so-1', payload: soPayload() });
    s = await startServer({ outbound: m.router, bindings: m.bindings });
    try {
      const owner = await plant(s);
      const r = await sync(s, owner);
      assert.equal(r.body.code, 'BRIDGE_OFF', mode);
      await s.scheduled(SYNC_CRON);
      assert.equal(m.router.requests.length, 0, mode);
    } finally {
      await s.dispose();
    }
  }
  const http = salesSetup({ SQ_SALES_URL: 'http://sales.test' });
  s = await startServer({ outbound: http.router, bindings: http.bindings });
  try {
    const owner = await plant(s);
    const r = await sync(s, owner);
    assert.ok(resultOf(r, 'domestic').problems.includes('SQ_SALES_URL_INVALID'));
    assert.equal(http.router.requests.length, 0);
  } finally {
    await s.dispose();
  }
});

test('pull: คำสั่งเป็นใบงานผ่าน ledger (หนึ่ง commit ต่อคำสั่ง) แยก Domestic/Export ตามหน้า cursor และไม่ POST เลย', async () => {
  const { f, router, bindings, secrets } = salesSetup({ SQ_SALES_BRIDGE: 'pull' });
  f.pageSize = 2;
  f.addCommand('domestic', { productionJobId: 'production:so-a', orderId: 'so-a', payload: soPayload() });
  f.addCommand('domestic', { productionJobId: 'production:so-b', orderId: 'so-b', payload: soPayload({ orderNumber: 'SO6911-0008' }) });
  f.addCommand('domestic', { productionJobId: 'production:so-c', orderId: 'so-c', payload: soPayload({ orderNumber: 'SO6911-0009' }) });
  f.addCommand('export', { productionJobId: 'production:so-a', orderId: 'so-a-export', payload: soPayload({ orderNumber: 'EX6911-0001' }) });
  const s = await startServer({ outbound: router, bindings });
  try {
    const owner = await plant(s);
    const r = await sync(s, owner);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.ok, true);
    assert.equal(resultOf(r, 'domestic').applied, 3);
    assert.equal(resultOf(r, 'domestic').pages, 2);
    assert.equal(resultOf(r, 'export').applied, 1);
    assert.ok(f.log.every((x) => x.method === 'GET'), 'pull mode never POSTs');
    assert.deepEqual(f.log.filter((x) => x.mode === 'domestic').map((x) => x.cursor), ['', 'production:so-b']);
    let db = await replay(s.d1);
    const jobs = db.state.tables.jobs;
    assert.deepEqual(Object.keys(jobs).sort(), [keyOf('domestic', 'production:so-a'), keyOf('domestic', 'production:so-b'),
      keyOf('domestic', 'production:so-c'), keyOf('export', 'production:so-a')].sort());
    assert.equal(jobs[keyOf('export', 'production:so-a')].orderId, 'so-a-export');
    assert.equal(jobs[keyOf('export', 'production:so-a')].orderNumber, 'EX6911-0001');
    assert.equal(jobs[keyOf('domestic', 'production:so-a')].orderId, 'so-a');
    const commits = (await s.d1.prepare("SELECT \"by\", via FROM sq_commits WHERE kind='sales.syncJob' ORDER BY seq").all()).results;
    assert.equal(commits.length, 4);
    assert.ok(commits.every((c) => c.by === 'ADMIN'), 'runs as the engine user bound to the owner account');
    assert.deepEqual(commits.map((c) => c.via), ['sales-bridge:domestic', 'sales-bridge:domestic', 'sales-bridge:domestic', 'sales-bridge:export']);
    const journal = (await s.d1.prepare('SELECT workspace,status,applied_seq FROM sq_bridge_commands').all()).results;
    assert.equal(journal.length, 4);
    assert.ok(journal.every((x) => x.status === 'applied' && x.applied_seq > 0));
    // the same feed again: nothing new, no commit
    const before = db.commits;
    const again = await sync(s, owner);
    assert.equal(resultOf(again, 'domestic').applied, 0);
    assert.equal(resultOf(again, 'domestic').unchanged, 3);
    db = await replay(s.d1);
    assert.equal(db.commits, before);
    assert.deepEqual(db.records.jobs, db.tables.jobs, 'sq_records follows the commits');
    // no customer name and no SO owner anywhere in D1; no secret either
    const text = await allText(s.d1);
    for (const v of [CUSTOMER, SALES_OWNER, secrets.domestic, secrets.export]) assert.ok(!text.includes(v), 'D1 holds ' + v.slice(0, 10));
    const st = await s.callJson('/api/sales/status', { cookie: owner });
    assert.equal(st.body.mode, 'pull');
    assert.equal(st.body.push, false);
    assert.equal(st.body.workspaces.domestic.commands.applied, 3);
    assert.ok(st.body.workspaces.domestic.lastPullAt);
    assert.equal(st.body.workspaces.domestic.lastPushAt, null);
    assert.equal(st.body.salesHost, 'sales.test');
    for (const v of [secrets.domestic, secrets.export]) assert.ok(!st.text.includes(v));
    assert.deepEqual(router.blocked, []);
  } finally {
    await s.dispose();
  }
});

test('ฉบับใหม่ใช้ได้ ฉบับเดิมข้อมูลต่าง/งานเดิมรหัสอื่น/hash ไม่ตรง/คนละพื้นที่/ข้อมูลผิด = หยุดและบันทึก', async () => {
  const { f, router, bindings } = salesSetup({ SQ_SALES_BRIDGE: 'pull' });
  f.addCommand('domestic', { productionJobId: 'production:so-a', orderId: 'so-a', payload: soPayload() });
  const b1 = f.addCommand('domestic', { productionJobId: 'production:so-b', orderId: 'so-b', payload: soPayload({ orderNumber: 'B' }) });
  f.addCommand('domestic', { productionJobId: 'production:so-c', orderId: 'so-c', payload: soPayload({ orderNumber: 'C' }) });
  const s = await startServer({ outbound: router, bindings });
  try {
    const owner = await plant(s);
    await sync(s, owner);
    // a newer version is applied
    const a2 = f.addCommand('domestic', { productionJobId: 'production:so-a', orderId: 'so-a', payload: soPayload({ due: '2026-12-20' }) });
    let r = await sync(s, owner);
    assert.equal(resultOf(r, 'domestic').applied, 1);
    let jobs = (await replay(s.d1)).state.tables.jobs;
    assert.equal(jobs[keyOf('domestic', 'production:so-a')].salesVersion, 2);
    assert.equal(jobs[keyOf('domestic', 'production:so-a')].dueDate, '2026-12-20');
    // Sales Office misbehaves in five ways at once
    const tampered = soPayload({ due: '2027-01-31' });
    f.addRaw('domestic', Object.assign({}, a2, { payload: tampered, payloadHash: sha(JSON.stringify(tampered)) })); // known id, other payload
    const otherB = soPayload({ orderNumber: 'B', vehicle: 'อื่น' });
    f.addRaw('domestic', Object.assign({}, b1, { commandId: 'pl:' + sha('other-b'), payload: otherB, payloadHash: sha(JSON.stringify(otherB)) })); // same job+version
    f.addRaw('domestic', { schemaVersion: 1, commandId: 'pl:' + sha('c2'), workspace: 'domestic', orderId: 'so-c', productionJobId: 'production:so-c', version: 2,
      type: 'upsert_draft', payloadHash: 'f'.repeat(64), payload: soPayload({ orderNumber: 'C' }) });
    const exp = soPayload({ orderNumber: 'X' });
    f.addRaw('domestic', { schemaVersion: 1, commandId: 'pl:' + sha('d1'), workspace: 'export', orderId: 'so-d', productionJobId: 'production:so-d', version: 1,
      type: 'upsert_draft', payloadHash: sha(JSON.stringify(exp)), payload: exp });
    f.addCommand('domestic', { productionJobId: 'production:so-e', orderId: 'so-e', payload: soPayload({ items: [] }) });
    r = await sync(s, owner);
    const d = resultOf(r, 'domestic');
    assert.equal(d.applied, 0);
    assert.equal(d.blocked, 5);
    jobs = (await replay(s.d1)).state.tables.jobs;
    assert.equal(jobs[keyOf('domestic', 'production:so-a')].dueDate, '2026-12-20', 'the conflicting payload is never applied');
    assert.equal(jobs[keyOf('domestic', 'production:so-b')].vehicle, 'HINO 10 ล้อ');
    assert.equal(jobs[keyOf('domestic', 'production:so-c')].salesVersion, 1);
    assert.equal(jobs[keyOf('export', 'production:so-d')], undefined);
    assert.equal(jobs[keyOf('domestic', 'production:so-d')], undefined);
    assert.equal(jobs[keyOf('domestic', 'production:so-e')], undefined);
    const issues = (await s.d1.prepare('SELECT code,command_id,job_id,version,known_hash,received_hash,seen FROM sq_bridge_issues ORDER BY code').all()).results;
    assert.deepEqual(issues.map((x) => x.code), ['BAD_COMMAND', 'PAYLOAD_CONFLICT', 'PAYLOAD_HASH_MISMATCH', 'VERSION_CONFLICT', 'WORKSPACE_MISMATCH']);
    const conflict = issues.find((x) => x.code === 'PAYLOAD_CONFLICT');
    assert.equal(conflict.command_id, a2.commandId);
    assert.equal(conflict.known_hash, a2.payloadHash);
    assert.equal(conflict.received_hash, sha(JSON.stringify(tampered)));
    assert.equal((await s.d1.prepare('SELECT status,error FROM sq_bridge_commands WHERE command_id=?').bind(a2.commandId).first()).status, 'blocked');
    const events = (await s.d1.prepare("SELECT event FROM sq_security_events WHERE event LIKE 'sales_bridge_%'").all()).results;
    assert.equal(events.length, 5);
    // seen again on the next poll: counted, not duplicated, no new security event
    await sync(s, owner);
    const again = (await s.d1.prepare('SELECT code,seen FROM sq_bridge_issues ORDER BY code').all()).results;
    assert.ok(again.length === 5 && again.every((x) => x.seen === 2), JSON.stringify(again));
    assert.equal((await s.d1.prepare("SELECT COUNT(*) AS n FROM sq_security_events WHERE event LIKE 'sales_bridge_%'").first()).n, 5);
    const st = await s.callJson('/api/sales/status', { cookie: owner });
    assert.equal(st.body.workspaces.domestic.issues.length, 5);
    assert.ok(st.body.workspaces.domestic.issues.every((x) => x.message), 'Thai message per issue');
    assert.equal(st.body.workspaces.domestic.commands.blocked, 2, 'PAYLOAD_CONFLICT + BAD_COMMAND rows');
  } finally {
    await s.dispose();
  }
});

test('push: สถานะต่อใบงานผ่านกฎของ Sales Office; ไม่เปลี่ยน = ไม่ส่ง; ready เฉพาะจองครบ; 503 ส่งใหม่ภายหลัง; event id ซ้ำต่างเนื้อหา/ฉบับเก่า ถูกปฏิเสธ', async () => {
  const { f, router, bindings } = salesSetup();
  f.addCommand('domestic', { productionJobId: 'production:so-a', orderId: 'so-a', payload: soPayload() });
  const s = await startServer({ outbound: router, bindings });
  const job = 'production:so-a';
  const key = keyOf('domestic', job);
  const events = () => s.d1.prepare("SELECT event_id,source_version,result,error,payload FROM sq_bridge_events WHERE workspace='domestic' ORDER BY source_version").all().then((x) => x.results);
  try {
    const owner = await plant(s);
    let r = await sync(s, owner);
    let d = resultOf(r, 'domestic');
    assert.deepEqual([d.applied, d.queued, d.posts, d.accepted, d.rejected], [1, 1, 1, 1, 0]);
    let st = f.statusOf('domestic', job);
    assert.equal(st.externalJobId, key);
    assert.equal(st.sourceVersion, 1);
    assert.equal(st.materialStatus, 'unknown');
    assert.ok(st.blockers.some((b) => /ยังไม่ได้ผูกใบงาน/.test(b)));
    let ev = await events();
    assert.match(ev[0].event_id, /^[a-f0-9]{64}$/);
    assert.equal(ev[0].result, 'accepted');
    // nothing changed: nothing sent
    r = await sync(s, owner);
    d = resultOf(r, 'domestic');
    assert.deepEqual([d.queued, d.posts], [0, 0]);
    // mapped: short (no stock), revision from the approved BOM
    await s.ok(owner, 'sales.mapJob', { jobKey: key, product: 'TST-FG', qty: 2 });
    r = await sync(s, owner);
    assert.equal(resultOf(r, 'domestic').accepted, 1);
    st = f.statusOf('domestic', job);
    assert.equal(st.sourceVersion, 2);
    assert.equal(st.materialStatus, 'short');
    assert.equal(st.revisionApproved, true);
    assert.match(st.bomFingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(st.parts.map((p) => [p.partId, p.required, p.reserved, p.shortage]), [['TST-001', 4, 0, 4], ['TST-002', 2, 0, 2]]);
    // stock + full reservation → ready (Sales Office checks the same rule and accepts it)
    await s.ok(owner, 'doc.post', { type: 'AJ', remark: 'ยอดตั้งต้น', lines: [{ code: 'TST-001', qty: 10, wh: 'A', bin: 'A-01' }, { code: 'TST-002', qty: 5, wh: 'A', bin: 'A-01' }] });
    await s.ok(owner, 'reserve.create', { jobNo: key, code: 'TST-001', wh: 'A', qty: 4 });
    const r2 = (await s.ok(owner, 'reserve.create', { jobNo: key, code: 'TST-002', wh: 'A', qty: 2 })).result.id;
    r = await sync(s, owner);
    assert.equal(resultOf(r, 'domestic').accepted, 1);
    st = f.statusOf('domestic', job);
    assert.equal(st.sourceVersion, 3);
    assert.equal(st.materialStatus, 'ready');
    assert.ok(st.parts.every((p) => p.reserved === p.required && p.shortage === 0));
    assert.deepEqual(f.badRequests, [], 'every status passed Sales Office validation');
    // a lost answer: the stored event is sent again unchanged and accepted once
    ev = await events();
    await s.d1.prepare("UPDATE sq_bridge_events SET result='pending' WHERE event_id=?").bind(ev[2].event_id).run();
    r = await sync(s, owner);
    d = resultOf(r, 'domestic');
    assert.deepEqual([d.queued, d.posts, d.accepted], [0, 1, 1]);
    assert.equal(f.eventCount('domestic'), 3);
    // Sales Office answers 503 to the push: the event waits and goes next time with the same id
    f.postUnavailable = true;
    await s.ok(owner, 'reserve.release', { id: r2, reason: 'เปลี่ยนแผน' });
    r = await sync(s, owner);
    d = resultOf(r, 'domestic');
    assert.equal(d.ok, false);
    assert.equal(d.code, 'SALES_UNAVAILABLE');
    assert.equal(d.retryable, true);
    ev = await events();
    assert.equal(ev[3].result, 'pending');
    let status = await s.callJson('/api/sales/status', { cookie: owner });
    assert.equal(status.body.workspaces.domestic.lastError, 'SALES_UNAVAILABLE');
    assert.match(status.body.workspaces.domestic.lastErrorMessage, /503/);
    f.postUnavailable = false;
    r = await sync(s, owner);
    d = resultOf(r, 'domestic');
    assert.deepEqual([d.ok, d.queued, d.accepted], [true, 0, 1]);
    assert.equal((await events())[3].event_id, ev[3].event_id);
    st = f.statusOf('domestic', job);
    assert.equal(st.sourceVersion, 4);
    assert.equal(st.materialStatus, 'unknown');
    assert.ok(st.blockers.includes('TST-002 ยังไม่ได้จอง 2 ชิ้น'));
    status = await s.callJson('/api/sales/status', { cookie: owner });
    assert.equal(status.body.workspaces.domestic.lastError, null);
    // the same event id with other content → event_conflict (recorded, nothing overwritten)
    const last = (await events())[3];
    const changed = JSON.parse(last.payload);
    changed.status.blockers = ['แก้ไขเนื้อหาแต่ใช้รหัสเดิม'];
    await s.d1.prepare("UPDATE sq_bridge_events SET payload=?, result='pending' WHERE event_id=?").bind(JSON.stringify(changed), last.event_id).run();
    r = await sync(s, owner);
    assert.equal(resultOf(r, 'domestic').rejected, 1);
    assert.deepEqual(await s.d1.prepare('SELECT result,error FROM sq_bridge_events WHERE event_id=?').bind(last.event_id).first(), { result: 'rejected', error: 'event_conflict' });
    assert.equal(f.statusOf('domestic', job).sourceVersion, 4);
    // a journal that lost its events starts again at sourceVersion 1 → stale_status, Sales Office keeps version 4
    await s.d1.prepare("DELETE FROM sq_bridge_events WHERE workspace='domestic'").run();
    r = await sync(s, owner);
    assert.equal(resultOf(r, 'domestic').rejected, 1);
    const stale = (await events())[0];
    assert.deepEqual([stale.source_version, stale.result, stale.error], [1, 'rejected', 'stale_status']);
    assert.equal(f.statusOf('domestic', job).sourceVersion, 4);
    assert.deepEqual(f.badRequests, []);
    assert.deepEqual(router.blocked, []);
  } finally {
    await s.dispose();
  }
});

test('SO ยกเลิก / คำสั่งใหม่ที่ใช้ไม่ได้ / Export แยกจาก Domestic ตอนส่งสถานะ', async () => {
  const { f, router, bindings } = salesSetup();
  f.addCommand('domestic', { productionJobId: 'production:so-z', orderId: 'so-z', payload: soPayload() });
  f.addCommand('domestic', { productionJobId: 'production:so-w', orderId: 'so-w', payload: soPayload({ orderNumber: 'W' }) });
  f.addCommand('export', { productionJobId: 'production:so-z', orderId: 'so-z-ex', payload: soPayload({ orderNumber: 'EX-Z' }) });
  const s = await startServer({ outbound: router, bindings });
  try {
    const owner = await plant(s);
    await s.ok(owner, 'doc.post', { type: 'AJ', remark: 'ยอดตั้งต้น', lines: [{ code: 'TST-001', qty: 10, wh: 'A', bin: 'A-01' }, { code: 'TST-002', qty: 5, wh: 'A', bin: 'A-01' }] });
    let r = await sync(s, owner);
    assert.equal(resultOf(r, 'export').accepted, 1);
    assert.equal(resultOf(r, 'domestic').accepted, 2);
    const kz = keyOf('domestic', 'production:so-z');
    await s.ok(owner, 'sales.mapJob', { jobKey: kz, product: 'TST-FG', qty: 1 });
    const rs = (await s.ok(owner, 'reserve.create', { jobNo: kz, code: 'TST-001', wh: 'A', qty: 2 })).result.id;
    // Sales Office cancels the SO
    f.addCommand('domestic', { productionJobId: 'production:so-z', orderId: 'so-z', payload: soPayload({ cancelled: true }) });
    // and sends a new version of so-w that cannot be used (no lines)
    f.addCommand('domestic', { productionJobId: 'production:so-w', orderId: 'so-w', payload: soPayload({ orderNumber: 'W', items: [] }) });
    r = await sync(s, owner);
    const d = resultOf(r, 'domestic');
    assert.equal(d.applied, 1);
    assert.equal(d.blocked, 1);
    assert.equal(d.waiting, 1, 'no status bound to the old so-w command while a newer one is blocked');
    const db = await replay(s.d1);
    assert.equal(db.state.tables.jobs[kz].status, 'CANCELLED');
    assert.equal(db.state.tables.reservations[rs].status, 'RELEASED');
    const st = f.statusOf('domestic', 'production:so-z');
    assert.equal(st.materialStatus, 'unknown');
    assert.ok(st.blockers.includes('Sales Office ยกเลิก SO นี้แล้ว'));
    assert.equal(f.statusOf('domestic', 'production:so-w').sourceVersion, 1);
    // Export job untouched by the Domestic cancel; its events went to the Export feed only
    assert.equal(db.state.tables.jobs[keyOf('export', 'production:so-z')].status, 'OPEN');
    assert.equal(f.statusOf('export', 'production:so-z').externalJobId, keyOf('export', 'production:so-z'));
    assert.ok(f.log.filter((x) => x.method === 'POST').every((x) => x.mode === 'domestic' || x.mode === 'export'));
    assert.deepEqual(f.badRequests, []);
  } finally {
    await s.dispose();
  }
});

test('cron ซิงก์ให้เมื่อเปิดใช้; lease กันสองรอบทับกัน; redirect ไม่ตามไป', async () => {
  const { f, router, bindings, ctl } = salesSetup();
  f.addCommand('domestic', { productionJobId: 'production:so-a', orderId: 'so-a', payload: soPayload() });
  const s = await startServer({ outbound: router, bindings });
  try {
    const owner = await plant(s);
    await s.scheduled(SYNC_CRON);
    let db = await replay(s.d1);
    assert.ok(db.state.tables.jobs[keyOf('domestic', 'production:so-a')]);
    assert.equal(f.statusOf('domestic', 'production:so-a').sourceVersion, 1);
    await s.scheduled('0 0 1 1 *'); // an unknown cron does nothing
    // two syncs at once: the workspace lease lets only one of them work
    f.addCommand('domestic', { productionJobId: 'production:so-b', orderId: 'so-b', payload: soPayload({ orderNumber: 'B' }) });
    ctl.delay = 40;
    const [a, b] = await Promise.all([sync(s, owner, { workspace: 'domestic' }), sync(s, owner, { workspace: 'domestic' })]);
    ctl.delay = 0;
    const res = [resultOf(a, 'domestic'), resultOf(b, 'domestic')];
    assert.equal(res.filter((x) => x.code === 'BUSY').length, 1, JSON.stringify(res));
    assert.equal(res.reduce((n, x) => n + x.applied, 0), 1);
    db = await replay(s.d1);
    assert.equal(Object.keys(db.state.tables.jobs).length, 2);
  } finally {
    await s.dispose();
  }
  // a redirect from Sales Office is never followed (the bearer secret would go to another origin)
  const red = salesSetup();
  const router2 = outboundRouter({ 'sales.test': async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/collect' } }) });
  const t = await startServer({ outbound: router2, bindings: red.bindings });
  try {
    const owner = await plant(t);
    const r = await sync(t, owner, { workspace: 'domestic' });
    assert.equal(resultOf(r, 'domestic').code, 'UNEXPECTED_REDIRECT');
    assert.ok(!router2.requests.some((x) => x.host === 'elsewhere.test'));
  } finally {
    await t.dispose();
  }
});

test('สิทธิ์และความปลอดภัย: เฉพาะตัวเชื่อมสร้างใบงาน SO, secret ผิด, เจ้าของยังไม่ผูกผู้ใช้', async () => {
  const { f, router, bindings } = salesSetup();
  f.addCommand('domestic', { productionJobId: 'production:so-a', orderId: 'so-a', payload: soPayload() });
  const s = await startServer({ outbound: router, bindings });
  try {
    const owner = await plant(s);
    // a page can never run the connector's command, not even the owner
    const forged = await s.cmd(owner, 'sales.syncJob', f.addCommand('domestic', { productionJobId: 'production:so-x', orderId: 'so-x', payload: soPayload() }), rid());
    assert.equal(forged.status, 403);
    assert.equal(forged.body.code, 'BRIDGE_ONLY');
    const store = await s.account(owner, 'store.user');
    await s.ok(owner, 'user.upsert', { id: 'STORE1', name: 'สโตร์', roles: ['store'], accountId: 'store.user' });
    assert.equal((await sync(s, store.cookie)).status, 403);
    assert.equal((await s.callJson('/api/sales/status', { cookie: store.cookie })).status, 200, 'readers may see the connector status');
    assert.equal((await s.callJson('/api/sales/sync', { body: {} })).status, 401);
    assert.equal((await s.callJson('/api/sales/sync', { cookie: owner, body: {}, origin: 'https://attacker.test' })).status, 403);
    assert.equal((await sync(s, owner, { workspace: 'live' })).status, 400);
    assert.equal((await sync(s, owner, { workspace: 'domestic', extra: 1 })).status, 400);
    assert.equal(router.requests.length, 0, 'none of these reached Sales Office');
    const planner = await s.account(owner, 'plan.user');
    await s.ok(owner, 'user.upsert', { id: 'PLAN1', name: 'วางแผน', roles: ['planner'], accountId: 'plan.user' });
    const ok = await sync(s, planner.cookie, { workspace: 'domestic' });
    assert.equal(ok.status, 200);
    assert.equal(resultOf(ok, 'domestic').applied, 2);
    const by = (await s.d1.prepare("SELECT DISTINCT \"by\" FROM sq_commits WHERE kind='sales.syncJob'").all()).results.map((x) => x.by);
    assert.deepEqual(by, ['ADMIN'], 'a manual sync still writes as the owner-bound engine user');
  } finally {
    await s.dispose();
  }
  // Sales Office does not accept our secret: AUTH_FAILED, a security event, nothing applied
  const wrong = salesSetup({}, { domestic: randomBytes(24).toString('hex'), export: randomBytes(24).toString('hex') });
  wrong.f.addCommand('domestic', { productionJobId: 'production:so-a', orderId: 'so-a', payload: soPayload() });
  const t = await startServer({ outbound: wrong.router, bindings: wrong.bindings });
  try {
    const owner = await plant(t);
    const r = await sync(t, owner);
    assert.equal(resultOf(r, 'domestic').code, 'AUTH_FAILED');
    assert.equal(resultOf(r, 'export').code, 'AUTH_FAILED');
    assert.equal((await t.d1.prepare("SELECT COUNT(*) AS n FROM sq_security_events WHERE event='sales_bridge_auth_failed'").first()).n, 2);
    const st = await t.callJson('/api/sales/status', { cookie: owner });
    assert.equal(st.body.workspaces.domestic.lastError, 'AUTH_FAILED');
    assert.equal((await replay(t.d1)).state.tables.jobs, undefined);
  } finally {
    await t.dispose();
  }
  // the owner account is not bound to an engine user (system not started): nothing is pulled
  const nb = salesSetup();
  const u = await startServer({ outbound: nb.router, bindings: nb.bindings });
  try {
    const owner = await u.ownerLogin();
    const r = await sync(u, owner);
    assert.equal(resultOf(r, 'domestic').code, 'OWNER_NOT_BOUND');
    assert.equal(nb.router.requests.length, 0);
  } finally {
    await u.dispose();
  }
});

test('ตัวจำลอง Sales Office ใช้กฎจริง: ready ต้องจองครบ, sourceVersion ไม่ใหม่กว่า = stale_status, event id เดิมเนื้อหาต่าง = event_conflict', async () => {
  const { f, secrets, connectorId } = salesSetup();
  const cmd = f.addCommand('domestic', { productionJobId: 'production:so-a', orderId: 'so-a', payload: soPayload() });
  const post = async (events, o = {}) => {
    const ws = o.mode || 'domestic';
    const res = await f.handle(new Request('https://sales.test/api/rrs/partlist/bridge?mode=' + ws, { method: 'POST',
      headers: { authorization: 'Bearer ' + (o.secret || secrets[ws]), 'x-rrs-connector-id': connectorId, 'content-type': 'application/json' },
      body: JSON.stringify({ events }) }));
    return { status: res.status, body: await res.json() };
  };
  const ev = (eventId, sourceVersion, over = {}) => ({ eventId, commandId: cmd.commandId, commandVersion: cmd.version, payloadHash: cmd.payloadHash,
    workspace: 'domestic', orderId: cmd.orderId, productionJobId: cmd.productionJobId, status: Object.assign({ externalJobId: 'SO-DOMESTIC-X', sourceVersion,
      bomRevision: null, drawingRevision: null, bomFingerprint: null, revisionApproved: false, revisionEvidence: null, materialStatus: 'unknown', parts: [],
      station: null, good: null, scrap: null, rework: null, blockers: [], eta: null, observedAt: new Date().toISOString() }, over) });
  const part = (o) => Object.assign({ partId: 'P1', required: 4, reserved: 4, shortage: 0, unit: 'ชิ้น' }, o);
  // validateStatus(): each of these refuses the whole request with 400
  for (const bad of [
    { materialStatus: 'ready', parts: [part({ reserved: 3 })] }, // ready without a full reservation
    { materialStatus: 'ready', parts: [part({ shortage: 1 })] }, // ready with a shortage
    { materialStatus: 'ready', parts: [] }, // ready without parts
    { materialStatus: 'ready', parts: [part({ reserved: null })] }, // ready with an unknown reservation
    { parts: [part({ reserved: 5 })] }, // reserved above required
    { parts: [part({}), part({})] }, // the same partId twice
    { revisionApproved: true, bomRevision: 'A', drawingRevision: 'A', bomFingerprint: 'a'.repeat(64), revisionEvidence: ' ' }, // no evidence
    { observedAt: new Date(Date.now() + 3600e3).toISOString() }, // in the future
  ]) {
    const r = await post([ev('bad', 1, bad)]);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await post([Object.assign(ev('extra-key', 1), { extra: 1 })])).status, 400, 'strict event keys');
  assert.equal((await post([ev('x', 1)], { secret: secrets.export })).status, 401, 'the other workspace secret');
  assert.equal(f.eventCount('domestic'), 0);
  // a fully reserved ready status is accepted; the same event again is accepted once
  const good = ev('e-1', 1, { materialStatus: 'ready', parts: [part({ completed: 0 })] });
  assert.deepEqual((await post([good])).body.accepted, ['e-1']);
  assert.deepEqual((await post([good])).body.accepted, ['e-1']);
  assert.equal(f.eventCount('domestic'), 1);
  const rejected = async (e) => (await post([e])).body.rejected;
  assert.deepEqual(await rejected(Object.assign({}, good, { status: Object.assign({}, good.status, { blockers: ['อื่น'] }) })), [{ eventId: 'e-1', code: 'event_conflict' }]);
  assert.deepEqual(await rejected(ev('e-2', 1)), [{ eventId: 'e-2', code: 'stale_status' }]);
  assert.deepEqual(await rejected(Object.assign(ev('e-3', 2), { workspace: 'export' })), [{ eventId: 'e-3', code: 'workspace_mismatch' }]);
  assert.deepEqual(await rejected(Object.assign(ev('e-4', 2), { commandVersion: 2 })), [{ eventId: 'e-4', code: 'stale_command' }]);
  assert.deepEqual(await rejected(ev('e-5', 2, { externalJobId: 'SO-DOMESTIC-OTHER' })), [{ eventId: 'e-5', code: 'mapping_conflict' }]);
  assert.deepEqual(await rejected(ev('e-6', 2, { observedAt: '2020-01-01T00:00:00.000Z' })), [{ eventId: 'e-6', code: 'stale_status' }]);
  assert.deepEqual((await post([ev('e-7', 2)])).body.accepted, ['e-7']);
  assert.equal(f.statusOf('domestic', cmd.productionJobId).sourceVersion, 2);
});

test('push: Sales Office ตอบ conflict (สถานะชั่วคราวของเขา) = ส่งเหตุการณ์เดิมรอบถัดไป; เกิน 20 เหตุการณ์แบ่ง POST', async () => {
  const { f, router, bindings } = salesSetup();
  for (let i = 0; i < 25; i++) {
    f.addCommand('domestic', { productionJobId: 'production:so-' + String(i).padStart(2, '0'), orderId: 'so-' + i, payload: soPayload({ orderNumber: 'SO-' + i }) });
  }
  f.forceReject.push('conflict');
  const s = await startServer({ outbound: router, bindings });
  try {
    const owner = await plant(s);
    let r = await sync(s, owner, { workspace: 'domestic' });
    let d = resultOf(r, 'domestic');
    assert.deepEqual([d.applied, d.queued, d.posts, d.accepted, d.rejected, d.retryLater], [25, 25, 2, 24, 0, 1]);
    const posts = f.log.filter((x) => x.method === 'POST');
    assert.deepEqual(posts.map((x) => x.events), [20, 5], 'at most 20 events per POST');
    assert.ok(posts.every((x) => x.bytes <= POST_BODY_BYTES));
    const waiting = (await s.d1.prepare("SELECT event_id, error, source_version FROM sq_bridge_events WHERE result='pending'").all()).results;
    assert.equal(waiting.length, 1);
    assert.deepEqual([waiting[0].error, waiting[0].source_version], ['conflict', 1]);
    const st = await s.callJson('/api/sales/status', { cookie: owner });
    assert.deepEqual(st.body.workspaces.domestic.events, { accepted: 24, pending: 1 });
    // next run: nothing new is built, the stored event goes again with the same id and is accepted
    r = await sync(s, owner, { workspace: 'domestic' });
    d = resultOf(r, 'domestic');
    assert.deepEqual([d.queued, d.posts, d.accepted, d.retryLater], [0, 1, 1, 0]);
    assert.deepEqual(await s.d1.prepare('SELECT result, error FROM sq_bridge_events WHERE event_id=?').bind(waiting[0].event_id).first(), { result: 'accepted', error: '' });
    assert.equal(f.eventCount('domestic'), 25);
    assert.deepEqual(f.badRequests, []);
    assert.deepEqual(router.blocked, []);
  } finally {
    await s.dispose();
  }
});

test('packEvents: ไม่เกิน 20 เหตุการณ์และ 1 MB ต่อคำขอ ตามลำดับเดิม; เหตุการณ์ที่ใหญ่เกินส่งเดี่ยว', () => {
  const row = (i, n) => ({ event_id: 'e' + i, payload: JSON.stringify({ eventId: 'e' + i, pad: 'x'.repeat(n) }) });
  const bodyBytes = (batch) => Buffer.byteLength(JSON.stringify({ events: batch.map((r) => JSON.parse(r.payload)) }));
  const check = (rows, expectSizes) => {
    const batches = packEvents(rows, EVENTS_PER_POST, POST_BODY_BYTES);
    assert.deepEqual(batches.flat().map((r) => r.event_id), rows.map((r) => r.event_id), 'every row once, in order');
    for (const b of batches) {
      assert.ok(b.length >= 1 && b.length <= EVENTS_PER_POST);
      if (b.length > 1) assert.ok(bodyBytes(b) <= POST_BODY_BYTES, 'body ' + bodyBytes(b));
    }
    assert.deepEqual(batches.map((b) => b.length), expectSizes);
  };
  check(Array.from({ length: 45 }, (_, i) => row(i, 100)), [20, 20, 5]);
  check(Array.from({ length: 10 }, (_, i) => row(i, 300000)), [3, 3, 3, 1]);
  check([row(0, 100), row(1, 1200000), row(2, 100)], [1, 1, 1]);
  check([], []);
  assert.ok(POST_BODY_BYTES < 1048576, 'under Sales Office\'s 1 MiB limit');
});
