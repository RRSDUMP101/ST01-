// Step 3 security / correctness review: one test per problem found (each failed before its fix), plus regression
// checks for attacks that were already stopped (header spoofing, a records write failing inside the commit batch).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, bootstrapped, stockIn, replay, balanceOf, rid, tempDir, makeSecrets, wranglerAssetRouting, tempPassword, ORIGIN } from './helpers.mjs';

let s;
let owner;
let assets;
before(async () => {
  assets = tempDir('review-assets');
  fs.writeFileSync(path.join(assets, 'index.html'), '<!doctype html><html lang="th"><body><main id="main">RRS Stock &amp; QC</main></body></html>');
  fs.writeFileSync(path.join(assets, 'artifact.html'), '<div>artifact build (browser-only data)</div>');
  fs.writeFileSync(path.join(assets, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  // the asset routing of the real deployment (wrangler.toml run_worker_first + Cloudflare's html_handling)
  s = await startServer({ assetsDir: assets, assetRouting: wranglerAssetRouting() });
  owner = await bootstrapped(s);
});
after(async () => {
  if (s) await s.dispose();
  fs.rmSync(assets, { recursive: true, force: true });
});

const commitCount = async (srv = s) => (await srv.d1.prepare('SELECT COUNT(*) AS n FROM sq_commits').first()).n;
async function assertRecordsMatchReplay(srv = s) {
  const r = await replay(srv.d1);
  assert.deepEqual(r.records, r.tables, 'sq_records equals the replay of sq_commits');
  return r;
}
const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// ---- login -------------------------------------------------------------------------------------------------------
test('login timing: an unknown or switched-off username costs the same as a real account, also with a cost-14 owner hash', async () => {
  // Before: an unknown/inactive username was compared against ADMIN_PASSWORD_HASH (cost 12–16 allowed) and a real
  // account against its own cost-12 hash, so with a cost-14 owner hash "fast 401" meant "this account exists".
  const t = await startServer({ secrets: await makeSecrets({ ownerCost: 14 }) });
  try {
    const own = await t.ownerLogin({ ip: '203.0.113.1' });
    await t.account(own, 'real.user');
    const off = await t.account(own, 'gone.user');
    assert.equal((await t.callJson('/api/admin/credentials', { cookie: own, body: { username: off.username, active: false }, ip: '203.0.113.1' })).status, 200);
    const time = async (username, ip) => {
      const t0 = performance.now();
      const r = await t.callJson('/api/auth/login', { body: { username, password: 'wrong-password-1234' }, ip });
      assert.equal(r.status, 401);
      return performance.now() - t0;
    };
    await time('warm-up-user', '203.0.113.200');
    await time('real.user', '203.0.113.201');
    const unknown = [];
    const known = [];
    const inactive = [];
    for (let i = 0; i < 3; i++) {
      unknown.push(await time('nobody-' + i, `203.0.113.${10 + i}`));
      known.push(await time('real.user', `203.0.113.${20 + i}`));
      inactive.push(await time('gone.user', `203.0.113.${30 + i}`));
    }
    const ratio = median(unknown) / median(known);
    const ratioOff = median(inactive) / median(known);
    assert.ok(ratio < 1.8 && ratio > 0.55, `unknown/known login time ratio ${ratio.toFixed(2)} (${unknown.map(Math.round)} vs ${known.map(Math.round)} ms)`);
    assert.ok(ratioOff < 1.8 && ratioOff > 0.55, `inactive/known login time ratio ${ratioOff.toFixed(2)}`);
  } finally {
    await t.dispose();
  }
});

test('usernames that are names of Object.prototype (__proto__, constructor, …) can never be accounts', async () => {
  // They become engine row keys (access_requests is keyed by the account): '__proto__' would swap the prototype of a
  // state table (the live isolate and a snapshot/replay then disagree) and 'constructor' makes tx.get return Object.
  for (const username of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '__defineGetter__', 'valueOf']) {
    const r = await s.callJson('/api/admin/credentials', { cookie: owner, body: { username, password: tempPassword() } });
    if (username.length >= 3) assert.equal(r.status, 400, `${username} → ${r.status} ${r.text}`);
    const login = await s.callJson('/api/auth/login', { body: { username, password: 'whatever-password-1' }, ip: '198.51.100.90' });
    assert.equal(login.status, 401);
  }
  const rows = (await s.d1.prepare("SELECT username FROM sq_app_users WHERE username IN ('__proto__','constructor','toString','hasOwnProperty','__defineGetter__','valueOf')").all()).results;
  assert.deepEqual(rows, []);
});

test('ADMIN_USERNAME must be a valid account name: ":" (the connector\'s via namespace) or __proto__ = login not configured', async () => {
  for (const bad of ['sales-bridge:domestic', '__proto__', ' owner ']) {
    const secrets = await makeSecrets();
    const t = await startServer({ secrets, bindings: { ADMIN_USERNAME: bad } });
    try {
      const h = await t.callJson('/api/health');
      assert.equal(h.body.features.login, false, bad);
      const r = await t.callJson('/api/auth/login', { body: { username: bad, password: secrets.ownerPassword } });
      assert.equal(r.status, 503, `${bad} → ${r.status}`);
    } finally {
      await t.dispose();
    }
  }
});

test('the login rate limit cannot be dodged with X-Forwarded-For / X-Real-IP / True-Client-IP', async () => {
  const ip = '198.51.100.77';
  for (let i = 0; i < 10; i++) {
    const r = await s.callJson('/api/auth/login', { body: { username: 'spoof-' + i, password: 'wrong-password' }, ip,
      headers: { 'x-forwarded-for': `10.0.0.${i}`, 'x-real-ip': `10.1.0.${i}`, 'true-client-ip': `10.2.0.${i}` } });
    assert.equal(r.status, 401);
  }
  const r = await s.callJson('/api/auth/login', { body: { username: s.secrets.ownerUsername, password: s.secrets.ownerPassword }, ip,
    headers: { 'x-forwarded-for': '10.9.9.9', 'x-real-ip': '10.9.9.8', 'true-client-ip': '10.9.9.7' } });
  assert.equal(r.status, 429);
});

test('session fixation: a cookie planted before login is never the session afterwards, and it is revoked', async () => {
  const planted = await s.ownerLogin({ ip: '198.51.100.120' });
  const plantedToken = planted.split('=')[1];
  const r = await s.callJson('/api/auth/login', { body: { username: s.secrets.ownerUsername, password: s.secrets.ownerPassword }, cookie: planted, ip: '198.51.100.120' });
  assert.equal(r.status, 200);
  const fresh = r.headers.get('set-cookie').split(';')[0];
  assert.notEqual(fresh.split('=')[1], plantedToken);
  assert.equal((await s.callJson('/api/auth/session', { cookie: planted })).status, 401, 'the planted session ended');
  assert.equal((await s.callJson('/api/auth/session', { cookie: fresh })).status, 200);
  // two cookies of the same name (cookie tossing) are no session at all
  assert.equal((await s.callJson('/api/auth/session', { cookie: `${fresh}; ${fresh}` })).status, 401);
});

test('the Worker log never gets a token-like value from an unexpected error', async () => {
  const { redactForLog } = await import('../src/runtime.js');
  const token = 'a'.repeat(64);
  const out = redactForLog(`D1_TYPE_ERROR: Type 'object' not supported for value '${token}' Bearer ${'Zx9'.repeat(12)} $2b$12$${'x'.repeat(53)}`);
  for (const v of [token, 'Zx9'.repeat(12), 'x'.repeat(53)]) assert.ok(!out.includes(v), out);
  assert.match(out, /^D1_TYPE_ERROR: Type 'object' not supported/);
});

// ---- commands ----------------------------------------------------------------------------------------------------
test('a public engine command (user.requestAccess) works for an account without an engine user, as that account only', async () => {
  // Before: every command without an engine user got 403 NO_USER, so the page's "ขอใช้งานระบบ" never reached the engine.
  const staff = await s.account(owner, 'new.staff');
  const r = await s.cmd(staff.cookie, 'user.requestAccess', { name: 'พนักงานใหม่', note: 'สโตร์', accountId: 'someone.else', via: 'x' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.commit.by, '', 'no engine user is claimed');
  assert.equal(r.body.commit.via, 'new.staff', 'the account comes from the session');
  const st = (await assertRecordsMatchReplay()).state;
  assert.equal(st.tables.access_requests['new.staff'].status, 'OPEN');
  assert.ok(!st.tables.access_requests['someone.else']);
  // every other command still needs an engine user; reading the ledger too
  const other = await s.cmd(staff.cookie, 'kpi.record', { id: 'x', label: 'x' });
  assert.equal(other.status, 403);
  assert.equal(other.body.code, 'NO_USER');
  assert.equal((await s.callJson('/api/commits?after=0', { cookie: staff.cookie })).status, 403);
  // bounded: at most 10 per account per hour
  for (let i = 0; i < 9; i++) assert.equal((await s.cmd(staff.cookie, 'user.requestAccess', { name: 'พนักงานใหม่ ' + i })).status, 200);
  const limited = await s.cmd(staff.cookie, 'user.requestAccess', { name: 'อีกครั้ง' });
  assert.equal(limited.status, 429);
  // an account with an engine user gets the engine's own answer (already a user)
  const mine = await s.cmd(owner, 'user.requestAccess', { name: 'เจ้าของ' });
  assert.equal(mine.status, 422);
  assert.equal(mine.body.errors[0].code, 'ALREADY_USER');
});

test('a commit that would write a row key like __proto__ / constructor is refused before D1 (state stays consistent)', async () => {
  // access_requests exists now (previous test): user.upsert looks the bound account up there, and for '__proto__' the
  // engine finds Object.prototype and writes an access_requests row under that key.
  const n = await commitCount();
  for (const accountId of ['__proto__', 'constructor']) {
    const r = await s.cmd(owner, 'user.upsert', { id: 'PROTO1', name: 'ทดสอบ', roles: ['viewer'], accountId });
    assert.equal(r.status, 422, `${accountId} → ${r.status} ${r.text}`);
    assert.equal(r.body.errors[0].code, 'BAD_KEY');
  }
  assert.equal(await commitCount(), n, 'nothing written');
  const st = (await assertRecordsMatchReplay()).state;
  const t = st.tables.access_requests;
  assert.equal(Object.getPrototypeOf(t), Object.prototype);
  const keys = [];
  for (const k in t) keys.push(k);
  assert.deepEqual(keys, Object.keys(t), 'no inherited rows');
});

test('engine exceptions are answered with a Thai message, never JavaScript internals', async () => {
  const cases = [['settings.update', { patch: 5 }], ['user.upsert', { id: 'X1', name: 'x', roles: 'admin' }], ['master.import', { items: 'x' }]];
  for (const [kind, payload] of cases) {
    const r = await s.cmd(owner, kind, payload);
    assert.equal(r.status, 422, kind);
    const e = r.body.errors[0];
    assert.equal(e.code, 'INTERNAL');
    assert.doesNotMatch(e.message, /operator|is not a function|Cannot|reading|undefined|\(p\.|TypeError/, `${kind}: ${e.message}`);
    assert.match(e.message, /[฀-๿]/, 'Thai message');
  }
});

test('page commands cannot use the request-id namespace of the Sales Office connector, or Object.prototype names', async () => {
  // A page user who learns a future command id could otherwise take its request id first: the connector's
  // sales.syncJob would then get REQUEST_REUSED for ever and that SO job would never arrive.
  const n = await commitCount();
  for (const requestId of ['so.domestic.' + 'a'.repeat(48), 'so.export.' + 'b'.repeat(48), '__proto__', 'constructor', 'toString']) {
    const r = await s.cmd(owner, 'kpi.record', { id: 'lead_time', baseline: 1 }, requestId);
    assert.equal(r.status, 400, `${requestId} → ${r.status} ${r.text}`);
  }
  assert.equal(await commitCount(), n);
});

test('a records write that fails inside the commit batch leaves no commit and no records; the retry applies once', async () => {
  // "crash between the commit and its records": they are one D1 batch (one transaction), so a failure of the
  // sq_records statement takes the commit back with it and the isolate's cache does not move either.
  const before = await assertRecordsMatchReplay();
  const n = await commitCount();
  await s.d1.prepare("CREATE TRIGGER review_fail_records BEFORE INSERT ON sq_records WHEN NEW.tbl = 'movements' BEGIN SELECT RAISE(ABORT, 'review: records write fails'); END").run();
  const id = rid('atomic');
  const payload = { type: 'AJ', remark: 'ทดสอบ batch', lines: [{ code: 'TST-001', qty: 3, wh: 'A', bin: 'A-01' }] };
  try {
    const r = await s.cmd(owner, 'doc.post', payload, id);
    assert.ok(r.status >= 500, `${r.status} ${r.text}`);
    assert.doesNotMatch(r.text, /review: records write fails|SQLITE|D1_ERROR/, 'no database detail in the answer');
    assert.equal(await commitCount(), n, 'commit rolled back with its records');
    const mid = await assertRecordsMatchReplay();
    assert.deepEqual(mid.records, before.records);
  } finally {
    await s.d1.prepare('DROP TRIGGER review_fail_records').run();
  }
  const ok = await s.cmd(owner, 'doc.post', payload, id);
  assert.equal(ok.status, 200, ok.text);
  assert.ok(!ok.body.duplicate);
  const again = await s.cmd(owner, 'doc.post', payload, id);
  assert.equal(again.body.duplicate, true);
  assert.equal(await commitCount(), n + 1);
  const after = await assertRecordsMatchReplay();
  assert.equal(balanceOf(after.state, 'TST-001'), balanceOf(before.state, 'TST-001') + 3);
});

// ---- sq_records check / repair -------------------------------------------------------------------------------------
test('sq_records can be checked against a verified replay of sq_commits and rebuilt (owner or backup.restore only)', async () => {
  await stockIn(s, owner, 5);
  await assertRecordsMatchReplay();
  const clean = await s.callJson('/api/admin/records', { cookie: owner, body: {} });
  assert.equal(clean.status, 200, clean.text);
  assert.equal(clean.body.clean, true);
  assert.equal(clean.body.head, await commitCount());
  // damage the readable copy three ways: a missing row, a changed row, a row that no commit wrote
  await s.d1.prepare("DELETE FROM sq_records WHERE tbl='items'").run();
  await s.d1.prepare("UPDATE sq_records SET data='{\"qty\":999}' WHERE tbl='balances'").run();
  await s.d1.prepare("INSERT INTO sq_records (tbl,id,data,seq) VALUES ('balances','GHOST|A||AVAILABLE|','{\"qty\":5}',1)").run();
  const check = await s.callJson('/api/admin/records', { cookie: owner, body: {} });
  assert.equal(check.status, 200);
  assert.equal(check.body.clean, false);
  assert.ok(check.body.missing >= 1 && check.body.different >= 1 && check.body.extra === 1, JSON.stringify(check.body));
  assert.equal(check.body.repaired, 0, 'a check alone changes nothing');
  assert.notDeepEqual((await replay(s.d1)).records, (await replay(s.d1)).tables);
  const fix = await s.callJson('/api/admin/records', { cookie: owner, body: { repair: true } });
  assert.equal(fix.status, 200, fix.text);
  assert.equal(fix.body.repaired, check.body.missing + check.body.different + check.body.extra);
  await assertRecordsMatchReplay();
  const seqs = (await s.d1.prepare("SELECT seq FROM sq_records WHERE tbl='items'").all()).results;
  assert.ok(seqs.length && seqs.every((x) => x.seq >= 1), 'repaired rows keep the seq of the commit that wrote them');
  assert.equal((await s.callJson('/api/admin/records', { cookie: owner, body: {} })).body.clean, true);
  // later commits keep writing their records as usual
  await stockIn(s, owner, 1);
  await assertRecordsMatchReplay();
  // who may run it
  const clerk = await s.account(owner, 'records.clerk');
  await s.ok(owner, 'user.upsert', { id: 'RCLERK', name: 'สโตร์', roles: ['store_lead'], accountId: 'records.clerk' });
  assert.equal((await s.callJson('/api/admin/records', { cookie: clerk.cookie, body: {} })).status, 403);
  assert.equal((await s.callJson('/api/admin/records', { body: {} })).status, 401);
  assert.equal((await s.callJson('/api/admin/records', { cookie: owner, body: {}, origin: 'https://attacker.test' })).status, 403);
  assert.equal((await s.callJson('/api/admin/records', { cookie: owner, body: { repair: 'yes' } })).status, 400);
  assert.equal((await s.callJson('/api/admin/records', { cookie: owner, body: { other: 1 } })).status, 400);
  assert.equal((await s.callJson('/api/admin/records', { cookie: owner, method: 'GET' })).status, 405);
});

// ---- page and files -------------------------------------------------------------------------------------------------
async function follow(pathname) {
  let url = ORIGIN + pathname;
  for (let i = 0; i < 4; i++) {
    const res = await s.mf.dispatchFetch(url, { redirect: 'manual' });
    if (res.status < 300 || res.status >= 400) return { res, url, text: await res.text() };
    url = new URL(res.headers.get('location'), url).href;
  }
  throw new Error('redirect loop ' + pathname);
}

test('with the deployed asset routing every page and static file goes through the Worker; the artifact build never', async () => {
  // Before: run_worker_first listed only /api/*, /, /index.html, /artifact.html, while Cloudflare's html_handling
  // serves artifact.html at /artifact too – straight from the asset store, without the Worker and its headers.
  for (const p of ['/artifact', '/artifact/', '/artifact.html', '/artifact.html/', '/%61rtifact', '/artifact.HTML']) {
    const { res, text, url } = await follow(p);
    assert.ok(!/artifact build/.test(text), `${p} → ${url} served the artifact build (${res.status})`);
  }
  for (const p of ['/', '/index', '/index.html']) {
    const { res, text } = await follow(p);
    assert.equal(res.status, 200, p);
    assert.match(text, /RRS Stock &amp; QC/);
    assert.match(res.headers.get('content-security-policy') || '', /frame-ancestors 'none'/, p);
    assert.equal(res.headers.get('x-frame-options'), 'DENY', p);
  }
  const robots = await follow('/robots.txt');
  assert.equal(robots.res.status, 200);
  assert.equal(robots.res.headers.get('x-content-type-options'), 'nosniff', 'static files carry the Worker headers too');
  assert.equal(robots.res.headers.get('x-frame-options'), 'DENY');
});

test('download names are RFC 8187 encoded (quote and brackets too) and never break the header', async () => {
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(512, 0x41)]);
  const name = "it's (final)\r\nX-Evil: 1.pdf";
  const up = await s.callJson('/api/files', { cookie: owner, raw: pdf, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(name) } });
  assert.equal(up.status, 201, up.text);
  const res = await s.call('/api/files/' + up.body.id, { cookie: owner, origin: null });
  assert.equal(res.status, 200);
  const cd = res.headers.get('content-disposition');
  assert.equal(res.headers.get('x-evil'), null);
  const ext = /filename\*=UTF-8''([^;\s]+)/.exec(cd);
  assert.ok(ext, cd);
  assert.match(ext[1], /^[A-Za-z0-9!#$&+.^_`|~%-]+$/, 'only RFC 8187 attr-chars and %XX');
  assert.match(ext[1], /%27/);
  assert.match(ext[1], /%28final%29/);
  await res.arrayBuffer();
});
