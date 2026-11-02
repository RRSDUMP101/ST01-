// Loads the engine (plain scripts that attach to globalThis.RRS) and gives tests a small world to run commands in.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const engineDir = path.join(here, '..', 'src', 'engine');
const order = JSON.parse(fs.readFileSync(path.join(engineDir, 'order.json'), 'utf8'));
// RRS_ENGINE_ONLY=planning.js,quality.js loads the base files plus only those (modules written in parallel cannot
// break each other's test runs). Without it every existing file in order.json is loaded.
const BASE = ['core.js', 'ledger.js', 'master.js', 'inventory.js'];
const only = process.env.RRS_ENGINE_ONLY ? process.env.RRS_ENGINE_ONLY.split(',').map((x) => x.trim()) : null;
for (const f of order) {
  if (only && BASE.indexOf(f) < 0 && only.indexOf(f) < 0) continue;
  if (fs.existsSync(path.join(engineDir, f))) require(path.join(engineDir, f));
}
export const RRS = globalThis.RRS;

/** A clock that moves one minute per call, from a fixed start (deterministic commits). */
export function makeClock(start = '2026-11-02T01:00:00.000Z') {
  let t = Date.parse(start);
  const clock = () => {
    t += 60e3;
    return new Date(t).toISOString();
  };
  clock.set = (iso) => {
    t = Date.parse(iso);
  };
  clock.peek = () => new Date(t).toISOString();
  return clock;
}

/**
 * A world: one shared store, a ledger per person (like separate browsers), users with roles, warehouses A/B.
 * exec(user, kind, payload, requestId?) -> result of Ledger.execute
 */
export async function world(opts = {}) {
  const store = new RRS.MemoryStore();
  const clock = makeClock(opts.start);
  const ledgers = {};
  const ledgerFor = (user) =>
    ledgers[user] || (ledgers[user] = new RRS.Ledger(store, { holder: user, clock, sleep: () => Promise.resolve() }));
  const exec = (user, kind, payload, requestId) => ledgerFor(user).execute({ kind, payload, requestId }, { user });
  const ok = async (user, kind, payload, requestId) => {
    const r = await exec(user, kind, payload, requestId);
    if (!r.ok) throw new Error(`${kind} failed: ${JSON.stringify(r.errors)}`);
    return r;
  };
  const state = async (user = 'ADMIN') => {
    await ledgerFor(user).catchUp();
    return ledgerFor(user).state;
  };
  if (opts.bare) return { store, clock, exec, ok, state, ledgerFor };
  await ok('ADMIN', 'system.bootstrap', { name: 'ผู้ดูแล', userId: 'ADMIN' });
  const users = opts.users || {
    STORE1: ['store'], STORE2: ['store'], LEAD: ['store_lead'], ACC: ['accounting'], PLAN: ['planner'],
    PUR: ['purchasing'], PURLEAD: ['purchasing_lead'], QC1: ['qc'], QCLEAD: ['qc_lead'], ENG: ['engineering'],
    PROD: ['production'], MGR: ['manager'], VIEW: ['viewer'],
  };
  for (const [id, roles] of Object.entries(users)) await ok('ADMIN', 'user.upsert', { id, name: id, roles });
  if (opts.masters !== false) {
    await ok('ADMIN', 'master.import', {
      warehouses: [{ code: 'A', name: 'คลัง A' }, { code: 'B', name: 'คลัง B' }],
      bins: [{ wh: 'A', code: 'A-01' }, { wh: 'A', code: 'A-02' }, { wh: 'B', code: 'B-01' }],
      items: [
        { code: 'TST-001', name: 'ชิ้นทดสอบ 1', baseUnit: 'ชิ้น', type: 'PART' },
        { code: 'TST-002', name: 'ชิ้นทดสอบ 2', baseUnit: 'ชิ้น', type: 'PART' },
        { code: 'TST-PLATE', name: 'แผ่นทดสอบ 3 มม.', baseUnit: 'แผ่น', type: 'RM', trackLot: 'heat', certRequired: true, qcIncoming: true },
        { code: 'TST-FG', name: 'กระบะทดสอบ', baseUnit: 'ชุด', type: 'FG', qcFinal: true },
      ],
      units: [{ code: 'TST-001', unit: 'โหล', factor: 12 }],
    });
  }
  return { store, clock, exec, ok, state, ledgerFor };
}

/** Receive stock quickly (AJ by the store lead). */
export async function stockIn(w, code, wh, bin, qty, extra = {}) {
  return w.ok('LEAD', 'doc.post', { type: 'AJ', remark: 'ยอดตั้งต้นทดสอบ', lines: [{ code, qty, wh, bin, ...extra }] });
}
