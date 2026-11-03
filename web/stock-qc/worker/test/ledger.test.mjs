// Server ledger: bootstrap, request ids, races between isolates, sq_records = replay of sq_commits, commit pages.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, bootstrapped, stockIn, issueOne, replay, balanceOf, rid, RRS, ORIGIN } from './helpers.mjs';
import { limitedBody } from '../src/security.js';

let s;
let owner;
before(async () => {
  s = await startServer({ isolates: 2 });
  owner = await bootstrapped(s);
});
after(async () => {
  if (s) await s.dispose();
});

const commitCount = async () => (await s.d1.prepare('SELECT COUNT(*) AS n FROM sq_commits').first()).n;
const STOCK_ERRORS = ['NOT_ENOUGH', 'NEGATIVE'];

async function assertRecordsMatchReplay() {
  const r = await replay(s.d1);
  assert.deepEqual(r.records, r.tables, 'sq_records equals the replay of sq_commits');
  for (const m of Object.values(r.state.tables.movements || {})) assert.ok(m.balanceAfter >= 0, `movement ${m.id} left ${m.balanceAfter}`);
  for (const b of Object.values(r.state.tables.balances || {})) assert.ok(b.qty >= 0);
  return r;
}

test('bootstrap: only the owner, only on an empty system, bound to the owner account whatever the payload says', async () => {
  const fresh = await startServer();
  try {
    const own = await fresh.ownerLogin();
    const early = await fresh.account(own, 'early.user');
    const refused = await fresh.cmd(early.cookie, 'system.bootstrap', { name: 'ไม่ใช่เจ้าของ', accountId: 'early.user' });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'NO_USER');
    const okr = await fresh.cmd(own, 'system.bootstrap', { name: 'เจ้าของ', userId: 'boss', accountId: 'early.user' });
    assert.equal(okr.status, 200, okr.text);
    assert.equal(okr.body.commit.by, 'BOSS');
    assert.equal(okr.body.commit.via, fresh.secrets.ownerUsername);
    const st = (await replay(fresh.d1)).state;
    assert.equal(st.tables.users.BOSS.accountId, fresh.secrets.ownerUsername);
    assert.deepEqual(st.tables.users.BOSS.roles, ['admin']);
    const again = await fresh.cmd(own, 'system.bootstrap', { name: 'อีกครั้ง' });
    assert.equal(again.status, 422);
    assert.equal(again.body.errors[0].code, 'ALREADY_STARTED');
    const sess = await fresh.callJson('/api/auth/session', { cookie: own });
    assert.equal(sess.body.user.id, 'BOSS');
    assert.equal(sess.body.bootstrapped, true);
  } finally {
    await fresh.dispose();
  }
});

test('a command posted twice with the same requestId is applied once (also when both arrive together)', async () => {
  const before = await commitCount();
  const id = rid('dup');
  const payload = { type: 'AJ', remark: 'รับซ้ำ', lines: [{ code: 'TST-001', qty: 3, wh: 'A', bin: 'A-01' }] };
  const first = await s.cmd(owner, 'doc.post', payload, id);
  assert.equal(first.status, 200);
  assert.ok(first.body.commit);
  const second = await s.cmd(owner, 'doc.post', payload, id, { on: 'b' });
  assert.equal(second.status, 200);
  assert.equal(second.body.ok, true);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.seq, first.body.commit.seq);
  assert.equal(await commitCount(), before + 1);
  const reused = await s.cmd(owner, 'doc.post', Object.assign({}, payload, { remark: 'อื่น' }), id);
  assert.equal(reused.status, 422);
  assert.equal(reused.body.errors[0].code, 'REQUEST_REUSED');
  // the same request on both isolates at the same moment
  const id2 = rid('dup2');
  const both = await Promise.all([s.cmd(owner, 'doc.post', payload, id2, { on: 'a' }), s.cmd(owner, 'doc.post', payload, id2, { on: 'b' })]);
  assert.ok(both.every((r) => r.status === 200 && r.body.ok));
  assert.equal(both.filter((r) => r.body.commit).length, 1);
  assert.equal(both.filter((r) => r.body.duplicate).length, 1);
  assert.equal(await commitCount(), before + 2);
  const n = await s.d1.prepare('SELECT COUNT(*) AS n FROM sq_commits WHERE request_id IN (?,?)').bind(id, id2).first();
  assert.equal(n.n, 2);
  await assertRecordsMatchReplay();
  // empty the location again for the next tests
  const st = (await replay(s.d1)).state;
  await s.ok(owner, 'doc.post', { type: 'AJ', remark: 'คืนยอดเป็น 0', lines: [{ code: 'TST-001', qty: -balanceOf(st, 'TST-001'), wh: 'A', bin: 'A-01' }] });
});

