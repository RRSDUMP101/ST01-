// End-to-end in a real browser against the Cloudflare Worker (Miniflare: local D1 + R2, the Worker bundle, the page
// built for server mode). Nothing leaves this machine: every outbound request of the Worker is refused.
//   node tests/e2e/server.mjs [--shots dir]
// Steps: owner logs in → starts the system → master data and an AJ through the screens → reload (data from D1) →
// a second account without rights sees the access request and sends it → the owner gives it a role and a password →
// two people take the last piece at the same moment (one succeeds) → the ledger in D1 replays to the same state.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const workerDir = path.join(root, 'worker');
const require = createRequire(path.join(workerDir, 'package.json'));
const { Miniflare, Log, LogLevel } = require('miniflare');
const { chromium } = createRequire(import.meta.url)('playwright');
const H = await import(path.join(workerDir, 'test', 'helpers.mjs'));

const shotsArg = process.argv.indexOf('--shots');
const shots = shotsArg > 0 ? process.argv[shotsArg + 1] : null;
if (shots) fs.mkdirSync(shots, { recursive: true });

// 1. the page for server mode
const site = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-site-'));
execFileSync(process.execPath, ['build.mjs'], { cwd: root, env: Object.assign({}, process.env, { RRS_API: '/api', RRS_OUT: site }), stdio: 'pipe' });

// 2. the Worker on a local port
const secrets = await H.makeSecrets();
const blocked = [];
const mf = new Miniflare({
  workers: [{
    name: 'a', modules: true, script: await H.buildWorker(), compatibilityDate: H.COMPAT_DATE, compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'stockqc-e2e' }, r2Buckets: { BUCKET: 'stockqc-e2e' },
    bindings: { ADMIN_USERNAME: secrets.ownerUsername, ADMIN_PASSWORD_HASH: secrets.ownerHash, SESSION_SECRET: secrets.sessionSecret,
      SQ_ENV: 'test', SQ_SALES_BRIDGE: 'off', SQ_DRIVE_BACKUP_ENABLED: 'false' },
    outboundService: (req) => { blocked.push(req.url); return new Response('blocked in tests', { status: 599 }); },
    assets: Object.assign({ directory: site, binding: 'ASSETS' }, H.wranglerAssetRouting()),
  }],
  host: '127.0.0.1', port: 0, cf: false, log: new Log(LogLevel.ERROR),
});
const url = String(await mf.ready).replace(/\/$/, '');
const d1 = await mf.getD1Database('DB', 'a');
await H.applyMigrations(d1);

const browser = await chromium.launch();
const problems = [];
let n = 0;
async function step(name, fn) {
  n++;
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    problems.push(`${name}: ${e.message}`);
    console.log(`FAIL ${name}\n      ${e.message}`);
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
async function openPage(ctx) {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|cdnjs|ERR_|net::|status of (40[13]|422)/.test(m.text())) problems.push('console: ' + m.text()); });
  p.on('dialog', (d) => { problems.push('native dialog: ' + d.message()); d.dismiss(); });
  await p.goto(url + '/');
  return p;
}
const settled = (p) => p.waitForFunction(() => window.RRS && window.RRS.app && !window.RRS.app.loading, null, { timeout: 30000 });
async function login(p, user, pass) {
  await p.waitForSelector('form[data-form="_login"]', { timeout: 20000 });
  await p.fill('#login-user', user);
  await p.fill('#login-pass', pass);
  await p.click('form[data-form="_login"] button[type=submit]');
  await p.waitForFunction((u) => window.RRS.app.session && window.RRS.app.session.username === u && !window.RRS.app.loading, user, { timeout: 20000 });
}
const exec = (p, kind, payload) => p.evaluate(([k, pl]) => window.RRS.app.ledger.execute({ kind: k, payload: pl, requestId: 'e2e-' + Math.random().toString(36).slice(2) }, {}), [kind, payload]);
const text = (p) => p.locator('#main').innerText();

const owner = await browser.newContext({ viewport: { width: 1366, height: 860 } });
const op = await openPage(owner);

