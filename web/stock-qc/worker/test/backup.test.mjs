// Google Drive backup (src/backup.js) against a local fake of Google's OAuth + Drive endpoints. Nothing leaves the
// machine: every outbound request goes through the test router, and requests nobody handles are counted and asserted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { startServer, bootstrapped, stockIn, outboundRouter, replay, rid, RRS } from './helpers.mjs';
import { fakeGoogle } from './fake-google.mjs';

const BACKUP_CRON = '40 18 * * *';
const sha = (b) => createHash('sha256').update(b).digest('hex');

function googleSetup(extra = {}) {
  const creds = { clientId: 'test-client-' + randomBytes(4).toString('hex') + '.apps.googleusercontent.com', clientSecret: 'GOCSPX-' + randomBytes(12).toString('hex'),
    refreshToken: '1//test-' + randomBytes(16).toString('hex'), rootId: 'rootfolder' + randomBytes(8).toString('hex') };
  const g = fakeGoogle(creds);
  const router = outboundRouter({ 'oauth2.googleapis.com': g.handle, 'www.googleapis.com': g.handle });
  const bindings = Object.assign({ SQ_DRIVE_BACKUP_ENABLED: 'true', GOOGLE_DRIVE_CLIENT_ID: creds.clientId, GOOGLE_DRIVE_CLIENT_SECRET: creds.clientSecret,
    GOOGLE_DRIVE_REFRESH_TOKEN: creds.refreshToken, SQ_DRIVE_BACKUP_FOLDER_ID: creds.rootId }, extra);
  return { creds, g, router, bindings };
}
/** Owner + masters + n stock documents (each its own commit). */
async function ledgerWithCommits(s, n) {
  const owner = await bootstrapped(s);
  for (let i = 0; i < n; i++) await stockIn(s, owner, 1 + (i % 3));
  return owner;
}
/** Files of the run folder, the manifest, and the commits rebuilt from the JSONL parts (checked against the manifest). */
function readBackup(g, folderId) {
  const files = g.children(folderId);
  const manifestFile = files.find((f) => f.name === 'manifest.json');
  assert.ok(manifestFile, 'manifest.json is there');
  const manifest = JSON.parse(Buffer.from(manifestFile.bytes).toString('utf8'));
  const commits = [];
  for (const p of manifest.parts) {
    const f = g.files.get(p.driveId);
    assert.ok(f, 'part ' + p.name + ' is in Drive');
    assert.equal(f.parents[0], folderId);
    assert.equal(f.name, p.name);
    assert.equal(f.bytes.length, p.bytes);
    assert.equal(sha(f.bytes), p.sha256, 'sha256 of part ' + p.name);
    assert.equal(f.mimeType, 'application/x-ndjson');
    const lines = Buffer.from(f.bytes).toString('utf8').split('\n');
    assert.equal(lines.pop(), '', 'every line ends with a newline');
    for (const line of lines) commits.push(JSON.parse(line));
    assert.equal(lines.length, p.commits);
    assert.equal(commits[commits.length - 1].seq, p.toSeq);
  }
  return { files, manifest, commits };
}

test('ปิดอยู่เป็นค่าเริ่มต้น: สั่งสำรองไม่ได้ cron ไม่ทำอะไร และไม่มีคำขอออกนอกเครื่องเลย', async () => {
  const s = await startServer();
  try {
    const owner = await bootstrapped(s);
    const run = await s.callJson('/api/backup/run', { cookie: owner, body: {} });
    assert.equal(run.status, 409);
    assert.equal(run.body.code, 'DISABLED');
    const st = await s.callJson('/api/backup/status', { cookie: owner });
    assert.equal(st.status, 200);
    assert.equal(st.body.enabled, false);
    assert.equal(st.body.configured, false);
    assert.deepEqual(st.body.missing, ['GOOGLE_DRIVE_CLIENT_ID', 'GOOGLE_DRIVE_CLIENT_SECRET', 'GOOGLE_DRIVE_REFRESH_TOKEN', 'SQ_DRIVE_BACKUP_FOLDER_ID']);
    assert.equal(st.body.schedule.active, false);
    await s.scheduled(BACKUP_CRON);
    assert.equal(s.outbound.requests.length, 0, 'no outbound request at all');
    assert.equal((await s.d1.prepare('SELECT COUNT(*) AS n FROM sq_backup_runs').first()).n, 0);
  } finally {
    await s.dispose();
  }
  // switched on but not configured: still nothing is sent
  const t = await startServer({ bindings: { SQ_DRIVE_BACKUP_ENABLED: 'true', GOOGLE_DRIVE_CLIENT_ID: 'only-this' } });
  try {
    const owner = await bootstrapped(t);
    const run = await t.callJson('/api/backup/run', { cookie: owner, body: {} });
    assert.equal(run.status, 503);
    assert.equal(run.body.code, 'CONFIGURATION_MISSING');
    assert.ok(!run.text.includes('only-this'));
    await t.scheduled(BACKUP_CRON);
    assert.equal(t.outbound.requests.length, 0);
  } finally {
    await t.dispose();
  }
  // fully configured but the flag is not exactly "true": off (fails closed like Sales Office's ==='true')
  for (const value of ['TRUE', ' true', '1', 'yes']) {
    const { router, bindings } = googleSetup({ SQ_DRIVE_BACKUP_ENABLED: value });
    const u = await startServer({ outbound: router, bindings });
    try {
      const owner = await bootstrapped(u, { masters: false });
      const run = await u.callJson('/api/backup/run', { cookie: owner, body: {} });
      assert.equal(run.body.code, 'DISABLED', value);
      await u.scheduled(BACKUP_CRON);
      assert.equal(router.requests.length, 0, value);
    } finally {
      await u.dispose();
    }
  }
});

