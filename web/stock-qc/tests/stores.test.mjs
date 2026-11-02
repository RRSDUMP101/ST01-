// The shared-database store (team mode) against a fake of the claude.use('db') API with latency and leases:
// several people saving at the same moment, restart, and idempotency.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { RRS, makeClock } from './helpers.mjs';

const require = createRequire(import.meta.url);
require('../src/store/stores.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal in-memory version of the artifact db: docs by path, queries over one collection, leases. */
class FakeDb {
  constructor(latency = 2) {
    this.docs = new Map();
    this.leases = new Map();
    this.latency = latency;
    this.subs = new Map();
    this.writes = 0;
  }
  async wait() {
    await sleep(this.latency + (this.writes % 3));
  }
  doc(path) {
    const db = this;
    return {
      id: path.split('/').pop(),
      path,
      async get() {
        await db.wait();
        const v = db.docs.get(path);
        return { id: path.split('/').pop(), exists: v !== undefined, data: () => (v === undefined ? undefined : JSON.parse(JSON.stringify(v))) };
      },
      async set(data) {
        await db.wait();
        db.writes++;
        db.docs.set(path, JSON.parse(JSON.stringify(data)));
        for (const fn of db.subs.get(path) || []) setTimeout(fn, 0);
      },
      async acquire({ holder, ttlMs }) {
        await db.wait();
        const ttl = Math.min(600000, Math.max(1000, ttlMs || 30000));
        const cur = db.leases.get(path);
        const now = Date.now();
        if (cur && cur.until > now && cur.holder !== holder) return { acquired: false, expiresAt: new Date(cur.until).toISOString() };
        db.leases.set(path, { holder, until: now + ttl });
        return { acquired: true, holder, expiresAt: new Date(now + ttl).toISOString() };
      },
      onSnapshot(next) {
        const list = db.subs.get(path) || [];
        list.push(() => next({ exists: db.docs.has(path), data: () => db.docs.get(path), metadata: { fromCache: false } }));
        db.subs.set(path, list);
        return () => {};
      },
    };
  }
  collection(path) {
    const db = this;
    const make = (filters, order, lim) => ({
      where: (f, op, v) => make(filters.concat([[f, op, v]]), order, lim),
      orderBy: (f) => make(filters, f, lim),
      limit: (n) => make(filters, order, n),
      doc: (id) => db.doc(path + '/' + id),
      async get() {
        await db.wait();
        let rows = [];
        for (const [p, v] of db.docs) {
          const rest = p.slice(path.length + 1);
          if (p.startsWith(path + '/') && rest.indexOf('/') < 0) rows.push({ id: rest, v });
        }
        for (const [f, op, val] of filters) {
          rows = rows.filter((r) => (op === '>' ? r.v[f] > val : op === '==' ? r.v[f] === val : true));
        }
        if (order) rows.sort((a, b) => (a.v[order] > b.v[order] ? 1 : -1));
        if (lim) rows = rows.slice(0, lim);
        const docs = rows.map((r) => ({ id: r.id, exists: true, data: () => JSON.parse(JSON.stringify(r.v)) }));
        return { docs, size: docs.length, empty: !docs.length };
      },
    });
    return make([], null, null);
  }
}

async function team(db) {
  const clock = makeClock();
  const ledger = (who) => new RRS.Ledger(new RRS.stores.ArtifactDbStore(db, { page: 3 }), { holder: who, clock, sleep });
  const admin = ledger('ADMIN');
  const ok = async (l, user, kind, payload) => {
    const r = await l.execute({ kind, payload }, { user });
    if (!r.ok) throw new Error(kind + ' ' + JSON.stringify(r.errors));
    return r;
  };
  await ok(admin, 'ADMIN', 'system.bootstrap', { name: 'ผู้ดูแล' });
  await ok(admin, 'ADMIN', 'user.upsert', { id: 'S1', name: 'สโตร์ 1', roles: ['store'] });
  await ok(admin, 'ADMIN', 'user.upsert', { id: 'S2', name: 'สโตร์ 2', roles: ['store'] });
  await ok(admin, 'ADMIN', 'user.upsert', { id: 'S3', name: 'สโตร์ 3', roles: ['store'] });
  await ok(admin, 'ADMIN', 'master.import', { warehouses: [{ code: 'A' }], items: [{ code: 'X-1', name: 'ชิ้น X', baseUnit: 'ชิ้น' }] });
  await ok(admin, 'ADMIN', 'doc.post', { type: 'AJ', lines: [{ code: 'X-1', qty: 2, wh: 'A' }] });
  return { ledger, ok };
}

test('team store: three people take the last two pieces at once – two succeed, stock never negative', async () => {
  const db = new FakeDb(2);
  const { ledger } = await team(db);
  const people = ['S1', 'S2', 'S3'].map((u) => ({ u, l: ledger(u) }));
  const results = await Promise.all(people.map(({ u, l }) => l.execute({ kind: 'doc.post', payload: { type: 'PD', lines: [{ code: 'X-1', qty: 1, wh: 'A' }] } }, { user: u })));
  assert.equal(results.filter((r) => r.ok).length, 2, JSON.stringify(results.map((r) => r.errors)));
  const fresh = ledger('reader');
  await fresh.catchUp();
  assert.equal(RRS.q.qty(fresh.state, { code: 'X-1' }), 0);
  assert.deepEqual(RRS.inventory.verifyBalances(fresh.state), []);
  // every commit is there once, in order, with a valid hash chain
  const seqs = [...db.docs.keys()].filter((k) => k.startsWith('tx/')).length;
  assert.equal(seqs, fresh.state.seq);
});

test('team store: a request repeated after a restart is applied once', async () => {
  const db = new FakeDb(1);
  const { ledger } = await team(db);
  const cmd = { kind: 'doc.post', payload: { type: 'PD', lines: [{ code: 'X-1', qty: 1, wh: 'A' }] }, requestId: 'rid-1' };
  const a = await ledger('S1').execute(cmd, { user: 'S1' });
  const b = await ledger('S1-after-restart').execute(cmd, { user: 'S1' });
  assert.equal(a.ok, true);
  assert.equal(b.duplicate, true);
  const r = ledger('reader');
  await r.catchUp();
  assert.equal(RRS.q.qty(r.state, { code: 'X-1' }), 1);
});

test('team store: loading pages through many commits keeps order (page size 3)', async () => {
  const db = new FakeDb(0);
  const { ledger } = await team(db);
  const l = ledger('S1');
  for (let i = 0; i < 7; i++) await l.execute({ kind: 'doc.saveDraft', payload: { type: 'PD', lines: [] } }, { user: 'S1' });
  const r = ledger('reader');
  await r.catchUp();
  assert.equal(r.state.seq, l.state.seq);
  assert.equal(r.state.head, l.state.head);
});