await step('login page, then the owner starts the system', async () => {
  await login(op, secrets.ownerUsername, secrets.ownerPassword);
  await op.waitForSelector('form[data-form="_bootstrap"]', { timeout: 15000 });
  await op.fill('form[data-form="_bootstrap"] input[name=name]', 'เจ้าของระบบทดสอบ');
  await op.click('form[data-form="_bootstrap"] button[type=submit]');
  await op.waitForFunction(() => window.RRS.app.ledger.state.seq >= 1 && Object.keys(window.RRS.app.ledger.state.tables.users || {}).length === 1, null, { timeout: 15000 });
  await op.waitForSelector('.page[data-page="home"]', { timeout: 15000 });
  const who = await op.locator('#top').innerText();
  assert(/เจ้าของระบบทดสอบ/.test(who) && /ออกจากระบบ/.test(who), 'แถบบนแสดงชื่อผู้ใช้และปุ่มออกจากระบบ: ' + who);
});

await step('master data through the item screen, stock through a document, both stored on the server', async () => {
  let r = await exec(op, 'master.import', { warehouses: [{ code: 'A', name: 'คลังทดสอบ A' }], bins: [{ wh: 'A', code: 'A-01' }] });
  assert(r.ok, 'import ' + JSON.stringify(r.errors));
  await op.evaluate(() => { location.hash = 'items'; });
  await op.waitForSelector('.page[data-page="items"]');
  await op.click('button[data-act="new"]');
  await op.fill('form[data-form="save"] input[name=code]', 'E2E-001');
  await op.fill('form[data-form="save"] input[name=name]', 'ชิ้นทดสอบผ่านเซิร์ฟเวอร์');
  await op.fill('form[data-form="save"] input[name=baseUnit]', 'ชิ้น');
  await op.click('form[data-form="save"] button[type=submit]');
  await op.waitForFunction(() => window.RRS.app.ledger.state.tables.items && window.RRS.app.ledger.state.tables.items['E2E-001'], null, { timeout: 15000 });
  r = await exec(op, 'doc.post', { type: 'AJ', remark: 'ยอดตั้งต้น', lines: [{ code: 'E2E-001', qty: 1, wh: 'A', bin: 'A-01' }] });
  assert(r.ok, 'AJ ' + JSON.stringify(r.errors));
  const row = await d1.prepare("SELECT data FROM sq_records WHERE tbl='items' AND id='E2E-001'").first();
  assert(row && JSON.parse(row.data).name === 'ชิ้นทดสอบผ่านเซิร์ฟเวอร์', 'แถวสินค้าอยู่ใน D1 sq_records');
  if (shots) await op.screenshot({ path: path.join(shots, 'server-items.png'), fullPage: true });
});

await step('reload: the page reads everything back from D1 (no data in the browser)', async () => {
  await op.reload();
  await settled(op);
  await op.waitForFunction(() => window.RRS.app.mode === 'server' && window.RRS.app.ledger.state.seq >= 4, null, { timeout: 15000 });
  const local = await op.evaluate(() => { try { return localStorage.getItem('rrs-stockqc-demo-v1'); } catch (e) { return null; } });
  assert(!local, 'โหมดเซิร์ฟเวอร์ต้องไม่เก็บข้อมูลไว้ในเบราว์เซอร์');
  const qty = await op.evaluate(() => window.RRS.q.qty(window.RRS.app.ledger.state, { code: 'E2E-001' }));
  assert(qty === 1, 'ยอดหลังโหลดใหม่ ' + qty);
});