test('สำรองด้วยมือ: JSONL ไม่เกินขนาดไฟล์ย่อย + manifest (sha256 ทุกไฟล์ + head) และกู้คืนตรวจผ่าน RRS.reports.verifyBackup', async () => {
  const { creds, g, router, bindings } = googleSetup({ SQ_BACKUP_PART_BYTES: '8192' });
  const s = await startServer({ outbound: router, bindings });
  try {
    const owner = await ledgerWithCommits(s, 30);
    const r = await s.callJson('/api/backup/run', { cookie: owner, body: {} });
    assert.equal(r.status, 200, r.text);
    const run = r.body.run;
    const db = await replay(s.d1);
    assert.equal(run.status, 'ok');
    assert.equal(run.trigger, 'manual');
    assert.equal(run.fromSeq, 1);
    assert.equal(run.toSeq, db.commits);
    assert.equal(run.commits, db.commits);
    assert.equal(run.head, db.state.head);
    assert.ok(run.parts >= 4, 'several parts: ' + run.parts);
    assert.match(run.folderUrl, /^https:\/\/drive\.google\.com\/drive\/folders\//);
    // Drive: one dated folder in the private root; parts ≤ 8192 bytes; manifest last
    const folders = g.children(creds.rootId);
    assert.equal(folders.length, 1);
    assert.match(folders[0].name, /^rrs-stockqc-\d{4}-\d{2}-\d{2}-\d{4}-manual-[0-9a-f]{8}$/);
    const { files, manifest, commits } = readBackup(g, folders[0].id);
    assert.equal(files.length, run.parts + 1);
    assert.equal(files[files.length - 1].name, 'manifest.json', 'manifest uploaded last');
    for (const f of files) assert.ok(f.bytes.length <= 8192 || f.name === 'manifest.json', f.name + ' ' + f.bytes.length);
    for (const f of files) assert.deepEqual(f.permissions.map((p) => p.role), ['owner'], 'private file');
    assert.equal(manifest.format, 'rrs-stockqc-drive-backup');
    assert.equal(manifest.complete, true);
    assert.equal(manifest.commits.head, db.state.head);
    assert.equal(manifest.commits.toSeq, db.commits);
    assert.equal(manifest.commits.count, db.commits);
    assert.equal(manifest.parts.length, run.parts);
    // restore check exactly as the page does it
    const check = RRS.reports.verifyBackup(commits, { compare: db.state });
    assert.deepEqual(check.problems, []);
    assert.equal(check.ok, true);
    assert.equal(check.commits, db.commits);
    assert.equal(check.head, db.state.head);
    // D1 bookkeeping: the run and one row per uploaded file with the same sha256 as Drive
    const parts = (await s.d1.prepare('SELECT * FROM sq_backup_parts WHERE run_id=? ORDER BY part_no').bind(run.id).all()).results;
    assert.equal(parts.length, run.parts + 1);
    for (const p of parts) assert.equal(p.sha256, sha(g.files.get(p.drive_id).bytes));
    assert.equal(parts[parts.length - 1].kind, 'manifest');
    // status: who/when/what, never a credential or the root folder id
    const st = await s.callJson('/api/backup/status', { cookie: owner });
    assert.equal(st.body.lastOk.id, run.id);
    assert.equal(st.body.running, false);
    for (const v of [creds.clientId, creds.clientSecret, creds.refreshToken, creds.rootId, ...g.tokens]) {
      assert.ok(!st.text.includes(v) && !r.text.includes(v), 'leaks ' + v.slice(0, 8));
    }
    const dbText = JSON.stringify((await s.d1.prepare('SELECT * FROM sq_backup_runs').all()).results) + JSON.stringify(parts);
    for (const v of [creds.clientSecret, creds.refreshToken, ...g.tokens]) assert.ok(!dbText.includes(v));
    assert.deepEqual(router.blocked, []);
    // a second backup after more work covers the new commits too (full ledger each time)
    await stockIn(s, owner, 5);
    const r2 = await s.callJson('/api/backup/run', { cookie: owner, body: {} });
    assert.equal(r2.body.run.toSeq, db.commits + 1);
    assert.equal(g.children(creds.rootId).length, 2);
  } finally {
    await s.dispose();
  }
});

test('ไฟล์ย่อยจริงไม่เกิน 4 MB: ledger 4.8 MB แบ่งเป็น 2 ไฟล์', async () => {
  const { creds, g, router, bindings } = googleSetup();
  const s = await startServer({ outbound: router, bindings });
  try {
    const owner = await bootstrapped(s, { masters: false });
    for (const id of ['Q01', 'Q02', 'Q03']) {
      await s.ok(owner, 'decision.record', { id, answer: id + ' ' + 'ก'.repeat(533000), decidedBy: 'ทดสอบขนาดไฟล์' });
    }
    const r = await s.callJson('/api/backup/run', { cookie: owner, body: {} });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.run.parts, 2);
    assert.ok(r.body.run.bytes > 4 * 1024 * 1024);
    const { files, commits, manifest } = readBackup(g, g.children(creds.rootId)[0].id);
    for (const f of files) assert.ok(f.bytes.length <= 4 * 1024 * 1024, f.name + ' ' + f.bytes.length);
    assert.equal(manifest.parts.length, 2);
    const db = await replay(s.d1);
    assert.equal(RRS.reports.verifyBackup(commits, { compare: db.state }).ok, true);
  } finally {
    await s.dispose();
  }
});

