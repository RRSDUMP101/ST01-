// Test harness: the Worker bundled with wrangler's esbuild (the same bundler `wrangler deploy` uses), run in Miniflare
// with in-memory (or temp-dir persisted) D1 + R2. Every secret is generated here for the test only; nothing talks to
// Cloudflare, Google or Sales Office (cf: false keeps Miniflare from fetching request.cf data).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { stateFingerprint, loadState } from '../src/ledger.js';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
export const workerDir = path.resolve(here, '..');
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const esbuild = wranglerRequire(wranglerRequire.resolve('esbuild'));
const { Miniflare, Log, LogLevel } = require('miniflare');

export const RRS = globalThis.RRS;
export { stateFingerprint, loadState };
export const ORIGIN = 'https://stockqc.test';
export const COMPAT_DATE = '2025-09-01';

let built = null;
/**
 * src/index.js bundled like wrangler does (workerd/worker/browser conditions, ESM). SQ_WORKER_BUNDLE=<file> runs the
 * tests against a bundle made by wrangler itself instead (`wrangler deploy --dry-run --outdir <dir>` → <dir>/index.js).
 */
export async function buildWorker() {
  if (!built && process.env.SQ_WORKER_BUNDLE) built = fs.readFileSync(process.env.SQ_WORKER_BUNDLE, 'utf8');
  if (!built) {
    const r = await esbuild.build({
      entryPoints: [path.join(workerDir, 'src', 'index.js')], bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
      conditions: ['workerd', 'worker', 'browser'], mainFields: ['browser', 'module', 'main'], write: false, logLevel: 'silent',
    });
    built = r.outputFiles[0].text;
  }
  return built;
}

/** Statements of every migrations/*.sql in order (a statement ends with ';' at line end; triggers end with END;). */
export function migrationStatements() {
  const dir = path.join(workerDir, 'migrations');
  const out = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    let cur = [];
    let trigger = false;
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      const t = line.trim();
      if (!cur.length && (t === '' || t.startsWith('--'))) continue;
      cur.push(line);
      if (/^CREATE TRIGGER/i.test(t)) trigger = true;
      if (trigger ? /^END;$/i.test(t) : /;$/.test(t)) {
        out.push(cur.join('\n'));
        cur = [];
        trigger = false;
      }
    }
    if (cur.join('').trim()) throw new Error(`unterminated statement in ${file}`);
  }
  return out;
}
export async function applyMigrations(d1) {
  for (const s of migrationStatements()) await d1.prepare(s).run();
}

export async function makeSecrets() {
  const ownerPassword = randomBytes(18).toString('base64url');
  return {
    ownerUsername: 'owner-' + randomBytes(3).toString('hex'),
    ownerPassword,
    ownerHash: await bcrypt.hash(ownerPassword, 12),
    sessionSecret: randomBytes(32).toString('hex'),
  };
}
export const tempPassword = () => 'T' + randomBytes(12).toString('base64url');
export const tempDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `sq-${name}-`));
export const rid = (p = 'rq') => `${p}-${randomBytes(8).toString('hex')}`;

/**
 * Starts the Worker. opts: {isolates: 1|2 (separate isolates on the same D1/R2), persist: dir, migrate (default true),
 * snapshotEvery, bindings, assetsDir, secrets}. → server {mf, d1, r2, secrets, a, b, call, …}
 */