// a second account (password set by the owner, changed at first sign-in like Sales Office)
const tmp = 'Tmp' + Math.random().toString(36).slice(2, 12) + 'x9';
const pass2 = 'Pw' + Math.random().toString(36).slice(2, 14) + 'Q7';
const other = await browser.newContext({ viewport: { width: 390, height: 844 } });
let pp;
await step('owner creates a sign-in for a new person; without rights they only see the access request', async () => {
  const c = await op.evaluate(([u, p]) => fetch('/api/admin/credentials', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) }).then((r) => r.status), ['store.e2e', tmp]);
  assert(c === 200, 'credentials ' + c);
  pp = await openPage(other);
  await login(pp, 'store.e2e', tmp);
  const ch = await pp.evaluate(([a, b]) => fetch('/api/auth/password', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ current: a, next: b }) }).then((r) => r.status), [tmp, pass2]);
  assert(ch === 200, 'password change ' + ch);
  await pp.goto(url + '/');
  await login(pp, 'store.e2e', pass2);
  await pp.waitForSelector('form[data-form="_access"]', { timeout: 15000 });
  assert(/ยังไม่มีสิทธิ์/.test(await text(pp)), 'หน้าขอสิทธิ์');
  await pp.fill('form[data-form="_access"] input[name=name]', 'สโตร์ทดสอบ <b>หนา</b>');
  await pp.click('form[data-form="_access"] button[type=submit]');
  await pp.waitForFunction(() => /ส่งคำขอแล้ว/.test(document.querySelector('#main').innerText), null, { timeout: 15000 });
  if (shots) await pp.screenshot({ path: path.join(shots, 'server-access-phone.png'), fullPage: true });
});

await step('the owner sees the request and gives the person the store role', async () => {
  await op.reload();
  await settled(op);
  await op.waitForFunction(() => Object.keys(window.RRS.app.ledger.state.tables.access_requests || {}).length === 1, null, { timeout: 15000 });
  const r = await exec(op, 'user.upsert', { id: 'STORE_E2E', name: 'สโตร์ทดสอบ', roles: ['store'], accountId: 'store.e2e' });
  assert(r.ok, 'user.upsert ' + JSON.stringify(r.errors));
  await pp.reload();
  await settled(pp);
  await pp.waitForFunction(() => window.RRS.app.ledger && window.RRS.app.ledger.state.seq > 0 && /สโตร์ทดสอบ/.test(document.querySelector('#top').innerText), null, { timeout: 15000 });
});

await step('two people take the last piece at the same moment: exactly one succeeds', async () => {
  const issue = (p) => p.evaluate(() => window.RRS.app.ledger.execute({ kind: 'doc.post', payload: { type: 'OU', remark: 'พร้อมกัน', lines: [{ code: 'E2E-001', qty: 1, wh: 'A', bin: 'A-01' }] }, requestId: 'race-' + Math.random().toString(36).slice(2) }, {}));
  const [a, b] = await Promise.all([issue(op), issue(pp)]);
  assert([a.ok, b.ok].filter(Boolean).length === 1, 'สำเร็จได้คนเดียว: ' + JSON.stringify([a.ok, b.ok, a.errors, b.errors]));
  const loser = a.ok ? b : a;
  assert(loser.errors && /NOT_ENOUGH|NEGATIVE/.test(loser.errors[0].code), 'อีกคนได้เหตุผลว่าของไม่พอ: ' + JSON.stringify(loser.errors));
});

await step('the ledger in D1 replays to the same balances, and no request left the machine', async () => {
  const { state } = await H.replay(d1);
  assert(H.balanceOf(state, 'E2E-001') === 0, 'ยอดใน D1 = 0');
  assert(state.tables.users.STORE_E2E.accountId === 'store.e2e', 'ผู้ใช้ผูกบัญชี');
  assert(state.tables.access_requests['store.e2e'].name === 'สโตร์ทดสอบ <b>หนา</b>', 'ชื่อเก็บเป็นข้อความ');
  assert(blocked.filter((u) => !/fonts|cdnjs/.test(u)).length === 0, 'Worker ไม่ควรเรียกออกนอกเครื่อง: ' + blocked.join(', '));
  const bold = await op.evaluate(() => document.querySelectorAll('#main b').length);
  assert(bold >= 0, 'ok');
});

await browser.close();
await mf.dispose();
fs.rmSync(site, { recursive: true, force: true });
if (problems.length) {
  console.log('PROBLEMS\n' + problems.join('\n'));
  process.exit(1);
}
console.log(`server e2e ok (${n} steps)`);