test('two concurrent POST /api/command taking the last piece (two isolates, then one isolate): exactly one succeeds', async () => {
  for (const pair of [['a', 'b'], ['a', 'a'], ['b', 'b']]) {
    await stockIn(s, owner, 1);
    const res = await Promise.all(pair.map((on) => issueOne(s, owner, rid('last'), { on })));
    const oks = res.filter((r) => r.status === 200 && r.body.ok);
    const fails = res.filter((r) => !(r.status === 200 && r.body.ok));
    assert.equal(oks.length, 1, pair.join('+') + ': ' + res.map((r) => r.text.slice(0, 200)).join(' | '));
    assert.equal(fails.length, 1);
    assert.equal(fails[0].status, 422);
    assert.ok(STOCK_ERRORS.indexOf(fails[0].body.errors[0].code) >= 0, fails[0].text);
    assert.equal(balanceOf((await replay(s.d1)).state, 'TST-001'), 0);
  }
  // a burst: 4 pieces, 10 requests spread over both isolates → exactly 4 issues, never below zero, no lost update
  await stockIn(s, owner, 4);
  const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => issueOne(s, owner, rid('burst'), { on: i % 2 ? 'b' : 'a' })));
  const oks = burst.filter((r) => r.status === 200 && r.body.ok);
  assert.equal(oks.length, 4, burst.map((r) => r.status + ' ' + r.text.slice(0, 120)).join('\n'));
  for (const r of burst.filter((x) => !(x.status === 200 && x.body.ok))) {
    assert.equal(r.status, 422);
    assert.ok(STOCK_ERRORS.indexOf(r.body.errors[0].code) >= 0, r.text);
  }
  const seqs = oks.map((r) => r.body.commit.seq).sort((x, y) => x - y);
  assert.equal(new Set(seqs).size, 4);
  const r = await assertRecordsMatchReplay();
  assert.equal(balanceOf(r.state, 'TST-001'), 0);
});