test('ส่งซ้ำหลังผลไม่แน่นอนไม่สร้างไฟล์ซ้ำ; Drive ล่มต่อเนื่อง = ล้มเหลวไม่มี manifest', async () => {
  const { creds, g, router, bindings } = googleSetup({ SQ_BACKUP_PART_BYTES: '4096' });
  const s = await startServer({ outbound: router, bindings });
  try {
    const owner = await ledgerWithCommits(s, 10);
    // the first upload is stored by Drive but the answer is a 503: the retry finds the reserved id and checks it
    g.fault('upload', { status: 503, commit: true });
    g.fault('upload', { status: 500 }); // and one plain failure on the next part
    const r = await s.callJson('/api/backup/run', { cookie: owner, body: {} });
    assert.equal(r.status, 200, r.text);
    const folder = g.children(creds.rootId)[0];
    const { files, manifest } = readBackup(g, folder.id);
    assert.equal(files.length, manifest.parts.length + 1, 'no duplicate file');
    assert.equal(new Set(files.map((f) => f.name)).size, files.length);
    assert.ok(g.faults.every((f) => f.times === 0), 'both injected failures happened');
    const ops = g.log.map((x) => x.op);
    const firstUp = ops.indexOf('upload');
    const firstId = g.log[firstUp].id;
    const nextUp = ops.indexOf('upload', firstUp + 1);
    assert.ok(g.log.slice(firstUp + 1, nextUp).some((x) => x.op === 'get' && x.path.endsWith('/' + firstId)),
      'after an uncertain upload the reserved id is looked up before anything else is sent');
    assert.equal(g.log.filter((x) => x.op === 'upload' && x.id === firstId).length, 1, 'the file Drive stored is not sent again');
    // one upload per file, plus one re-send for the part whose first attempt Drive did not store
    assert.equal(ops.filter((x) => x === 'upload').length, files.length + 1);
    // Drive keeps failing: the run fails after 3 attempts, the folder has no manifest (= incomplete backup)
    g.fault('upload', { status: 503, times: 3 });
    const bad = await s.callJson('/api/backup/run', { cookie: owner, body: {} });
    assert.equal(bad.status, 502);
    assert.equal(bad.body.code, 'DRIVE_UNAVAILABLE');
    assert.equal(bad.body.run.status, 'failed');
    assert.equal(bad.body.run.error, 'DRIVE_UNAVAILABLE');
    assert.match(bad.body.message, /Google Drive/);
    const second = g.children(creds.rootId)[1];
    assert.ok(!g.children(second.id).some((f) => f.name === 'manifest.json'));
    const ev = await s.d1.prepare("SELECT event,severity FROM sq_security_events WHERE event='drive_backup_failed'").first();
    assert.equal(ev.severity, 'warning');
  } finally {
    await s.dispose();
  }
});