export async function startServer(opts = {}) {
  const script = await buildWorker();
  const secrets = opts.secrets || (await makeSecrets());
  const bindings = Object.assign({
    ADMIN_USERNAME: secrets.ownerUsername, ADMIN_PASSWORD_HASH: secrets.ownerHash, SESSION_SECRET: secrets.sessionSecret,
    SQ_ENV: 'test', SQ_SALES_BRIDGE: 'off', SQ_DRIVE_BACKUP_ENABLED: 'false', SQ_SNAPSHOT_EVERY: String(opts.snapshotEvery || 500),
  }, opts.bindings || {});
  const names = opts.isolates === 2 ? ['a', 'b'] : ['a'];
  const workers = names.map((name, i) => {
    const w = { name, modules: true, script, compatibilityDate: COMPAT_DATE, compatibilityFlags: ['nodejs_compat'],
      d1Databases: { DB: 'stockqc-test-db' }, r2Buckets: { BUCKET: 'stockqc-test-files' }, bindings };
    if (opts.assetsDir && i === 0) {
      w.assets = { directory: opts.assetsDir, binding: 'ASSETS', routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true } };
    }
    return w;
  });
  const mf = new Miniflare({
    workers, cf: false, log: new Log(LogLevel.ERROR),
    d1Persist: opts.persist ? path.join(opts.persist, 'd1') : false,
    r2Persist: opts.persist ? path.join(opts.persist, 'r2') : false,
  });
  await mf.ready;
  const d1 = await mf.getD1Database('DB', 'a');
  const r2 = await mf.getR2Bucket('BUCKET', 'a');
  if (opts.migrate !== false) await applyMigrations(d1);
  // dispatchFetch reaches the first worker; MF-Route-Override sends the request to another isolate by name.
  const target = (name) => ({ fetch: (u, i) => mf.dispatchFetch(u, Object.assign({}, i, { headers: Object.assign({}, i.headers, name === 'a' ? {} : { 'MF-Route-Override': name }) })) });
  const targets = Object.fromEntries(names.map((n) => [n, target(n)]));

  /** HTTP call to isolate `on` (default a). body → JSON; raw → as is. */
  function call(pathname, o = {}) {
    const headers = Object.assign({ 'cf-connecting-ip': o.ip || '192.0.2.10' }, o.headers || {});
    if (o.origin !== null) headers.origin = o.origin || ORIGIN;
    if (o.cookie) headers.cookie = o.cookie;
    let payload;
    if (o.raw !== undefined) payload = o.raw;
    else if (o.body !== undefined) {
      payload = JSON.stringify(o.body);
      headers['content-type'] = 'application/json';
    }
    const method = o.method || (payload !== undefined ? 'POST' : 'GET');
    return targets[o.on || 'a'].fetch(ORIGIN + pathname, { method, headers, body: payload });
  }
  async function callJson(pathname, o) {
    const res = await call(pathname, o);
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch (e) {
      body = null;
    }
    return { status: res.status, headers: res.headers, body, text };
  }
  async function login(username, password, o = {}) {
    const r = await callJson('/api/auth/login', Object.assign({ body: { username, password } }, o));
    if (r.status !== 200) throw new Error(`login ${username} → ${r.status} ${r.text}`);
    return r.headers.get('set-cookie').split(';')[0];
  }
  const ownerLogin = (o) => login(secrets.ownerUsername, secrets.ownerPassword, o);
  async function cmd(cookie, kind, payload, requestId, o = {}) {
    return callJson('/api/command', Object.assign({ cookie, body: { kind, payload, requestId: requestId || rid() } }, o));
  }
  async function ok(cookie, kind, payload, requestId, o) {
    const r = await cmd(cookie, kind, payload, requestId, o);
    if (r.status !== 200 || !r.body || !r.body.ok) throw new Error(`${kind} → ${r.status} ${r.text}`);
    return r.body;
  }
  /** Account with a temporary password from the owner, then its own password: → {username, password, cookie}. */
  async function account(ownerCookie, username) {
    const temp = tempPassword();
    const c = await callJson('/api/admin/credentials', { cookie: ownerCookie, body: { username, password: temp } });
    if (c.status !== 200) throw new Error(`credentials ${username} → ${c.status} ${c.text}`);
    const first = await login(username, temp);
    const password = tempPassword();
    const ch = await callJson('/api/auth/password', { cookie: first, body: { current: temp, next: password } });
    if (ch.status !== 200) throw new Error(`password ${username} → ${ch.status} ${ch.text}`);
    return { username, password, cookie: await login(username, password) };
  }
  const env = () => ({ DB: d1, BUCKET: r2 });
  return { mf, d1, r2, secrets, bindings, call, callJson, login, ownerLogin, cmd, ok, account, env, dispose: () => mf.dispose() };
}

/** Owner logs in and starts the system; masters for stock tests. → owner cookie */
export async function bootstrapped(server, { masters = true } = {}) {
  const owner = await server.ownerLogin();
  await server.ok(owner, 'system.bootstrap', { name: 'เจ้าของทดสอบ', company: 'บริษัททดสอบ', userId: 'ADMIN' });
  if (masters) {
    await server.ok(owner, 'master.import', {
      warehouses: [{ code: 'A', name: 'คลัง A' }],
      bins: [{ wh: 'A', code: 'A-01' }],
      items: [{ code: 'TST-001', name: 'ชิ้นทดสอบ 1', baseUnit: 'ชิ้น', type: 'PART' }],
    });
  }
  return owner;
}
export const stockIn = (server, cookie, qty) => server.ok(cookie, 'doc.post', { type: 'AJ', remark: 'ยอดตั้งต้นทดสอบ', lines: [{ code: 'TST-001', qty, wh: 'A', bin: 'A-01' }] });
export const issueOne = (server, cookie, requestId, o) => server.cmd(cookie, 'doc.post', { type: 'OU', remark: 'เบิกทดสอบ', lines: [{ code: 'TST-001', qty: 1, wh: 'A', bin: 'A-01' }] }, requestId, o);

/** Every commit from D1 replayed with hash checks, and sq_records read back as {table: {key: row}}. */
export async function replay(d1) {
  const rows = (await d1.prepare('SELECT seq,request_id,kind,at,"by",via,summary,payload_hash,prev,hash,effects FROM sq_commits ORDER BY seq').all()).results;
  const state = RRS.core.createState();
  for (const r of rows) {
    const c = { seq: r.seq, id: r.request_id || '', kind: r.kind, at: r.at, by: r.by, via: r.via, summary: r.summary, payloadHash: r.payload_hash,
      effects: JSON.parse(r.effects), prev: r.prev, hash: r.hash };
    if (!RRS.core.verifyCommit(c)) throw new Error(`commit ${r.seq} hash mismatch`);
    RRS.core.reduce(state, c);
  }
  const records = {};
  for (const r of (await d1.prepare('SELECT tbl,id,data FROM sq_records').all()).results) (records[r.tbl] || (records[r.tbl] = {}))[r.id] = JSON.parse(r.data);
  const tables = {};
  for (const t of Object.keys(state.tables)) {
    const keep = {};
    for (const [k, v] of Object.entries(state.tables[t])) if (v !== undefined) keep[k] = v;
    if (Object.keys(keep).length) tables[t] = keep;
  }
  return { state, records, tables, commits: rows.length };
}
export const balanceOf = (state, code) => RRS.q.qty(state, { code });