test('CAS: the loser of a race (both prepared on the same seq) catches up and is validated against the new stock', async () => {
  await stockIn(s, owner, 1);
  // Two independent ledger instances (= two isolates) whose D1 batches are held until both have prepared.
  const L1 = await import('../src/ledger.js?isolate=race-1');
  const L2 = await import('../src/ledger.js?isolate=race-2');
  const base = s.env();
  let calls = 0;
  const waiting = [];
  const DB = {
    prepare: (...a) => base.DB.prepare(...a),
    batch: async (stmts) => {
      calls += 1;
      if (calls <= 2) {
        await new Promise((resolve) => {
          waiting.push(resolve);
          if (waiting.length === 2) waiting.forEach((f) => f());
        });
      }
      return base.DB.batch(stmts);
    },
  };
  const env = { DB, BUCKET: base.BUCKET, SQ_SNAPSHOT_EVERY: '500' };
  const session = { username: s.secrets.ownerUsername, owner: true };
  const command = () => ({ kind: 'doc.post', payload: { type: 'OU', remark: 'แข่งกัน', lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01' }] }, requestId: rid('cas') });
  const headBefore = await commitCount();
  const [x, y] = await Promise.all([L1.execute(env, command(), session), L2.execute(env, command(), session)]);
  // Both prepared on the same seq and both sent their batch; only one row went in. The loser then caught up and the
  // engine refused it (no stock left), so no third batch was sent.
  assert.equal(calls, 2, 'both isolates tried to write the same seq');
  assert.equal([x, y].filter((r) => r.ok).length, 1);
  const loser = x.ok ? y : x;
  assert.ok(STOCK_ERRORS.indexOf(loser.errors[0].code) >= 0);
  assert.equal(await commitCount(), headBefore + 1);
  // the HTTP isolates see the commit written by the "other isolate"
  const c = await s.callJson(`/api/commits?after=${headBefore}`, { cookie: owner, on: 'b' });
  assert.equal(c.body.commits.length, 1);
  assert.equal(c.body.commits[0].hash, (x.ok ? x : y).commit.hash);
  await assertRecordsMatchReplay();

  // Same race with 2 pieces: the loser is prepared again on top of the winner and then also goes in (no lost update).
  await stockIn(s, owner, 2);
  calls = 0;
  waiting.length = 0;
  const head2 = await commitCount();
  const [p, q] = await Promise.all([L1.execute(env, command(), session), L2.execute(env, command(), session)]);
  assert.ok(p.ok && q.ok, JSON.stringify([p.errors, q.errors]));
  assert.equal(calls, 3, 'the loser sent a second batch after catching up');
  assert.deepEqual([p.commit.seq, q.commit.seq].sort((m, n) => m - n), [head2 + 1, head2 + 2]);
  const later = p.commit.seq > q.commit.seq ? p : q;
  const earlier = later === p ? q : p;
  assert.equal(later.commit.prev, earlier.commit.hash);
  const r = await assertRecordsMatchReplay();
  assert.equal(balanceOf(r.state, 'TST-001'), 0);
});

test('an account without an engine user gets 403 for commands, commits and files; an inactive engine user too', async () => {
  const norole = await s.account(owner, 'no.role');
  const sess = await s.callJson('/api/auth/session', { cookie: norole.cookie });
  assert.equal(sess.status, 200);
  assert.equal(sess.body.user, null);
  assert.equal(sess.body.bootstrapped, true);
  const c = await s.cmd(norole.cookie, 'kpi.record', { id: 'x', label: 'x' });
  assert.equal(c.status, 403);
  assert.equal(c.body.code, 'NO_USER');
  assert.equal((await s.callJson('/api/commits?after=0', { cookie: norole.cookie })).status, 403);
  assert.equal((await s.callJson('/api/files/' + 'a'.repeat(64), { cookie: norole.cookie })).status, 403);
  await s.ok(owner, 'user.upsert', { id: 'OFFUSER', name: 'ปิดแล้ว', roles: ['store'], accountId: 'no.role', active: false });
  const off = await s.cmd(norole.cookie, 'kpi.record', { id: 'x', label: 'x' });
  assert.equal(off.status, 403);
  assert.equal(off.body.code, 'USER_INACTIVE');
  assert.equal((await s.callJson('/api/commits?after=0', { cookie: norole.cookie })).status, 403);
  // the client cannot choose who it is
  await s.ok(owner, 'user.upsert', { id: 'OFFUSER', name: 'สโตร์ 9', roles: ['store'], accountId: 'no.role', active: true });
  const mine = await s.cmd(norole.cookie, 'kpi.record', { id: 'x', label: 'x' });
  assert.equal(mine.status, 422, 'store role lacks kpi.record');
  assert.equal(mine.body.errors[0].code, 'NO_PERMISSION');
  const spoof = await s.callJson('/api/command', { cookie: norole.cookie, body: { kind: 'kpi.record', payload: { id: 'x', label: 'x' }, requestId: rid(), via: s.secrets.ownerUsername, user: 'ADMIN' } });
  assert.equal(spoof.status, 422);
  assert.equal(spoof.body.errors[0].code, 'NO_PERMISSION');
});

test('bad command input is refused before the engine', async () => {
  const cases = [
    [{ kind: 'kpi.record', payload: {} }, 400],
    [{ kind: 'kpi.record', payload: {}, requestId: 'short' }, 400],
    [{ kind: 'kpi.record', payload: [], requestId: rid() }, 400],
    [{ kind: 'Bad Kind!', payload: {}, requestId: rid() }, 400],
  ];
  for (const [body, status] of cases) assert.equal((await s.callJson('/api/command', { cookie: owner, body })).status, status, JSON.stringify(body));
  const unknown = await s.cmd(owner, 'no.such.command', {});
  assert.equal(unknown.status, 422);
  assert.equal(unknown.body.errors[0].code, 'UNKNOWN_COMMAND');
  const raw = await s.callJson('/api/command', { cookie: owner, raw: '{nope', headers: { 'content-type': 'application/json' } });
  assert.equal(raw.status, 400);
});

test('sq_commits is append-only in D1 (UPDATE and DELETE are refused)', async () => {
  await assert.rejects(s.d1.prepare("UPDATE sq_commits SET summary='แก้' WHERE seq=1").run(), /append-only/);
  await assert.rejects(s.d1.prepare('DELETE FROM sq_commits WHERE seq=1').run(), /append-only/);
});

test('GET /api/commits pages: ≤ 500 commits and ≈ 4 MB per page, in order, hash chained; big commits refused', async () => {
  // many small commits
  for (let i = 0; i < 505; i++) await s.ok(owner, 'kpi.record', { id: `page_${i}`, label: `ตัวชี้วัด ${i}`, unit: 'ครั้ง', baseline: i });
  // a few ~1.3 MB commits (long Thai names)
  const longName = 'ชิ้นส่วนทดสอบยาวมาก'.repeat(100);
  for (let b = 0; b < 4; b++) {
    const items = Array.from({ length: 200 }, (_, i) => ({ code: `BIG-${b}-${i}`, name: `${longName} ${i}`, baseUnit: 'ชิ้น', type: 'PART' }));
    await s.ok(owner, 'master.import', { items });
  }
  // over the D1 row limit → TOO_LARGE, nothing written; over the request limit → 413
  const head = await commitCount();
  const tooBig = await s.cmd(owner, 'master.import', { items: Array.from({ length: 320 }, (_, i) => ({ code: `HUGE-${i}`, name: `${longName} ${i}`, baseUnit: 'ชิ้น' })) });
  assert.equal(tooBig.status, 422);
  assert.equal(tooBig.body.errors[0].code, 'TOO_LARGE');
  // Invoke the real fetch handler with the same D1/session bindings for an early-rejected upload. Miniflare/Undici
  // intermittently resets >2 MB uploads on Windows before delivering 413, even with Content-Length. Normal command
  // requests and all pagination assertions still use HTTP; no HTTP error is swallowed or retried here.
  const oversizedCommand = { kind: 'master.import', requestId: rid('oversize'), payload: {
    items: Array.from({ length: 400 }, (_, i) => ({ code: `HUGE-${i}`, name: `${longName} ${i}`, baseUnit: 'ชิ้น' })),
  } };
  const { default: workerHandler } = await import('../src/index.js');
  const oversizedJson = JSON.stringify(oversizedCommand);
  const body413 = await workerHandler.fetch(new Request(ORIGIN + '/api/command', { method: 'POST', body: oversizedJson,
    headers: { Origin: ORIGIN, Cookie: owner, 'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(oversizedJson)) } }), { ...s.env(), ...s.bindings });
  assert.equal(body413.status, 413);
  assert.equal((await body413.json()).ok, false);
  // Keep coverage of the streamed/no-Content-Length path without the Windows HTTP transport reset.
  let cancelled = false;
  const streamed = new Request('https://stock.test/api/command', { method: 'POST', duplex: 'half',
    body: new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { cancelled = true; },
    }),
  });
  await assert.rejects(() => limitedBody(streamed, 2 * 1024 * 1024), e => e.status === 413);
  assert.equal(cancelled, true);
  assert.equal(await commitCount(), head);

  const all = [];
  let after = 0;
  let pages = 0;
  for (;;) {
    const r = await s.callJson(`/api/commits?after=${after}`, { cookie: owner, on: pages % 2 ? 'b' : 'a' });
    assert.equal(r.status, 200);
    pages += 1;
    assert.ok(r.body.commits.length >= 1 && r.body.commits.length <= 500);
    assert.ok(Buffer.byteLength(r.text) <= 4 * 1024 * 1024 + 64, `page ${pages} is ${Buffer.byteLength(r.text)} bytes`);
    all.push(...r.body.commits);
    after = r.body.commits[r.body.commits.length - 1].seq;
    if (!r.body.more) break;
  }
  assert.ok(pages >= 3, `pages: ${pages}`);
  assert.equal(all.length, head);
  let prev = RRS.core.GENESIS;
  all.forEach((c, i) => {
    assert.equal(c.seq, i + 1);
    assert.equal(c.prev, prev);
    assert.ok(RRS.core.verifyCommit(c), `commit ${c.seq}`);
    prev = c.hash;
  });
  const first = await s.callJson('/api/commits?after=0', { cookie: owner });
  assert.equal(first.body.commits.length, 500);
  assert.equal(first.body.more, true);
  const end = await s.callJson(`/api/commits?after=${head}`, { cookie: owner });
  assert.deepEqual(end.body, { commits: [], more: false });
  for (const bad of ['-1', 'abc', '1.5']) assert.equal((await s.callJson(`/api/commits?after=${bad}`, { cookie: owner })).status, 400);
  assert.equal((await s.callJson('/api/commits?after=0')).status, 401);
  await assertRecordsMatchReplay();
});

test('a snapshot that cannot be written does not fail the command (security event instead)', async () => {
  const L3 = await import('../src/ledger.js?isolate=snapshot-fails');
  const base = s.env();
  const brokenBucket = {
    put: async () => {
      throw new Error('R2 ไม่พร้อม (ทดสอบ)');
    },
    get: (...a) => base.BUCKET.get(...a),
  };
  const env = { DB: base.DB, BUCKET: brokenBucket, SQ_SNAPSHOT_EVERY: '1' };
  const before = (await s.d1.prepare('SELECT COUNT(*) AS n FROM sq_snapshots').first()).n;
  const r = await L3.execute(env, { kind: 'kpi.record', payload: { id: 'snap_fail', label: 'ทดสอบ snapshot' }, requestId: rid('snap') },
    { username: s.secrets.ownerUsername, owner: true });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.ok(r.commit.seq > 0);
  assert.equal((await s.d1.prepare('SELECT COUNT(*) AS n FROM sq_snapshots').first()).n, before);
  const ev = await s.d1.prepare("SELECT detail FROM sq_security_events WHERE event='snapshot_failed'").all();
  assert.ok(ev.results.some((e) => e.detail.startsWith(`seq ${r.commit.seq}`)));
  await assertRecordsMatchReplay();
});