test('ปลายทางไม่เป็นส่วนตัว / สิทธิ์ Google หมด / ข้อมูล commit ถูกแก้ = หยุด ไม่อัปโหลด', async () => {
  const { creds, g, router, bindings } = googleSetup();
  const s = await startServer({ outbound: router, bindings });
  try {
    const owner = await ledgerWithCommits(s, 3);
    g.files.get(creds.rootId).permissions.push({ id: 'anyone', type: 'anyone', role: 'reader' });
    g.files.get(creds.rootId).shared = true;
    let r = await s.callJson('/api/backup/run', { cookie: owner, body: {} });
    assert.equal(r.body.code, 'DESTINATION_NOT_PRIVATE');
    assert.ok(!g.log.some((x) => x.op === 'upload' || x.op === 'createFolder'), 'nothing written to a shared folder');
    g.files.get(creds.rootId).permissions.pop();
    g.files.get(creds.rootId).shared = false;
    // revoked refresh token
    g.fault('token', { status: 400, error: 'invalid_grant' });
    r = await s.callJson('/api/backup/run', { cookie: owner, body: {} });
    assert.equal(r.body.code, 'AUTH_REAUTHORIZE_REQUIRED');
    assert.match(r.body.message, /refresh token/);
    // a stored commit edited behind the ledger's back: never backed up
    await s.d1.prepare('DROP TRIGGER sq_commits_no_update').run();
    await s.d1.prepare("UPDATE sq_commits SET summary='แก้ไขย้อนหลัง' WHERE seq=2").run();
    const before = g.log.filter((x) => x.op === 'upload').length;
    r = await s.callJson('/api/backup/run', { cookie: owner, body: {} });
    assert.equal(r.status, 500);
    assert.equal(r.body.code, 'LEDGER_INTEGRITY');
    assert.equal(g.log.filter((x) => x.op === 'upload').length, before, 'no part uploaded');
    const ev = await s.d1.prepare("SELECT severity FROM sq_security_events WHERE event='ledger_integrity'").first();
    assert.equal(ev.severity, 'critical');
    const runs = (await s.d1.prepare("SELECT status,error FROM sq_backup_runs ORDER BY started_at").all()).results;
    assert.deepEqual(runs.map((x) => x.error), ['DESTINATION_NOT_PRIVATE', 'AUTH_REAUTHORIZE_REQUIRED', 'LEDGER_INTEGRITY']);
    assert.ok(runs.every((x) => x.status === 'failed'));
  } finally {
    await s.dispose();
  }
});

test('ตรวจปลายทางก่อนเขียนทุกไฟล์: แชร์โฟลเดอร์หรือย้ายโฟลเดอร์ระหว่างสำรอง = หยุดก่อนเขียนไฟล์ถัดไป', async () => {
  const { creds, g, router, bindings } = googleSetup({ SQ_BACKUP_PART_BYTES: '4096' });
  const s = await startServer({ outbound: router, bindings });
  try {
    const owner = await ledgerWithCommits(s, 10);
    // somebody shares the backup root while the run is going (right after the first part is stored)
    let uploads = 0;
    g.afterUpload = () => {
      uploads += 1;
      if (uploads === 1) {
        const root = g.files.get(creds.rootId);
        root.shared = true;
        root.permissions.push({ id: 'anyone', type: 'anyone', role: 'reader' });
      }
    };
    let r = await s.callJson('/api/backup/run', { cookie: owner, body: {} });
    assert.equal(r.body.code, 'DESTINATION_NOT_PRIVATE', r.text);
    assert.equal(r.body.run.status, 'failed');
    assert.equal(uploads, 1, 'nothing more is written once the folder is shared');
    const first = g.children(creds.rootId)[0];
    assert.ok(!g.children(first.id).some((f) => f.name === 'manifest.json'), 'no manifest = incomplete backup');
    assert.equal(r.body.run.parts, 1);
    const root = g.files.get(creds.rootId);
    root.shared = false;
    root.permissions.pop();
    // the run folder is moved out of the backup root mid-run (into a private folder outside it)
    const otherId = 'otherfolder' + randomBytes(6).toString('hex');
    g.files.set(otherId, { id: otherId, name: 'อื่น', mimeType: 'application/vnd.google-apps.folder', parents: [], trashed: false, shared: false,
      ownedByMe: true, permissions: [{ id: 'owner-permission', type: 'user', role: 'owner' }], capabilities: { canAddChildren: true }, appProperties: {} });
    uploads = 0;
    g.afterUpload = (f) => {
      uploads += 1;
      if (uploads === 1) g.files.get(f.parents[0]).parents = [otherId];
    };
    r = await s.callJson('/api/backup/run', { cookie: owner, body: {} });
    assert.equal(r.body.code, 'DESTINATION_OUTSIDE_BACKUP_FOLDER', r.text);
    assert.match(r.body.message, /โฟลเดอร์สำรอง/);
    assert.equal(uploads, 1);
    // back to normal: a full backup works again
    g.afterUpload = null;
    r = await s.callJson('/api/backup/run', { cookie: owner, body: {} });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(router.blocked, []);
  } finally {
    await s.dispose();
  }
});

