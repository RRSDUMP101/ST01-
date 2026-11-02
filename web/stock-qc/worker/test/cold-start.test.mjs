// Cold isolate: a new Miniflare instance on the same persisted D1/R2 (temp dir) rebuilds the same state from the newest
// R2 snapshot + the commits after it; a broken snapshot falls back; a tampered commit stops the ledger.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer, bootstrapped, stockIn, issueOne, replay, balanceOf, stateFingerprint, loadState, tempDir, makeSecrets, RRS } from './helpers.mjs';

const persist = tempDir('cold');
const open = [];
after(async () => {
  for (const s of open) await s.dispose().catch(() => {});
  fs.rmSync(persist, { recursive: true, force: true });
});
async function server(opts) {
  const s = await startServer(Object.assign({ persist, snapshotEvery: 5 }, opts));
  open.push(s);
  return s;
}
async function close(s) {
  open.splice(open.indexOf(s), 1);
  await s.dispose();
}

test('cold isolate rebuilds the same state hash from snapshot + commits, and keeps working', async () => {
  const secrets = await makeSecrets();
  const s1 = await server({ secrets });
  const owner = await bootstrapped(s1); // commits 1–2
  await stockIn(s1, owner, 7); // 3
  for (let i = 0; i < 9; i++) await s1.ok(owner, 'kpi.record', { id: `cold_${i}`, label: `ค่า ${i}`, baseline: i }); // 4–12
  await issueOne(s1, owner); // 13 (7 → 6)
  const snaps = (await s1.d1.prepare('SELECT seq,r2_key,hash,sha256,size FROM sq_snapshots ORDER BY seq').all()).results;
  assert.deepEqual(snaps.map((x) => x.seq), [5, 10]);
  for (const snap of snaps) {
    const obj = await s1.r2.get(snap.r2_key);
    assert.ok(obj, snap.r2_key);
    const text = await obj.text();
    assert.equal(Buffer.byteLength(text), snap.size);
    assert.equal(RRS.util.sha256(text), snap.sha256);
    assert.equal(JSON.parse(text).state.head, snap.hash);
  }
  const warm = await replay(s1.d1);
  const expected = stateFingerprint(warm.state);
  assert.equal(warm.state.seq, 13);
  await close(s1);

  const s2 = await server({ secrets, migrate: false });
  // the same rebuild the Worker does on a cold isolate
  const cold = await loadState(s2.env());
  assert.equal(cold.source, 'snapshot');
  assert.equal(cold.snapshotSeq, 10);
  assert.equal(stateFingerprint(cold.state), expected);
  // the Worker on the new instance: the old session (persisted, same secret) still works; stock was rebuilt (6 left)
  const page = await s2.callJson('/api/commits?after=0', { cookie: owner });
  assert.equal(page.status, 200);
  assert.equal(page.body.commits.length, 13);
  for (let i = 0; i < 6; i++) {
    const r = await issueOne(s2, owner);
    assert.equal(r.status, 200, r.text);
    if (i === 0) assert.equal(r.body.commit.prev, warm.state.head, 'first new commit follows the old head');
  }
  const empty = await issueOne(s2, owner);
  assert.equal(empty.status, 422);
  const r2 = await replay(s2.d1);
  assert.deepEqual(r2.records, r2.tables);
  assert.equal(balanceOf(r2.state, 'TST-001'), 0);
  assert.equal(r2.state.seq, 19);
  assert.deepEqual((await s2.d1.prepare('SELECT seq FROM sq_snapshots ORDER BY seq').all()).results.map((x) => x.seq), [5, 10, 15]);
  await close(s2);
});

test('a snapshot whose bytes do not match falls back to the previous one (same state); without snapshots it replays from the start', async () => {
  const s3 = await server({ migrate: false });
  const newest = await s3.d1.prepare('SELECT seq,r2_key FROM sq_snapshots ORDER BY seq DESC LIMIT 1').first();
  const obj = await s3.r2.get(newest.r2_key);
  const body = JSON.parse(await obj.text());
  body.state.tables.balances = {}; // someone "edits" the snapshot
  await s3.r2.put(newest.r2_key, JSON.stringify(body));
  const expected = stateFingerprint((await replay(s3.d1)).state);
  const cold = await loadState(s3.env());
  assert.equal(cold.source, 'snapshot');
  assert.equal(cold.snapshotSeq, 10, 'skipped the broken snapshot 15');
  assert.equal(stateFingerprint(cold.state), expected);
  const ev = await s3.d1.prepare("SELECT detail FROM sq_security_events WHERE event='snapshot_unusable'").all();
  assert.ok(ev.results.some((e) => e.detail.startsWith('seq 15')));
  const none = await loadState({ DB: s3.d1 }); // no R2 binding → full replay
  assert.equal(none.source, 'genesis');
  assert.equal(stateFingerprint(none.state), expected);
  await close(s3);
});

test('a commit changed in D1 stops the ledger on a cold isolate (no command is accepted on top of it)', async () => {
  const s4 = await server({ migrate: false });
  await s4.d1.prepare('DROP TRIGGER sq_commits_no_update').run();
  await s4.d1.prepare("UPDATE sq_commits SET summary='แก้ข้อมูลย้อนหลัง' WHERE seq=17").run();
  await assert.rejects(loadState(s4.env()), (e) => e.extra && e.extra.code === 'LEDGER_INTEGRITY');
  const owner = await s4.ownerLogin();
  const before = (await s4.d1.prepare('SELECT COUNT(*) AS n FROM sq_commits').first()).n;
  const r = await s4.cmd(owner, 'kpi.record', { id: 'after_tamper', label: 'x' });
  assert.equal(r.status, 500);
  assert.equal(r.body.code, 'LEDGER_INTEGRITY');
  assert.equal((await s4.d1.prepare('SELECT COUNT(*) AS n FROM sq_commits').first()).n, before);
  const ev = await s4.d1.prepare("SELECT severity FROM sq_security_events WHERE event='ledger_integrity'").all();
  assert.ok(ev.results.length >= 1 && ev.results.every((e) => e.severity === 'critical'));
  await close(s4);
});