test('lease: สองรอบพร้อมกันได้รอบเดียว; รอบตามเวลาวันละครั้ง; รอบค้างหมดเวลาถูกปิด', async () => {
  const { creds, g, router, bindings } = googleSetup();
  const s = await startServer({ outbound: router, bindings });
  try {
    const owner = await ledgerWithCommits(s, 2);
    g.delayMs = 40;
    const [a, b] = await Promise.all([
      s.callJson('/api/backup/run', { cookie: owner, body: {} }),
      s.callJson('/api/backup/run', { cookie: owner, body: {} }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal([a, b].find((x) => x.status === 409).body.code, 'BUSY');
    g.delayMs = 0;
    assert.equal(g.children(creds.rootId).length, 1);
    // cron: once per Bangkok day
    await s.scheduled(BACKUP_CRON);
    const tokenCalls = g.tokenCalls;
    await s.scheduled(BACKUP_CRON);
    assert.equal(g.tokenCalls, tokenCalls, 'the second tick of the day does not call Google');
    const sched = (await s.d1.prepare("SELECT status, requested_by FROM sq_backup_runs WHERE trigger_kind='scheduled'").all()).results;
    assert.deepEqual(sched, [{ status: 'ok', requested_by: 'cron' }]);
    // a run left 'running' by a stopped Worker is closed when its lease is over
    await s.d1.prepare("INSERT INTO sq_backup_runs (id,trigger_kind,day,status,lease,lease_until,started_at) VALUES ('stale-run','manual','2026-01-01','running','x',1,'2026-01-01T00:00:00Z')").run();
    const r = await s.callJson('/api/backup/run', { cookie: owner, body: {} });
    assert.equal(r.status, 200);
    const stale = await s.d1.prepare("SELECT status,error FROM sq_backup_runs WHERE id='stale-run'").first();
    assert.deepEqual(stale, { status: 'failed', error: 'LEASE_EXPIRED' });
    assert.deepEqual(router.blocked, []);
  } finally {
    await s.dispose();
  }
});

test('สิทธิ์: เฉพาะเจ้าของระบบหรือ backup.export และต้องมาจากหน้าเว็บเดียวกัน', async () => {
  const { router, bindings } = googleSetup();
  const s = await startServer({ outbound: router, bindings });
  try {
    const owner = await bootstrapped(s);
    const store = await s.account(owner, 'store.user');
    const acc = await s.account(owner, 'acc.user');
    await s.ok(owner, 'user.upsert', { id: 'STORE1', name: 'สโตร์', roles: ['store'], accountId: 'store.user' });
    await s.ok(owner, 'user.upsert', { id: 'ACC1', name: 'บัญชี', roles: ['accounting'], accountId: 'acc.user' });
    assert.equal((await s.callJson('/api/backup/run', { cookie: store.cookie, body: {} })).status, 403);
    assert.equal((await s.callJson('/api/backup/status', { cookie: store.cookie })).status, 403);
    assert.equal((await s.callJson('/api/backup/status', { cookie: acc.cookie })).status, 200);
    assert.equal((await s.callJson('/api/backup/run', { cookie: owner, body: {}, origin: 'https://attacker.test' })).status, 403);
    assert.equal((await s.callJson('/api/backup/run', { body: {} })).status, 401);
    assert.equal((await s.callJson('/api/backup/status')).status, 401);
    assert.equal((await s.callJson('/api/backup/run', { cookie: owner, method: 'GET' })).status, 405);
    const ok = await s.callJson('/api/backup/run', { cookie: acc.cookie, body: {} });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.run.requestedBy, 'acc.user');
  } finally {
    await s.dispose();
  }
});
